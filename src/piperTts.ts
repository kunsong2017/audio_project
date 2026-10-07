import * as ort from 'onnxruntime-web/wasm'
import { db } from './db'
import type { AudioCacheRecord, ChapterRecord, ModelRecord } from './types'

interface PiperConfig {
  audio: { sample_rate: number }
  espeak: { voice: string }
  inference: { noise_scale: number; length_scale: number; noise_w: number }
  speaker_id_map?: Record<string, number>
}

interface PhonemizeModule {
  callMain: (args: string[]) => void
}

type PhonemizeFactory = (options: {
  print: (data: string) => void
  printErr: (data: string) => void
  locateFile: (url: string) => string
}) => Promise<PhonemizeModule>

export interface TtsProgress {
  phase: string
  chunkIndex: number
  totalChunks: number
}

const PIPER_BASE = `${import.meta.env.BASE_URL}piper/`
const MAX_CHUNK_LENGTH = 400
let phonemizeFactoryPromise: Promise<PhonemizeFactory> | undefined
let sessionCache: { modelId: string; session: ort.InferenceSession } | undefined

function splitIntoChunks(text: string, maxLength = MAX_CHUNK_LENGTH): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= maxLength) return [trimmed]
  const sentences = trimmed.match(/[^。！？!?…\n]+[。！？!?…\n]*/g) ?? [trimmed]
  const chunks: string[] = []
  let current = ''
  const push = () => {
    const value = current.trim()
    if (value) chunks.push(value)
    current = ''
  }
  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength && current) push()
    if (sentence.length <= maxLength) current += sentence
    else {
      for (let index = 0; index < sentence.length; index += maxLength) {
        const part = sentence.slice(index, index + maxLength)
        if (part.length === maxLength) chunks.push(part)
        else current += part
      }
    }
  }
  push()
  return chunks
}

async function loadConfig(model: ModelRecord): Promise<PiperConfig> {
  const record = (await db.modelData()).find((item) => item.id === `${model.id}:config`)
  if (record) return JSON.parse(await record.blob.text()) as PiperConfig

  if (!navigator.onLine) throw new Error('旧模型缺少 Piper 配置。请联网打开一次书籍，自动补齐配置后即可离线使用。')
  const configUrl = model.configUrl ?? model.url.replace(/\.onnx(\?.*)?$/i, '.onnx.json$1')
  const response = await fetch(configUrl, { cache: 'no-store' })
  if (!response.ok) throw new Error(`旧模型配置自动修复失败：HTTP ${response.status}。请确认模型地址旁边存在 .onnx.json。`)
  const configText = await response.text()
  let config: PiperConfig
  try {
    config = JSON.parse(configText) as PiperConfig
  } catch {
    throw new Error('旧模型配置自动修复失败：.onnx.json 不是有效 JSON。')
  }
  if (!config.audio?.sample_rate || !config.espeak?.voice || !config.inference) throw new Error('旧模型配置自动修复失败：Piper 配置字段不完整。')
  await db.saveModelData({
    id: `${model.id}:config`,
    modelId: model.id,
    bytes: new Blob([configText]).size,
    blob: new Blob([configText], { type: 'application/json' }),
  })
  await db.saveModel({ ...model, configUrl })
  return config
}

