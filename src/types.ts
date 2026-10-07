export type AppTab = 'benchmark' | 'import' | 'library' | 'storage'

export interface BookRecord {
  id: string
  title: string
  sourceName: string
  sourceSize: number
  chapterCount: number
  createdAt: number
  updatedAt: number
  currentChapter: number
  currentOffset: number
}

export interface ChapterRecord {
  id: string
  bookId: string
  index: number
  title: string
  text: string
  audioCacheId?: string
}

export interface ModelRecord {
  id: string
  name: string
  url: string
  configUrl?: string
  bytes: number
  downloadedAt: number
  sampleRate: number
}

export interface ModelBlobRecord {
  id: string
  modelId: string
  bytes: number
  blob: Blob
}

export interface AudioCacheRecord {
  id: string
  audioVersion?: number
  bookId?: string
  chapterId?: string
  modelId: string
  chunkIndex?: number
  text?: string
  bytes: number
  duration: number
  createdAt: number
  blob: Blob
}

export interface AppSettings {
  id: 'settings'
  playbackRate: number
  activeModelId?: string
  dialogueModelId?: string
  dialogueModelIds?: string[]
  autoDialogueVoice?: boolean
}

export interface StorageStats {
  books: number
  chapters: number
  models: number
  modelBytes: number
  audioBytes: number
  audioItems: number
}

export interface BenchmarkResult {
  characters: number
  loadMs?: number
  inferenceMs?: number
  durationSec?: number
  audioBytes?: number
  ok: boolean
  error?: string
}
