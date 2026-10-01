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
        globPatterns: ['**/*.{js,css,html,svg,wasm,webmanifest}'],
        globIgnores: ['assets/ort-*.wasm'],
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
      devOptions: { enabled: true },
    }),
  ],
})
