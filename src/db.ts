import type { AppSettings, AudioCacheRecord, BookRecord, ChapterRecord, ModelBlobRecord, ModelRecord, StorageStats } from './types'

const DB_NAME = 'offline-audiobook'
const DB_VERSION = 2

type StoreName = 'books' | 'chapters' | 'models' | 'modelData' | 'audio' | 'settings'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('chapters')) {
        const store = db.createObjectStore('chapters', { keyPath: 'id' })
        store.createIndex('by-book', 'bookId')
      }
      if (!db.objectStoreNames.contains('models')) db.createObjectStore('models', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('modelData')) db.createObjectStore('modelData', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'))
  })
}

async function put<T>(storeName: StoreName, value: T): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(value)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to write ${storeName}`))
  })
  db.close()
}

async function getAll<T>(storeName: StoreName): Promise<T[]> {
  const db = await openDb()
  return new Promise<T[]>((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onsuccess = () => {
      db.close()
      resolve(request.result as T[])
    }
    request.onerror = () => {
      db.close()
      reject(request.error ?? new Error(`Failed to read ${storeName}`))
    }
  })
}

async function remove(storeName: StoreName, id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to delete ${id}`))
  })
  db.close()
}

export const db = {
  books: () => getAll<BookRecord>('books'),
  chapters: () => getAll<ChapterRecord>('chapters'),
  models: () => getAll<ModelRecord>('models'),
  audio: () => getAll<AudioCacheRecord>('audio'),
  saveBook: (book: BookRecord) => put('books', book),
  saveChapter: (chapter: ChapterRecord) => put('chapters', chapter),
  saveModel: (model: ModelRecord) => put('models', model),
  saveAudio: (audio: AudioCacheRecord) => put('audio', audio),
  modelData: () => getAll<ModelBlobRecord>('modelData'),
  deleteModel: async (id: string) => { await remove('models', id); await remove('modelData', id); await remove('modelData', `${id}:config`) },
  saveModelData: (data: ModelBlobRecord) => put('modelData', data),
  getBook: async (id: string) => (await getAll<BookRecord>('books')).find((book) => book.id === id),
  chaptersForBook: async (bookId: string) => (await getAll<ChapterRecord>('chapters')).filter((chapter) => chapter.bookId === bookId).sort((a, b) => a.index - b.index),
  audioForChapter: async (chapterId: string, modelId: string) => (await getAll<AudioCacheRecord>('audio'))
    .filter((audio) => audio.chapterId === chapterId && audio.modelId === modelId && !audio.id.endsWith(':weights'))
    .sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0)),
  deleteAudio: (id: string) => remove('audio', id),
  deleteAudioByIds: async (ids: string[]) => Promise.all(ids.map((id) => remove('audio', id))).then(() => undefined),
  getSettings: async (): Promise<AppSettings> => {
    const settings = await getAll<AppSettings>('settings')
    return settings[0] ?? { id: 'settings', playbackRate: 1 }
  },
  saveSettings: (settings: AppSettings) => put('settings', settings),
  stats: async (): Promise<StorageStats> => {
    const [books, chapters, models, audio] = await Promise.all([
      getAll<BookRecord>('books'), getAll<ChapterRecord>('chapters'), getAll<ModelRecord>('models'), getAll<AudioCacheRecord>('audio'),
    ])
    return {
      books: books.length,
      chapters: chapters.length,
      models: models.length,
      modelBytes: models.reduce((total, item) => total + item.bytes, 0),
      audioItems: audio.filter((item) => !item.id.endsWith(':weights')).length,
      audioBytes: audio.filter((item) => !item.id.endsWith(':weights')).reduce((total, item) => total + item.bytes, 0),
    }
  },
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