async function loadSession(model: ModelRecord): Promise<ort.InferenceSession> {
  if (sessionCache?.modelId === model.id) return sessionCache.session
  const record = (await db.modelData()).find((item) => item.id === model.id)
  if (!record) throw new Error('本地没有该模型，请先在线下载一次。')
  configureOrt()
  let session: ort.InferenceSession
  try {
    session = await ort.InferenceSession.create(await record.blob.arrayBuffer(), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
  } catch (error) {
    throw new Error(`ONNX 模型加载失败：${error instanceof Error ? error.message : String(error)}。请保持联网并刷新 PWA 后重试。`)
  }
  sessionCache = { modelId: model.id, session }
  return session
}

function configureOrt(): void {
  ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
}

async function loadPhonemizeFactory(): Promise<PhonemizeFactory> {
  phonemizeFactoryPromise ??= import(/* @vite-ignore */ `${PIPER_BASE}piper-o91UDS6e.js`)
    .then((module) => module.createPiperPhonemize as PhonemizeFactory)
    .catch((error) => {
      phonemizeFactoryPromise = undefined
      throw new Error(`中文音素引擎加载失败：${error instanceof Error ? error.message : String(error)}。请在线刷新一次页面。`)
    })
  return phonemizeFactoryPromise
}

async function phonemize(text: string, config: PiperConfig): Promise<number[]> {
  const factory = await loadPhonemizeFactory()
  return new Promise<number[]>((resolve, reject) => {
    let settled = false
    void factory({
      print: (data) => {
        if (settled) return
        try {
          const parsed = JSON.parse(data) as { phoneme_ids?: number[] }
          if (!parsed.phoneme_ids) throw new Error('Piper 音素解析没有返回 phoneme_ids')
          settled = true
          resolve(parsed.phoneme_ids)
        } catch (error) {
          settled = true
          reject(error)
        }
      },
      printErr: (data) => {
        if (!settled) {
          settled = true
          reject(new Error(`中文音素解析失败：${data}`))
        }
      },
      locateFile: (url) => {
        if (url.endsWith('.wasm')) return `${PIPER_BASE}piper_phonemize.wasm`
        if (url.endsWith('.data')) return `${PIPER_BASE}piper_phonemize.data`
        return url
      },
    }).then((module) => {
      if (settled) return
      try {
        module.callMain(['-l', config.espeak.voice, '--input', JSON.stringify([{ text: text.trim() }]), '--espeak_data', '/espeak-ng-data'])
      } catch (error) {
        settled = true
        reject(error)
      }
    }).catch((error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

async function synthesizeChunk(text: string, model: ModelRecord, config: PiperConfig): Promise<Blob> {
  const session = await loadSession(model)
  const phonemeIds = await phonemize(text, config)
  const inputIds = BigInt64Array.from(phonemeIds, (value) => BigInt(value))
  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor('int64', inputIds, [1, phonemeIds.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(phonemeIds.length)])),
    scales: new ort.Tensor('float32', Float32Array.from([
      config.inference.noise_scale,
      config.inference.length_scale,
      config.inference.noise_w,
    ])),
  }
  if (Object.keys(config.speaker_id_map ?? {}).length > 0) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]))
  const outputs = await session.run(feeds)
  const output = outputs.output?.data
  if (!output || !(output instanceof Float32Array || output instanceof Float64Array)) throw new Error('Piper 推理没有返回音频输出')
  return pcmToWav(Float32Array.from(output), config.audio.sample_rate)
}

function pcmToWav(pcm: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  view.setUint32(0, 0x52494646, false)
  view.setUint32(4, buffer.byteLength - 8, true)
  view.setUint32(8, 0x57415645, false)
  view.setUint32(12, 0x666d7420, false)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  view.setUint32(36, 0x64617461, false)
  view.setUint32(40, pcm.length * 2, true)
  for (let index = 0; index < pcm.length; index += 1) {
    const value = Math.max(-1, Math.min(1, pcm[index]))
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export async function synthesizeChapter(
  chapter: ChapterRecord,
  model: ModelRecord,
  onProgress?: (progress: TtsProgress) => void,
): Promise<AudioCacheRecord[]> {
  const chunks = splitIntoChunks(chapter.text)
  const output: AudioCacheRecord[] = []
  for (let index = 0; index < chunks.length; index += 1) {
    const audio = await synthesizeChapterChunk(chapter, model, index, onProgress)
    if (audio) output.push(audio)
  }
  return output
}

export async function synthesizeChapterChunk(
  chapter: ChapterRecord,
  model: ModelRecord,
  index: number,
  onProgress?: (progress: TtsProgress) => void,
): Promise<AudioCacheRecord | undefined> {
  const chunks = splitIntoChunks(chapter.text)
  if (!chunks[index]) return undefined
  const existing = (await db.audioForChapter(chapter.id, model.id)).find((item) => item.chunkIndex === index)
  if (existing) {
    onProgress?.({ phase: '读取本地音频', chunkIndex: index + 1, totalChunks: chunks.length })
    return existing
  }
  onProgress?.({ phase: '本地生成音频', chunkIndex: index + 1, totalChunks: chunks.length })
  const config = await loadConfig(model)
  const blob = await synthesizeChunk(chunks[index], model, config)
  const audio: AudioCacheRecord = {
    id: `${chapter.id}:${model.id}:${index}`,
    bookId: chapter.bookId,
    chapterId: chapter.id,
    modelId: model.id,
    chunkIndex: index,
    text: chunks[index],
    bytes: blob.size,
    duration: blob.size > 44 ? (blob.size - 44) / (config.audio.sample_rate * 2) : 0,
    createdAt: Date.now(),
    blob,
  }
  await db.saveAudio(audio)
  return audio
}

export { splitIntoChunks }
