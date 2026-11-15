# FrameForge v1.6.0

FrameForge is a multi-track video editor for Windows and the web, built with React, TypeScript, Vite, Electron and FFmpeg.

## What's new in v1.6 — AI & Advanced Video Tools

- **Speed ramps:** apply Normal, Slow Motion, Speed Ramp and Montage presets, then edit the rate of each source-time segment. Playback preview and full-timeline FFmpeg export retime video and audio together.
- **Advanced masks:** centered rectangle or ellipse masks with adjustable width, height and feathered edges. Masks are rendered into the final video alpha channel.
- **Audio visualizer:** generate a line, dot or mirrored waveform from an audio clip and composite it at a chosen vertical position, height and colour during export.
- **Subtitle workflow:** import `.srt` and `.vtt`, edit subtitle cues in the text lane, and export them back to `.srt`.
- **Local speech-to-text:** the Windows desktop build can call the locally installed OpenAI Whisper CLI (`tiny`, `base` or `small`) to generate captions in English, Malayalam, Hindi or Tamil. No FrameForge cloud account or upload is involved. The Whisper Python package and FFmpeg must be installed separately; the first model run may download model weights.
- **Colour-based motion tracker:** sample a distinctive colour from the preview, scan the selected source clip and create X/Y position keyframes from the detected colour centroid. This is a lightweight colour tracker, not a neural object-tracking model; inspect and adjust the generated keyframes when the target is occluded or similar colours are present.
- **Project format v5:** visualizer settings and all v1.6 clip controls are saved; v1–v5 project files are supported.

## What's new in v1.5 — Audio Studio & Compositing

- **Audio mixer:** per-clip volume up to 200%, stereo pan, fade-in and fade-out.
- **3-band EQ:** independent low (100 Hz), mid (1 kHz) and high (8 kHz) gain from -12 dB to +12 dB.
- **Noise reduction:** FFmpeg `afftdn` processing with adjustable strength. Strong settings can affect voice quality.
- **Dynamics:** per-clip audio compression with adjustable intensity.
- **Chroma key:** configurable key colour, similarity and edge blend, rendered to alpha and composited in the final export.
- **Blend modes:** Normal, Screen, Multiply, Overlay, Add, Darken, Lighten and Soft Light on video layers.
- **Motion path helper:** add paired X/Y keyframe points at the playhead to manually trace an object's movement. Automatic AI/object detection is not included.
- **Project format v4:** new per-clip audio, keying and compositing controls are saved; v1–v3 projects remain supported.
- **Preview:** audio fades are reflected in playback; pan, EQ, noise reduction, compression, chroma key and multi-layer blend compositing are applied in export. Chroma key is not shown in the live preview yet.

## What's new in v1.4.5 — Startup Experience

- **Animated splash screen:** branded FrameForge startup screen with an animated loading indicator.
- **Project manager home screen:** choose New Project or Open Project before entering the editor.
- **Recent projects:** remembers project names, last-opened dates and media counts in browser local storage. Selecting a recent item opens the project picker so you can locate its `.ffproj` file.
- **Return Home:** a Home button in the editor returns to the project manager without closing the app.
- **Cross-platform:** the same startup experience works in Electron on Windows and in supported web browsers.
- **Project compatibility:** existing v1.1–v1.4 `.ffproj` projects remain supported.

## What's new in v1.4 — Professional Editing Tools

- **Transform controls:** crop top/right/bottom/left, scale, rotation, horizontal/vertical position and opacity, with live preview and full-timeline rendering.
- **Keyframe animation:** animate position, scale, rotation and opacity with clip-local keyframes and Linear, Ease In, Ease Out or Ease In/Out interpolation. The same keyframe curves are evaluated in preview and encoded in FFmpeg export.
- **Audio waveforms:** audio files are analysed at import and displayed directly inside audio timeline clips. Peak data is preserved in project files.
- **Expanded colour grading:** temperature, tint, highlights, shadows and vibrance controls, in addition to presets, brightness, contrast and saturation.
- **QHD export preset:** 1440p output is now available alongside 720p, 1080p and 4K.
- **Full timeline export:** render the edit as one MP4 instead of exporting only the selected source clip.
- **Multi-layer video compositing:** visible video tracks are composited in their timeline stacking order, with clips placed at their actual timeline positions.
- **Mixed audio:** audio clips from all unmuted audio tracks are mixed at their timeline positions. Windows export also detects and mixes embedded audio from video files.
- **Rendered text:** titles and subtitles are burned into the output with their text, size, colour, background, alignment, timing and position. The renderer loads explicit font files, including a Malayalam-capable face for Malayalam overlays.
- **Rendered transitions:** fade, wipe and zoom clip transitions are applied by FFmpeg during export.
- **Rendered colour controls:** v1.2 presets, brightness, contrast and saturation are applied to the final render.
- **Output controls:** MP4 export at 720p, 1080p, 1440p or 4K; 24, 30, 60 or 120 FPS; Draft, Balanced or High encoding quality.
- **Progress feedback:** desktop progress is reported by FFmpeg; browser builds use the FFmpeg WebAssembly progress events.
- **Project compatibility:** `.ffproj` is upgraded to v3; v1.1, v1.2 and v1.3 projects remain supported.

## Requirements

