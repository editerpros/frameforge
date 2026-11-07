export type RenderMediaKind = 'video' | 'audio';
export type RenderAsset = { id: string; name: string; kind: RenderMediaKind; file: File };
export type RenderTrack = { id: string; kind: RenderMediaKind; name: string; muted: boolean; hidden: boolean; locked: boolean };
export type RenderClip = {
  id: string; assetId: string; trackId: string; position: number; sourceStart: number; sourceEnd: number;
  playbackRate?: number; volume?: number; filter?: string; brightness?: number; contrast?: number; saturation?: number;
  transitionIn?: string; transitionOut?: string; transitionDuration?: number;
};
export type RenderOverlay = {
  id: string; kind: 'title' | 'subtitle'; text: string; start: number; duration: number; x: number; y: number;
  fontSize: number; color: string; background: string; bold: boolean; align: 'left' | 'center' | 'right';
};
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
const transitionAlpha = (clip: RenderClip, length: number) => {
  const duration = Math.min(Math.max(0.05, clip.transitionDuration ?? 0.6), Math.max(0.05, length / 2));
  const parts: string[] = [];
  if (clip.transitionIn === 'fade') parts.push(`min(1,max(0,T/${n(duration)}))`);
  if (clip.transitionOut === 'fade') parts.push(`min(1,max(0,(${n(length)}-T)/${n(duration)}))`);
  if (clip.transitionIn === 'wipe') parts.push(`if(lt(X,W*min(1,max(0,T/${n(duration)}))),1,0)`);
  if (clip.transitionOut === 'wipe') parts.push(`if(lt(X,W*(1-min(1,max(0,T-${n(Math.max(0, length - duration))})/${n(duration)}))),1,0)`);
  if (!parts.length) return '';
  return `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*${parts.join('*')}'`;
};

export function buildRenderPlan(input: {
  assets: RenderAsset[];
  tracks: RenderTrack[];
  clips: RenderClip[];
  overlays: RenderOverlay[];
  audioAssetIds: Set<string>;
  options: RenderOptions;
}): RenderPlan {
  const { assets, tracks, clips, overlays, audioAssetIds, options } = input;
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const eligible = clips.map((clip) => ({ clip, asset: assetById.get(clip.assetId), track: trackById.get(clip.trackId) }))
    .filter((item): item is { clip: RenderClip; asset: RenderAsset; track: RenderTrack } => Boolean(item.asset && item.track))
    .filter(({ asset, track }) => asset.kind === track.kind && !(track.kind === 'video' ? track.hidden : track.muted));

  const maxClipEnd = eligible.reduce((end, { clip }) => Math.max(end, clip.position + Math.max(0, (clip.sourceEnd - clip.sourceStart) / Math.max(0.25, clip.playbackRate ?? 1))), 0);
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
    const length = Math.max(0.05, (clip.sourceEnd - clip.sourceStart) / rate);
    const start = Math.max(0, clip.position);
    const end = start + length;
    const filters: string[] = [
      `setpts=(PTS-STARTPTS)/${n(rate)}`,
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
    ];
    const preset = presetFilter[clip.filter ?? 'none'];
    if (preset) filters.push(preset);
    const brightness = Math.max(-50, Math.min(50, clip.brightness ?? 0)) / 100;
    const contrast = Math.max(50, Math.min(150, clip.contrast ?? 100)) / 100;
    const saturation = Math.max(0, Math.min(200, clip.saturation ?? 100)) / 100;
    if (brightness !== 0 || contrast !== 1 || saturation !== 1) filters.push(`eq=brightness=${n(brightness)}:contrast=${n(contrast)}:saturation=${n(saturation)}`);

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
    const alphaFilter = transitionAlpha(clip, length);
    if (alphaFilter) filters.push(alphaFilter);
    filters.push(`setpts=PTS+${n(start)}/TB`);
    const clipLabel = `vclip${index}`;
    graph.push(`[${i}:v]${filters.join(',')}[${clipLabel}]`);
    const nextLabel = `vmix${index}`;
    graph.push(`[${currentVideo}][${clipLabel}]overlay=x=0:y=0:eof_action=pass:shortest=0:repeatlast=0:enable='between(t,${n(start)},${n(end)})'[${nextLabel}]`);
    currentVideo = nextLabel;
  });

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

  const audioItems = eligible.filter(({ asset, track }) => track.kind === 'audio' && asset.kind === 'audio' || track.kind === 'video' && asset.kind === 'video' && audioAssetIds.has(asset.id));
  const audioLabels: string[] = [];
  audioItems.forEach(({ clip }, index) => {
    const i = inputIndex.get(clip.id);
    if (i === undefined) return;
    const rate = Math.max(0.25, Math.min(4, clip.playbackRate ?? 1));
    const volume = Math.max(0, Math.min(2, clip.volume ?? 1));
    const delay = Math.max(0, Math.round(clip.position * 1000));
    const label = `aclip${index}`;
    const chain = `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,atempo=${n(rate)},volume=${n(volume)},adelay=${delay}:all=1,apad=pad_dur=${n(duration)},atrim=duration=${n(duration)}[${label}]`;
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
  };
}
