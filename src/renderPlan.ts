import { buildKeyframeExpression } from './animation';
import type { AnimatedProperty, ClipKeyframe } from './animation';
import { getRampedDuration, normalizeSpeedSegments } from './speedRamp';
import type { SpeedSegment } from './speedRamp';

export type RenderMediaKind = 'video' | 'audio';
export type RenderAsset = { id: string; name: string; kind: RenderMediaKind; file: File };
export type RenderTrack = { id: string; kind: RenderMediaKind; name: string; muted: boolean; hidden: boolean; locked: boolean };
export type RenderClip = {
  id: string; assetId: string; trackId: string; position: number; sourceStart: number; sourceEnd: number;
  playbackRate?: number; speedSegments?: SpeedSegment[]; maskShape?: 'none' | 'ellipse' | 'rectangle'; maskWidth?: number; maskHeight?: number; maskFeather?: number; volume?: number; audioFadeIn?: number; audioFadeOut?: number; noiseReduction?: number; eqLow?: number; eqMid?: number; eqHigh?: number; compressor?: number; audioPan?: number; blendMode?: 'normal' | 'screen' | 'multiply' | 'overlay' | 'addition' | 'darken' | 'lighten' | 'softlight'; blendOpacity?: number; chromaKeyEnabled?: boolean; chromaKeyColor?: string; chromaKeySimilarity?: number; chromaKeyBlend?: number; filter?: string; brightness?: number; contrast?: number; saturation?: number;
  transitionIn?: string; transitionOut?: string; transitionDuration?: number;
  scale?: number; rotation?: number; positionX?: number; positionY?: number; opacity?: number;
  cropTop?: number; cropRight?: number; cropBottom?: number; cropLeft?: number;
  temperature?: number; tint?: number; highlights?: number; shadows?: number; vibrance?: number;
  keyframes?: ClipKeyframe[];
};
export type RenderOverlay = {
  id: string; kind: 'title' | 'subtitle'; text: string; start: number; duration: number; x: number; y: number;
  fontSize: number; color: string; background: string; bold: boolean; align: 'left' | 'center' | 'right';
};
export type RenderAudioVisualizer = { enabled: boolean; assetId: string; mode: 'line' | 'point' | 'p2p'; color: string; width: number; height: number; y: number };
export type RenderOptions = {
  width: number; height: number; fps: number; quality: 'draft' | 'balanced' | 'high';
  fontFiles?: { regular: string; bold: string; malayalamRegular?: string; malayalamBold?: string; };
};
export type RenderPlan = {
  duration: number;
  args: string[];
  mediaFiles: Array<{ assetId: string; name: string; file: File }>;
  textFiles: Array<{ name: string; content: string }>;
  videoClipCount: number;
  audioClipCount: number;
  overlayCount: number;
  visualizerCount: number;
};

const presetFilter: Record<string, string> = {
  none: '',
  cinematic: 'eq=contrast=1.12:saturation=0.88',
  vivid: 'eq=contrast=1.08:saturation=1.35',
  mono: 'hue=s=0',
  warm: 'colorbalance=rs=0.05:gs=0.02:bs=-0.03',
  cool: 'colorbalance=rs=-0.03:gs=0.01:bs=0.05',
  vintage: 'eq=contrast=0.92:saturation=0.75:brightness=0.02',
  noir: 'hue=s=0,eq=contrast=1.3',
};

const n = (value: number) => {
  if (!Number.isFinite(value)) return '0';
  return Number(value.toFixed(4)).toString();
};

