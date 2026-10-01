# 听书 · Offline First

面向 iPhone Safari 的本地听书 PWA。小说 TXT、ONNX 模型和生成音频都留在设备本地；当前仓库处于 V1 的 Phase 01，优先验证离线启动和 TTS WASM benchmark。

## 本地运行

```bash
npm install
npm run dev
npm run lint
npm run build
```

生产构建默认使用 `/audio_project/` 作为 GitHub Pages base path，可用 `BASE_PATH=/custom-path/ npm run build` 覆盖。

## 当前已实现

- Vite + React + TypeScript + `vite-plugin-pwa`，包含 manifest、service worker 和 GitHub Pages Actions。
- IndexedDB 保存书籍、章节、模型元数据、音频缓存和播放设置的基础结构。
- 从 Files 读取 TXT，在浏览器本地识别 `第 xxx 章/节/回`、序章、楔子、番外等标题。
- ONNX Runtime Web 的 WASM-only benchmark：模型在线下载后写入 IndexedDB，之后从本地模型缓存加载。
- 100 / 500 / 1000 字测试、模型加载时间、推理时间、音频输出时长和失败信息。
- 存储管理基础页和音频缓存清理入口。

## iPhone 验证顺序

1. 部署到 HTTPS 的 GitHub Pages，用 Safari 打开并通过“添加到主屏幕”安装。
2. 在线打开一次，确认“离线缓存就绪”，再开启飞行模式，从主屏幕重新打开。
3. 在线下载一个允许 CORS 的 ONNX TTS 模型并运行 benchmark。
4. 开启飞行模式，重新打开 PWA，再运行相同 benchmark；这一步成功才算模型链路离线成立。

当前 benchmark 使用通用 Tensor 输入探测，不替代中文 TTS 的 tokenizer / 声学模型 profile。真实模型接入前需明确输入名称、tokenizer、声码器输出和采样率；不兼容时页面会记录失败，不会把失败伪装成可播放音频。

原始 TXT 始终应保留在 iPhone Files 中，PWA 内的章节数据和缓存不作为唯一备份。

## 开发顺序

PWA 骨架 → iPhone 离线验证 → TXT 导入 → TTS benchmark → 真机性能验证 → 播放器 → 书架增强。未通过真机 benchmark 前，不投入大规模阅读器 UI。
