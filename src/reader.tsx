import { useEffect, useRef, useState } from 'react'
import { db } from './db'
import { synthesizeChapter } from './piperTts'
import type { AudioCacheRecord, BookRecord, ChapterRecord, ModelRecord } from './types'

interface ReaderProps {
  book: BookRecord
  models: ModelRecord[]
  onBack: () => void
  onChanged: () => Promise<void>
  onNotice: (message: string) => void
}

export function ReaderPage({ book, models, onBack, onChanged, onNotice }: ReaderProps) {
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
  const audioElement = useRef<HTMLAudioElement>(null)
  const urls = useRef<string[]>([])
  const currentAudio = useRef<AudioCacheRecord[]>([])
  const currentAudioIndex = useRef(0)
  const currentChapterIndex = useRef(chapterIndex)
  const prewarming = useRef(new Set<string>())
  const bookRef = useRef(book)
  const lastSaved = useRef(0)

  const chapter = chapters[chapterIndex]
  const model = models[0]

  useEffect(() => {
    currentAudio.current = audio
    currentAudioIndex.current = audioIndex
  }, [audio, audioIndex])

  useEffect(() => {
    currentChapterIndex.current = chapterIndex
  }, [chapterIndex])

  useEffect(() => {
    let active = true
    void Promise.all([db.chaptersForBook(book.id), db.getSettings()]).then(([items, settings]) => {
      if (!active) return
      setChapters(items)
      setChapterIndex(Math.min(book.currentChapter, Math.max(0, items.length - 1)))
      setRate(settings.playbackRate || 1)
    })
    return () => { active = false }
  }, [book.id, book.currentChapter])

  useEffect(() => {
    const element = audioElement.current
    if (!element) return
    element.playbackRate = rate
  }, [rate])

  useEffect(() => {
    const element = audioElement.current
    if (!element) return
    const onTime = () => {
      setProgress(element.currentTime)
      setDuration(Number.isFinite(element.duration) ? element.duration : 0)
      const now = Date.now()
      if (now - lastSaved.current < 1500 || !chapter) return
      lastSaved.current = now
      void saveProgress(chapterIndex, currentAudio.current[currentAudioIndex.current]?.text)
    }
    const onEnded = () => {
      if (currentAudioIndex.current + 1 < currentAudio.current.length) {
        void playAudioIndex(currentAudioIndex.current + 1, currentAudio.current)
      } else if (currentChapterIndex.current + 1 < chapters.length) {
        void startChapter(currentChapterIndex.current + 1, true)
      } else {
        setPlaying(false)
        setPhase('本书已播放完')
      }
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    element.addEventListener('timeupdate', onTime)
    element.addEventListener('ended', onEnded)
    element.addEventListener('play', onPlay)
    element.addEventListener('pause', onPause)
    return () => {
      element.removeEventListener('timeupdate', onTime)
      element.removeEventListener('ended', onEnded)
      element.removeEventListener('play', onPlay)
      element.removeEventListener('pause', onPause)
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
    audioElement.current?.pause()
    urls.current.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  async function saveProgress(nextChapterIndex: number, chunkText?: string) {
    const nextBook: BookRecord = {
      ...bookRef.current,
      currentChapter: nextChapterIndex,
      currentOffset: chunkText ? (chapters[nextChapterIndex]?.text.indexOf(chunkText) ?? 0) : 0,
      updatedAt: Date.now(),
    }
    bookRef.current = nextBook
    await db.saveBook(nextBook)
    await onChanged()
  }

  async function playAudioIndex(index: number, records: AudioCacheRecord[]) {
    const element = audioElement.current
    const record = records[index]
    if (!element || !record) return
    currentAudioIndex.current = index
    setAudioIndex(index)
    setProgress(0)
    setDuration(record.duration)
    urls.current.forEach((url) => URL.revokeObjectURL(url))
    urls.current = []
    const url = URL.createObjectURL(record.blob)
    urls.current.push(url)
    element.src = url
    element.playbackRate = rate
    try {
      await element.play()
      setPhase(`播放第 ${index + 1}/${records.length} 个文本块`)
    } catch {
      setPhase('音频已生成，请再次点击播放（iPhone 浏览器的播放权限限制）')
      onNotice('音频已生成，再点一次播放即可开始。')
    }
  }

  async function startChapter(nextIndex: number, autoPlay = false) {
    const nextChapter = chapters[nextIndex]
    if (!nextChapter || !model || busy) return
    audioElement.current?.pause()
    setPlaying(false)
    setChapterIndex(nextIndex)
    currentChapterIndex.current = nextIndex
    setAudio([])
    setAudioIndex(0)
    setProgress(0)
    await saveProgress(nextIndex)
    setBusy(true)
    try {
      const records = await synthesizeChapter(nextChapter, model, ({ phase: nextPhase, chunkIndex, totalChunks }) => {
        setPhase(`${nextPhase} ${chunkIndex}/${totalChunks}`)
      })
      setAudio(records)
      currentAudio.current = records
      currentAudioIndex.current = 0
      setPhase(`第 ${nextIndex + 1} 章音频已就绪，共 ${records.length} 个文本块`)
      if (autoPlay) await playAudioIndex(0, records)
      void prewarmNext(nextIndex)
    } catch (error) {
      setPhase('TTS 生成失败')
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function prewarmNext(index: number) {
    const nextChapter = chapters[index + 1]
    if (!nextChapter || !model || prewarming.current.has(nextChapter.id)) return
    prewarming.current.add(nextChapter.id)
    try {
      await synthesizeChapter(nextChapter, model)
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
      if (audioElement.current?.paused) await playAudioIndex(audioIndex, audio)
      else audioElement.current?.pause()
      return
    }
    await startChapter(chapterIndex)
    setPhase('当前章节已生成，再次点击播放')
  }

  async function moveChapter(delta: number) {
    const nextIndex = chapterIndex + delta
    if (nextIndex < 0 || nextIndex >= chapters.length) return
    await startChapter(nextIndex, playing)
  }

  async function changeRate(nextRate: number) {
    setRate(nextRate)
    if (audioElement.current) audioElement.current.playbackRate = nextRate
    await db.saveSettings({ ...(await db.getSettings()), playbackRate: nextRate })
  }

  function turnPage(direction: -1 | 1) {
    window.scrollBy({ top: direction * Math.round(window.innerHeight * 0.78), behavior: 'smooth' })
  }

  if (chapters.length === 0) return <div className="reader-page"><button className="text-button" onClick={onBack}>← 返回书架</button><div className="empty-state"><p>正在读取章节…</p></div></div>

  return <div className="reader-page">
    <div className="reader-header"><button className="text-button" onClick={onBack}>← 书架</button><span className="chip">{chapterIndex + 1} / {chapters.length}</span></div>
    <div className="reader-title"><div className="eyebrow accent">READING LOCALLY</div><h3>{book.title}</h3><select value={chapterIndex} onChange={(event) => void startChapter(Number(event.target.value))}>{chapters.map((item) => <option value={item.index} key={item.id}>{item.title}</option>)}</select></div>
    <div className="reader-page-nav"><button onClick={() => turnPage(-1)}>↑ 上一页</button><span>可滑动阅读</span><button onClick={() => turnPage(1)}>下一页 ↓</button></div>
    <article className="reader-text"><h4>{chapter?.title}</h4>{chapter?.text.split(/\n+/).filter(Boolean).map((paragraph, index) => <p key={`${chapter.id}-${index}`}>{paragraph}</p>)}</article>
    <div className="player-panel">
      <div className="player-status"><span className={playing ? 'pulse' : 'offline-dot'} />{phase}</div>
      <input className="seek" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(progress, duration || 0)} onChange={(event) => { const value = Number(event.target.value); setProgress(value); if (audioElement.current) audioElement.current.currentTime = value }} />
      <div className="time-row"><span>{formatTime(progress)}</span><span>{formatTime(duration)}</span></div>
      <div className="player-controls"><button onClick={() => void moveChapter(-1)} disabled={chapterIndex === 0}>上一章</button><button className="play-button" onClick={() => void handlePlay()} disabled={busy}>{playing ? '暂停' : busy ? '生成中…' : '播放'}</button><button onClick={() => void moveChapter(1)} disabled={chapterIndex === chapters.length - 1}>下一章</button></div>
      <div className="speed-row"><span>倍速</span>{[0.8, 1, 1.25, 1.5, 2].map((value) => <button className={rate === value ? 'selected' : ''} key={value} onClick={() => void changeRate(value)}>{value}x</button>)}</div>
      {!model && <small>还没有可用模型：先在线下载中文 Piper 模型，之后可以完全离线生成。</small>}
    </div>
    <audio ref={audioElement} preload="auto" />
  </div>
}

function formatTime(value: number): string {
  if (!Number.isFinite(value)) return '0:00'
  const seconds = Math.max(0, Math.floor(value))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
