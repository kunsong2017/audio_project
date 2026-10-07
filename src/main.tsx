import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { configureOrt, downloadModel, runBenchmark } from './onnxBenchmark'
import { db, formatBytes } from './db'
import { parseTxt } from './txt'
import { parseEpub } from './epub'
import type { AppTab, BenchmarkResult, BookRecord, ModelRecord, StorageStats } from './types'
import { ReaderPage } from './reader'
import './styles.css'

configureOrt(import.meta.env.BASE_URL)
const APP_VERSION = 'v1.3.0'

const tabs: { id: AppTab; label: string; icon: string }[] = [
  { id: 'benchmark', label: 'Benchmark', icon: '◒' },
  { id: 'import', label: '导入书籍', icon: '＋' },
  { id: 'library', label: '书架', icon: '▤' },
  { id: 'storage', label: '存储', icon: '⌁' },
]

function bookFingerprint(chapters: { index: number; title: string; text: string }[]): string {
  if (chapters.length === 0) return ''
  const source = [...chapters]
    .sort((a, b) => a.index - b.index)
    .map((chapter) => `${chapter.title}\n${chapter.text}`.replace(/\s+/g, ''))
    .join('\u0001')
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${hash >>> 0}:${source.length}`
}

function deduplicateBooks(books: BookRecord[], chapters: { bookId: string; index: number; title: string; text: string }[]): BookRecord[] {
  const chaptersByBook = new Map<string, typeof chapters>()
  chapters.forEach((chapter) => {
    const items = chaptersByBook.get(chapter.bookId) ?? []
    items.push(chapter)
    chaptersByBook.set(chapter.bookId, items)
  })
  const seen = new Set<string>()
  return books
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((book) => {
      const fingerprint = bookFingerprint(chaptersByBook.get(book.id) ?? [])
      if (!fingerprint || seen.has(fingerprint)) return false
      seen.add(fingerprint)
      return true
    })
}

function CapabilityPill({ label, ok }: { label: string; ok: boolean }) {
  return <span className={`capability ${ok ? 'ok' : 'warn'}`}><i />{label}</span>
}

function App() {
  const [tab, setTab] = useState<AppTab>('benchmark')
  const [books, setBooks] = useState<BookRecord[]>([])
  const [models, setModels] = useState<ModelRecord[]>([])
  const [stats, setStats] = useState<StorageStats>()
  const [offlineReady, setOfflineReady] = useState(false)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [notice, setNotice] = useState('')
  const [readingBook, setReadingBook] = useState<BookRecord>()
  const [remoteVersion, setRemoteVersion] = useState('')
  const [updating, setUpdating] = useState(false)

  const refresh = async () => {
    const [nextBooks, nextModels, nextStats, nextChapters] = await Promise.all([db.books(), db.models(), db.stats(), db.chapters()])
    setBooks(deduplicateBooks(nextBooks, nextChapters))
    setModels(nextModels.sort((a, b) => b.downloadedAt - a.downloadedAt))
    setStats(nextStats)
  }

  useEffect(() => {
    void refresh()
    const online = () => setIsOnline(true)
    const offline = () => setIsOnline(false)
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline) }
  }, [])

  const pwa = useRegisterSW({ immediate: true, onOfflineReady: () => setOfflineReady(true) })
  useEffect(() => { if (pwa.offlineReady[0]) setOfflineReady(true) }, [pwa.offlineReady])
  useEffect(() => {
    void fetch(`${import.meta.env.BASE_URL}version.json?check=${Date.now()}`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() as Promise<{ version?: string }> : undefined)
      .then((data) => { if (data?.version) setRemoteVersion(data.version) })
      .catch(() => undefined)
  }, [])
  const updateAvailable = pwa.needRefresh[0] || Boolean(remoteVersion && remoteVersion !== APP_VERSION)
  const updateNow = async () => {
    if (updating) return
    setUpdating(true)
    try {
      const registration = await navigator.serviceWorker?.getRegistration(import.meta.env.BASE_URL)
      if (registration) {
        await registration.update()
        const installing = registration.installing
        if (installing) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              if (installing.state === 'installed' || installing.state === 'activated' || installing.state === 'redundant') {
                installing.removeEventListener('statechange', finish)
                resolve()
              }
            }
            installing.addEventListener('statechange', finish)
            finish()
          })
        }
        registration.waiting?.postMessage({ type: 'SKIP_WAITING' })
      } else {
        await pwa.updateServiceWorker(true)
      }
    } catch {
      // A normal reload is still useful when Safari has already activated the new worker.
    } finally {
      window.location.reload()
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">◖</div>
        <div><div className="eyebrow">OFFLINE FIRST / V1</div><h1>听书 <small className="app-version">{APP_VERSION}</small></h1></div>
        <div className="connection"><span className={isOnline ? 'live-dot' : 'offline-dot'} />{isOnline ? '在线' : '离线'}</div>
      </header>
      {updateAvailable && <button className="update-banner" disabled={updating} onClick={() => void updateNow()}>{updating ? '正在更新…' : `发现新版本 ${remoteVersion || ''}，点击立即更新`}</button>}
      <main>
        <section className="hero">
          <div>
            <div className="eyebrow accent">LOCAL AUDIOBOOK LAB</div>
            <h2>先让本地声音<br /><em>跑起来。</em></h2>
            <p>小说、模型、音频都留在这台 iPhone。第一阶段只关心浏览器能力和 TTS 性能。</p>
          </div>
          <div className="hero-orbit"><span /><span /><span /></div>
        </section>
        <section className="status-card">
          <div className="status-title"><span className="pulse" />PWA 状态</div>
          <div className="capabilities">
            <CapabilityPill label={offlineReady ? '离线缓存就绪' : '等待离线缓存'} ok={offlineReady} />
            <CapabilityPill label="IndexedDB" ok={'indexedDB' in window} />
            <CapabilityPill label="WASM" ok={typeof WebAssembly !== 'undefined'} />
            <CapabilityPill label="Media Session" ok={'mediaSession' in navigator} />
          </div>
          {!offlineReady && <small>首次打开需要在线完成静态资源缓存；之后可从主屏幕离线启动。</small>}
        </section>
        <div className="page-content">
          {tab === 'benchmark' && <BenchmarkPage models={models} onChanged={refresh} onNotice={setNotice} />}
          {tab === 'import' && <ImportPage onImported={async (format, duplicate, title) => { await refresh(); setTab('library'); setNotice(duplicate ? `《${title}》已在书架中，跳过重复导入。` : `${format} 已保存在本机，原始文件仍在 Files 中。`) }} onNotice={setNotice} />}
          {readingBook ? <ReaderPage book={readingBook} models={models} onBack={() => { setReadingBook(undefined); void refresh() }} onChanged={refresh} onNotice={setNotice} /> : tab === 'library' && <LibraryPage books={books} onOpen={(book) => setReadingBook(book)} />}
          {tab === 'storage' && <StoragePage stats={stats} models={models} onChanged={refresh} />}
        </div>
      </main>
      {notice && <button className="toast" onClick={() => setNotice('')}>{notice}</button>}
      <nav className="bottom-nav" aria-label="主导航">
        {tabs.map((item) => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><span>{item.icon}</span>{item.label}</button>)}
      </nav>
    </div>
  )
}

function BenchmarkPage({ models, onChanged, onNotice }: { models: ModelRecord[]; onChanged: () => Promise<void>; onNotice: (value: string) => void }) {
  const [url, setUrl] = useState('https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx?download=true')
  const [selectedId, setSelectedId] = useState('')
  const [phase, setPhase] = useState('准备就绪')
  const [downloadProgress, setDownloadProgress] = useState<number>()
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [busy, setBusy] = useState(false)
  const selected = models.find((model) => model.id === selectedId) ?? models[0]
  const samples = useMemo(() => [100, 500, 1000], [])

  const handleDownload = async () => {
    if (!url.trim()) { onNotice('请先填入可直接下载的 .onnx 模型 URL。'); return }
    setBusy(true); setResults([]); setPhase('准备下载'); setDownloadProgress(0)
    try {
      const model = await downloadModel(url.trim(), ({ phase, progress }) => { setPhase(phase); setDownloadProgress(progress) })
      setSelectedId(model.id); await onChanged(); setPhase('模型已缓存，可离线加载')
      onNotice('模型已写入 IndexedDB；断网后仍可加载。')
    } catch (error) { setPhase('下载失败'); onNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const handleRun = async () => {
    if (!selected) { onNotice('请先下载一个 ONNX 模型。'); return }
    setBusy(true); setResults([]); setPhase('开始 WASM 推理')
    try { setResults(await runBenchmark(selected, samples, ({ phase, progress }) => { setPhase(phase); setDownloadProgress(progress) })); setPhase('Benchmark 完成') }
    catch (error) { setPhase('推理失败'); onNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  return <>
    <div className="section-heading"><div><div className="eyebrow accent">PHASE 01 / BENCHMARK</div><h3>浏览器 TTS 体检</h3></div><span className="chip">WASM ONLY</span></div>
    <p className="muted">先测真实 iPhone Safari 的模型加载和推理，再决定模型、分块大小与播放器策略。所有计时均在当前设备本地完成。</p>
    <div className="panel model-panel">
      <label className="field-label">ONNX 模型直链 <span>不会上传小说</span></label>
      <div className="input-row"><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://.../tts-model.onnx" inputMode="url" /><button disabled={busy} onClick={() => void handleDownload()}>{busy && downloadProgress !== undefined ? `${Math.round(downloadProgress * 100)}%` : '下载并缓存'}</button></div>
      <small>建议使用预填的 medium 中文模型，声调和停顿比 x_low 更自然。下载时会同时缓存 .onnx.json 配置；模型、配置和音素 WASM 齐全后，断网也能在书架中阅读和听书。</small>
      {models.length > 0 && <div className="cached-models"><span className="field-label">本机模型</span>{models.map((model) => <button key={model.id} className={`model-item ${selected?.id === model.id ? 'selected' : ''}`} onClick={() => setSelectedId(model.id)}><span>{model.name}</span><small>{formatBytes(model.bytes)} · 可离线</small></button>)}</div>}
    </div>
    <div className="benchmark-action"><div><span className="eyebrow">TEST TEXT</span><strong>100 / 500 / 1000 字</strong></div><button className="primary-button" disabled={busy || !selected} onClick={() => void handleRun()}>{busy ? phase : '运行本地 benchmark'} <span>→</span></button></div>
    {(phase !== '准备就绪' || results.length > 0) && <div className="panel result-panel"><div className="result-head"><span className="field-label">运行状态</span><strong>{phase}</strong></div>{results.length > 0 ? <div className="result-grid">{results.map((result) => <div className={`result-card ${result.ok ? 'success' : 'failure'}`} key={result.characters}><div className="result-number">{result.characters}<small>字</small></div><div className="result-values"><span>推理 <b>{result.inferenceMs?.toFixed(0) ?? '—'} ms</b></span><span>音频 <b>{result.durationSec?.toFixed(2) ?? '—'} s</b></span></div><small>{result.ok ? 'WASM 输出可识别' : result.error}</small></div>)}</div> : <div className="progress-line"><span style={{ width: `${Math.round((downloadProgress ?? 0) * 100)}%` }} /></div>}</div>}
    <div className="callout"><span>i</span><p>验收建议：在 iPhone Safari 中添加到主屏幕后，先在线下载模型并运行一次；打开飞行模式，重新启动 PWA，再运行相同 benchmark。离线成功才算模型链路成立。</p></div>
  </>
}

function ImportPage({ onImported, onNotice }: { onImported: (format: string, duplicate: boolean, title: string) => Promise<void>; onNotice: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [fileName, setFileName] = useState('')
  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setBusy(true); setFileName(file.name)
    try {
      const isEpub = /\.epub$/i.test(file.name)
      const parsed = isEpub
        ? await parseEpub(file)
        : parseTxt(file.name.replace(/\.txt$/i, ''), file.name, file.size, await file.text())
      const [existingBooks, existingChapters] = await Promise.all([db.books(), db.chapters()])
      const parsedFingerprint = bookFingerprint(parsed.chapters)
      const duplicate = existingBooks
        .map((book) => ({ book, chapters: existingChapters.filter((chapter) => chapter.bookId === book.id) }))
        .find((item) => bookFingerprint(item.chapters) === parsedFingerprint)
      if (duplicate) {
        await onImported(isEpub ? 'EPUB' : 'TXT', true, duplicate.book.title)
        return
      }
      await db.saveBook(parsed.book)
      await Promise.all(parsed.chapters.map((chapter) => db.saveChapter(chapter)))
      await onImported(isEpub ? 'EPUB' : 'TXT', false, parsed.book.title)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false); event.target.value = '' }
  }
  return <><div className="section-heading"><div><div className="eyebrow accent">LOCAL SOURCE</div><h3>从 Files 导入 TXT / EPUB</h3></div></div><div className="panel import-panel"><div className="drop-icon">TXT<br />EPUB</div><h4>{busy ? '正在解析章节…' : '选择一本本地小说'}</h4><p>TXT 和 EPUB 都只在浏览器内读取，解析后的章节写入本机 IndexedDB，不会上传服务器。</p><label className="primary-button file-button">{fileName || '选择 .txt 或 .epub 文件'}<input type="file" accept=".txt,text/plain,.epub,application/epub+zip" onChange={(event) => void onFile(event)} disabled={busy} /></label><small>原始 TXT/EPUB 仍是用户数据源。请保留 Files 中的原文件，PWA 缓存不作为唯一备份。</small></div></>
}

function LibraryPage({ books, onOpen }: { books: BookRecord[]; onOpen: (book: BookRecord) => void }) {
  return <><div className="section-heading"><div><div className="eyebrow accent">YOUR SHELF</div><h3>书架</h3></div><span className="chip">{books.length} 本</span></div>{books.length === 0 ? <div className="empty-state"><span>▤</span><p>还没有书。先从本地 Files 导入一本 TXT。</p></div> : <div className="book-list">{books.map((book) => <article className="book-card" key={book.id} onClick={() => onOpen(book)}><div className="book-cover">{book.title.slice(0, 1)}</div><div><h4>{book.title}</h4><p>{book.chapterCount} 章 · {book.sourceName}</p><small>进度：第 {book.currentChapter + 1} 章</small></div><button aria-label="打开书籍" onClick={(event) => { event.stopPropagation(); onOpen(book) }}>→</button></article>)}</div>}</>
}

function StoragePage({ stats, models, onChanged }: { stats?: StorageStats; models: ModelRecord[]; onChanged: () => Promise<void> }) {
  const clearAudio = async () => { const ids = (await db.audio()).map((item) => item.id); await db.deleteAudioByIds(ids); await onChanged() }
  return <><div className="section-heading"><div><div className="eyebrow accent">LOCAL STORAGE</div><h3>存储管理</h3></div></div><div className="storage-grid"><div><strong>{formatBytes((stats?.modelBytes ?? 0) + (stats?.audioBytes ?? 0))}</strong><span>总计（模型 + 音频）</span></div><div><strong>{formatBytes(stats?.modelBytes ?? 0)}</strong><span>{stats?.models ?? 0} 个模型</span></div><div><strong>{formatBytes(stats?.audioBytes ?? 0)}</strong><span>{stats?.audioItems ?? 0} 段音频缓存</span></div></div><div className="panel storage-panel"><div className="result-head"><span className="field-label">缓存策略</span><span className="chip">本机存储</span></div><p>模型和生成音频只存手机 IndexedDB。清理音频不会删除小说章节；删除模型后需要重新联网下载。</p><button className="danger-button" onClick={() => void clearAudio()}>清理音频缓存</button>{models.map((model) => <div className="storage-row" key={model.id}><span>{model.name}</span><small>{formatBytes(model.bytes)} · {new Date(model.downloadedAt).toLocaleDateString()}</small></div>)}</div></>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