// FFmpeg atempo accepts factors from 0.5 to 2.0 per filter. Chain filters to
// support the editor's full combined speed range (0.0625x–16x) predictably.
const atempoFilters = (value: number) => {
  let factor = Math.max(0.0625, Math.min(16, Number.isFinite(value) ? value : 1));
  const filters: string[] = [];
  while (factor < 0.5 - 1e-8) { filters.push('atempo=0.5'); factor /= 0.5; }
  while (factor > 2 + 1e-8) { filters.push('atempo=2'); factor /= 2; }
  filters.push(`atempo=${n(factor)}`);
  return filters;
};
const safeExtension = (name: string, kind: RenderMediaKind) => {
  const match = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match?.[1] ?? (kind === 'audio' ? 'm4a' : 'mp4');
};
const ffColor = (value: string, fallback: string) => {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return `0x${hex[1]}`;
  const rgba = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (rgba) {
    const rgb = [rgba[1], rgba[2], rgba[3]].map((part) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, '0')).join('');
    const alpha = rgba[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(rgba[4])));
    return `0x${rgb}@${n(alpha)}`;
  }
  return fallback;
};
const transitionAlpha = (clip: RenderClip, length: number, opacityExpression = '100') => {
  const duration = Math.min(Math.max(0.05, clip.transitionDuration ?? 0.6), Math.max(0.05, length / 2));
  const parts: string[] = [];
  if (clip.transitionIn === 'fade') parts.push(`min(1,max(0,T/${n(duration)}))`);
  if (clip.transitionOut === 'fade') parts.push(`min(1,max(0,(${n(length)}-T)/${n(duration)}))`);
  if (clip.transitionIn === 'wipe') parts.push(`if(lt(X,W*min(1,max(0,T/${n(duration)}))),1,0)`);
  if (clip.transitionOut === 'wipe') parts.push(`if(lt(X,W*(1-min(1,max(0,T-${n(Math.max(0, length - duration))})/${n(duration)}))),1,0)`);
  if (opacityExpression !== '100') parts.push(`(${opacityExpression.replace(/\bt\b/g, 'T')})/100`);
  if (!parts.length) return '';
  return `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*${parts.join('*')}'`;
};

const animated = (clip: RenderClip, property: AnimatedProperty, fallback: number) => buildKeyframeExpression(clip.keyframes, property, fallback);
const boundedCrop = (value: number | undefined) => Math.max(0, Math.min(40, value ?? 0)) / 100;

