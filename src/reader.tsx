import { useEffect, useRef, useState } from 'react'
import { db } from './db'
import { splitIntoChunks, synthesizeChapterChunk } from './piperTts'
import type { AudioCacheRecord, BookRecord, ChapterRecord, ModelRecord } from './types'

interface ReaderProps {
  book: BookRecord
  models: ModelRecord[]
  onBack: () => void
  onNotice: (message: string) => void
}

interface ChapterPlan {
  runId: number
  chapter: ChapterRecord
  model: ModelRecord
  dialogueModels?: ModelRecord[]
  totalChunks: number
}

export function ReaderPage({ book, models, onBack, onNotice }: ReaderProps) {
  const [chapters, setChapters] = useState<ChapterRecord[]>([])
  const [chapterIndex, setChapterIndex] = useState(book.currentChapter)
  const [audio, setAudio] = useState<AudioCacheRecord[]>([])
  const [audioIndex, setAudioIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('点击播放开始生成当前章节音频')
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const [ttsProgress, setTtsProgress] = useState({ done: 0, total: 0 })
  const [ttsElapsed, setTtsElapsed] = useState(0)
  const [errorDetail, setErrorDetail] = useState('')
  const [activeModelId, setActiveModelId] = useState('')
  const [dialogueModelIds, setDialogueModelIds] = useState<string[]>([])
  const [autoDialogueVoice, setAutoDialogueVoice] = useState(false)
  const [showChapterList, setShowChapterList] = useState(false)
  const [playerExpanded, setPlayerExpanded] = useState(false)
  const audioElement = useRef<HTMLAudioElement>(null)
  const activeTextRef = useRef<HTMLElement>(null)
  const urls = useRef<string[]>([])
  const currentAudio = useRef<AudioCacheRecord[]>([])
  const currentAudioIndex = useRef(0)
  const currentChapterIndex = useRef(chapterIndex)
  const prewarming = useRef(new Set<string>())
  const bookRef = useRef(book)
  const lastSaved = useRef(0)
  const currentPlan = useRef<ChapterPlan | undefined>(undefined)
  const chunkPromises = useRef(new Map<string, Promise<AudioCacheRecord | undefined>>())
  const ttsStartedAt = useRef<number | undefined>(undefined)
  const runId = useRef(0)
  const playbackIntent = useRef(false)
  const pauseGuardUntil = useRef(0)
  const resumeTimer = useRef<number | undefined>(undefined)

  const chapter = chapters[chapterIndex]
  const model = models.find((item) => item.id === activeModelId) ?? models[0]
  const dialogueOptions = models
  const effectiveDialogueModelIds = autoDialogueVoice
    ? [...new Set([...dialogueModelIds, ...models.map((item) => item.id)])].slice(0, 2)
    : []
  const dialogueModels = autoDialogueVoice
    ? effectiveDialogueModelIds
      .map((id) => models.find((item) => item.id === id))
      .filter((item): item is ModelRecord => Boolean(item))
    : []
  const activeText = audio.find((item) => item.chunkIndex === audioIndex)?.text?.trim() ?? ''

  function isCurrentPlan(plan: ChapterPlan): boolean {
    return currentPlan.current?.runId === plan.runId && currentPlan.current.chapter.id === plan.chapter.id
  }

  useEffect(() => {
    currentAudio.current = audio
    currentAudioIndex.current = audioIndex
  }, [audio, audioIndex])

  useEffect(() => {
    currentChapterIndex.current = chapterIndex
  }, [chapterIndex])

  useEffect(() => {
    if (!ttsStartedAt.current || ttsProgress.done >= ttsProgress.total) return
    const updateElapsed = () => setTtsElapsed(Math.floor((performance.now() - ttsStartedAt.current!) / 1000))
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [ttsProgress.done, ttsProgress.total])

  useEffect(() => {
    let active = true
    void db.chaptersForBook(book.id).then((items) => {
      if (!active) return
      setChapters(items)
      const savedChapter = Math.min(bookRef.current.currentChapter, Math.max(0, items.length - 1))
      setChapterIndex(savedChapter)
      currentChapterIndex.current = savedChapter
    })
    return () => { active = false }
  }, [book.id])

  useEffect(() => {
    let active = true
    void db.getSettings().then((settings) => {
      if (!active) return
      setRate(settings.playbackRate || 1)
      setActiveModelId(settings.activeModelId ?? '')
      setDialogueModelIds(settings.dialogueModelIds ?? (settings.dialogueModelId ? [settings.dialogueModelId] : []))
      setAutoDialogueVoice(settings.autoDialogueVoice ?? false)
    })
    return () => { active = false }
  }, [book.id])

  useEffect(() => {
    const element = audioElement.current
    if (!element) return
    element.playbackRate = rate
    element.defaultPlaybackRate = rate
    element.preservesPitch = true
  }, [rate])

  useEffect(() => {
    if (!activeText) return
    const timer = window.setTimeout(() => activeTextRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
    return () => window.clearTimeout(timer)
  }, [activeText, chapterIndex])

  useEffect(() => {
    const element = audioElement.current
    if (!element) return
    const onTime = () => {
      setProgress(element.currentTime)
      setDuration(Number.isFinite(element.duration) ? element.duration : 0)
      const now = Date.now()
      if (now - lastSaved.current < 5000 || !chapter) return
      lastSaved.current = now
      void saveProgress(chapterIndex, currentAudio.current.find((item) => item.chunkIndex === currentAudioIndex.current)?.text)
    }
    const onEnded = () => {
      void handleAudioEnded()
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => {
      setPlaying(false)
      if (!playbackIntent.current || performance.now() < pauseGuardUntil.current || element.ended || element.error) return
      setPhase('播放短暂中断，正在继续…')
      if (resumeTimer.current !== undefined) window.clearTimeout(resumeTimer.current)
      resumeTimer.current = window.setTimeout(() => {
        if (!playbackIntent.current || !element.paused || element.ended) return
        void element.play().catch(() => {
          playbackIntent.current = false
          setPhase('播放已暂停，请点击播放继续')
        })
      }, 180)
    }
    const onError = () => {
      const code = element.error?.code
      const reason = code === MediaError.MEDIA_ERR_DECODE ? 'WAV 解码失败' : code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'Safari 不支持此音频格式' : '音频资源加载失败'
      setPlaying(false)
      playbackIntent.current = false
      setPhase(reason)
      onNotice(`${reason}。如果是首次播放，请保持联网并再点击一次播放。`)
    }
    element.addEventListener('timeupdate', onTime)
    element.addEventListener('ended', onEnded)
    element.addEventListener('play', onPlay)
    element.addEventListener('pause', onPause)
    element.addEventListener('error', onError)
    return () => {
      element.removeEventListener('timeupdate', onTime)
      element.removeEventListener('ended', onEnded)
      element.removeEventListener('play', onPlay)
      element.removeEventListener('pause', onPause)
      element.removeEventListener('error', onError)
      if (resumeTimer.current !== undefined) window.clearTimeout(resumeTimer.current)
    }
  }, [chapter, chapterIndex, chapters.length])

  useEffect(() => {
    const mediaSession = navigator.mediaSession
    if (!mediaSession) return
    mediaSession.metadata = new MediaMetadata({ title: chapter?.title ?? book.title, artist: '本地 Piper TTS', album: book.title })
    mediaSession.setActionHandler('play', () => { void audioElement.current?.play() })
    mediaSession.setActionHandler('pause', () => audioElement.current?.pause())
    mediaSession.setActionHandler('previoustrack', () => void moveChapter(-1))
    mediaSession.setActionHandler('nexttrack', () => void moveChapter(1))
    return () => {
      for (const action of ['play', 'pause', 'previoustrack', 'nexttrack'] as MediaSessionAction[]) {
        try { mediaSession.setActionHandler(action, null) } catch { /* iOS may reject unsupported actions */ }
      }
    }
  }, [book.title, chapter?.title])

  useEffect(() => () => {
    playbackIntent.current = false
    audioElement.current?.pause()
    urls.current.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  function appendGeneratedAudio(record: AudioCacheRecord) {
    const next = [...currentAudio.current.filter((item) => item.chunkIndex !== record.chunkIndex), record]
      .sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
    currentAudio.current = next
    setAudio(next)
  }

  function dialogueModelForChunk(plan: ChapterPlan, index: number): ModelRecord | undefined {
    if (!plan.dialogueModels?.length) return undefined
    let inDialogue = false
    let dialogueSegment = -1
    let activeSpeakerSlot: number | undefined
    const speakerSlots = new Map<string, number>()
    for (const [chunkIndex, text] of splitIntoChunks(plan.chapter.text).entries()) {
      let chunkDialogue = inDialogue
      let chunkSpeakerSlot = activeSpeakerSlot
      let quoteStart = -1
      const labeledSpeaker = speakerAtStart(text)
      if (labeledSpeaker) {
        chunkDialogue = true
        if (!speakerSlots.has(labeledSpeaker)) speakerSlots.set(labeledSpeaker, speakerSlots.size % plan.dialogueModels.length)
        chunkSpeakerSlot = speakerSlots.get(labeledSpeaker)
      }
      for (let charIndex = 0; charIndex < text.length; charIndex += 1) {
        const character = text[charIndex]
        const opens = /[“「『"]/.test(character)
        const closes = /[”」』"]/.test(character)
        if (opens && !inDialogue) {
          inDialogue = true
          chunkDialogue = true
          dialogueSegment += 1
          quoteStart = charIndex
          const speaker = speakerBeforeQuote(text, quoteStart)
          if (speaker) {
            if (!speakerSlots.has(speaker)) speakerSlots.set(speaker, speakerSlots.size % plan.dialogueModels.length)
            chunkSpeakerSlot = speakerSlots.get(speaker)
          } else {
            chunkSpeakerSlot = dialogueSegment % plan.dialogueModels.length
          }
          activeSpeakerSlot = chunkSpeakerSlot
          continue
        }
        if (inDialogue) chunkDialogue = true
        if (closes && inDialogue) {
          inDialogue = false
          activeSpeakerSlot = undefined
        }
      }
      if (chunkIndex === index) {
        return chunkDialogue
          ? plan.dialogueModels[(chunkSpeakerSlot ?? dialogueSegment) % plan.dialogueModels.length]
          : undefined
      }
    }
    return undefined
  }

  function voiceModelForChunk(plan: ChapterPlan, index: number): ModelRecord {
    return dialogueModelForChunk(plan, index) ?? plan.model
  }

  function ensureChunk(plan: ChapterPlan, index: number): Promise<AudioCacheRecord | undefined> {
    const voiceModel = voiceModelForChunk(plan, index)
    const key = `${plan.chapter.id}:${voiceModel.id}:${index}`
    const existing = currentAudio.current.find((item) => item.chapterId === plan.chapter.id && item.modelId === voiceModel.id && item.chunkIndex === index)
    if (existing) return Promise.resolve(existing)
    const pending = chunkPromises.current.get(key)
    if (pending) return pending
    const promise = synthesizeChapterChunk(plan.chapter, voiceModel, index, ({ phase: nextPhase, chunkIndex, totalChunks }) => {
      if (isCurrentPlan(plan)) {
        setPhase(`${nextPhase} ${chunkIndex}/${totalChunks}`)
        setTtsProgress({ done: chunkIndex, total: totalChunks })
      }
    }).then((record) => {
      if (record && isCurrentPlan(plan)) appendGeneratedAudio(record)
      return record
    }).finally(() => { chunkPromises.current.delete(key) })
    chunkPromises.current.set(key, promise)
    return promise
  }

  async function primeUpcoming(plan: ChapterPlan, fromIndex: number, count = 1) {
    const end = Math.min(plan.totalChunks, fromIndex + count)
    for (let index = fromIndex; index < end; index += 1) {
      try {
        await ensureChunk(plan, index)
      } catch (error) {
        if (isCurrentPlan(plan)) {
          setPhase(`第 ${index + 1}/${plan.totalChunks} 段生成失败`)
          onNotice(error instanceof Error ? error.message : String(error))
        }
        return
      }
    }
    if (isCurrentPlan(plan) && end >= plan.totalChunks) void prewarmNext(currentChapterIndex.current)
  }

  async function handleAudioEnded() {
    const plan = currentPlan.current
    const nextIndex = currentAudioIndex.current + 1
    if (plan && nextIndex < plan.totalChunks) {
      setPhase(`准备第 ${nextIndex + 1}/${plan.totalChunks} 个文本块`)
      try {
        const record = await ensureChunk(plan, nextIndex)
        if (record) {
          await playAudioIndex(nextIndex, currentAudio.current)
          void primeUpcoming(plan, nextIndex + 1)
        }
      } catch (error) {
        setPlaying(false)
        setPhase('下一文本块生成失败')
        onNotice(error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (currentChapterIndex.current + 1 < chapters.length) {
      await startChapter(currentChapterIndex.current + 1, true)
    } else {
      playbackIntent.current = false
      setPlaying(false)
      setPhase('本书已播放完')
    }
  }

  async function saveProgress(nextChapterIndex: number, chunkText?: string) {
    const nextBook: BookRecord = {
      ...bookRef.current,
      currentChapter: nextChapterIndex,
      currentOffset: chunkText ? (chapters[nextChapterIndex]?.text.indexOf(chunkText) ?? 0) : 0,
      updatedAt: Date.now(),
    }
    bookRef.current = nextBook
    await db.saveBook(nextBook)
  }

  async function playAudioIndex(index: number, records: AudioCacheRecord[]) {
    const element = audioElement.current
    const record = records.find((item) => item.chunkIndex === index)
    if (!element || !record) return
    const totalChunks = currentPlan.current?.totalChunks ?? records.length
    currentAudioIndex.current = index
    setAudioIndex(index)
    setProgress(0)
    setDuration(record.duration)
    urls.current.forEach((url) => URL.revokeObjectURL(url))
    urls.current = []
    const url = URL.createObjectURL(record.blob)
    urls.current.push(url)
    pauseGuardUntil.current = performance.now() + 700
    element.pause()
    element.src = url
    element.playbackRate = rate
    element.load()
    try {
      await element.play()
      setPhase(`播放第 ${index + 1}/${totalChunks} 个文本块`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/notallowed|gesture|user/i.test(message)) {
        playbackIntent.current = false
        setPhase('音频已生成，请再次点击播放（iPhone 播放权限限制）')
        onNotice('音频已生成，请再次点击播放。')
      } else {
        playbackIntent.current = false
        setPhase('音频播放失败')
        onNotice(`音频播放失败：${message || '请重试当前文本块'}`)
      }
    }
  }

  async function startChapter(nextIndex: number, autoPlay = false, startChunkIndex = 0) {
    const nextChapter = chapters[nextIndex]
    if (!nextChapter || !model) return
    const totalChunks = splitIntoChunks(nextChapter.text).length
    const firstChunkIndex = Math.min(Math.max(0, startChunkIndex), Math.max(0, totalChunks - 1))
    const plan: ChapterPlan = { runId: ++runId.current, chapter: nextChapter, model, dialogueModels, totalChunks }
    pauseGuardUntil.current = performance.now() + 900
    audioElement.current?.pause()
    playbackIntent.current = autoPlay
    setPlaying(false)
    setChapterIndex(nextIndex)
    currentChapterIndex.current = nextIndex
    window.scrollTo({ top: 0, behavior: 'auto' })
    currentPlan.current = plan
    chunkPromises.current.clear()
    setAudio([])
    currentAudio.current = []
    setAudioIndex(0)
    setProgress(0)
    setTtsProgress({ done: 0, total: totalChunks })
    setErrorDetail('')
    ttsStartedAt.current = performance.now()
    setTtsElapsed(0)
    await saveProgress(nextIndex)
    setBusy(true)
    try {
      const first = await ensureChunk(plan, firstChunkIndex)
      if (!first) throw new Error('当前章节没有可朗读文本')
      if (!isCurrentPlan(plan)) return
      currentAudioIndex.current = firstChunkIndex
      setAudioIndex(firstChunkIndex)
      setPhase(`文本块 ${firstChunkIndex + 1}/${totalChunks} 已就绪，正在准备播放`)
      if (autoPlay) await playAudioIndex(firstChunkIndex, currentAudio.current)
      void primeUpcoming(plan, firstChunkIndex + 1)
    } catch (error) {
      if (!isCurrentPlan(plan)) return
      const detail = error instanceof Error ? error.message : String(error)
      setPhase('TTS 生成失败')
      setErrorDetail(detail)
      onNotice(detail)
      playbackIntent.current = false
    } finally {
      if (isCurrentPlan(plan)) setBusy(false)
    }
  }

  async function prewarmNext(index: number) {
    const nextChapter = chapters[index + 1]
    if (!nextChapter || !model || prewarming.current.has(nextChapter.id)) return
    prewarming.current.add(nextChapter.id)
    try {
      const plan: ChapterPlan = { runId: -runId.current, chapter: nextChapter, model, dialogueModels, totalChunks: splitIntoChunks(nextChapter.text).length }
      await ensureChunk(plan, 0)
    } catch {
      // 下一章是预生成，失败时播放到该章再提示，不打断当前播放。
    } finally {
      prewarming.current.delete(nextChapter.id)
    }
  }

  async function handlePlay() {
    if (!model) { onNotice('请先在 Benchmark 页面下载中文 Piper 模型。'); return }
    if (!chapter) return
    if (audio.length > 0) {
      if (audioElement.current?.paused) {
        playbackIntent.current = true
        await playAudioIndex(audioIndex, audio)
      } else {
        playbackIntent.current = false
        audioElement.current?.pause()
      }
      return
    }
    await startChapter(chapterIndex, true)
  }

  async function moveChapter(delta: number) {
    const nextIndex = chapterIndex + delta
    if (nextIndex < 0 || nextIndex >= chapters.length) return
    await startChapter(nextIndex, playbackIntent.current)
  }

  async function changeRate(nextRate: number) {
    setRate(nextRate)
    const element = audioElement.current
    if (element) {
      const wasPlaying = !element.paused
      element.defaultPlaybackRate = nextRate
      element.playbackRate = nextRate
      element.preservesPitch = true
      if (wasPlaying) {
        try { await element.play() } catch { /* Safari may require the original tap */ }
      }
    }
    await db.saveSettings({ ...(await db.getSettings()), playbackRate: nextRate })
  }

  async function resetAudioAfterVoiceChange(message: string) {
    playbackIntent.current = false
    audioElement.current?.pause()
    setPlaying(false)
    currentPlan.current = undefined
    chunkPromises.current.clear()
    prewarming.current.clear()
    currentAudio.current = []
    setAudio([])
    setAudioIndex(0)
    setProgress(0)
    setDuration(0)
    setTtsProgress({ done: 0, total: 0 })
    setErrorDetail('')
    setPhase(message)
  }

  async function changeNarrationModel(nextModelId: string) {
    setActiveModelId(nextModelId)
    await db.saveSettings({ ...(await db.getSettings()), activeModelId: nextModelId })
    await resetAudioAfterVoiceChange('旁白人声已切换，点击播放重新生成')
  }

  async function changeDialogueVoice(enabled: boolean, nextModelIds = dialogueModelIds) {
    const selectedDialogueModelIds = [...new Set(nextModelIds)].filter((id) => id && models.some((item) => item.id === id))
    if (enabled) {
      for (const candidate of models) {
        if (selectedDialogueModelIds.length >= 2) break
        if (!selectedDialogueModelIds.includes(candidate.id)) selectedDialogueModelIds.push(candidate.id)
      }
    }
    setAutoDialogueVoice(enabled)
    setDialogueModelIds(selectedDialogueModelIds)
    await db.saveSettings({ ...(await db.getSettings()), autoDialogueVoice: enabled, dialogueModelIds: selectedDialogueModelIds, dialogueModelId: selectedDialogueModelIds[0] })
    await resetAudioAfterVoiceChange(enabled ? '对白将使用独立人声，点击播放重新生成' : '已关闭对白独立人声')
  }

  async function changeDialogueVoiceSlot(slot: number, nextModelId: string) {
    const nextModelIds = [...dialogueModelIds]
    nextModelIds[slot] = nextModelId
    await changeDialogueVoice(true, nextModelIds)
  }

  function turnPage(direction: -1 | 1) {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    const nextScroll = Math.min(maxScroll, Math.max(0, window.scrollY + direction * Math.round(window.innerHeight * 0.78)))
    window.scrollTo({ top: nextScroll, behavior: 'auto' })
  }

  function startFromParagraph(text: string) {
    if (!chapter) return
    const chunks = splitIntoChunks(chapter.text)
    const paragraphStart = chapter.text.indexOf(text)
    if (paragraphStart < 0) return
    let searchFrom = 0
    let targetIndex = 0
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkStart = chapter.text.indexOf(chunks[index], searchFrom)
      if (chunkStart < 0) break
      if (chunkStart >= paragraphStart && chunkStart < paragraphStart + text.length) {
        targetIndex = index
        break
      }
      searchFrom = chunkStart + chunks[index].length
    }
    setPlayerExpanded(true)
    void startChapter(chapterIndex, true, targetIndex)
  }

  function renderParagraph(text: string, index: number) {
    const start = activeText ? text.indexOf(activeText) : -1
    if (start < 0) return <p key={`${chapter?.id}-${index}`} onDoubleClick={() => startFromParagraph(text)}>{text}</p>
    return <p className="active-paragraph" key={`${chapter?.id}-${index}`} onDoubleClick={() => startFromParagraph(text)}>{text.slice(0, start)}<mark ref={activeTextRef}>{activeText}</mark>{text.slice(start + activeText.length)}</p>
  }

  if (chapters.length === 0) return <div className="reader-page"><button className="text-button" onClick={onBack}>← 返回书架</button><div className="empty-state"><p>正在读取章节…</p></div></div>

  return <div className="reader-page">
    <div className="reader-header"><button className="text-button" onClick={onBack}>← 书架</button><span className="chip">{chapterIndex + 1} / {chapters.length}</span></div>
    <div className="reader-title"><div className="eyebrow accent">READING LOCALLY</div><h3>{book.title}</h3><p className="reader-chapter-label">第 {chapterIndex + 1} 章 · {chapter?.title}</p></div>
    <div className="reader-page-nav"><button onClick={() => turnPage(-1)}>↑ 上一页</button><span>可滑动阅读</span><button onClick={() => turnPage(1)}>下一页 ↓</button></div>
    <article className="reader-text"><h4>{chapter?.title}</h4>{chapter?.text.split(/\n+/).filter(Boolean).map((paragraph, index) => renderParagraph(paragraph, index))}</article>
    <div className={`player-panel ${playerExpanded ? 'expanded' : 'collapsed'}`}>
      <div className="mini-player">
        <button className="mini-toggle" aria-expanded={playerExpanded} onClick={() => setPlayerExpanded((expanded) => !expanded)}><span className={playing ? 'pulse' : 'offline-dot'} /><span><strong>第 {chapterIndex + 1} / {chapters.length} 章</strong><small>{busy ? phase : playing ? '正在播放' : '点击展开播放器'}</small></span></button>
        <button className="mini-chapters" onClick={() => { setPlayerExpanded(true); setShowChapterList(true) }}>章节</button>
        <button className="mini-play" onClick={() => void handlePlay()} disabled={busy} aria-label={playing ? '暂停' : '播放'}>{playing ? 'Ⅱ' : '▶'}</button>
      </div>
      {playerExpanded && <>
      <div className="player-top-row"><span className="player-chapter-title">播放控制</span><div className="player-top-actions"><button className="chapter-list-button" onClick={() => setShowChapterList((visible) => !visible)}>章节目录</button><button className="collapse-button" onClick={() => setPlayerExpanded(false)}>收起</button></div></div>
      {showChapterList && <div className="chapter-drawer"><div className="chapter-drawer-head"><strong>全部章节</strong><button onClick={() => setShowChapterList(false)}>关闭</button></div><div className="chapter-list">{chapters.map((item, position) => <button className={position === chapterIndex ? 'current' : ''} key={item.id} onClick={() => { setShowChapterList(false); void startChapter(position, playbackIntent.current) }}><span>{String(position + 1).padStart(3, '0')}</span><em>{item.title}</em></button>)}</div></div>}
      <div className="player-status"><span className={playing ? 'pulse' : 'offline-dot'} />{phase}</div>
      {ttsProgress.total > 0 && <div className="tts-progress"><span style={{ width: `${Math.round((ttsProgress.done / ttsProgress.total) * 100)}%` }} /><small>本章音频 {ttsProgress.done}/{ttsProgress.total} 段 · 已耗时 {ttsElapsed} 秒</small></div>}
      {errorDetail && <div className="tts-error">{errorDetail}</div>}
      <input className="seek" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(progress, duration || 0)} onChange={(event) => { const value = Number(event.target.value); setProgress(value); if (audioElement.current) audioElement.current.currentTime = value }} />
      <div className="time-row"><span>{formatTime(progress)}</span><span>{formatTime(duration)}</span></div>
      <div className="player-controls"><button onClick={() => void moveChapter(-1)} disabled={chapterIndex === 0}>上一章</button><button className="play-button" onClick={() => void handlePlay()} disabled={busy}>{playing ? '暂停' : busy ? `生成 ${Math.max(1, ttsProgress.done + 1)}/${ttsProgress.total}…` : '播放'}</button><button onClick={() => void moveChapter(1)} disabled={chapterIndex === chapters.length - 1}>下一章</button></div>
      <div className="speed-row"><span>倍速</span>{[0.8, 1, 1.25, 1.5, 2].map((value) => <button className={rate === value ? 'selected' : ''} key={value} onClick={() => void changeRate(value)}>{value}x</button>)}</div>
      {models.length > 0 && <div className="voice-settings"><label><span>旁白人声</span><select value={model?.id ?? ''} disabled={busy} onChange={(event) => void changeNarrationModel(event.target.value)}>{models.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label className="dialogue-toggle"><input type="checkbox" checked={autoDialogueVoice} disabled={busy || models.length < 2} onChange={(event) => void changeDialogueVoice(event.target.checked)} /><span>对白使用独立声音并按角色轮换</span></label>{autoDialogueVoice && dialogueOptions.length > 0 && <><label><span>对白声音 1</span><select value={dialogueModelIds[0] && dialogueOptions.some((item) => item.id === dialogueModelIds[0]) ? dialogueModelIds[0] : dialogueOptions[0].id} disabled={busy} onChange={(event) => void changeDialogueVoiceSlot(0, event.target.value)}>{dialogueOptions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{dialogueOptions.length > 1 && <label><span>对白声音 2</span><select value={dialogueModelIds[1] && dialogueOptions.some((item) => item.id === dialogueModelIds[1]) ? dialogueModelIds[1] : dialogueOptions[1].id} disabled={busy} onChange={(event) => void changeDialogueVoiceSlot(1, event.target.value)}>{dialogueOptions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}<small className="voice-hint dialogue-hint">优先按“张三说：”等角色名绑定声音；没有角色名时按对白段轮换。至少准备两个不同模型，才能听出两种声音。</small></>}</div>}
      {model && /x[_-]?low/i.test(model.name) && <small className="voice-hint">当前是 x_low 音质，声调较弱；下载 medium 模型后可在这里切换为更自然的人声。</small>}
      {!model && <small>还没有可用模型：先在线下载中文 Piper 模型，之后可以完全离线生成。</small>}
      </>}
    </div>
    <audio ref={audioElement} preload="auto" />
  </div>
}

function formatTime(value: number): string {
  if (!Number.isFinite(value)) return '0:00'
  const seconds = Math.max(0, Math.floor(value))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function speakerBeforeQuote(text: string, quoteStart: number): string | undefined {
  if (quoteStart <= 0) return undefined
  const prefix = text.slice(0, quoteStart)
  return speakerAtStart(prefix.replace(/^.*[。！？!?；;]\s*/s, ''))
    ?? prefix.match(/([\u4e00-\u9fffA-Za-z0-9·]{1,16})(?:说道|说|问道|答道|喊道|叫道|笑道|怒道|冷冷地道|开口道)[：:，,]?\s*$/)?.[1]
}

function speakerAtStart(text: string): string | undefined {
  const match = text.match(/^\s*([\u4e00-\u9fffA-Za-z0-9·]{1,16})(?:说|问|答|喊|叫|笑|怒)?(?:道)?[：:]\s*/)
  return match?.[1]
}