- Node.js 20 or newer.
- FFmpeg with `libx264`, `drawtext`, `geq`, `showwaves`, `overlay`, `amix`, `atempo`, and audio filters such as `afftdn`, `equalizer` and `acompressor` for desktop export.
- FFprobe for detecting embedded audio in video sources.
- Standard Windows font files (`Arial`, and `Nirmala UI` for Malayalam titles) for desktop text rendering.
- Optional, for local automatic captions: Python 3.9+ and the OpenAI Whisper package. Install it from a Windows terminal with:

  ```cmd
  py -m pip install -U openai-whisper
  ```

  Ensure both `whisper` and `ffmpeg` are available on PATH. If the Whisper command is not on PATH, set `WHISPER_PATH` to the full path of `whisper.exe`. The first Whisper model run may need an internet connection to download model weights; later runs can use the cached model.

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

The export includes visible video clips, crop and transform settings, animated keyframes, colour grading and transitions, all active audio segments, and timed text overlays. Audio from video source files is detected and included in Windows desktop builds. In the browser build, embedded audio is probed through FFmpeg.wasm; audio-only files on audio tracks are also mixed.

## Known limitations

- Output is MP4/H.264 with AAC audio; other codecs and containers are not exposed in this release.
- Track compositing uses the current full-frame fit/pad model. Blend modes are supported for centered full-frame clips; transformed, cropped, transitioned or keyed clips use normal alpha compositing. Nested sequences are not yet available.
- The browser renderer runs entirely in memory and can fail on large source files, long timelines, or high-resolution exports. The native desktop renderer is recommended for large projects.
- Hardware-accelerated export, proxy media, persistent waveform caching, nested sequences and GPU-accelerated preview are not included yet.
- The preview remains a lightweight monitor; the final render is authoritative for complex overlaps and transitions. The colour motion tracker is CPU-based and samples a downscaled copy of the source; it may drift if the target is obscured or similar colours appear nearby.

## Project format

Projects are `.ffproj` JSON documents with format `frameforge-project`, version `5`. Source media and audio waveform peaks are embedded in the project, and timeline clips, tracks, text overlays, colour settings, transform settings, keyframes, speed ramps, masks and audio visualizer settings are preserved. v1.6 opens v1, v2, v3, v4 and v5 project files.

## Third-party font attribution

Browser text rendering downloads Noto Sans and Noto Sans Malayalam from the [Noto Fonts project](https://github.com/notofonts/noto-fonts). The Noto project states that its fonts are licensed under the SIL Open Font License; see the [Noto font usage and license guidance](https://notofonts.github.io/noto-docs/website/use/). FrameForge does not bundle or resell the font files.

## v1.6 feature notes

- Speed-ramp segments are percentages of the source clip duration. Audio uses chained `atempo` filters so combined rates below 0.5x or above 2x stay within FFmpeg's per-filter limits.
- Rectangular and elliptical masks are centered on the clip frame. Edge feathering is rendered in FFmpeg with an alpha expression; this is not a freehand Bezier mask editor.
- The waveform visualizer uses FFmpeg `showwaves` and is composited into the final export. It follows the selected audio clip’s speed-ramp timing. One visualizer source is active per project; choose an audio clip or a video clip whose embedded audio is detected.
- Whisper caption generation is desktop-only because it invokes a local Python CLI. It is optional and not bundled with FrameForge. SRT/VTT import and SRT export work without Whisper.
- The colour tracker samples a user-selected pixel colour, scans up to 56 frames and generates approximate X/Y keyframes. It can drift when a target is hidden, motion-blurred or shares its colour with the background.
- Neural object tracking, AI background removal, automatic rotoscoping and cloud speech processing are not included in this release.

## v1.5 feature notes

- Audio EQ, denoising, compression, pan and fades are encoded in the FFmpeg timeline graph. The native single-clip exporter uses the same audio processing controls.
- Blend modes use FFmpeg's `blend` filter on centered full-frame layers. If a layer has a crop, rotation, transition or animated/non-default transform, the renderer falls back to normal alpha overlay so transform animation remains predictable. Chroma-keyed footage uses alpha overlay and therefore takes priority over the selected blend mode.
- Chroma key is applied after crop and before scale/compositing. Similarity and edge blend are adjustable; results depend on lighting, spill and the quality of the source green/blue screen.
- Motion path helper is manual keyframe assistance, not automatic tracking.

## Validation notes for this source release

- `animation.ts`, `speedRamp.ts` and `renderPlan.ts` pass strict standalone TypeScript compilation.
- React/TypeScript sources pass TypeScript transpilation syntax checks; Electron main/preload files pass Node syntax checks.
- Synthetic FFmpeg exports were executed for chroma key over a background, Screen blend compositing, three-band EQ, noise reduction, compression, stereo panning, and fade-in/fade-out audio. Both compositing renders were verified as H.264 video with AAC audio.
- The chroma-key test rendered a green-screen source with a red foreground object over a blue background, confirming transparent key-colour removal.
- A combined synthetic export with a three-part speed ramp, feathered ellipse mask, waveform visualizer, retimed audio and AAC mix rendered successfully and was verified as H.264 video with AAC audio.
- The audio tempo graph chains `atempo` filters for combined speeds outside FFmpeg’s single-filter 0.5x–2x range.
- Full Vite production build and the Windows installer still need validation on a machine with npm dependencies installed. Run `npm install` before launching/building.
- Preview playback reflects volume and fade timing; pan, EQ/noise reduction/compression, chroma key and multi-layer compositing are authoritative in final export. Chroma key is not yet shown in live preview.

## Update your GitHub repository

After copying the v1.6 files into your existing local clone of `editerpros/frameforge`, run:

```bash
npm install
git add .
git commit -m "FrameForge v1.6 - AI and Advanced Video Tools"
git push origin main
```