export function buildRenderPlan(input: {
  assets: RenderAsset[];
  tracks: RenderTrack[];
  clips: RenderClip[];
  overlays: RenderOverlay[];
  audioAssetIds: Set<string>;
  visualizer?: RenderAudioVisualizer;
  options: RenderOptions;
}): RenderPlan {
  const { assets, tracks, clips, overlays, audioAssetIds, visualizer, options } = input;
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const eligible = clips.map((clip) => ({ clip, asset: assetById.get(clip.assetId), track: trackById.get(clip.trackId) }))
    .filter((item): item is { clip: RenderClip; asset: RenderAsset; track: RenderTrack } => Boolean(item.asset && item.track))
    .filter(({ asset, track }) => asset.kind === track.kind && !(track.kind === 'video' ? track.hidden : track.muted));

  const maxClipEnd = eligible.reduce((end, { clip }) => Math.max(end, clip.position + getRampedDuration(Math.max(0, clip.sourceEnd - clip.sourceStart), clip.playbackRate ?? 1, clip.speedSegments)), 0);
  const maxOverlayEnd = overlays.reduce((end, overlay) => Math.max(end, overlay.start + overlay.duration), 0);
  const duration = Math.max(maxClipEnd, maxOverlayEnd);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Add at least one clip or timed text overlay before exporting.');
  if (!eligible.length && !overlays.some((overlay) => overlay.text.trim())) throw new Error('There is nothing visible or audible to render.');

  const usedAssets = new Map<string, { assetId: string; name: string; file: File }>();
  eligible.forEach(({ asset }) => {
    if (!usedAssets.has(asset.id)) {
      const index = usedAssets.size;
      usedAssets.set(asset.id, { assetId: asset.id, name: `media-${index}.${safeExtension(asset.name, asset.kind)}`, file: asset.file });
    }
  });
  const mediaFiles = [...usedAssets.values()];
  const mediaName = new Map(mediaFiles.map((item) => [item.assetId, item.name]));

  const args: string[] = ['-hide_banner', '-y'];
  const inputIndex = new Map<string, number>();
  let nextInput = 0;
  for (const { clip, asset } of eligible) {
    const sourceDuration = Math.max(0.05, clip.sourceEnd - clip.sourceStart);
    args.push('-ss', n(Math.max(0, clip.sourceStart)), '-t', n(sourceDuration), '-i', mediaName.get(asset.id)!);
    inputIndex.set(clip.id, nextInput++);
  }

  const width = Math.max(320, Math.min(3840, Math.round(options.width)));
  const height = Math.max(320, Math.min(3840, Math.round(options.height)));
  const fps = Math.max(1, Math.min(120, Math.round(options.fps)));
  const graph: string[] = [`color=c=black:s=${width}x${height}:r=${fps}:d=${n(duration)},format=rgba[base0]`];
  let currentVideo = 'base0';
  const trackOrder = new Map(tracks.map((track, index) => [track.id, index]));
  const videoItems = eligible.filter(({ asset, track }) => asset.kind === 'video' && track.kind === 'video')
    // The first visible track in the UI is the topmost layer, so composite in reverse order.
    .sort((a, b) => (trackOrder.get(b.track.id) ?? 0) - (trackOrder.get(a.track.id) ?? 0) || a.clip.position - b.clip.position);
  const textFiles: Array<{ name: string; content: string }> = [];

  videoItems.forEach(({ clip, track }, index) => {
    const i = inputIndex.get(clip.id)!;
    const rate = Math.max(0.25, Math.min(4, clip.playbackRate ?? 1));
    const length = Math.max(0.05, getRampedDuration(clip.sourceEnd - clip.sourceStart, rate, clip.speedSegments));
    const start = Math.max(0, clip.position);
    const end = start + length;
    const cropTop = boundedCrop(clip.cropTop);
    const cropRight = boundedCrop(clip.cropRight);
    const cropBottom = boundedCrop(clip.cropBottom);
    const cropLeft = boundedCrop(clip.cropLeft);
    const speedSegments = normalizeSpeedSegments(clip.speedSegments);
    let videoInputLabel = `${i}:v`;
    const filters: string[] = [];
    if (speedSegments.length > 1) {
      const sourceLabels = speedSegments.map((_, part) => `vsrc${index}_${part}`);
      graph.push(`[${i}:v]split=${sourceLabels.length}${sourceLabels.map((label) => `[${label}]`).join('')}`);
      const segmentLabels: string[] = [];
      speedSegments.forEach((segment, part) => {
        const label = `vramp${index}_${part}`;
        const sourceStart = (clip.sourceEnd - clip.sourceStart) * segment.start / 100;
        const sourceEnd = (clip.sourceEnd - clip.sourceStart) * segment.end / 100;
        graph.push(`[${sourceLabels[part]}]trim=start=${n(sourceStart)}:end=${n(sourceEnd)},setpts=(PTS-STARTPTS)/${n(rate * segment.rate)}[${label}]`);
        segmentLabels.push(`[${label}]`);
      });
      videoInputLabel = `vramped${index}`;
      graph.push(`${segmentLabels.join('')}concat=n=${segmentLabels.length}:v=1:a=0[${videoInputLabel}]`);
    } else {
      filters.push(`setpts=(PTS-STARTPTS)/${n(rate * (speedSegments[0]?.rate ?? 1))}`);
    }
    if (cropTop + cropBottom <= 0.8 && cropLeft + cropRight <= 0.8 && cropTop + cropRight + cropBottom + cropLeft > 0) {
      filters.push(`crop=w=iw*${n(1 - cropLeft - cropRight)}:h=ih*${n(1 - cropTop - cropBottom)}:x=iw*${n(cropLeft)}:y=ih*${n(cropTop)}`);
    }
    if (clip.chromaKeyEnabled) {
      const keyHex = /^#[0-9a-f]{6}$/i.test(clip.chromaKeyColor ?? '') ? `0x${(clip.chromaKeyColor ?? '#00ff00').slice(1)}` : '0x00FF00';
      const similarity = Math.max(0.01, Math.min(1, (clip.chromaKeySimilarity ?? 18) / 100));
      const edgeBlend = Math.max(0, Math.min(1, (clip.chromaKeyBlend ?? 8) / 100));
      filters.push('format=yuv444p', `chromakey=${keyHex}:${n(similarity)}:${n(edgeBlend)}`, 'format=rgba');
    }
    filters.push(
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      'format=rgba',
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      'setsar=1',
    );
    const preset = presetFilter[clip.filter ?? 'none'];
    if (preset) filters.push(preset);
    const brightness = Math.max(-50, Math.min(50, clip.brightness ?? 0)) / 100;
    const contrast = Math.max(50, Math.min(150, clip.contrast ?? 100)) / 100;
    const vibrance = Math.max(-100, Math.min(100, clip.vibrance ?? 0)) / 100;
    const saturation = Math.max(0, Math.min(200, clip.saturation ?? 100)) / 100;
    const effectiveSaturation = Math.max(0, Math.min(2.5, saturation * (1 + vibrance * 0.5)));
    if (brightness !== 0 || contrast !== 1 || effectiveSaturation !== 1) filters.push(`eq=brightness=${n(brightness)}:contrast=${n(contrast)}:saturation=${n(effectiveSaturation)}`);
    const temperature = Math.max(-100, Math.min(100, clip.temperature ?? 0)) / 100;
    const tint = Math.max(-100, Math.min(100, clip.tint ?? 0)) / 100;
    const highlights = Math.max(-100, Math.min(100, clip.highlights ?? 0)) / 100;
    const shadows = Math.max(-100, Math.min(100, clip.shadows ?? 0)) / 100;
    if (temperature || tint || highlights || shadows) {
      filters.push(`colorbalance=rs=${n(temperature * 0.18 + shadows * 0.08)}:gs=${n(-tint * 0.12)}:bs=${n(-temperature * 0.18)}:rh=${n(temperature * 0.18 + highlights * 0.1)}:gh=${n(-tint * 0.12)}:bh=${n(-temperature * 0.18 - highlights * 0.1)}`);
    }
    const scaleExpression = animated(clip, 'scale', clip.scale ?? 100);
    const rotationExpression = animated(clip, 'rotation', clip.rotation ?? 0);
    if (scaleExpression !== '100') filters.push(`scale=w='iw*(${scaleExpression})/100':h='ih*(${scaleExpression})/100':eval=frame`);
    if (rotationExpression !== '0') filters.push(`rotate=angle='(${rotationExpression})*PI/180':ow='rotw(iw)':oh='roth(ih)':c=none`);

    const transitionDuration = Math.min(Math.max(0.05, clip.transitionDuration ?? 0.6), Math.max(0.05, length / 2));
    filters.push(`fps=${fps}`, 'format=rgba');
    if (clip.transitionIn === 'zoom' || clip.transitionOut === 'zoom') {
      const zoomIn = clip.transitionIn === 'zoom';
      const zoomOut = clip.transitionOut === 'zoom';
      const inFrames = n(transitionDuration * fps);
      const outStart = n(Math.max(0, (length - transitionDuration) * fps));
      let zoomExpr = '1';
      if (zoomIn && zoomOut) {
        zoomExpr = `if(lt(on,${inFrames}),1.12-0.12*min(1,on/${inFrames}),if(gt(on,${outStart}),1+0.12*min(1,(on-${outStart})/${inFrames}),1))`;
      } else if (zoomIn) {
        zoomExpr = `1.12-0.12*min(1,on/${inFrames})`;
      } else {
        zoomExpr = `1+0.12*min(1,max(0,(on-${outStart})/${inFrames}))`;
      }
      filters.push(`zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`, 'format=rgba');
    }
    if ((clip.maskShape ?? 'none') !== 'none') {
      const maskWidth = Math.max(5, Math.min(100, clip.maskWidth ?? 82)) / 100;
      const maskHeight = Math.max(5, Math.min(100, clip.maskHeight ?? 82)) / 100;
      const feather = Math.max(0, Math.min(30, clip.maskFeather ?? 0)) / 100;
      const dx = `abs(X-W/2)/(W*${n(maskWidth / 2)})`;
      const dy = `abs(Y-H/2)/(H*${n(maskHeight / 2)})`;
      const distance = clip.maskShape === 'ellipse' ? `sqrt(pow(${dx},2)+pow(${dy},2))` : `max(${dx},${dy})`;
      const alpha = feather > 0
        ? `if(lt(${distance},${n(1 - feather)}),255,if(lt(${distance},${n(1 + feather)}),255*(${n(1 + feather)}-${distance})/${n(2 * feather)},0))`
        : `if(lt(${distance},1),255,0)`;
      filters.push(`format=rgba`, `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${alpha})'`);
    }
    const opacityExpression = animated(clip, 'opacity', clip.opacity ?? 100);
    const alphaFilter = transitionAlpha(clip, length, opacityExpression);
    if (alphaFilter) filters.push(alphaFilter);
    filters.push(`setpts=PTS+${n(start)}/TB`);
    const clipLabel = `vclip${index}`;
    graph.push(`[${videoInputLabel}]${filters.join(',')}[${clipLabel}]`);
    const nextLabel = `vmix${index}`;
    const xExpression = animated(clip, 'positionX', clip.positionX ?? 0).replace(/\bt\b/g, `(t-${n(start)})`);
    const yExpression = animated(clip, 'positionY', clip.positionY ?? 0).replace(/\bt\b/g, `(t-${n(start)})`);
    const overlayX = `(W-w)/2+W*(${xExpression})/100`;
    const overlayY = `(H-h)/2+H*(${yExpression})/100`;
    const blendMode = clip.chromaKeyEnabled ? 'normal' : (clip.blendMode ?? 'normal');
    const canUseBlendFilter = xExpression === '0'
      && yExpression === '0'
      && scaleExpression === '100'
      && rotationExpression === '0'
      && !(clip.cropTop || clip.cropRight || clip.cropBottom || clip.cropLeft)
      && opacityExpression === '100'
      && (clip.transitionIn ?? 'none') === 'none'
      && (clip.transitionOut ?? 'none') === 'none';
    if (blendMode !== 'normal' && canUseBlendFilter) {
      const blendOpacity = Math.max(0, Math.min(1, (clip.blendOpacity ?? 100) / 100));
      graph.push(`[${clipLabel}][${currentVideo}]blend=all_mode=${blendMode}:all_opacity=${n(blendOpacity)}:eof_action=pass:shortest=0:enable='between(t,${n(start)},${n(end)})'[${nextLabel}]`);
    } else {
      graph.push(`[${currentVideo}][${clipLabel}]overlay=x='${overlayX}':y='${overlayY}':eval=frame:eof_action=pass:shortest=0:repeatlast=0:enable='between(t,${n(start)},${n(end)})'[${nextLabel}]`);
    }
    currentVideo = nextLabel;
  });

  const audioItems = eligible.filter(({ asset, track }) => (track.kind === 'audio' && asset.kind === 'audio') || (track.kind === 'video' && asset.kind === 'video' && audioAssetIds.has(asset.id)));
  let visualizerCount = 0;
  const audioSourceOverrides = new Map<string, string>();
  if (visualizer?.enabled) {
    const visualizerItem = audioItems.find(({ asset }) => !visualizer.assetId || asset.id === visualizer.assetId);
    if (visualizerItem) {
      const clip = visualizerItem.clip;
      const rate = Math.max(0.25, Math.min(4, clip.playbackRate ?? 1));
      const input = inputIndex.get(clip.id);
      if (input !== undefined) {
        const start = Math.max(0, clip.position);
        const length = getRampedDuration(clip.sourceEnd - clip.sourceStart, clip.playbackRate ?? 1, clip.speedSegments);
        const end = start + length;
        const width = Math.max(160, Math.min(options.width, Math.round(visualizer.width || 1200)));
        const height = Math.max(40, Math.min(600, Math.round(visualizer.height || 180)));
        const color = /^#[0-9a-f]{6}$/i.test(visualizer.color) ? `0x${visualizer.color.slice(1)}` : '0xB99AFF';
        const mode = visualizer.mode === 'point' || visualizer.mode === 'p2p' ? visualizer.mode : 'line';
        const waveLabel = 'audioVisualizer';
        graph.push(`[${input}:a]asplit=2[visualizerAudio][timelineAudio${input}]`);
        audioSourceOverrides.set(clip.id, `timelineAudio${input}`);
        const rampSegments = normalizeSpeedSegments(clip.speedSegments);
        let waveformAudio = 'visualizerAudio';
        if (rampSegments.length > 1) {
          const splitLabels = rampSegments.map((_, part) => `visualizerRampSrc${part}`);
          graph.push(`[visualizerAudio]asplit=${splitLabels.length}${splitLabels.map((label) => `[${label}]`).join('')}`);
          const retimedLabels: string[] = [];
          rampSegments.forEach((segment, part) => {
            const sourceStart = (clip.sourceEnd - clip.sourceStart) * segment.start / 100;
            const sourceEnd = (clip.sourceEnd - clip.sourceStart) * segment.end / 100;
            const label = `visualizerRamp${part}`;
            graph.push(`[${splitLabels[part]}]atrim=start=${n(sourceStart)}:end=${n(sourceEnd)},asetpts=PTS-STARTPTS,${atempoFilters(rate * segment.rate).join(',')}[${label}]`);
            retimedLabels.push(`[${label}]`);
          });
          waveformAudio = 'visualizerRetimed';
          graph.push(`${retimedLabels.join('')}concat=n=${retimedLabels.length}:v=0:a=1[${waveformAudio}]`);
        } else {
          graph.push(`[visualizerAudio]asetpts=PTS-STARTPTS,${atempoFilters(rate * (rampSegments[0]?.rate ?? 1)).join(',')}[visualizerRetimed]`);
          waveformAudio = 'visualizerRetimed';
        }
        graph.push(`[${waveformAudio}]aformat=sample_rates=48000:channel_layouts=stereo,showwaves=s=${width}x${height}:mode=${mode}:rate=${fps}:colors=${color}:draw=full,format=rgba,colorkey=0x000000:0.12:0.04,setpts=PTS+${n(start)}/TB[${waveLabel}]`);
        const nextLabel = 'vmixvisualizer';
        const y = Math.max(0, Math.min(100, visualizer.y ?? 78)) / 100;
        graph.push(`[${currentVideo}][${waveLabel}]overlay=x='(W-w)/2':y='H*${n(y)}':eval=frame:eof_action=pass:shortest=0:enable='between(t,${n(start)},${n(end)})'[${nextLabel}]`);
        currentVideo = nextLabel;
        visualizerCount = 1;
      }
    }
  }

  overlays.filter((overlay) => overlay.text.trim() && overlay.duration > 0)
    .sort((a, b) => a.start - b.start)
    .forEach((overlay, index) => {
      const textName = `overlay-${index}.txt`;
      textFiles.push({ name: textName, content: overlay.text.replace(/\r\n/g, '\n') });
      const foreground = ffColor(overlay.color, '0xFFFFFF');
      const background = ffColor(overlay.background, '0x08080c@0.65');
      const x = overlay.align === 'left' ? `w*${n(overlay.x / 100)}` : overlay.align === 'right' ? `w*${n(overlay.x / 100)}-text_w` : `w*${n(overlay.x / 100)}-text_w/2`;
      const y = `h*${n(overlay.y / 100)}-text_h/2`;
      const size = Math.max(10, Math.min(120, Math.round(overlay.fontSize)));
      const hasMalayalam = /[\u0D00-\u0D7F]/.test(overlay.text);
      const fontFile = hasMalayalam
        ? (overlay.bold ? options.fontFiles?.malayalamBold : options.fontFiles?.malayalamRegular)
        : (overlay.bold ? options.fontFiles?.bold : options.fontFiles?.regular);
      if (!fontFile) throw new Error('A font file is required to render titles and subtitles.');
      const filter = `drawtext=fontfile='${fontFile}':textfile='${textName}':fontcolor=${foreground}:fontsize=${size}:x='${x}':y='${y}':box=1:boxcolor=${background}:boxborderw=${Math.max(4, Math.round(size * 0.22))}:expansion=none:enable='between(t,${n(Math.max(0, overlay.start))},${n(overlay.start + overlay.duration)})'`;
      const nextLabel = `vtext${index}`;
      graph.push(`[${currentVideo}]${filter}[${nextLabel}]`);
      currentVideo = nextLabel;
    });
  graph.push(`[${currentVideo}]format=yuv420p[vout]`);

  const audioLabels: string[] = [];
  audioItems.forEach(({ clip }, index) => {
    const i = inputIndex.get(clip.id);
    if (i === undefined) return;
    const rate = Math.max(0.25, Math.min(4, clip.playbackRate ?? 1));
    const volume = Math.max(0, Math.min(2, clip.volume ?? 1));
    const delay = Math.max(0, Math.round(clip.position * 1000));
    const clipDuration = getRampedDuration(clip.sourceEnd - clip.sourceStart, rate, clip.speedSegments);
    const speedSegments = normalizeSpeedSegments(clip.speedSegments);
    let audioInputLabel = audioSourceOverrides.get(clip.id) ?? `${i}:a`;
    const filters: string[] = ['aformat=sample_rates=48000:channel_layouts=stereo', 'asetpts=PTS-STARTPTS'];
    if (speedSegments.length > 1) {
      const sourceLabels = speedSegments.map((_, part) => `asrc${index}_${part}`);
      graph.push(`[${audioInputLabel}]asplit=${sourceLabels.length}${sourceLabels.map((label) => `[${label}]`).join('')}`);
      const segmentLabels: string[] = [];
      speedSegments.forEach((segment, part) => {
        const label = `aramp${index}_${part}`;
        const sourceStart = (clip.sourceEnd - clip.sourceStart) * segment.start / 100;
        const sourceEnd = (clip.sourceEnd - clip.sourceStart) * segment.end / 100;
        graph.push(`[${sourceLabels[part]}]atrim=start=${n(sourceStart)}:end=${n(sourceEnd)},asetpts=PTS-STARTPTS,${atempoFilters(rate * segment.rate).join(',')}[${label}]`);
        segmentLabels.push(`[${label}]`);
      });
      audioInputLabel = `aramped${index}`;
      graph.push(`${segmentLabels.join('')}concat=n=${segmentLabels.length}:v=0:a=1[${audioInputLabel}]`);
      filters.splice(1, 1);
    } else {
      filters.push(...atempoFilters(rate * (speedSegments[0]?.rate ?? 1)));
    }
    const noiseReduction = Math.max(0, Math.min(100, clip.noiseReduction ?? 0));
    if (noiseReduction > 0) filters.push(`afftdn=nr=${n(Math.max(0.1, noiseReduction * 0.24))}:nf=-35`);
    const eqLow = Math.max(-12, Math.min(12, clip.eqLow ?? 0));
    const eqMid = Math.max(-12, Math.min(12, clip.eqMid ?? 0));
    const eqHigh = Math.max(-12, Math.min(12, clip.eqHigh ?? 0));
    if (eqLow) filters.push(`equalizer=f=100:t=q:w=1:g=${n(eqLow)}`);
    if (eqMid) filters.push(`equalizer=f=1000:t=q:w=1:g=${n(eqMid)}`);
    if (eqHigh) filters.push(`equalizer=f=8000:t=q:w=1:g=${n(eqHigh)}`);
    const compressor = Math.max(0, Math.min(100, clip.compressor ?? 0));
    if (compressor > 0) filters.push(`acompressor=threshold=-24dB:ratio=${n(1 + compressor * 0.05)}:attack=20:release=250:makeup=1.5`);
    filters.push(`volume=${n(volume)}`);
    const pan = Math.max(-100, Math.min(100, clip.audioPan ?? 0)) / 100;
    if (pan) {
      const leftGain = pan > 0 ? 1 - pan : 1;
      const rightGain = pan < 0 ? 1 + pan : 1;
      filters.push(`pan=stereo\\|c0=${n(leftGain)}*c0\\|c1=${n(rightGain)}*c1`);
    }
    const fadeIn = Math.max(0, Math.min(clipDuration, clip.audioFadeIn ?? 0));
    const fadeOut = Math.max(0, Math.min(clipDuration, clip.audioFadeOut ?? 0));
    if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${n(fadeIn)}`);
    if (fadeOut > 0) filters.push(`afade=t=out:st=${n(Math.max(0, clipDuration - fadeOut))}:d=${n(fadeOut)}`);
    filters.push(`adelay=${delay}:all=1`, `apad=pad_dur=${n(duration)}`, `atrim=duration=${n(duration)}`);
    const label = `aclip${index}`;
    const chain = `[${audioInputLabel}]${filters.join(',')}[${label}]`;
    graph.push(chain);
    audioLabels.push(`[${label}]`);
  });
  if (audioLabels.length === 1) {
    graph.push(`${audioLabels[0]}anull[aout]`);
  } else if (audioLabels.length > 1) {
    graph.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
  }

  const quality = options.quality === 'draft'
    ? { preset: 'ultrafast', crf: '28' }
    : options.quality === 'high'
      ? { preset: 'slow', crf: '18' }
      : { preset: 'medium', crf: '23' };
  args.push(
    '-filter_complex', graph.join(';'),
    '-map', '[vout]',
  );
  if (audioLabels.length) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push(
    '-t', n(duration), '-r', String(fps), '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', quality.preset, '-crf', quality.crf,
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '__FRAMEFORGE_OUTPUT__',
  );

  return {
    duration, args, mediaFiles, textFiles,
    videoClipCount: videoItems.length,
    audioClipCount: audioItems.length,
    overlayCount: textFiles.length,
    visualizerCount,
  };
}
