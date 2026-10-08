import * as ort from 'onnxruntime-web/wasm'
import { db } from './db'
import type { BenchmarkResult, ModelRecord } from './types'

export const DEFAULT_SAMPLE_RATE = 22050

export interface BenchmarkProgress {
  phase: string
  progress?: number
}

function modelId(url: string): string {
  return `model-${crypto.subtle ? btoa(url).replace(/[^a-z0-9]/gi, '').slice(-24) : url.length}`
}

export function configureOrt(baseUrl: string): void {
  ort.env.wasm.wasmPaths = `${baseUrl}ort/`
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = true
}

export async function downloadModel(url: string, onProgress?: (progress: BenchmarkProgress) => void): Promise<ModelRecord> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`模型下载失败：HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  if (reader) {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      chunks.push(part.value)
      received += part.value.byteLength
      onProgress?.({ phase: '下载模型', progress: total ? received / total : undefined })
    }
  } else {
    chunks.push(new Uint8Array(await response.arrayBuffer()))
    received = chunks[0].byteLength
  }
  const buffer = new Uint8Array(received)
  let offset = 0
  chunks.forEach((chunk) => { buffer.set(chunk, offset); offset += chunk.byteLength })
  const record: ModelRecord = {
    id: modelId(url), name: url.split('/').pop()?.split('?')[0] || 'custom-model.onnx', url,
    bytes: buffer.byteLength, downloadedAt: Date.now(), sampleRate: DEFAULT_SAMPLE_RATE,
  }
  const configUrl = url.replace(/\.onnx(\?.*)?$/i, '.onnx.json$1')
  const configResponse = await fetch(configUrl, { cache: 'no-store' })
  if (!configResponse.ok) throw new Error(`模型配置下载失败：HTTP ${configResponse.status}（需要与 .onnx 同目录的 .onnx.json）`)
  const configBuffer = await configResponse.arrayBuffer()
  record.configUrl = configUrl
  await db.saveModel(record)
  await db.saveModelData({
    id: record.id, modelId: record.id, bytes: buffer.byteLength,
    blob: new Blob([buffer], { type: 'application/octet-stream' }),
  })
  await db.saveModelData({
    id: `${record.id}:config`, modelId: record.id, bytes: configBuffer.byteLength,
    blob: new Blob([configBuffer], { type: 'application/json' }),
  })
  return record
}

async function loadCachedModel(model: ModelRecord): Promise<ArrayBuffer> {
  const cached = (await db.modelData()).find((item) => item.id === model.id)
  if (!cached) throw new Error('本地没有该模型，请联网下载一次。')
  return cached.blob.arrayBuffer()
}

function testText(length: number): string {
  const seed = '夜色落在窗棂上，远处的风穿过安静的街道，故事从这一刻开始。'
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length)
}

function concreteDims(dims: readonly (number | string)[] | undefined, length: number): number[] {
  return (dims ?? [1, length]).map((dim, index) => typeof dim === 'number' && dim > 0 ? dim : index === 0 ? 1 : length)
}

function inputForType(type: string, dims: number[], text: string): ort.Tensor {
  const size = dims.reduce((a, b) => a * b, 1)
  if (type === 'int64') {
    const values = new BigInt64Array(size)
    for (let i = 0; i < size; i += 1) values[i] = BigInt(text.charCodeAt(i % text.length))
    return new ort.Tensor('int64', values, dims)
  }
  if (type === 'int32') {
    const values = new Int32Array(size)
    for (let i = 0; i < size; i += 1) values[i] = text.charCodeAt(i % text.length)
    return new ort.Tensor('int32', values, dims)
  }
  const values = new Float32Array(size)
  return new ort.Tensor('float32', values, dims)
}

function audioFromOutputs(outputs: Record<string, ort.Tensor>): Float32Array | undefined {
  for (const output of Object.values(outputs)) {
    if (output.type === 'float32' || output.type === 'float64') {
      const values = output.data as Float32Array | Float64Array
      if (values.length > 100) return Float32Array.from(values)
    }
  }
  return undefined
}

export async function runBenchmark(model: ModelRecord, characterCounts: number[], onProgress?: (progress: BenchmarkProgress) => void): Promise<BenchmarkResult[]> {
  const started = performance.now()
  const buffer = await loadCachedModel(model)
  onProgress?.({ phase: '加载 ONNX Runtime WASM' })
  const session = await ort.InferenceSession.create(buffer, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  const loadMs = performance.now() - started
  const results: BenchmarkResult[] = []
  for (const characters of characterCounts) {
    const text = testText(characters)
    const inputs: Record<string, ort.Tensor> = {}
    for (const [inputIndex, name] of session.inputNames.entries()) {
      const metadata = session.inputMetadata[inputIndex]
      if (!metadata.isTensor) throw new Error(`输入 ${name} 不是 Tensor，当前 benchmark 需要模型 profile`) 
      inputs[name] = inputForType(metadata.type, concreteDims(metadata.shape, characters), text)
    }
    const inferenceStarted = performance.now()
    try {
      const outputs = await session.run(inputs)
      const inferenceMs = performance.now() - inferenceStarted
      const audio = audioFromOutputs(outputs)
      const durationSec = audio ? audio.length / model.sampleRate : undefined
      results.push({ characters, loadMs, inferenceMs, durationSec, audioBytes: audio?.byteLength, ok: Boolean(audio), error: audio ? undefined : '推理成功，但没有识别到浮点音频输出' })
    } catch (error) {
      results.push({ characters, loadMs, inferenceMs: performance.now() - inferenceStarted, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    onProgress?.({ phase: `完成 ${characters} 字`, progress: results.length / characterCounts.length })
  }
  return results
}
