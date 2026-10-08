import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const base = process.env.BASE_PATH ?? '/audio_project/'

export default defineConfig({
  base,
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', dest: 'ort' },
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', dest: 'ort' },
        { src: 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', dest: 'kokoro-ort' },
        { src: 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', dest: 'kokoro-ort' },
        { src: 'node_modules/@mintplex-labs/piper-tts-web/dist/piper-o91UDS6e.js', dest: 'piper' },
        // Keep the Emscripten glue, WASM binary, and preloaded data from the
        // exact pair declared by @mintplex-labs/piper-tts-web.
        { src: 'node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.data', dest: 'piper' },
        { src: 'node_modules/@diffusionstudio/piper-wasm/build/piper_phonemize.wasm', dest: 'piper' },
      ],
    }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: '听书 · Offline First',
        short_name: '听书',
        description: '本地 TXT、浏览器本地 TTS、离线播放',
        start_url: base,
        scope: base,
        display: 'standalone',
        background_color: '#0c1018',
        theme_color: '#0c1018',
        lang: 'zh-CN',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,wasm,webmanifest,data}'],
        globIgnores: ['assets/ort-*.wasm'],
        maximumFileSizeToCacheInBytes: 24 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
      devOptions: { enabled: true },
    }),
  ],
})
