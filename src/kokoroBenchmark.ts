const MODEL_ID = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX'
const MODEL_HOST = 'https://huggingface.co/'
const VOICE_PATH = `${MODEL_HOST}${MODEL_ID}/resolve/main/voices`

export const KOKORO_SAMPLE = '清晨的风从半开的窗户吹进来。她放下书，轻声问：“你真的决定今天出发吗？”他望向远处的山影，停了一会儿才回答：“是的，但我会在日落以前回来。”院子里很安静，只有树叶轻轻摇动。远处钟声响起，新的一天开始。'

export type KokoroVoice = 'zf_001' | 'zm_009'

export interface KokoroProgress {
  phase: string
  progress?: number
}

export interface KokoroBenchmarkResult {
  characters: number
  loadMs: number
  inferenceMs: number
  durationSec: number
  audioBytes: number
  audioUrl: string
}

let modelPromise: Promise<KokoroTTS> | undefined
let loadedAt = 0

interface KokoroAudio {
  data: Float32Array
  sampling_rate: number
  toBlob: () => Blob
}

interface KokoroTTS {
  generate: (text: string, options: { voice: KokoroVoice; speed: number }) => Promise<KokoroAudio>
}

function ensureReadableStreamAsyncIterator(): void {
  if (typeof ReadableStream === 'undefined') return
  const prototype = ReadableStream.prototype as unknown as Record<symbol, unknown>
  if (prototype[Symbol.asyncIterator]) return
  Object.defineProperty(prototype, Symbol.asyncIterator, {
    configurable: true,
    value: async function* (this: ReadableStream<Uint8Array>) {
      const reader = this.getReader()
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) return
          yield item.value
        }
      } finally {
        reader.releaseLock()
      }
    },
  })
}

async function createModel(baseUrl: string, onProgress?: (progress: KokoroProgress) => void): Promise<KokoroTTS> {
  ensureReadableStreamAsyncIterator()
  const [{ env: transformersEnv }, { KokoroTTS: Kokoro, env: kokoroEnv }] = await Promise.all([
    import('@huggingface/transformers'),
    import('@uzen/kokoro-js'),
  ])
  transformersEnv.remoteHost = MODEL_HOST
  transformersEnv.useBrowserCache = true
  transformersEnv.useWasmCache = true
  const wasm = transformersEnv.backends.onnx.wasm
  if (!wasm) throw new Error('当前浏览器没有可用的 ONNX WASM 后端')
  wasm.numThreads = 1
  wasm.proxy = false
  kokoroEnv.wasmPaths = {
    mjs: `${baseUrl}kokoro-ort/ort-wasm-simd-threaded.mjs`,
    wasm: `${baseUrl}kokoro-ort/ort-wasm-simd-threaded.wasm`,
  }
  return Kokoro.from_pretrained(MODEL_ID, {
    dtype: 'q8',
    device: 'wasm',
    voicePath: VOICE_PATH,
    progress_callback: (item) => {
      if (item.status === 'progress') {
        onProgress?.({ phase: `正在下载 ${item.file}`, progress: item.progress / 100 })
      } else if (item.status === 'done') {
        onProgress?.({ phase: `已缓存 ${item.file}`, progress: 1 })
      } else if (item.status === 'initiate') {
        onProgress?.({ phase: `准备 ${item.file}` })
      }
    },
  })
}

async function loadModel(baseUrl: string, onProgress?: (progress: KokoroProgress) => void): Promise<KokoroTTS> {
  if (!modelPromise) {
    const started = performance.now()
    modelPromise = createModel(baseUrl, onProgress).then((model) => {
      loadedAt = performance.now() - started
      return model
    }).catch((error) => {
      modelPromise = undefined
      throw error
    })
  } else {
    onProgress?.({ phase: '从本机缓存加载模型' })
  }
  return modelPromise
}

export async function runKokoroBenchmark(
  baseUrl: string,
  voice: KokoroVoice,
  onProgress?: (progress: KokoroProgress) => void,
): Promise<KokoroBenchmarkResult> {
  onProgress?.({ phase: '加载 Kokoro q8 模型', progress: 0 })
  const model = await loadModel(baseUrl, onProgress)
  onProgress?.({ phase: '正在生成 100 字试听', progress: undefined })
  const inferenceStarted = performance.now()
  const audio = await model.generate(KOKORO_SAMPLE, { voice, speed: 1 })
  const inferenceMs = performance.now() - inferenceStarted
  const blob = audio.toBlob()
  return {
    characters: KOKORO_SAMPLE.length,
    loadMs: loadedAt,
    inferenceMs,
    durationSec: audio.data.length / audio.sampling_rate,
    audioBytes: blob.size,
    audioUrl: URL.createObjectURL(blob),
  }
}
