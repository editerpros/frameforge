# FrameForge v1.3

FrameForge is a multi-track video editor for Windows and the web, built with React, TypeScript, Vite, Electron and FFmpeg.

## What's new in v1.3 — Rendering Engine

- **Full timeline export:** render the edit as one MP4 instead of exporting only the selected source clip.
- **Multi-layer video compositing:** visible video tracks are composited in their timeline stacking order, with clips placed at their actual timeline positions.
- **Mixed audio:** audio clips from all unmuted audio tracks are mixed at their timeline positions. Windows export also detects and mixes embedded audio from video files.
- **Rendered text:** titles and subtitles are burned into the output with their text, size, colour, background, alignment, timing and position. The renderer loads explicit font files, including a Malayalam-capable face for Malayalam overlays.
- **Rendered transitions:** fade, wipe and zoom clip transitions are applied by FFmpeg during export.
- **Rendered colour controls:** v1.2 presets, brightness, contrast and saturation are applied to the final render.
- **Output controls:** MP4 export at 720p, 1080p or 4K; 24, 30, 60 or 120 FPS; Draft, Balanced or High encoding quality.
- **Progress feedback:** desktop progress is reported by FFmpeg; browser builds use the FFmpeg WebAssembly progress events.
- **Project compatibility:** the existing `.ffproj` v2 format is retained, so v1.1 and v1.2 projects can still be opened.

## Requirements

- Node.js 20 or newer.
- FFmpeg with `libx264`, `drawtext`, `geq`, `overlay` and `amix` filters for Windows desktop export.
- FFprobe for detecting embedded audio in video sources.
- Standard Windows font files (`Arial`, and `Nirmala UI` for Malayalam titles) for desktop text rendering.

Install FFmpeg and add its `bin` directory to PATH so `ffmpeg.exe` and `ffprobe.exe` are available. Alternatively, set `FFMPEG_PATH` and `FFPROBE_PATH` to their executable paths.

## Run the web editor

```bash
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). Browser rendering uses FFmpeg WebAssembly and requires a modern browser with SharedArrayBuffer support. The first browser export that includes text downloads Noto Sans font files (and Noto Sans Malayalam when needed) from jsDelivr, so an internet connection is required for that first text render. The fonts are from the Noto project and are licensed under the SIL Open Font License 1.1. Large projects or 4K renders may exceed browser memory limits; use the Windows desktop build for larger projects.

## Run the Windows desktop editor

```bash
npm install
npm run dev:desktop
```

## Build

Web production build:

```bash
npm run build:web
```

Windows installer:

```bash
npm run build:desktop
```

The Windows installer is generated under `dist/` by electron-builder.

## Export workflow

1. Arrange clips across video and audio tracks.
2. Make sure the tracks you want rendered are visible and audio tracks are not muted.
3. Add titles/subtitles and set their timing in the Text lane.
4. Click **Export timeline**.
5. Choose resolution, frame rate and quality, then click **Start MP4 export**.

The export includes visible video clips, their colour settings and transitions, all active audio segments, and timed text overlays. Audio from video source files is detected and included in Windows desktop builds. In the browser build, embedded audio is probed through FFmpeg.wasm; audio-only files on audio tracks are also mixed.

## Known limitations

- Output is MP4/H.264 with AAC audio; other codecs and containers are not exposed in this release.
- Track compositing uses the current full-frame fit/pad model; crop/position/opacity keyframes and blend modes are not yet available.
- The browser renderer runs entirely in memory and can fail on large source files, long timelines, or high-resolution exports. The native desktop renderer is recommended for large projects.
- Hardware-accelerated export, proxy media, waveform caching, nested sequences and keyframe automation are not included yet.
- The preview remains a lightweight monitor; the final render is authoritative for complex overlaps and transitions.

## Project format

Projects remain `.ffproj` JSON documents with format `frameforge-project`, version `2`. Source media is embedded in the project, and timeline clips, tracks, text overlays and clip effects are preserved.

## Third-party font attribution

Browser text rendering downloads Noto Sans and Noto Sans Malayalam from the [Noto Fonts project](https://github.com/notofonts/noto-fonts). The Noto project states that its fonts are licensed under the SIL Open Font License; see the [Noto font usage and license guidance](https://notofonts.github.io/noto-docs/website/use/). FrameForge does not bundle or resell the font files.

## Validation notes for this source release

- The render-plan TypeScript module passes a strict standalone TypeScript compile.
- The React/TypeScript source files pass TypeScript syntax transpilation, and the Electron main/preload files pass Node syntax checks.
- A synthetic FFmpeg render was executed successfully with two overlapping video clips, three audio sources, clip speed/colour effects, fade/wipe/zoom transitions and a burned-in title. The resulting file was verified as H.264 video with AAC stereo audio.
- A complete Vite production build, Electron installer build and browser FFmpeg.wasm export were not verified in the packaging environment because npm dependencies were not installed there. Run `npm install` on your development machine before launching or building the app.
