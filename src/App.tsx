import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, MouseEvent } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { buildRenderPlan } from './renderPlan';
import { ANIMATED_DEFAULTS, getAnimatedValue, upsertKeyframe } from './animation';
import type { AnimatedProperty, ClipKeyframe } from './animation';
import { getRampedDuration, normalizeSpeedSegments, sourceOffsetAtTimelineTime, speedAtTimelineTime, timelineOffsetAtSourceTime } from './speedRamp';
import type { SpeedSegment } from './speedRamp';
import {
  Aperture, AudioLines, ChevronDown, Clapperboard, Download, FilePlus2, Film,
  FolderOpen, Maximize2, MoreHorizontal, MousePointer2, Play, Plus, Redo2,
  Save, Scissors, Settings2, SkipBack, SkipForward, Trash2, Undo2, Upload,
  Volume2, WandSparkles, ZoomIn, ZoomOut, Video, Music2, Lock, Unlock,
  Eye, EyeOff, Mic2, Layers3, Keyboard, X, Captions, Type, SlidersHorizontal,
  Crop, RotateCw, Move, Diamond, Waves, Focus, Sparkles, Target,
} from 'lucide-react';

type MediaKind = 'video' | 'audio';
type MediaAsset = { id: string; name: string; file: File; url: string; duration: number; kind: MediaKind; mime: string; waveform?: number[] };
type Track = { id: string; kind: MediaKind; name: string; muted: boolean; hidden: boolean; locked: boolean };
type FilterPreset = 'none' | 'cinematic' | 'vivid' | 'mono' | 'warm' | 'cool' | 'vintage' | 'noir';
type TransitionPreset = 'none' | 'fade' | 'wipe' | 'zoom';
type BlendMode = 'normal' | 'screen' | 'multiply' | 'overlay' | 'addition' | 'darken' | 'lighten' | 'softlight';
type TimelineClip = { id: string; assetId: string; trackId: string; position: number; sourceStart: number; sourceEnd: number; playbackRate?: number; speedSegments?: SpeedSegment[]; maskShape?: 'none' | 'ellipse' | 'rectangle'; maskWidth?: number; maskHeight?: number; maskFeather?: number; volume?: number; audioFadeIn?: number; audioFadeOut?: number; noiseReduction?: number; eqLow?: number; eqMid?: number; eqHigh?: number; compressor?: number; audioPan?: number; blendMode?: BlendMode; blendOpacity?: number; chromaKeyEnabled?: boolean; chromaKeyColor?: string; chromaKeySimilarity?: number; chromaKeyBlend?: number; filter?: FilterPreset; brightness?: number; contrast?: number; saturation?: number; transitionIn?: TransitionPreset; transitionOut?: TransitionPreset; transitionDuration?: number; scale?: number; rotation?: number; positionX?: number; positionY?: number; opacity?: number; cropTop?: number; cropRight?: number; cropBottom?: number; cropLeft?: number; temperature?: number; tint?: number; highlights?: number; shadows?: number; vibrance?: number; keyframes?: ClipKeyframe[] };
type TextOverlay = { id: string; kind: 'title' | 'subtitle'; text: string; start: number; duration: number; x: number; y: number; fontSize: number; color: string; background: string; bold: boolean; align: 'left' | 'center' | 'right' };
type HistoryState = { clips: TimelineClip[]; tracks: Track[]; overlays: TextOverlay[] };
type ProjectAsset = { id: string; name: string; mime: string; duration: number; kind: MediaKind; data: string; waveform?: number[] };
type ProjectFile = { format: 'frameforge-project'; version: number; name: string; assets: ProjectAsset[]; tracks: Track[]; clips: TimelineClip[]; overlays?: TextOverlay[]; audioVisualizer?: AudioVisualizerSettings; playhead: number };
type RecentProject = { name: string; openedAt: number; mediaCount: number };
type AudioVisualizerSettings = { enabled: boolean; assetId: string; mode: 'line' | 'point' | 'p2p'; color: string; width: number; height: number; y: number };
const defaultVisualizer: AudioVisualizerSettings = { enabled: false, assetId: '', mode: 'line', color: '#b99aff', width: 1200, height: 180, y: 78 };

const initialTracks: Track[] = [
  { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
  { id: 'v2', kind: 'video', name: 'V2', muted: false, hidden: false, locked: false },
  { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false },
  { id: 'a2', kind: 'audio', name: 'A2', muted: false, hidden: false, locked: false },
];
const fmt = (value: number) => {
  const s = Math.max(0, Number.isFinite(value) ? value : 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const clipLength = (clip: TimelineClip) => getRampedDuration(Math.max(0, clip.sourceEnd - clip.sourceStart), clip.playbackRate ?? 1, clip.speedSegments);
const clipFadeGain = (clip: TimelineClip, timelineTime: number) => { const local = Math.max(0, timelineTime - clip.position); const length = clipLength(clip); const fadeIn = Math.min(length, Math.max(0, clip.audioFadeIn ?? 0)); const fadeOut = Math.min(length, Math.max(0, clip.audioFadeOut ?? 0)); const inGain = fadeIn > 0 ? Math.min(1, local / fadeIn) : 1; const outGain = fadeOut > 0 ? Math.min(1, (length - local) / fadeOut) : 1; return Math.max(0, Math.min(inGain, outGain)); };
const normalizeClip = (clip: TimelineClip): TimelineClip => ({ playbackRate: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0, noiseReduction: 0, eqLow: 0, eqMid: 0, eqHigh: 0, compressor: 0, audioPan: 0, blendMode: 'normal', blendOpacity: 100, chromaKeyEnabled: false, chromaKeyColor: '#00ff00', chromaKeySimilarity: 18, chromaKeyBlend: 8, filter: 'none', brightness: 0, contrast: 100, saturation: 100, transitionIn: 'none', transitionOut: 'none', transitionDuration: 0.6, scale: 100, rotation: 0, positionX: 0, positionY: 0, opacity: 100, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, maskShape: 'none', maskWidth: 82, maskHeight: 82, maskFeather: 0, speedSegments: [], temperature: 0, tint: 0, highlights: 0, shadows: 0, vibrance: 0, keyframes: [], ...clip });
const presetCss: Record<FilterPreset, string> = { none: '', cinematic: 'sepia(.08) contrast(1.12) saturate(.88)', vivid: 'contrast(1.08) saturate(1.35)', mono: 'grayscale(1)', warm: 'sepia(.18) saturate(1.08)', cool: 'hue-rotate(12deg) saturate(.92)', vintage: 'sepia(.28) contrast(.92) saturate(.75)', noir: 'grayscale(1) contrast(1.3)' };
const presetFfmpeg: Record<FilterPreset, string> = { none: '', cinematic: 'eq=contrast=1.12:saturation=0.88', vivid: 'eq=contrast=1.08:saturation=1.35', mono: 'hue=s=0', warm: 'colorbalance=rs=0.05:gs=0.02:bs=-0.03', cool: 'colorbalance=rs=-0.03:gs=0.01:bs=0.05', vintage: 'eq=contrast=0.92:saturation=0.75:brightness=0.02', noir: 'hue=s=0,eq=contrast=1.3' };
const clipFilterCss = (clip: TimelineClip) => `brightness(${1 + (clip.brightness ?? 0) / 100 + (clip.highlights ?? 0) / 500}) contrast(${(clip.contrast ?? 100) / 100}) saturate(${Math.max(0, (clip.saturation ?? 100) / 100 * (1 + (clip.vibrance ?? 0) / 200))}) sepia(${Math.max(0, clip.temperature ?? 0) / 650}) hue-rotate(${-(clip.temperature ?? 0) / 5 + (clip.tint ?? 0) / 4}deg) ${presetCss[clip.filter ?? 'none']}`.trim();
const clipTransitionStyle = (clip: TimelineClip, time: number): CSSProperties => {
  const len = clipLength(clip); const duration = Math.min(Math.max(0.05, clip.transitionDuration ?? 0.6), len / 2);
  const local = Math.max(0, time - clip.position); const remaining = Math.max(0, len - local);
  const inType = clip.transitionIn ?? 'none'; const outType = clip.transitionOut ?? 'none';
  const mode = local < duration && inType !== 'none' ? inType : remaining < duration && outType !== 'none' ? outType : 'none';
  const progress = mode === inType && local < duration ? Math.min(1, local / duration) : Math.min(1, remaining / duration);
  if (mode === 'fade') return { opacity: progress };
  if (mode === 'wipe') return { clipPath: local < duration ? `inset(0 ${(1 - progress) * 100}% 0 0)` : `inset(0 0 0 ${(1 - progress) * 100}%)` };
  if (mode === 'zoom') return { transform: `scale(${local < duration ? 1.12 - progress * 0.12 : 1 + (1 - progress) * 0.12})`, opacity: Math.min(1, progress + 0.15) };
  return {};
};
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const bytesToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
};
const base64ToBytes = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const buildWaveform = async (file: File, samples = 144): Promise<number[]> => {
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return [];
  const context = new AudioContextCtor();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const channelCount = decoded.numberOfChannels;
    const peaks: number[] = [];
    const blockSize = Math.max(1, Math.floor(decoded.length / samples));
    for (let block = 0; block < samples; block += 1) {
      const start = block * blockSize;
      const end = Math.min(decoded.length, start + blockSize);
      let peak = 0;
      for (let channel = 0; channel < channelCount; channel += 1) {
        const data = decoded.getChannelData(channel);
        for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(data[index]));
      }
      peaks.push(Math.round(Math.min(1, peak) * 1000) / 1000);
    }
    return peaks;
  } catch {
    return [];
  } finally {
    await context.close().catch(() => undefined);
  }
};

const parseSubtitleTime = (value: string) => {
  const normalized = value.trim().replace(',', '.');
  const match = normalized.match(/(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
};
const parseSubtitleFile = (content: string): Array<{ start: number; duration: number; text: string }> => {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r/g, '').replace(/^WEBVTT[^\n]*\n/i, '');
  const blocks = normalized.split(/\n\s*\n/);
  const subtitles: Array<{ start: number; duration: number; text: string }> = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex < 0) continue;
    const times = lines[timeIndex].split('-->');
    const start = parseSubtitleTime(times[0] || '');
    const end = parseSubtitleTime((times[1] || '').split(/\s+/)[0]);
    const text = lines.slice(timeIndex + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (text && Number.isFinite(start) && end > start) subtitles.push({ start, duration: end - start, text });
  }
  return subtitles;
};
const formatSubtitleTime = (seconds: number) => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const wholeSeconds = Math.floor((ms % 60000) / 1000);
  const remainder = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
};
const subtitlesToSrt = (overlays: TextOverlay[]) => overlays.filter((item) => item.kind === 'subtitle' && item.text.trim()).sort((a, b) => a.start - b.start).map((item, index) => `${index + 1}\n${formatSubtitleTime(item.start)} --> ${formatSubtitleTime(item.start + item.duration)}\n${item.text}`).join('\n\n') + '\n';
const colorToRgb = (hex: string) => {
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  if (!match) return [255, 0, 0];
  const value = match[1];
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
};

const WASM_FONT_FILES = {
  regular: 'frameforge-noto-sans-regular.ttf',
  bold: 'frameforge-noto-sans-bold.ttf',
  malayalamRegular: 'frameforge-noto-sans-malayalam-regular.ttf',
  malayalamBold: 'frameforge-noto-sans-malayalam-bold.ttf',
};
const WASM_FONT_URLS = {
  regular: 'https://cdn.jsdelivr.net/gh/notofonts/noto-fonts@main/hinted/ttf/NotoSans/NotoSans-Regular.ttf',
  bold: 'https://cdn.jsdelivr.net/gh/notofonts/noto-fonts@main/hinted/ttf/NotoSans/NotoSans-Bold.ttf',
  malayalamRegular: 'https://cdn.jsdelivr.net/gh/notofonts/noto-fonts@main/hinted/ttf/NotoSansMalayalam/NotoSansMalayalamUI-Regular.ttf',
  malayalamBold: 'https://cdn.jsdelivr.net/gh/notofonts/noto-fonts@main/hinted/ttf/NotoSansMalayalam/NotoSansMalayalamUI-Bold.ttf',
};
const wasmFontCache = new WeakMap<FFmpeg, Set<keyof typeof WASM_FONT_FILES>>();
const loadWasmFonts = async (engine: FFmpeg, needsMalayalam: boolean) => {
  const weights = needsMalayalam ? ['regular', 'bold', 'malayalamRegular', 'malayalamBold'] as const : ['regular', 'bold'] as const;
  const loaded = wasmFontCache.get(engine) ?? new Set<keyof typeof WASM_FONT_FILES>();
  wasmFontCache.set(engine, loaded);
  for (const weight of weights) {
    if (loaded.has(weight)) continue;
    const response = await fetch(WASM_FONT_URLS[weight]);
    if (!response.ok) throw new Error(`Could not download the ${weight} title font (HTTP ${response.status}). Check your internet connection and retry.`);
    await engine.writeFile(WASM_FONT_FILES[weight], new Uint8Array(await response.arrayBuffer()));
    loaded.add(weight);
  }
};

export default function App() {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [tracks, setTracks] = useState<Track[]>(initialTracks);
  const [timelineClips, setTimelineClips] = useState<TimelineClip[]>([]);
  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [zoom, setZoom] = useState(34);
  const [tab, setTab] = useState('Media');
  const [projectName, setProjectName] = useState('Untitled Project');
  const [exporting, setExporting] = useState(false);
  const [showExportSettings, setShowExportSettings] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportResolution, setExportResolution] = useState('1080p');
  const [exportFps, setExportFps] = useState(30);
  const [exportQuality, setExportQuality] = useState<'draft' | 'balanced' | 'high'>('balanced');
  const [message, setMessage] = useState('Ready. Import media or drag it onto a timeline track.');
  const [history, setHistory] = useState<HistoryState[]>([{ clips: [], tracks: initialTracks, overlays: [] }]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [screen, setScreen] = useState<'splash' | 'home' | 'editor'>('splash');
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [audioVisualizer, setAudioVisualizer] = useState<AudioVisualizerSettings>(defaultVisualizer);
  const [captionAssetId, setCaptionAssetId] = useState('');
  const [captionModel, setCaptionModel] = useState<'tiny' | 'base' | 'small'>('base');
  const [captionLanguage, setCaptionLanguage] = useState('auto');
  const [generatingCaptions, setGeneratingCaptions] = useState(false);
  const [trackingTargetColor, setTrackingTargetColor] = useState('#ff3b30');
  const [trackingTolerance, setTrackingTolerance] = useState(65);
  const [samplingTrackingColor, setSamplingTrackingColor] = useState(false);
  const [trackingProgress, setTrackingProgress] = useState(0);
  const [trackingBusy, setTrackingBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const projectPickerRef = useRef<HTMLInputElement>(null);
  const subtitlePickerRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('frameforge.recentProjects');
      if (saved) setRecentProjects(JSON.parse(saved) as RecentProject[]);
    } catch { /* Ignore invalid or unavailable browser storage. */ }
    const splashTimer = window.setTimeout(() => setScreen('home'), 1450);
    return () => window.clearTimeout(splashTimer);
  }, []);

  const rememberRecentProject = (name: string, mediaCount: number) => {
    setRecentProjects((current) => {
      const next = [{ name, openedAt: Date.now(), mediaCount }, ...current.filter((item) => item.name !== name)].slice(0, 8);
      try { localStorage.setItem('frameforge.recentProjects', JSON.stringify(next)); } catch { /* Storage is optional. */ }
      return next;
    });
  };

  const createNewProject = () => {
    if ((assets.length || timelineClips.length || textOverlays.length) && !window.confirm('Start a new project? Save your current project first if you want to keep these edits.')) return;
    assets.forEach((asset) => URL.revokeObjectURL(asset.url));
    setAssets([]);
    setTracks(initialTracks);
    setTimelineClips([]);
    setTextOverlays([]);
    setAudioVisualizer(defaultVisualizer);
    setSelectedClipId(null);
    setSelectedOverlayId(null);
    setPlaying(false);
    setPlayhead(0);
    setProjectName('Untitled Project');
    setHistory([{ clips: [], tracks: initialTracks, overlays: [] }]);
    setHistoryIndex(0);
    setMessage('New project ready. Import media or drag files into the timeline.');
    setScreen('editor');
  };

  const selectedClip = timelineClips.find((clip) => clip.id === selectedClipId) ?? null;
  const selectedAsset = selectedClip ? assets.find((asset) => asset.id === selectedClip.assetId) ?? null : null;
  const selectedOverlay = textOverlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;
  const selectedLocalTime = selectedClip ? Math.max(0, Math.min(clipLength(selectedClip), playhead - selectedClip.position)) : 0;
  const clipAnimatedValue = (clip: TimelineClip, property: AnimatedProperty, localTime: number, fallback = ANIMATED_DEFAULTS[property]) => getAnimatedValue(clip.keyframes, property, localTime, fallback);
  const activeOverlays = textOverlays.filter((overlay) => playhead >= overlay.start && playhead < overlay.start + overlay.duration);
  const totalDuration = Math.max(30, ...timelineClips.map((clip) => clip.position + clipLength(clip)), ...textOverlays.map((overlay) => overlay.start + overlay.duration));
  const timelineWidth = 60 + Math.max(30, totalDuration + 8) * zoom;
  const tickStep = totalDuration > 600 ? 60 : totalDuration > 240 ? 30 : totalDuration > 90 ? 15 : 10;
  const ticks = useMemo(() => Array.from({ length: Math.ceil(totalDuration / tickStep) + 1 }, (_, index) => index * tickStep), [totalDuration, tickStep]);

  const previewVideo = useMemo(() => {
    const videoTrackIds = new Set(tracks.filter((track) => track.kind === 'video' && !track.hidden).map((track) => track.id));
    return timelineClips
      .filter((clip) => videoTrackIds.has(clip.trackId) && playhead >= clip.position && playhead < clip.position + clipLength(clip))
      .sort((a, b) => tracks.findIndex((track) => track.id === a.trackId) - tracks.findIndex((track) => track.id === b.trackId))[0] ?? null;
  }, [timelineClips, tracks, playhead]);
  const previewAudio = useMemo(() => {
    const audioTrackIds = new Set(tracks.filter((track) => track.kind === 'audio' && !track.muted).map((track) => track.id));
    return timelineClips.find((clip) => audioTrackIds.has(clip.trackId) && playhead >= clip.position && playhead < clip.position + clipLength(clip)) ?? null;
  }, [timelineClips, tracks, playhead]);

  const commit = useCallback((nextClips: TimelineClip[], nextTracks: Track[] = tracks, nextOverlays: TextOverlay[] = textOverlays) => {
    const snapshot = { clips: nextClips, tracks: nextTracks, overlays: nextOverlays };
    setTimelineClips(nextClips);
    setTracks(nextTracks);
    setTextOverlays(nextOverlays);
    setHistory((previous) => {
      const next = previous.slice(0, historyIndex + 1);
      next.push(snapshot);
      return next.slice(-100);
    });
    setHistoryIndex((index) => Math.min(index + 1, 99));
  }, [historyIndex, tracks, textOverlays]);

  const undo = useCallback(() => {
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    const snapshot = history[nextIndex];
    setHistoryIndex(nextIndex);
    setTimelineClips(snapshot.clips);
    setTracks(snapshot.tracks);
    setTextOverlays(snapshot.overlays ?? []);
    setSelectedClipId(null);
    setSelectedOverlayId(null);
    setMessage('Undo completed.');
  }, [history, historyIndex]);
  const redo = useCallback(() => {
    if (historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    const snapshot = history[nextIndex];
    setHistoryIndex(nextIndex);
    setTimelineClips(snapshot.clips);
    setTracks(snapshot.tracks);
    setTextOverlays(snapshot.overlays ?? []);
    setSelectedClipId(null);
    setSelectedOverlayId(null);
    setMessage('Redo completed.');
  }, [history, historyIndex]);

  const importFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const additions: MediaAsset[] = [];
    for (const file of Array.from(files)) {
      const kind: MediaKind = file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'video';
      if (!file.type.startsWith('video/') && !file.type.startsWith('audio/')) continue;
      const url = URL.createObjectURL(file);
      const duration = await new Promise<number>((resolve) => {
        const media = document.createElement(kind === 'video' ? 'video' : 'audio');
        media.preload = 'metadata';
        media.onloadedmetadata = () => resolve(Number.isFinite(media.duration) ? media.duration : 0);
        media.onerror = () => resolve(0);
        media.src = url;
      });
      const waveform = kind === 'audio' ? await buildWaveform(file) : undefined;
      additions.push({ id: uid(), name: file.name, file, url, duration, kind, mime: file.type || (kind === 'audio' ? 'audio/mpeg' : 'video/mp4'), ...(waveform?.length ? { waveform } : {}) });
    }
    if (additions.length) {
      setAssets((previous) => [...previous, ...additions]);
      setMessage(`${additions.length} media file${additions.length === 1 ? '' : 's'} imported. Drag an item onto a matching track.`);
    } else {
      setMessage('No supported audio or video files were found.');
    }
  };

  const addAssetToTimeline = (assetId: string, trackId?: string, position = playhead) => {
    const asset = assets.find((item) => item.id === assetId);
    if (!asset) return;
    const targetTrack = tracks.find((track) => track.id === trackId && track.kind === asset.kind && !track.locked)
      ?? tracks.find((track) => track.kind === asset.kind && !track.locked);
    if (!targetTrack) {
      setMessage(`Add or unlock an ${asset.kind} track first.`);
      return;
    }
    const clip: TimelineClip = normalizeClip({ id: uid(), assetId, trackId: targetTrack.id, position: Math.max(0, position), sourceStart: 0, sourceEnd: asset.duration });
    commit([...timelineClips, clip]);
    setSelectedClipId(clip.id);
    setSelectedOverlayId(null);
    setPlayhead(clip.position);
    setMessage(`${asset.name} added to ${targetTrack.name}.`);
  };

  const handleTrackDrop = (event: DragEvent<HTMLDivElement>, track: Track) => {
    event.preventDefault();
    if (track.locked) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = Math.max(0, (event.clientX - bounds.left) / zoom);
    const assetId = event.dataTransfer.getData('application/x-frameforge-asset');
    const clipId = event.dataTransfer.getData('application/x-frameforge-clip');
    if (assetId) {
      const asset = assets.find((item) => item.id === assetId);
      if (!asset) return;
      if (asset.kind !== track.kind) {
        setMessage(`${asset.kind === 'video' ? 'Video' : 'Audio'} media must be dropped on a ${asset.kind} track.`);
        return;
      }
      addAssetToTimeline(assetId, track.id, position);
    } else if (clipId) {
      const moving = timelineClips.find((clip) => clip.id === clipId);
      if (!moving) return;
      if (assets.find((asset) => asset.id === moving.assetId)?.kind !== track.kind) return;
      const next = timelineClips.map((clip) => clip.id === clipId ? { ...clip, trackId: track.id, position } : clip);
      commit(next);
      setSelectedClipId(clipId);
      setSelectedOverlayId(null);
      setMessage(`Clip moved to ${track.name} at ${fmt(position)}.`);
    }
  };

  const updateSelectedClip = (patch: Partial<Omit<TimelineClip, 'id' | 'assetId' | 'trackId'>>) => {
    if (!selectedClip) return;
    const asset = assets.find((item) => item.id === selectedClip.assetId);
    if (!asset) return;
    const updated = { ...selectedClip, ...patch };
    updated.sourceStart = Math.max(0, Math.min(updated.sourceStart, asset.duration - 0.05));
    updated.sourceEnd = Math.max(updated.sourceStart + 0.05, Math.min(updated.sourceEnd, asset.duration));
    updated.position = Math.max(0, updated.position);
    updated.playbackRate = Math.max(0.5, Math.min(2, updated.playbackRate ?? 1));
    updated.volume = Math.max(0, Math.min(2, updated.volume ?? 1));
    updated.transitionDuration = Math.max(0.1, Math.min(3, updated.transitionDuration ?? 0.6));
    updated.scale = Math.max(25, Math.min(300, updated.scale ?? 100));
    updated.rotation = Math.max(-180, Math.min(180, updated.rotation ?? 0));
    updated.positionX = Math.max(-100, Math.min(100, updated.positionX ?? 0));
    updated.positionY = Math.max(-100, Math.min(100, updated.positionY ?? 0));
    updated.opacity = Math.max(0, Math.min(100, updated.opacity ?? 100));
    updated.cropTop = Math.max(0, Math.min(40, updated.cropTop ?? 0));
    updated.cropRight = Math.max(0, Math.min(40, updated.cropRight ?? 0));
    updated.cropBottom = Math.max(0, Math.min(40, updated.cropBottom ?? 0));
    updated.cropLeft = Math.max(0, Math.min(40, updated.cropLeft ?? 0));
    updated.temperature = Math.max(-100, Math.min(100, updated.temperature ?? 0));
    updated.tint = Math.max(-100, Math.min(100, updated.tint ?? 0));
    updated.highlights = Math.max(-100, Math.min(100, updated.highlights ?? 0));
    updated.shadows = Math.max(-100, Math.min(100, updated.shadows ?? 0));
    updated.vibrance = Math.max(-100, Math.min(100, updated.vibrance ?? 0));
    updated.audioFadeIn = Math.max(0, Math.min(10, updated.audioFadeIn ?? 0));
    updated.audioFadeOut = Math.max(0, Math.min(10, updated.audioFadeOut ?? 0));
    updated.noiseReduction = Math.max(0, Math.min(100, updated.noiseReduction ?? 0));
    updated.eqLow = Math.max(-12, Math.min(12, updated.eqLow ?? 0));
    updated.eqMid = Math.max(-12, Math.min(12, updated.eqMid ?? 0));
    updated.eqHigh = Math.max(-12, Math.min(12, updated.eqHigh ?? 0));
    updated.compressor = Math.max(0, Math.min(100, updated.compressor ?? 0));
    updated.audioPan = Math.max(-100, Math.min(100, updated.audioPan ?? 0));
    updated.blendOpacity = Math.max(0, Math.min(100, updated.blendOpacity ?? 100));
    updated.chromaKeySimilarity = Math.max(1, Math.min(100, updated.chromaKeySimilarity ?? 18));
    updated.chromaKeyBlend = Math.max(0, Math.min(100, updated.chromaKeyBlend ?? 8));
    updated.maskWidth = Math.max(5, Math.min(100, updated.maskWidth ?? 82));
    updated.maskHeight = Math.max(5, Math.min(100, updated.maskHeight ?? 82));
    updated.maskFeather = Math.max(0, Math.min(30, updated.maskFeather ?? 0));
    updated.speedSegments = normalizeSpeedSegments(updated.speedSegments).map((segment) => ({ end: segment.end, rate: segment.rate }));
    updated.keyframes = (updated.keyframes ?? []).map((frame) => ({
      ...frame,
      time: Math.max(0, Math.min(clipLength(updated), frame.time)),
      value: frame.property === 'scale' ? Math.max(25, Math.min(300, frame.value))
        : frame.property === 'rotation' ? Math.max(-180, Math.min(180, frame.value))
          : frame.property === 'opacity' ? Math.max(0, Math.min(100, frame.value))
            : Math.max(-100, Math.min(100, frame.value)),
    }));
    commit(timelineClips.map((clip) => clip.id === selectedClip.id ? updated : clip));
  };

  const updateAnimatedProperty = (property: AnimatedProperty, value: number) => {
    if (!selectedClip) return;
    const hasAnimation = (selectedClip.keyframes ?? []).some((frame) => frame.property === property);
    const patch: Partial<TimelineClip> = { [property]: value };
    if (hasAnimation) patch.keyframes = upsertKeyframe(selectedClip.keyframes, property, selectedLocalTime, value);
    updateSelectedClip(patch);
  };

  const toggleKeyframe = (property: AnimatedProperty) => {
    if (!selectedClip) return;
    const keyframes = [...(selectedClip.keyframes ?? [])];
    const current = keyframes.find((frame) => frame.property === property && Math.abs(frame.time - selectedLocalTime) < 0.025);
    if (current) {
      const next = keyframes.filter((frame) => frame.id !== current.id);
      updateSelectedClip({ keyframes: next });
      setMessage(`Removed ${property} keyframe at ${fmt(selectedLocalTime)}.`);
      return;
    }
    let next = keyframes;
    const hasProperty = keyframes.some((frame) => frame.property === property);
    if (!hasProperty && selectedLocalTime > 0.025) {
      const baseValue = Number(selectedClip[property] ?? ANIMATED_DEFAULTS[property]);
      next = upsertKeyframe(next, property, 0, baseValue);
    }
    const value = clipAnimatedValue(selectedClip, property, selectedLocalTime, Number(selectedClip[property] ?? ANIMATED_DEFAULTS[property]));
    next = upsertKeyframe(next, property, selectedLocalTime, value);
    updateSelectedClip({ keyframes: next });
    setMessage(`Added ${property} keyframe at ${fmt(selectedLocalTime)}. Change the value at another playhead position to animate it.`);
  };

  const addMotionPathPoint = () => {
    if (!selectedClip) return;
    const x = clipAnimatedValue(selectedClip, 'positionX', selectedLocalTime, selectedClip.positionX ?? 0);
    const y = clipAnimatedValue(selectedClip, 'positionY', selectedLocalTime, selectedClip.positionY ?? 0);
    let keyframes = upsertKeyframe(selectedClip.keyframes, 'positionX', selectedLocalTime, x);
    keyframes = upsertKeyframe(keyframes, 'positionY', selectedLocalTime, y);
    updateSelectedClip({ keyframes });
    setMessage(`Motion path point added at ${fmt(selectedLocalTime)}. Move the playhead, reposition the clip, and add another point to trace the subject.`);
  };

  const updateKeyframeEasing = (frameId: string, easing: ClipKeyframe['easing']) => {
    if (!selectedClip) return;
    updateSelectedClip({ keyframes: (selectedClip.keyframes ?? []).map((frame) => frame.id === frameId ? { ...frame, easing } : frame) });
  };

  const addTextOverlay = (kind: TextOverlay['kind']) => {
    const overlay: TextOverlay = {
      id: uid(), kind, text: kind === 'title' ? 'Your title' : 'Subtitle text',
      start: playhead, duration: kind === 'title' ? 4 : 3.5, x: 50,
      y: kind === 'title' ? 42 : 84, fontSize: kind === 'title' ? 42 : 24,
      color: '#ffffff', background: kind === 'title' ? 'rgba(8,8,12,.18)' : 'rgba(8,8,12,.72)',
      bold: kind === 'title', align: 'center',
    };
    const next = [...textOverlays, overlay];
    commit(timelineClips, tracks, next);
    setSelectedClipId(null);
    setSelectedOverlayId(overlay.id);
    setTab('Text');
    setMessage(`${kind === 'title' ? 'Title' : 'Subtitle'} added at ${fmt(playhead)}.`);
  };

  const updateSelectedOverlay = (patch: Partial<Omit<TextOverlay, 'id'>>) => {
    if (!selectedOverlay) return;
    const next = textOverlays.map((overlay) => overlay.id === selectedOverlay.id ? { ...overlay, ...patch } : overlay);
    commit(timelineClips, tracks, next);
  };

  const deleteSelectedOverlay = () => {
    if (!selectedOverlay) return;
    commit(timelineClips, tracks, textOverlays.filter((overlay) => overlay.id !== selectedOverlay.id));
    setSelectedOverlayId(null);
    setMessage('Text overlay removed.');
  };

  const handleOverlayDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const overlayId = event.dataTransfer.getData('application/x-frameforge-overlay');
    if (!overlayId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const start = Math.max(0, (event.clientX - bounds.left) / zoom);
    commit(timelineClips, tracks, textOverlays.map((item) => item.id === overlayId ? { ...item, start } : item));
    setSelectedOverlayId(overlayId);
    setSelectedClipId(null);
  };

  const applySpeedPreset = (preset: 'normal' | 'slowmo' | 'ramp' | 'montage') => {
    if (!selectedClip) return;
    const presets: Record<typeof preset, SpeedSegment[]> = {
      normal: [],
      slowmo: [{ end: 35, rate: 0.5 }, { end: 70, rate: 0.65 }, { end: 100, rate: 1 }],
      ramp: [{ end: 30, rate: 0.65 }, { end: 65, rate: 1 }, { end: 100, rate: 2 }],
      montage: [{ end: 30, rate: 1.6 }, { end: 70, rate: 0.75 }, { end: 100, rate: 1.6 }],
    };
    updateSelectedClip({ speedSegments: presets[preset] });
    setMessage(preset === 'normal' ? 'Speed ramp removed.' : `Applied ${preset === 'slowmo' ? 'slow motion' : preset === 'ramp' ? 'speed ramp' : 'montage'} preset.`);
  };

  const addSubtitlesToTimeline = (items: Array<{ start: number; duration: number; text: string }>, sourceLabel: string) => {
    if (!items.length) { setMessage('No subtitle cues were found in that file.'); return; }
    const additions: TextOverlay[] = items.map((item) => ({
      id: uid(), kind: 'subtitle', text: item.text, start: Math.max(0, item.start), duration: Math.max(0.2, item.duration),
      x: 50, y: 84, fontSize: 24, color: '#ffffff', background: 'rgba(8,8,12,.72)', bold: false, align: 'center',
    }));
    commit(timelineClips, tracks, [...textOverlays, ...additions]);
    setTab('Text');
    setMessage(`Imported ${additions.length} subtitle cue(s) from ${sourceLabel}.`);
  };

  const importSubtitleFile = async (file?: File) => {
    if (!file) return;
    try { addSubtitlesToTimeline(parseSubtitleFile(await file.text()), file.name); }
    catch (error) { setMessage(`Could not import subtitles: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const exportSubtitles = () => {
    const cues = textOverlays.filter((item) => item.kind === 'subtitle' && item.text.trim());
    if (!cues.length) { setMessage('There are no subtitle cues to export.'); return; }
    const blob = new Blob([subtitlesToSrt(cues)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${projectName.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'FrameForge'}.srt`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(`Exported ${cues.length} subtitle cue(s) as SRT.`);
  };

  const generateCaptions = async () => {
    const source = assets.find((asset) => asset.id === captionAssetId) ?? (selectedAsset?.kind === 'video' ? selectedAsset : null);
    if (!source) { setMessage('Choose a video or audio asset for transcription first.'); return; }
    if (!window.frameforge?.isDesktop || !window.frameforge.transcribeMedia) {
      setMessage('Local Whisper transcription is available in the Windows desktop build. In web mode, import an SRT or VTT subtitle file.');
      return;
    }
    setGeneratingCaptions(true);
    try {
      setMessage(`Transcribing ${source.name} with Whisper ${captionModel}… The first run may download its model.`);
      const response = await window.frameforge.transcribeMedia({ bytes: new Uint8Array(await source.file.arrayBuffer()), fileName: source.name, model: captionModel, language: captionLanguage });
      if (response.error) throw new Error(response.error);
      const cues = parseSubtitleFile(response.srt ?? '');
      addSubtitlesToTimeline(cues, `Whisper (${source.name})`);
    } catch (error) {
      setMessage(`Transcription failed: ${error instanceof Error ? error.message : String(error)}. Install openai-whisper and FFmpeg, then try again.`);
    } finally { setGeneratingCaptions(false); }
  };

  const sampleTrackingColorFromPreview = (event: MouseEvent<HTMLDivElement>) => {
    if (!samplingTrackingColor) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) { setMessage('Move the playhead to a visible video frame before sampling.'); setSamplingTrackingColor(false); return; }
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(video.videoWidth - 1, Math.round((event.clientX - bounds.left) / bounds.width * video.videoWidth)));
    const y = Math.max(0, Math.min(video.videoHeight - 1, Math.round((event.clientY - bounds.top) / bounds.height * video.videoHeight)));
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) { setSamplingTrackingColor(false); return; }
    try {
      context.drawImage(video, x, y, 1, 1, 0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      setTrackingTargetColor(`#${[pixel[0], pixel[1], pixel[2]].map((part) => part.toString(16).padStart(2, '0')).join('')}`);
      setMessage('Tracking colour sampled from the preview. Start the colour tracker when ready.');
    } catch { setMessage('Could not sample this video frame. Try using the colour picker manually.'); }
    setSamplingTrackingColor(false);
  };

  const runColorTracker = async () => {
    if (!selectedClip || !selectedAsset || selectedAsset.kind !== 'video') { setMessage('Select a video clip before starting the tracker.'); return; }
    setTrackingBusy(true); setTrackingProgress(0);
    const trackerVideo = document.createElement('video');
    trackerVideo.muted = true; trackerVideo.preload = 'auto'; trackerVideo.src = selectedAsset.url;
    try {
      await new Promise<void>((resolve, reject) => {
        trackerVideo.onloadedmetadata = () => resolve();
        trackerVideo.onerror = () => reject(new Error('The source video could not be decoded.'));
      });
      const canvas = document.createElement('canvas');
      const width = 240; const height = Math.max(90, Math.round(width * trackerVideo.videoHeight / Math.max(1, trackerVideo.videoWidth)));
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas pixel access is unavailable.');
      const target = colorToRgb(trackingTargetColor);
      const threshold = Math.max(12, trackingTolerance);
      const sourceDuration = selectedClip.sourceEnd - selectedClip.sourceStart;
      const samples = Math.min(56, Math.max(10, Math.ceil(sourceDuration / 0.35)));
      const step = sourceDuration / Math.max(1, samples - 1);
      const found: Array<{ time: number; x: number; y: number }> = [];
      const seekFrame = async (time: number) => {
        if (Math.abs(trackerVideo.currentTime - time) < 0.01 && trackerVideo.readyState >= 2) return;
        await new Promise<void>((resolve, reject) => {
          const onSeeked = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error('A video frame could not be decoded.')); };
          const cleanup = () => { trackerVideo.removeEventListener('seeked', onSeeked); trackerVideo.removeEventListener('error', onError); };
          trackerVideo.addEventListener('seeked', onSeeked, { once: true }); trackerVideo.addEventListener('error', onError, { once: true });
          trackerVideo.currentTime = time;
        });
      };
      for (let sample = 0; sample < samples; sample += 1) {
        const sourceOffset = Math.min(sourceDuration, sample * step);
        await seekFrame(Math.min(selectedClip.sourceEnd - 0.02, selectedClip.sourceStart + sourceOffset));
        context.drawImage(trackerVideo, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        let count = 0; let sumX = 0; let sumY = 0;
        for (let y = 0; y < height; y += 2) {
          for (let x = 0; x < width; x += 2) {
            const offset = (y * width + x) * 4;
            if (pixels[offset + 3] < 80) continue;
            const dr = pixels[offset] - target[0]; const dg = pixels[offset + 1] - target[1]; const db = pixels[offset + 2] - target[2];
            if (Math.sqrt(dr * dr + dg * dg + db * db) <= threshold) { count += 1; sumX += x; sumY += y; }
          }
        }
        if (count >= 8) {
          found.push({
            time: timelineOffsetAtSourceTime(sourceDuration, selectedClip.playbackRate ?? 1, selectedClip.speedSegments, sourceOffset),
            x: ((sumX / count) / width - 0.5) * 200,
            y: ((sumY / count) / height - 0.5) * 200,
          });
        }
        setTrackingProgress(Math.round((sample + 1) / samples * 100));
      }
      if (found.length < 2) throw new Error('The selected colour was not found consistently. Try sampling a more distinct colour or increasing tolerance.');
      let keyframes = [...(selectedClip.keyframes ?? [])];
      for (const point of found) {
        keyframes = upsertKeyframe(keyframes, 'positionX', point.time, Math.max(-100, Math.min(100, point.x)));
        keyframes = upsertKeyframe(keyframes, 'positionY', point.time, Math.max(-100, Math.min(100, point.y)));
      }
      updateSelectedClip({ keyframes });
      setMessage(`Colour tracker added ${found.length} motion points. This is colour-based tracking; inspect and adjust the keyframes if the subject overlaps similar colours.`);
    } catch (error) {
      setMessage(`Motion tracking failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      trackerVideo.pause(); trackerVideo.removeAttribute('src'); trackerVideo.load();
      setTrackingBusy(false); setTrackingProgress(0);
    }
  };

  const splitSelected = () => {
    if (!selectedClip) { setMessage('Select a timeline clip to split.'); return; }
    const offset = playhead - selectedClip.position;
    if (offset <= 0.05 || offset >= clipLength(selectedClip) - 0.05) {
      setMessage('Move the playhead inside the selected clip before splitting.');
      return;
    }
    const sourceSplit = selectedClip.sourceStart + offset * (selectedClip.playbackRate ?? 1);
    const left: TimelineClip = { ...selectedClip, sourceEnd: sourceSplit };
    const right: TimelineClip = { ...selectedClip, id: uid(), position: playhead, sourceStart: sourceSplit };
    commit(timelineClips.flatMap((clip) => clip.id === selectedClip.id ? [left, right] : [clip]));
    setSelectedClipId(right.id);
    setSelectedOverlayId(null);
    setMessage('Clip split at the playhead.');
  };

  const deleteSelected = (ripple = false) => {
    if (!selectedClip) { setMessage('Select a clip to remove.'); return; }
    const deletedLength = clipLength(selectedClip);
    const deletedEnd = selectedClip.position + deletedLength;
    const next = timelineClips
      .filter((clip) => clip.id !== selectedClip.id)
      .map((clip) => ripple && clip.trackId === selectedClip.trackId && clip.position >= deletedEnd - 0.001
        ? { ...clip, position: Math.max(selectedClip.position, clip.position - deletedLength) }
        : clip);
    commit(next);
    setSelectedClipId(null);
    setMessage(ripple ? 'Clip removed and following clips rippled left on its track.' : 'Clip removed. Timeline gap preserved.');
  };

  const addTrack = (kind: MediaKind) => {
    const count = tracks.filter((track) => track.kind === kind).length + 1;
    const track: Track = { id: uid(), kind, name: `${kind === 'video' ? 'V' : 'A'}${count}`, muted: false, hidden: false, locked: false };
    const next = kind === 'video' ? [track, ...tracks] : [...tracks, track];
    commit(timelineClips, next);
    setMessage(`${track.name} ${kind} track added.`);
  };

  const toggleTrackFlag = (trackId: string, flag: 'muted' | 'hidden' | 'locked') => {
    const nextTracks = tracks.map((track) => track.id === trackId ? { ...track, [flag]: !track[flag] } : track);
    commit(timelineClips, nextTracks);
  };

  const seek = (seconds: number) => setPlayhead(Math.max(0, Math.min(totalDuration, seconds)));
  const togglePlayback = async () => {
    if (playing) { setPlaying(false); return; }
    if (!timelineClips.length) { setMessage('Add a clip to the timeline before playback.'); return; }
    if (playhead >= totalDuration) { setPlayhead(0); setPlaying(true); return; }
    if (!previewVideo && !previewAudio) {
      const next = timelineClips.filter((clip) => clip.position >= playhead).sort((a, b) => a.position - b.position)[0];
      if (!next) { setMessage('There are no clips after the current playhead.'); return; }
      setPlayhead(next.position + 0.001);
    }
    setPlaying(true);
  };

  useEffect(() => {
    const node = videoRef.current;
    if (!node) return;
    if (!previewVideo) {
      node.pause();
      return;
    }
    const asset = assets.find((item) => item.id === previewVideo.assetId);
    if (!asset) return;
    if (node.dataset.assetId !== asset.id) {
      node.src = asset.url;
      node.dataset.assetId = asset.id;
    }
    const localTime = Math.max(0, playhead - previewVideo.position);
    const sourceOffset = sourceOffsetAtTimelineTime(previewVideo.sourceEnd - previewVideo.sourceStart, previewVideo.playbackRate ?? 1, previewVideo.speedSegments, localTime);
    const sourceTime = previewVideo.sourceStart + sourceOffset;
    node.playbackRate = speedAtTimelineTime(previewVideo.sourceEnd - previewVideo.sourceStart, previewVideo.playbackRate ?? 1, previewVideo.speedSegments, localTime);
    node.volume = Math.max(0, Math.min(1, (previewVideo.volume ?? 1) * clipFadeGain(previewVideo, playhead)));
    if (Number.isFinite(sourceTime) && Math.abs(node.currentTime - sourceTime) > 0.35) node.currentTime = sourceTime;
    if (playing) void node.play().catch(() => setMessage('This video format could not be played by the browser.'));
    else node.pause();
  }, [assets, playhead, playing, previewVideo?.id, previewVideo?.assetId, previewVideo?.playbackRate, previewVideo?.speedSegments, previewVideo?.volume, previewVideo?.audioFadeIn, previewVideo?.audioFadeOut]);

  useEffect(() => {
    const node = audioRef.current;
    if (!node) return;
    if (!previewAudio) { node.pause(); return; }
    const asset = assets.find((item) => item.id === previewAudio.assetId);
    if (!asset) return;
    if (node.dataset.assetId !== asset.id) {
      node.src = asset.url;
      node.dataset.assetId = asset.id;
    }
    const localTime = Math.max(0, playhead - previewAudio.position);
    const sourceOffset = sourceOffsetAtTimelineTime(previewAudio.sourceEnd - previewAudio.sourceStart, previewAudio.playbackRate ?? 1, previewAudio.speedSegments, localTime);
    const sourceTime = previewAudio.sourceStart + sourceOffset;
    node.playbackRate = speedAtTimelineTime(previewAudio.sourceEnd - previewAudio.sourceStart, previewAudio.playbackRate ?? 1, previewAudio.speedSegments, localTime);
    node.volume = Math.max(0, Math.min(1, (previewAudio.volume ?? 1) * clipFadeGain(previewAudio, playhead)));
    if (Number.isFinite(sourceTime) && Math.abs(node.currentTime - sourceTime) > 0.4) node.currentTime = sourceTime;
    node.muted = tracks.find((track) => track.id === previewAudio.trackId)?.muted ?? false;
    if (playing) void node.play().catch(() => setMessage('This audio format could not be played by the browser.'));
    else node.pause();
  }, [assets, playhead, playing, previewAudio?.id, previewAudio?.assetId, previewAudio?.playbackRate, previewAudio?.speedSegments, previewAudio?.volume, previewAudio?.audioFadeIn, previewAudio?.audioFadeOut, tracks]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const v = videoRef.current;
      const a = audioRef.current;
      if (previewVideo && v && !v.paused && Number.isFinite(v.currentTime)) {
        const nextTime = previewVideo.position + timelineOffsetAtSourceTime(previewVideo.sourceEnd - previewVideo.sourceStart, previewVideo.playbackRate ?? 1, previewVideo.speedSegments, v.currentTime - previewVideo.sourceStart);
        setPlayhead(Math.min(previewVideo.position + clipLength(previewVideo), nextTime));
      } else if (!previewVideo && previewAudio && a && !a.paused && Number.isFinite(a.currentTime)) {
        const nextTime = previewAudio.position + timelineOffsetAtSourceTime(previewAudio.sourceEnd - previewAudio.sourceStart, previewAudio.playbackRate ?? 1, previewAudio.speedSegments, a.currentTime - previewAudio.sourceStart);
        setPlayhead(Math.min(previewAudio.position + clipLength(previewAudio), nextTime));
      } else if (!previewVideo && !previewAudio) {
        setPlaying(false);
      }
    }, 80);
    return () => window.clearInterval(timer);
  }, [playing, previewVideo?.id, previewVideo?.playbackRate, previewAudio?.id, previewAudio?.playbackRate]);

  useEffect(() => {
    if (!playing) return;
    const end = previewVideo ? previewVideo.position + clipLength(previewVideo) : previewAudio ? previewAudio.position + clipLength(previewAudio) : 0;
    if (end > 0 && playhead >= end - 0.03) {
      const candidates = timelineClips
        .filter((clip) => clip.id !== (previewVideo?.id ?? previewAudio?.id) && clip.position >= end - 0.001)
        .sort((a, b) => a.position - b.position);
      if (candidates.length) setPlayhead(candidates[0].position + 0.001);
      else if (playhead >= totalDuration - 0.03) setPlaying(false);
    }
  }, [playhead, playing, previewVideo?.id, previewAudio?.id, timelineClips, totalDuration]);

  const onVideoTimeUpdate = () => {
    if (!playing || !previewVideo || !videoRef.current) return;
    if (videoRef.current.currentTime >= previewVideo.sourceEnd - 0.04) {
      const next = timelineClips
        .filter((clip) => clip.id !== previewVideo.id && clip.position >= previewVideo.position + clipLength(previewVideo) - 0.001)
        .sort((a, b) => a.position - b.position)[0];
      if (next) setPlayhead(next.position + 0.001);
      else setPlaying(false);
    }
  };

  const saveProject = async () => {
    try {
      setMessage('Preparing project file and embedding source media…');
      const projectAssets: ProjectAsset[] = await Promise.all(assets.map(async (asset) => ({
        id: asset.id, name: asset.name, mime: asset.mime, duration: asset.duration, kind: asset.kind,
        data: bytesToBase64(await asset.file.arrayBuffer()), ...(asset.waveform ? { waveform: asset.waveform } : {}),
      })));
      const project: ProjectFile = { format: 'frameforge-project', version: 5, name: projectName, assets: projectAssets, tracks, clips: timelineClips.map(normalizeClip), overlays: textOverlays, audioVisualizer, playhead };
      const serialized = JSON.stringify(project);
      rememberRecentProject(projectName, assets.length);
      if (window.frameforge?.saveProject) {
        const result = await window.frameforge.saveProject(serialized);
        if (result.error) throw new Error(result.error);
        if (!result.canceled) setMessage(`Project saved: ${result.filePath}`);
      } else {
        const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${projectName.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'Untitled Project'}.ffproj`;
        anchor.click();
        URL.revokeObjectURL(url);
        setMessage('Project file downloaded. Keep the .ffproj file to reopen your edit.');
      }
    } catch (error) {
      setMessage(`Could not save project: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const loadProjectText = (serialized: string) => {
    const project = JSON.parse(serialized) as ProjectFile;
    if (project.format !== 'frameforge-project' || ![1, 2, 3, 4, 5].includes(project.version) || !Array.isArray(project.assets) || !Array.isArray(project.clips) || !Array.isArray(project.tracks)) {
      throw new Error('This is not a supported FrameForge project file.');
    }
    assets.forEach((asset) => URL.revokeObjectURL(asset.url));
    const restoredAssets: MediaAsset[] = project.assets.map((asset) => {
      const bytes = base64ToBytes(asset.data);
      const mediaBlob = new Blob([bytes.buffer as ArrayBuffer], { type: asset.mime });
      const file = new File([mediaBlob], asset.name, { type: asset.mime });
      return { id: asset.id, name: asset.name, file, url: URL.createObjectURL(file), duration: asset.duration, kind: asset.kind, mime: asset.mime, waveform: asset.waveform ?? [] };
    });
    const restoredTracks = project.tracks.length ? project.tracks : initialTracks;
    setAssets(restoredAssets);
    setTracks(restoredTracks);
    const restoredClips = project.clips.map(normalizeClip);
    const restoredOverlays = Array.isArray(project.overlays) ? project.overlays : [];
    setTimelineClips(restoredClips);
    setTextOverlays(restoredOverlays);
    setAudioVisualizer({ ...defaultVisualizer, ...(project.audioVisualizer ?? {}) });
    setHistory([{ clips: restoredClips, tracks: restoredTracks, overlays: restoredOverlays }]);
    setHistoryIndex(0);
    setSelectedClipId(null);
    setSelectedOverlayId(null);
    setPlayhead(Number(project.playhead) || 0);
    setPlaying(false);
    setProjectName(project.name || 'Untitled Project');
    rememberRecentProject(project.name || 'Untitled Project', restoredAssets.length);
    setScreen('editor');
    setMessage(`Project “${project.name || 'Untitled Project'}” opened with ${restoredAssets.length} media file(s) and ${restoredOverlays.length} text overlay(s).`);
  };

  const openProject = async (file?: File) => {
    try {
      if (window.frameforge?.openProject && !file) {
        const result = await window.frameforge.openProject();
        if (result.error) throw new Error(result.error);
        if (!result.canceled && result.content) loadProjectText(result.content);
      } else if (file) {
        loadProjectText(await file.text());
      } else {
        projectPickerRef.current?.click();
      }
    } catch (error) {
      setMessage(`Could not open project: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportSelected = async () => {
    if (!selectedClip || !selectedAsset) { setMessage('Select a clip to export its trimmed source.'); return; }
    setExporting(true);
    try {
      if (window.frameforge?.isDesktop) {
        setMessage('Exporting selected clip with FFmpeg…');
        const bytes = new Uint8Array(await selectedAsset.file.arrayBuffer());
        const result = await window.frameforge.exportNative({ bytes, extension: selectedAsset.name.split('.').pop() || 'mp4', start: selectedClip.sourceStart, duration: clipLength(selectedClip), kind: selectedAsset.kind, speed: selectedClip.playbackRate ?? 1, volume: selectedClip.volume ?? 1, filter: selectedClip.filter ?? 'none', brightness: selectedClip.brightness ?? 0, contrast: selectedClip.contrast ?? 100, saturation: selectedClip.saturation ?? 100, audioFadeIn: selectedClip.audioFadeIn ?? 0, audioFadeOut: selectedClip.audioFadeOut ?? 0, noiseReduction: selectedClip.noiseReduction ?? 0, eqLow: selectedClip.eqLow ?? 0, eqMid: selectedClip.eqMid ?? 0, eqHigh: selectedClip.eqHigh ?? 0, compressor: selectedClip.compressor ?? 0, audioPan: selectedClip.audioPan ?? 0 });
        if (result.error) throw new Error(result.error);
        if (!result.canceled) setMessage(`Selected clip exported: ${result.filePath}`);
        return;
      }
      const engine = ffmpegRef.current ?? new FFmpeg();
      ffmpegRef.current = engine;
      if (!engine.loaded) {
        setMessage('Loading browser video engine…');
        const base = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
        await engine.load({ coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'), wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm') });
      }
      const ext = selectedAsset.name.split('.').pop()?.toLowerCase() || 'mp4';
      await engine.writeFile(`input.${ext}`, await fetchFile(selectedAsset.file));
      const speed = selectedClip.playbackRate ?? 1;
      const vFilters = [`setpts=PTS/${speed}`, presetFfmpeg[selectedClip.filter ?? 'none'], `eq=brightness=${(selectedClip.brightness ?? 0) / 100}:contrast=${(selectedClip.contrast ?? 100) / 100}:saturation=${(selectedClip.saturation ?? 100) / 100}`].filter(Boolean).join(',');
      const fadeIn = Math.max(0, Math.min(clipLength(selectedClip), selectedClip.audioFadeIn ?? 0));
      const fadeOut = Math.max(0, Math.min(clipLength(selectedClip), selectedClip.audioFadeOut ?? 0));
      const pan = Math.max(-100, Math.min(100, selectedClip.audioPan ?? 0)) / 100;
      const leftGain = pan > 0 ? 1 - pan : 1;
      const rightGain = pan < 0 ? 1 + pan : 1;
      const aFilters = [
        'aformat=sample_rates=48000:channel_layouts=stereo',
        (selectedClip.noiseReduction ?? 0) > 0 ? `afftdn=nr=${Math.max(0.1, (selectedClip.noiseReduction ?? 0) * 0.24)}:nf=-35` : '',
        (selectedClip.eqLow ?? 0) !== 0 ? `equalizer=f=100:t=q:w=1:g=${selectedClip.eqLow}` : '',
        (selectedClip.eqMid ?? 0) !== 0 ? `equalizer=f=1000:t=q:w=1:g=${selectedClip.eqMid}` : '',
        (selectedClip.eqHigh ?? 0) !== 0 ? `equalizer=f=8000:t=q:w=1:g=${selectedClip.eqHigh}` : '',
        (selectedClip.compressor ?? 0) > 0 ? `acompressor=threshold=-24dB:ratio=${1 + (selectedClip.compressor ?? 0) * 0.05}:attack=20:release=250:makeup=1.5` : '',
        `atempo=${speed}`, `volume=${selectedClip.volume ?? 1}`,
        pan ? `pan=stereo|c0=${leftGain}*c0|c1=${rightGain}*c1` : '',
        fadeIn > 0 ? `afade=t=in:st=0:d=${fadeIn}` : '',
        fadeOut > 0 ? `afade=t=out:st=${Math.max(0, clipLength(selectedClip) - fadeOut)}:d=${fadeOut}` : '',
      ].filter(Boolean).join(',');
      const args = ['-ss', String(selectedClip.sourceStart), '-i', `input.${ext}`, '-t', String(clipLength(selectedClip))];
      if (selectedAsset.kind === 'video') args.push('-vf', vFilters, '-c:v', 'libx264'); else args.push('-vn');
      args.push('-af', aFilters, '-c:a', 'aac', '-preset', 'ultrafast', 'output.mp4');
      await engine.exec(args);
      const data = await engine.readFile('output.mp4');
      const outputBlob = data instanceof Uint8Array
        ? new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: 'video/mp4' })
        : new Blob([data], { type: 'video/mp4' });
      const url = URL.createObjectURL(outputBlob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'frameforge-clip-export.mp4'; anchor.click(); URL.revokeObjectURL(url);
      setMessage('Selected clip export complete with its speed, volume and colour settings.');
    } catch (error) {
      setMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setExporting(false); }
  };

  const exportTimeline = async () => {
    if (!timelineClips.length && !textOverlays.some((overlay) => overlay.text.trim())) {
      setMessage('Add clips or timed text to the timeline before exporting.');
      return;
    }
    setExporting(true);
    setExportProgress(0);
    try {
      const dimensions: Record<string, { width: number; height: number }> = {
        '720p': { width: 1280, height: 720 },
        '1080p': { width: 1920, height: 1080 },
        '1440p': { width: 2560, height: 1440 },
        '4K': { width: 3840, height: 2160 },
      };
      const videoAssetIds = new Set(timelineClips
        .filter((clip) => assets.some((asset) => asset.id === clip.assetId && asset.kind === 'video') && tracks.some((track) => track.id === clip.trackId && track.kind === 'video' && !track.hidden))
        .map((clip) => clip.assetId));
      let audioAssetIds = new Set(assets.filter((asset) => asset.kind === 'audio').map((asset) => asset.id));

      const native = window.frameforge;
      if (native?.isDesktop) {
        if (!native.exportTimeline) throw new Error('The desktop renderer API is unavailable. Restart the FrameForge desktop app.');
        if (videoAssetIds.size && native.probeMediaAudio) {
          setMessage('Checking source audio streams…');
          const probeAssets = await Promise.all(assets.filter((asset) => videoAssetIds.has(asset.id)).map(async (asset) => ({
            id: asset.id,
            name: asset.name,
            bytes: new Uint8Array(await asset.file.arrayBuffer()),
          })));
          const probe = await native.probeMediaAudio(probeAssets);
          if (probe.error) throw new Error(probe.error);
          audioAssetIds = new Set([...audioAssetIds, ...(probe.audioAssetIds ?? [])]);
        }
        const nativeFonts = textOverlays.some((overlay) => overlay.text.trim())
          ? await native.getRenderFonts?.()
          : undefined;
        const plan = buildRenderPlan({ assets, tracks, clips: timelineClips, overlays: textOverlays, audioAssetIds, visualizer: audioVisualizer, options: { ...dimensions[exportResolution], fps: exportFps, quality: exportQuality, ...(nativeFonts ? { fontFiles: nativeFonts } : {}) } });
        setMessage(`Rendering ${plan.videoClipCount} video clip(s), ${plan.audioClipCount} audio clip(s), and ${plan.overlayCount} text overlay(s)…`);
        const files: Array<{ name: string; data: Uint8Array | string }> = await Promise.all(plan.mediaFiles.map(async ({ name, file }) => ({ name, data: new Uint8Array(await file.arrayBuffer()) })));
        files.push(...plan.textFiles.map(({ name, content }) => ({ name, data: content })));
        const stopProgress = native.onRenderProgress?.((progress) => setExportProgress(progress));
        try {
          const result = await native.exportTimeline({ files, args: plan.args, duration: plan.duration, projectName });
          if (result.error) throw new Error(result.error);
          if (!result.canceled) {
            setExportProgress(100);
            setMessage(`Full timeline exported: ${result.filePath}`);
            setShowExportSettings(false);
          }
        } finally {
          stopProgress?.();
        }
      } else {
        const engine = ffmpegRef.current ?? new FFmpeg();
        ffmpegRef.current = engine;
        if (!engine.loaded) {
          setMessage('Loading browser rendering engine…');
          const base = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
          await engine.load({ coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'), wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm') });
        }
        if (textOverlays.some((overlay) => overlay.text.trim())) {
          setMessage('Loading title and subtitle fonts…');
          await loadWasmFonts(engine, textOverlays.some((overlay) => /[\u0D00-\u0D7F]/.test(overlay.text)));
        }
        const preliminary = buildRenderPlan({ assets, tracks, clips: timelineClips, overlays: textOverlays, audioAssetIds: new Set(assets.filter((asset) => asset.kind === 'audio').map((asset) => asset.id)), visualizer: audioVisualizer, options: { ...dimensions[exportResolution], fps: exportFps, quality: exportQuality, fontFiles: WASM_FONT_FILES } });
        setMessage('Preparing media for browser rendering…');
        for (const source of preliminary.mediaFiles) {
          try { await engine.deleteFile(source.name); } catch { /* File not present yet. */ }
          await engine.writeFile(source.name, await fetchFile(source.file));
        }
        // Probe audio streams through the WASM FFmpeg log so silent video files do not break the mix graph.
        const detectedAudio = new Set<string>(assets.filter((asset) => asset.kind === 'audio').map((asset) => asset.id));
        for (const source of preliminary.mediaFiles) {
          const asset = assets.find((item) => item.id === source.assetId);
          if (!asset || asset.kind !== 'video') continue;
          const logLines: string[] = [];
          const onLog = ({ message: logMessage }: { message: string }) => logLines.push(logMessage);
          engine.on('log', onLog);
          try {
            await engine.exec(['-hide_banner', '-i', source.name, '-map', '0:a:0?', '-t', '0.01', '-f', 'null', '-']);
          } catch { /* A source without an audio stream can return a non-zero probe result. */ }
          finally { engine.off('log', onLog); }
          if (logLines.some((line) => /Stream #\d+:\d+(?:\([^)]*\))?: Audio:/i.test(line))) detectedAudio.add(asset.id);
        }
        const plan = buildRenderPlan({ assets, tracks, clips: timelineClips, overlays: textOverlays, audioAssetIds: detectedAudio, visualizer: audioVisualizer, options: { ...dimensions[exportResolution], fps: exportFps, quality: exportQuality, fontFiles: WASM_FONT_FILES } });
        for (const textFile of plan.textFiles) {
          try { await engine.deleteFile(textFile.name); } catch { /* File not present yet. */ }
          await engine.writeFile(textFile.name, new TextEncoder().encode(textFile.content));
        }
        setMessage(`Rendering ${plan.videoClipCount} video clip(s), ${plan.audioClipCount} audio clip(s), and ${plan.overlayCount} text overlay(s)…`);
        const onProgress = ({ progress }: { progress: number }) => setExportProgress(Math.max(0, Math.min(99, Math.round(progress * 100))));
        engine.on('progress', onProgress);
        try {
          const args = plan.args.map((arg) => arg === '__FRAMEFORGE_OUTPUT__' ? 'frameforge-render.mp4' : arg);
          const code = await engine.exec(args);
          if (code !== 0) throw new Error(`FFmpeg returned exit code ${code}. Check the source media formats and try again.`);
        } finally { engine.off('progress', onProgress); }
        const data = await engine.readFile('frameforge-render.mp4');
        const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
        const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${projectName.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'FrameForge'}-export.mp4`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setExportProgress(100);
        setMessage('Full timeline export complete. Browser builds mix dedicated audio clips and embedded video audio when detected.');
        setShowExportSettings(false);
      }
    } catch (error) {
      setMessage(`Timeline export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
      window.setTimeout(() => setExportProgress(0), 1200);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
      else if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); void saveProject(); }
      else if (mod && event.key.toLowerCase() === 'o') { event.preventDefault(); void openProject(); }
      else if (event.code === 'Space') { event.preventDefault(); void togglePlayback(); }
      else if (event.key.toLowerCase() === 's') { event.preventDefault(); splitSelected(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); if (selectedOverlayId) deleteSelectedOverlay(); else deleteSelected(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const selectedTrack = selectedClip ? tracks.find((track) => track.id === selectedClip.trackId) : null;
  const previewLocalTime = previewVideo ? Math.max(0, playhead - previewVideo.position) : 0;
  const previewTransition = previewVideo ? clipTransitionStyle(previewVideo, playhead) : {};
  const previewStyle = previewVideo ? {
    filter: clipFilterCss(previewVideo),
    ...previewTransition,
    transform: `${typeof previewTransition.transform === 'string' ? previewTransition.transform : ''} translate(${clipAnimatedValue(previewVideo, 'positionX', previewLocalTime, previewVideo.positionX ?? 0)}%, ${clipAnimatedValue(previewVideo, 'positionY', previewLocalTime, previewVideo.positionY ?? 0)}%) rotate(${clipAnimatedValue(previewVideo, 'rotation', previewLocalTime, previewVideo.rotation ?? 0)}deg) scale(${clipAnimatedValue(previewVideo, 'scale', previewLocalTime, previewVideo.scale ?? 100) / 100})`,
    opacity: (typeof previewTransition.opacity === 'number' ? previewTransition.opacity : 1) * clipAnimatedValue(previewVideo, 'opacity', previewLocalTime, previewVideo.opacity ?? 100) / 100,
    clipPath: previewVideo.maskShape === 'ellipse' ? `ellipse(${(previewVideo.maskWidth ?? 82) / 2}% ${(previewVideo.maskHeight ?? 82) / 2}% at 50% 50%)` : previewVideo.maskShape === 'rectangle' ? `inset(${(100 - (previewVideo.maskHeight ?? 82)) / 2}% ${(100 - (previewVideo.maskWidth ?? 82)) / 2}%)` : (typeof previewTransition.clipPath === 'string' ? previewTransition.clipPath : `inset(${previewVideo.cropTop ?? 0}% ${previewVideo.cropRight ?? 0}% ${previewVideo.cropBottom ?? 0}% ${previewVideo.cropLeft ?? 0}%)`),
    transformOrigin: 'center center',
  } as CSSProperties : undefined;

  if (screen === 'splash') return (
    <div className="splash-screen">
      <div className="splash-glow splash-glow-one" /><div className="splash-glow splash-glow-two" />
      <div className="splash-brand-mark"><Aperture size={46} strokeWidth={1.35} /></div>
      <div className="splash-wordmark">FRAME<span>FORGE</span></div>
      <div className="splash-tagline">CREATE WITHOUT LIMITS</div>
      <div className="splash-loader"><i /></div>
      <div className="splash-version">VIDEO EDITOR · VERSION 1.6.0</div>
    </div>
  );

  if (screen === 'home') return (
    <div className="home-screen">
      <div className="home-topbar">
        <div className="brand"><div className="brand-icon"><Aperture size={19} /></div><span>FRAME<span className="brand-accent">FORGE</span></span><span className="version">1.6.0</span></div>
        <div className="home-top-right"><span className="home-edition">VIDEO EDITOR</span><button className="home-settings" title="About FrameForge" onClick={() => setMessage('FrameForge 1.6.0 · Windows and Web edition')}>About</button></div>
      </div>
      <main className="home-content">
        <section className="home-welcome">
          <div className="home-eyebrow"><span /> YOUR CREATIVE WORKSPACE</div>
          <h1>Make something<br /><em>remarkable.</em></h1>
          <p>Pick up where you left off, or start a fresh project.</p>
          <div className="home-actions">
            <button className="home-primary" onClick={createNewProject}><FilePlus2 size={18} /><span><b>New project</b><small>Start editing from scratch</small></span><span className="home-shortcut">NEW</span></button>
            <button className="home-secondary" onClick={() => void openProject()}><FolderOpen size={18} /><span><b>Open project</b><small>Continue a .ffproj project</small></span></button>
          </div>
        </section>
        <section className="home-projects">
          <div className="home-section-heading"><div><span className="home-eyebrow">YOUR WORK</span><h2>Recent projects</h2></div><span className="home-project-count">{recentProjects.length} {recentProjects.length === 1 ? 'PROJECT' : 'PROJECTS'}</span></div>
          {recentProjects.length ? <div className="recent-project-list">{recentProjects.map((project, index) => <button className="recent-project" key={`${project.name}-${project.openedAt}-${index}`} onClick={() => void openProject()}><span className="recent-project-thumb"><Film size={22} /><i>{String(index + 1).padStart(2, '0')}</i></span><span className="recent-project-info"><b>{project.name}</b><small>{project.mediaCount} media files · {new Date(project.openedAt).toLocaleDateString()} · click to locate file</small></span><span className="recent-project-open">OPEN <ChevronDown size={13} /></span></button>)}</div> : <div className="home-empty"><div className="home-empty-icon"><Clapperboard size={25} /></div><b>No recent projects yet</b><span>Your projects will appear here after you save or open them.</span></div>}
        </section>
      </main>
      <footer className="home-footer"><span>FRAMEFORGE 1.6.0</span><span>DESIGNED FOR CREATORS</span><span>WINDOWS · WEB</span></footer>
      <input ref={projectPickerRef} type="file" accept=".ffproj,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void openProject(file); event.target.value = ''; }} />
      {message !== 'Ready. Import media or drag it onto a timeline track.' && <div className="home-toast">{message}</div>}
    </div>
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-icon"><Aperture size={19} /></div><span>FRAME<span className="brand-accent">FORGE</span></span><span className="version">V1.6.0</span></div>
        <div className="project-name-wrap"><input className="project-name-input" value={projectName} onChange={(event) => setProjectName(event.target.value)} aria-label="Project name" /><ChevronDown size={14} /></div>
        <div className="top-actions">
          <button className="secondary-btn home-return-btn" onClick={() => setScreen('home')} title="Return to project manager"><Aperture size={14} /> Home</button>
          <button className="icon-btn" title="Keyboard shortcuts" onClick={() => setShowShortcuts(true)}><Keyboard size={17} /></button>
          <button className="secondary-btn" onClick={() => void openProject()}><FolderOpen size={15} /> Open</button>
          <button className="secondary-btn" onClick={() => void saveProject()}><Save size={15} /> Save project</button>
          <button className="export-btn" onClick={() => setShowExportSettings(true)} disabled={exporting || (!timelineClips.length && !textOverlays.length)}><Download size={16} />{exporting ? `Rendering ${exportProgress}%` : 'Export timeline'}</button>
        </div>
      </header>

      <main className="workspace">
        <aside className="media-panel">
          <input ref={projectPickerRef} type="file" accept=".ffproj,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void openProject(file); event.target.value = ''; }} />
          <div className="panel-tabs">{['Media', 'Effects', 'Text', 'Audio', 'AI Studio'].map((item) => <button key={item} className={tab === item ? 'selected' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
          {tab === 'Media' ? <>
            <div className="media-heading">PROJECT MEDIA <button className="tiny-icon" onClick={() => pickerRef.current?.click()} title="Import media"><Plus size={16} /></button></div>
            <button className="import-card" onClick={() => pickerRef.current?.click()}><Upload size={22} /><b>Import media</b><span>Video and audio · MP4, MOV, MP3, WAV…</span></button>
            <input ref={pickerRef} type="file" accept="video/*,audio/*" multiple hidden onChange={(event) => { void importFiles(event.target.files); event.target.value = ''; }} />
            <div className="asset-list">{assets.map((asset) => <div key={asset.id} className="asset" draggable onDragStart={(event) => { event.dataTransfer.setData('application/x-frameforge-asset', asset.id); event.dataTransfer.effectAllowed = 'copy'; }} onDoubleClick={() => addAssetToTimeline(asset.id)}>
              <div className={`asset-thumb ${asset.kind}`}><span>{asset.kind === 'video' ? <Film size={18} /> : <AudioLines size={18} />}</span></div>
              <div className="asset-info"><b title={asset.name}>{asset.name}</b><span>{asset.kind.toUpperCase()} · {fmt(asset.duration)}</span></div>
              <button className="asset-add" title="Add to timeline" onClick={() => addAssetToTimeline(asset.id)}><Plus size={15} /></button>
            </div>)}</div>
            {!assets.length && <div className="media-empty"><Layers3 size={24} /><b>No media yet</b><span>Import a file, then drag it onto V1 or A1.</span></div>}
          </> : tab === 'Effects' ? <div className="tool-pane">
            <div className="media-heading">COLOUR PRESETS</div>
            <div className="preset-grid">{(['cinematic', 'vivid', 'mono', 'warm', 'cool', 'vintage', 'noir'] as FilterPreset[]).map((preset) => <button key={preset} className="preset-card" disabled={!selectedClip || selectedAsset?.kind !== 'video'} onClick={() => selectedClip && selectedAsset?.kind === 'video' && updateSelectedClip({ filter: preset })}><span className={`preset-swatch ${preset}`} /><b>{preset}</b></button>)}</div>
            <div className="tool-note">Select a video clip, then choose a look. Fine adjustments are available in the Inspector.</div>
            <div className="media-heading">TRANSITIONS</div>
            <div className="transition-list">{(['none', 'fade', 'wipe', 'zoom'] as TransitionPreset[]).map((transition) => <button key={transition} className="preset-row" disabled={!selectedClip || selectedAsset?.kind !== 'video'} onClick={() => selectedClip && selectedAsset?.kind === 'video' && updateSelectedClip({ transitionIn: transition, transitionOut: transition })}><span>{transition === 'none' ? 'No transition' : `${transition[0].toUpperCase()}${transition.slice(1)}`}</span><small>In + out</small></button>)}</div>
            <div className="tool-note">Transitions are previewed at the clip edges and saved in your project.</div>
          </div> : tab === 'AI Studio' ? <div className="tool-pane ai-studio-pane">
            <div className="media-heading">AI SUBTITLES <span className="panel-count">LOCAL</span></div>
            <input ref={subtitlePickerRef} type="file" accept=".srt,.vtt,text/vtt,text/plain" hidden onChange={(event) => { void importSubtitleFile(event.target.files?.[0]); event.target.value = ''; }} />
            <button className="import-card tool-add" onClick={() => subtitlePickerRef.current?.click()}><Captions size={21} /><b>Import SRT / VTT</b><span>Bring existing subtitle cues into the timeline</span></button>
            <button className="preset-row" onClick={exportSubtitles}><span>Export subtitles</span><small>.SRT</small></button>
            <div className="ai-field"><label>Transcription source</label><select value={captionAssetId} onChange={(event) => setCaptionAssetId(event.target.value)}><option value="">Use selected video clip</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></div>
            <div className="ai-field"><label>Whisper model</label><select value={captionModel} onChange={(event) => setCaptionModel(event.target.value as 'tiny' | 'base' | 'small')}><option value="tiny">Tiny · fastest / lighter</option><option value="base">Base · balanced</option><option value="small">Small · better accuracy</option></select></div>
            <div className="ai-field"><label>Language</label><select value={captionLanguage} onChange={(event) => setCaptionLanguage(event.target.value)}><option value="auto">Auto detect</option><option value="English">English</option><option value="Malayalam">Malayalam</option><option value="Hindi">Hindi</option><option value="Tamil">Tamil</option></select></div>
            <button className="inspector-action ai-action" disabled={generatingCaptions || !assets.length} onClick={() => void generateCaptions()}><Sparkles size={14} />{generatingCaptions ? 'Transcribing…' : 'Generate captions with Whisper'}</button>
            <div className="tool-note">Windows desktop only. Install openai-whisper and FFmpeg locally. The first run downloads the selected Whisper model; audio is processed on your computer, not sent to FrameForge.</div>

            <div className="media-heading">COLOUR MOTION TRACKER</div>
            <div className="property ai-color-row"><label>Target colour</label><input type="color" value={trackingTargetColor} onChange={(event) => setTrackingTargetColor(event.target.value)} /></div>
            <button className={`inspector-action ${samplingTrackingColor ? 'active' : ''}`} disabled={!previewVideo} onClick={() => { setSamplingTrackingColor(true); setMessage('Click the target object in the preview monitor to sample its colour.'); }}><Target size={14} />{samplingTrackingColor ? 'Click the preview monitor…' : 'Sample colour from preview'}</button>
            <div className="range-property"><label>Colour tolerance <strong>{trackingTolerance}</strong></label><input type="range" min="15" max="180" value={trackingTolerance} onChange={(event) => setTrackingTolerance(Number(event.target.value))} /></div>
            <button className="inspector-action ai-action" disabled={trackingBusy || !selectedClip || selectedAsset?.kind !== 'video'} onClick={() => void runColorTracker()}><Focus size={14} />{trackingBusy ? `Tracking ${trackingProgress}%` : 'Track colour through clip'}</button>
            {trackingBusy && <div className="render-progress-track"><div className="render-progress-fill" style={{ width: `${trackingProgress}%` }} /></div>}
            <div className="tool-note">Colour-based tracking samples frames and creates X/Y keyframes. It works best with a distinct, consistently visible colour; it is not a neural object detector.</div>

            <div className="media-heading">AUDIO VISUALIZER</div>
            <label className="check-property"><input type="checkbox" checked={audioVisualizer.enabled} onChange={(event) => setAudioVisualizer((current) => ({ ...current, enabled: event.target.checked }))} /> Render waveform visualizer</label>
            <div className="ai-field"><label>Audio source</label><select value={audioVisualizer.assetId} onChange={(event) => setAudioVisualizer((current) => ({ ...current, assetId: event.target.value }))}><option value="">First active audio clip</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></div>
            <div className="ai-field"><label>Waveform style</label><select value={audioVisualizer.mode} onChange={(event) => setAudioVisualizer((current) => ({ ...current, mode: event.target.value as AudioVisualizerSettings['mode'] }))}><option value="line">Line</option><option value="point">Dots</option><option value="p2p">Mirrored / P2P</option></select></div>
            <div className="property ai-color-row"><label>Wave colour</label><input type="color" value={audioVisualizer.color} onChange={(event) => setAudioVisualizer((current) => ({ ...current, color: event.target.value }))} /></div>
            <div className="range-property"><label>Height <strong>{audioVisualizer.height}px</strong></label><input type="range" min="60" max="420" step="10" value={audioVisualizer.height} onChange={(event) => setAudioVisualizer((current) => ({ ...current, height: Number(event.target.value) }))} /></div>
            <div className="range-property"><label>Vertical position <strong>{audioVisualizer.y}%</strong></label><input type="range" min="0" max="95" value={audioVisualizer.y} onChange={(event) => setAudioVisualizer((current) => ({ ...current, y: Number(event.target.value) }))} /></div>
            <div className="tool-note">The visualizer is composited into the exported MP4 when its selected audio source is present on the timeline.</div>
            <div className="media-heading">AI TOOLS STATUS</div>
            <div className="tool-note">AI background removal and neural object tracking are not bundled in this release. Use chroma key, manual masks and the colour tracker without cloud accounts or API keys.</div>
          </div> : tab === 'Text' ? <div className="tool-pane">
            <div className="media-heading">TITLES & SUBTITLES</div>
            <button className="import-card tool-add" onClick={() => addTextOverlay('title')}><Type size={22} /><b>Add title</b><span>Headline or on-screen text at the playhead</span></button>
            <button className="import-card tool-add" onClick={() => addTextOverlay('subtitle')}><Captions size={22} /><b>Add subtitle</b><span>Caption-style text at the playhead</span></button>
            <div className="media-heading">PROJECT TEXT <span className="panel-count">{textOverlays.length}</span></div>
            <div className="overlay-list">{textOverlays.map((overlay) => <button key={overlay.id} className={`overlay-item ${selectedOverlayId === overlay.id ? 'active' : ''}`} onClick={() => { setSelectedOverlayId(overlay.id); setSelectedClipId(null); seek(overlay.start); }}><span className="overlay-icon">{overlay.kind === 'title' ? <Type size={15} /> : <Captions size={15} />}</span><span><b>{overlay.text || (overlay.kind === 'title' ? 'Untitled title' : 'Untitled subtitle')}</b><small>{fmt(overlay.start)} · {fmt(overlay.duration)}</small></span></button>)}</div>
            {!textOverlays.length && <div className="tool-note">Add a title or subtitle. Drag its block on the TEXT timeline lane to change its timing.</div>}
          </div> : <div className="tool-pane">
            <div className="media-heading">AUDIO MIXER</div>
            {selectedClip ? <>
              <div className="audio-tool-card"><AudioLines size={20} /><b>{selectedAsset?.name ?? 'Selected clip'}</b><span>Per-clip processing is applied during timeline export.</span>
                <label>Volume <strong>{Math.round((selectedClip.volume ?? 1) * 100)}%</strong></label><input type="range" min="0" max="200" value={Math.round((selectedClip.volume ?? 1) * 100)} onChange={(event) => updateSelectedClip({ volume: Number(event.target.value) / 100 })} />
                <label>Fade in <strong>{(selectedClip.audioFadeIn ?? 0).toFixed(1)} s</strong></label><input type="range" min="0" max="5" step="0.1" value={selectedClip.audioFadeIn ?? 0} onChange={(event) => updateSelectedClip({ audioFadeIn: Number(event.target.value) })} />
                <label>Fade out <strong>{(selectedClip.audioFadeOut ?? 0).toFixed(1)} s</strong></label><input type="range" min="0" max="5" step="0.1" value={selectedClip.audioFadeOut ?? 0} onChange={(event) => updateSelectedClip({ audioFadeOut: Number(event.target.value) })} />
                <label>Pan <strong>{(selectedClip.audioPan ?? 0) < 0 ? `L ${Math.abs(selectedClip.audioPan ?? 0)}` : (selectedClip.audioPan ?? 0) > 0 ? `R ${selectedClip.audioPan}` : 'Centre'}</strong></label><input type="range" min="-100" max="100" value={selectedClip.audioPan ?? 0} onChange={(event) => updateSelectedClip({ audioPan: Number(event.target.value) })} />
              </div>
              <div className="media-heading">3-BAND EQUALIZER</div>
              {[['eqLow','Low · 100 Hz'],['eqMid','Mid · 1 kHz'],['eqHigh','High · 8 kHz']].map(([field,label]) => <div className="range-property" key={field}><label>{label} <strong>{Number(selectedClip[field as 'eqLow'|'eqMid'|'eqHigh'] ?? 0) > 0 ? '+' : ''}{selectedClip[field as 'eqLow'|'eqMid'|'eqHigh'] ?? 0} dB</strong></label><input type="range" min="-12" max="12" step="1" value={selectedClip[field as 'eqLow'|'eqMid'|'eqHigh'] ?? 0} onChange={(event) => updateSelectedClip({ [field]: Number(event.target.value) })} /></div>)}
              <div className="media-heading">DYNAMICS & CLEANUP</div>
              <div className="range-property"><label>Noise reduction <strong>{selectedClip.noiseReduction ?? 0}%</strong></label><input type="range" min="0" max="100" value={selectedClip.noiseReduction ?? 0} onChange={(event) => updateSelectedClip({ noiseReduction: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Compressor <strong>{selectedClip.compressor ?? 0}%</strong></label><input type="range" min="0" max="100" value={selectedClip.compressor ?? 0} onChange={(event) => updateSelectedClip({ compressor: Number(event.target.value) })} /></div>
              <div className="tool-note">Fade timing is reflected in playback. Pan, EQ, noise reduction and compression are processed in export. Noise reduction works best with a steady background-noise profile; excessive settings can affect voice quality.</div>
            </> : <div className="media-empty"><Volume2 size={24} /><b>Select a clip</b><span>Select a video or audio clip to access the mixer, EQ, fades and cleanup.</span></div>}
          </div>}
        </aside>

        <section className="editor-center">
          <div className="preview-top"><span>PREVIEW MONITOR</span><span className="preview-quality">FIT <ChevronDown size={12} /></span></div>
          <div className="preview-stage"><div className={`video-frame ${samplingTrackingColor ? 'sampling-color' : ''}`} onClick={sampleTrackingColorFromPreview}>
            <video ref={videoRef} className={previewVideo ? '' : 'hidden-preview'} style={previewStyle} playsInline onTimeUpdate={onVideoTimeUpdate} />
            {activeOverlays.map((overlay) => <div key={overlay.id} className={`preview-text ${overlay.kind}`} style={{ left: `${overlay.x}%`, top: `${overlay.y}%`, color: overlay.color, background: overlay.background, fontSize: `${overlay.fontSize}px`, fontWeight: overlay.bold ? 700 : 500, textAlign: overlay.align, transform: 'translate(-50%, -50%)' }}>{overlay.text}</div>)}
            {!previewVideo && <div className="preview-empty"><div className="empty-logo"><Clapperboard size={35} /></div><b>{previewAudio ? 'Audio playback' : 'Your story starts here'}</b><span>{previewAudio ? assets.find((asset) => asset.id === previewAudio.assetId)?.name : 'Add a video clip to a video track to preview it'}</span></div>}
            <audio ref={audioRef} />
          </div></div>
          <div className="transport"><div className="transport-left">
            <button className="icon-btn" title="Go to start" onClick={() => { seek(0); setPlaying(false); }}><SkipBack size={17} /></button>
            <button className="play-btn" title="Play / pause (Space)" onClick={() => void togglePlayback()}>{playing ? 'Ⅱ' : <Play size={17} fill="currentColor" />}</button>
            <button className="icon-btn" title="Go to end" onClick={() => { seek(totalDuration); setPlaying(false); }}><SkipForward size={17} /></button>
            <span className="timecode">{fmt(playhead)} <i>/</i> {fmt(totalDuration)}</span>
          </div><div className="transport-right"><Volume2 size={16} /><span>Timeline audio</span><Maximize2 size={16} /></div></div>

          <div className="timeline-panel">
            <div className="timeline-toolbar">
              <div className="timeline-title">TIMELINE <span className="track-count">{timelineClips.length} clips · {tracks.length} tracks</span></div>
              <div className="tool-buttons">
                <button className="tool-btn active" title="Selection tool"><MousePointer2 size={15} /></button>
                <button className="tool-btn" onClick={splitSelected} title="Split at playhead (S)" disabled={!selectedClip}><Scissors size={15} /></button>
                <button className="tool-btn" onClick={undo} title="Undo (Ctrl+Z)" disabled={historyIndex <= 0}><Undo2 size={15} /></button>
                <button className="tool-btn" onClick={redo} title="Redo (Ctrl+Y)" disabled={historyIndex >= history.length - 1}><Redo2 size={15} /></button>
                <button className="tool-btn" onClick={() => selectedOverlay ? deleteSelectedOverlay() : deleteSelected(false)} title="Delete selected clip or text" disabled={!selectedClip && !selectedOverlay}><Trash2 size={15} /></button>
                <button className="tool-btn ripple-btn" onClick={() => deleteSelected(true)} title="Ripple delete" disabled={!selectedClip}>R</button>
                <span className="toolbar-separator" />
                <button className="tool-btn" onClick={() => setZoom((value) => Math.max(12, value - 5))} title="Zoom out"><ZoomOut size={15} /></button>
                <input className="zoom-slider" type="range" min="12" max="100" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label="Timeline zoom" />
                <button className="tool-btn" onClick={() => setZoom((value) => Math.min(100, value + 5))} title="Zoom in"><ZoomIn size={15} /></button>
              </div>
            </div>
            <div className="track-actions"><span>TRACKS</span><button onClick={() => addTrack('video')}><Plus size={13} /><Video size={13} /> Video track</button><button onClick={() => addTrack('audio')}><Plus size={13} /><Music2 size={13} /> Audio track</button><span className="drag-hint">Drag media onto a track · drag clips to reposition</span></div>
            <div className="timeline-scroll" ref={timelineScrollRef}>
              <div className="timeline-canvas" style={{ width: timelineWidth }}>
                <div className="ruler" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); seek(Math.max(0, (event.clientX - rect.left - 60) / zoom)); }}>
                  {ticks.map((tick) => <div className="ruler-tick" key={tick} style={{ left: 60 + tick * zoom }}><span>{fmt(tick).slice(0, 5)}</span></div>)}
                </div>
                <div className="graphic-row">
                  <div className="track-label graphic-label"><div className="track-symbol graphic"><Type size={14} /></div><b>TEXT</b></div>
                  <div className="graphic-lane" onDragOver={(event) => event.preventDefault()} onDrop={handleOverlayDrop} onClick={(event) => { if (event.target === event.currentTarget) seek(Math.max(0, (event.clientX - event.currentTarget.getBoundingClientRect().left) / zoom)); }}>
                    {textOverlays.map((overlay) => <div key={overlay.id} draggable className={`graphic-clip ${overlay.kind} ${selectedOverlayId === overlay.id ? 'chosen' : ''}`} style={{ left: overlay.start * zoom, width: Math.max(72, overlay.duration * zoom) }} onDragStart={(event) => { event.dataTransfer.setData('application/x-frameforge-overlay', overlay.id); event.dataTransfer.effectAllowed = 'move'; }} onClick={(event) => { event.stopPropagation(); setSelectedOverlayId(overlay.id); setSelectedClipId(null); seek(overlay.start); }}><b>{overlay.text || (overlay.kind === 'title' ? 'Title' : 'Subtitle')}</b></div>)}
                  </div>
                </div>
                <div className="track-rows">{tracks.map((track) => <div className={`track-row ${track.kind}`} key={track.id}>
                  <div className="track-label"><div className={`track-symbol ${track.kind}`}>{track.kind === 'video' ? <Film size={14} /> : <AudioLines size={14} />}</div><b>{track.name}</b>
                    <button title={track.kind === 'audio' ? (track.muted ? 'Unmute track' : 'Mute track') : (track.hidden ? 'Show track' : 'Hide track')} onClick={() => toggleTrackFlag(track.id, track.kind === 'audio' ? 'muted' : 'hidden')}>{track.kind === 'audio' ? (track.muted ? <Volume2 size={12} /> : <Mic2 size={12} />) : (track.hidden ? <EyeOff size={12} /> : <Eye size={12} />)}</button>
                    <button title={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => toggleTrackFlag(track.id, 'locked')}>{track.locked ? <Lock size={12} /> : <Unlock size={12} />}</button>
                  </div>
                  <div className={`track-lane ${track.kind}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => handleTrackDrop(event, track)} onClick={(event) => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); seek((event.clientX - bounds.left) / zoom); setSelectedClipId(null); setSelectedOverlayId(null); } }}>
                    {timelineClips.filter((clip) => clip.trackId === track.id).map((clip) => {
                      const asset = assets.find((item) => item.id === clip.assetId);
                      if (!asset) return null;
                      const isSelected = clip.id === selectedClipId;
                      return <div key={clip.id} draggable={!track.locked} onDragStart={(event) => { event.dataTransfer.setData('application/x-frameforge-clip', clip.id); event.dataTransfer.effectAllowed = 'move'; }} onClick={(event) => { event.stopPropagation(); setSelectedClipId(clip.id); setSelectedOverlayId(null); seek(clip.position); }} onDoubleClick={(event) => { event.stopPropagation(); setSelectedClipId(clip.id); setSelectedOverlayId(null); }} className={`timeline-clip ${track.kind} ${isSelected ? 'chosen' : ''} ${track.locked ? 'clip-locked' : ''}`} style={{ left: clip.position * zoom, width: Math.max(44, clipLength(clip) * zoom) }} title={`${asset.name} · ${fmt(clip.position)} · ${fmt(clipLength(clip))}`}>
                        {track.kind === 'audio' && asset.waveform?.length ? <div className="waveform-bars" aria-label="Audio waveform">{asset.waveform.slice(0, 72).map((peak, index) => <i key={index} style={{ height: `${Math.max(8, peak * 100)}%` }} />)}</div> : <div className="clip-pattern">▥ ▥ ▥ ▥ ▥ ▥ ▥</div>}<b>{asset.name}</b><small>{fmt(clipLength(clip))}</small>
                      </div>;
                    })}
                    {track.locked && <div className="lane-locked">Track locked</div>}
                  </div>
                </div>)}</div>
                <div className="playhead" style={{ left: 60 + playhead * zoom }}><div className="playhead-handle" /></div>
              </div>
            </div>
          </div>
        </section>

        <aside className="inspector">
          <div className="inspector-head">INSPECTOR <MoreHorizontal size={17} /></div>
          {selectedOverlay ? <><div className="inspector-section"><div className="section-title"><Type size={15} /> {selectedOverlay.kind === 'title' ? 'Title properties' : 'Subtitle properties'}</div>
              <div className="text-field"><label>Text</label><textarea rows={3} value={selectedOverlay.text} onChange={(event) => updateSelectedOverlay({ text: event.target.value })} /></div>
              <div className="property"><label>Start (sec)</label><input type="number" min="0" step="0.1" value={Number(selectedOverlay.start.toFixed(1))} onChange={(event) => updateSelectedOverlay({ start: Math.max(0, Number(event.target.value) || 0) })} /></div>
              <div className="property"><label>Duration</label><input type="number" min="0.2" step="0.1" value={Number(selectedOverlay.duration.toFixed(1))} onChange={(event) => updateSelectedOverlay({ duration: Math.max(0.2, Number(event.target.value) || 0.2) })} /></div>
              <div className="property"><label>Font size</label><input type="number" min="10" max="120" value={selectedOverlay.fontSize} onChange={(event) => updateSelectedOverlay({ fontSize: Math.max(10, Math.min(120, Number(event.target.value) || 10)) })} /></div>
              <div className="property"><label>Horizontal position</label><input type="number" min="0" max="100" value={Math.round(selectedOverlay.x)} onChange={(event) => updateSelectedOverlay({ x: Math.max(0, Math.min(100, Number(event.target.value) || 0)) })} /></div>
              <div className="property"><label>Vertical position</label><input type="number" min="0" max="100" value={Math.round(selectedOverlay.y)} onChange={(event) => updateSelectedOverlay({ y: Math.max(0, Math.min(100, Number(event.target.value) || 0)) })} /></div>
              <div className="property"><label>Text colour</label><input type="color" value={selectedOverlay.color} onChange={(event) => updateSelectedOverlay({ color: event.target.value })} /></div>
              <div className="property"><label>Background</label><input type="color" value={selectedOverlay.background.startsWith('#') ? selectedOverlay.background : '#18151f'} onChange={(event) => updateSelectedOverlay({ background: event.target.value })} /></div>
              <div className="property"><label>Alignment</label><select value={selectedOverlay.align} onChange={(event) => updateSelectedOverlay({ align: event.target.value as TextOverlay['align'] })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></div>
              <label className="check-property"><input type="checkbox" checked={selectedOverlay.bold} onChange={(event) => updateSelectedOverlay({ bold: event.target.checked })} /> Bold text</label>
              <button className="inspector-action danger-action" onClick={deleteSelectedOverlay}><Trash2 size={14} /> Remove text overlay</button>
            </div></> : selectedClip && selectedAsset ? <>
            <div className="inspector-section"><div className="section-title"><Film size={15} /> Clip properties</div>
              <div className="property"><label>Media</label><span className="file-value" title={selectedAsset.name}>{selectedAsset.name}</span></div>
              <div className="property"><label>Track</label><span>{selectedTrack?.name ?? '—'}</span></div>
              <div className="property"><label>Timeline position</label><input type="number" min="0" step="0.1" value={Number(selectedClip.position.toFixed(1))} onChange={(event) => updateSelectedClip({ position: Number(event.target.value) })} /></div>
              <div className="property"><label>Source in</label><input type="number" min="0" max={selectedClip.sourceEnd - 0.1} step="0.1" value={Number(selectedClip.sourceStart.toFixed(1))} onChange={(event) => updateSelectedClip({ sourceStart: Number(event.target.value) })} /></div>
              <div className="property"><label>Source out</label><input type="number" min={selectedClip.sourceStart + 0.1} max={selectedAsset.duration} step="0.1" value={Number(selectedClip.sourceEnd.toFixed(1))} onChange={(event) => updateSelectedClip({ sourceEnd: Number(event.target.value) })} /></div>
              <div className="trim-summary">Timeline length <b>{fmt(clipLength(selectedClip))}</b></div>
            </div>
            <div className="inspector-section"><div className="section-title"><SlidersHorizontal size={15} /> Speed & audio</div>
              <div className="property"><label>Playback speed</label><select value={selectedClip.playbackRate ?? 1} onChange={(event) => updateSelectedClip({ playbackRate: Number(event.target.value) })}><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option></select></div>
              <div className="media-heading">SPEED RAMP</div>
              <div className="speed-preset-grid"><button onClick={() => applySpeedPreset('normal')}>Normal</button><button onClick={() => applySpeedPreset('slowmo')}>Slow motion</button><button onClick={() => applySpeedPreset('ramp')}>Speed ramp</button><button onClick={() => applySpeedPreset('montage')}>Montage</button></div>
              {normalizeSpeedSegments(selectedClip.speedSegments).map((segment, index) => <div className="range-property" key={`${segment.end}-${index}`}><label>Segment {index + 1} · {Math.round(segment.start)}–{Math.round(segment.end)}% <strong>{segment.rate.toFixed(2)}×</strong></label><input type="range" min="0.25" max="4" step="0.05" value={segment.rate} onChange={(event) => updateSelectedClip({ speedSegments: normalizeSpeedSegments(selectedClip.speedSegments).map((item, itemIndex) => ({ end: item.end, rate: itemIndex === index ? Number(event.target.value) : item.rate })) })} /></div>)}
              <div className="tool-note">Speed ramps divide the source clip into timed sections. Video and audio are retimed together during full timeline export.</div>
              <div className="range-property"><label>Volume <strong>{Math.round((selectedClip.volume ?? 1) * 100)}%</strong></label><input type="range" min="0" max="200" value={Math.round(Math.min(2, selectedClip.volume ?? 1) * 100)} onChange={(event) => updateSelectedClip({ volume: Number(event.target.value) / 100 })} /></div>
            </div>
            <div className="inspector-section"><div className="section-title"><WandSparkles size={15} /> Colour & effects</div>
              <div className="property"><label>Preset</label><select disabled={selectedAsset.kind !== 'video'} value={selectedClip.filter ?? 'none'} onChange={(event) => updateSelectedClip({ filter: event.target.value as FilterPreset })}><option value="none">Original</option><option value="cinematic">Cinematic</option><option value="vivid">Vivid</option><option value="mono">Monochrome</option><option value="warm">Warm</option><option value="cool">Cool</option><option value="vintage">Vintage</option><option value="noir">Noir</option></select></div>
              <div className="range-property"><label>Brightness <strong>{selectedClip.brightness ?? 0}</strong></label><input type="range" min="-50" max="50" disabled={selectedAsset.kind !== 'video'} value={selectedClip.brightness ?? 0} onChange={(event) => updateSelectedClip({ brightness: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Contrast <strong>{selectedClip.contrast ?? 100}%</strong></label><input type="range" min="50" max="150" disabled={selectedAsset.kind !== 'video'} value={selectedClip.contrast ?? 100} onChange={(event) => updateSelectedClip({ contrast: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Saturation <strong>{selectedClip.saturation ?? 100}%</strong></label><input type="range" min="0" max="200" disabled={selectedAsset.kind !== 'video'} value={selectedClip.saturation ?? 100} onChange={(event) => updateSelectedClip({ saturation: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Temperature <strong>{selectedClip.temperature ?? 0}</strong></label><input type="range" min="-100" max="100" disabled={selectedAsset.kind !== 'video'} value={selectedClip.temperature ?? 0} onChange={(event) => updateSelectedClip({ temperature: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Tint <strong>{selectedClip.tint ?? 0}</strong></label><input type="range" min="-100" max="100" disabled={selectedAsset.kind !== 'video'} value={selectedClip.tint ?? 0} onChange={(event) => updateSelectedClip({ tint: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Highlights <strong>{selectedClip.highlights ?? 0}</strong></label><input type="range" min="-100" max="100" disabled={selectedAsset.kind !== 'video'} value={selectedClip.highlights ?? 0} onChange={(event) => updateSelectedClip({ highlights: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Shadows <strong>{selectedClip.shadows ?? 0}</strong></label><input type="range" min="-100" max="100" disabled={selectedAsset.kind !== 'video'} value={selectedClip.shadows ?? 0} onChange={(event) => updateSelectedClip({ shadows: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Vibrance <strong>{selectedClip.vibrance ?? 0}</strong></label><input type="range" min="-100" max="100" disabled={selectedAsset.kind !== 'video'} value={selectedClip.vibrance ?? 0} onChange={(event) => updateSelectedClip({ vibrance: Number(event.target.value) })} /></div>
            </div>
            <div className="inspector-section"><div className="section-title"><Layers3 size={15} /> Compositing & keying</div>
              <div className="property"><label>Blend mode</label><select disabled={selectedAsset.kind !== 'video' || Boolean(selectedClip.chromaKeyEnabled)} value={selectedClip.blendMode ?? 'normal'} onChange={(event) => updateSelectedClip({ blendMode: event.target.value as BlendMode })}><option value="normal">Normal</option><option value="screen">Screen</option><option value="multiply">Multiply</option><option value="overlay">Overlay</option><option value="addition">Add</option><option value="darken">Darken</option><option value="lighten">Lighten</option><option value="softlight">Soft light</option></select></div>
              {(selectedClip.blendMode ?? 'normal') !== 'normal' && <div className="range-property"><label>Blend opacity <strong>{selectedClip.blendOpacity ?? 100}%</strong></label><input type="range" min="0" max="100" disabled={selectedAsset.kind !== 'video'} value={selectedClip.blendOpacity ?? 100} onChange={(event) => updateSelectedClip({ blendOpacity: Number(event.target.value) })} /></div>}
              <label className="check-property"><input type="checkbox" checked={Boolean(selectedClip.chromaKeyEnabled)} disabled={selectedAsset.kind !== 'video'} onChange={(event) => updateSelectedClip({ chromaKeyEnabled: event.target.checked, blendMode: event.target.checked ? 'normal' : selectedClip.blendMode ?? 'normal' })} /> Enable chroma key / green screen</label>
              <div className="property"><label>Key colour</label><input type="color" disabled={!selectedClip.chromaKeyEnabled || selectedAsset.kind !== 'video'} value={selectedClip.chromaKeyColor ?? '#00ff00'} onChange={(event) => updateSelectedClip({ chromaKeyColor: event.target.value })} /></div>
              <div className="range-property"><label>Colour similarity <strong>{selectedClip.chromaKeySimilarity ?? 18}%</strong></label><input type="range" min="1" max="100" disabled={!selectedClip.chromaKeyEnabled || selectedAsset.kind !== 'video'} value={selectedClip.chromaKeySimilarity ?? 18} onChange={(event) => updateSelectedClip({ chromaKeySimilarity: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Edge blend <strong>{selectedClip.chromaKeyBlend ?? 8}%</strong></label><input type="range" min="0" max="100" disabled={!selectedClip.chromaKeyEnabled || selectedAsset.kind !== 'video'} value={selectedClip.chromaKeyBlend ?? 8} onChange={(event) => updateSelectedClip({ chromaKeyBlend: Number(event.target.value) })} /></div>
              <div className="media-heading">ADVANCED MASK</div>
              <div className="property"><label>Mask shape</label><select disabled={selectedAsset.kind !== 'video'} value={selectedClip.maskShape ?? 'none'} onChange={(event) => updateSelectedClip({ maskShape: event.target.value as TimelineClip['maskShape'] })}><option value="none">None</option><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse / circle</option></select></div>
              <div className="range-property"><label>Mask width <strong>{selectedClip.maskWidth ?? 82}%</strong></label><input type="range" min="5" max="100" disabled={(selectedClip.maskShape ?? 'none') === 'none' || selectedAsset.kind !== 'video'} value={selectedClip.maskWidth ?? 82} onChange={(event) => updateSelectedClip({ maskWidth: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Mask height <strong>{selectedClip.maskHeight ?? 82}%</strong></label><input type="range" min="5" max="100" disabled={(selectedClip.maskShape ?? 'none') === 'none' || selectedAsset.kind !== 'video'} value={selectedClip.maskHeight ?? 82} onChange={(event) => updateSelectedClip({ maskHeight: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Edge feather <strong>{selectedClip.maskFeather ?? 0}%</strong></label><input type="range" min="0" max="30" disabled={(selectedClip.maskShape ?? 'none') === 'none' || selectedAsset.kind !== 'video'} value={selectedClip.maskFeather ?? 0} onChange={(event) => updateSelectedClip({ maskFeather: Number(event.target.value) })} /></div>
              <div className="tool-note">Chroma key and blend modes are rendered in the final export. Keyed clips use alpha compositing. Blend modes apply to centered full-frame layers; cropped, rotated, transitioned or animated layers use Normal compositing. The preview monitor does not yet show the keyed composite in real time.</div>
            </div>
            <div className="inspector-section"><div className="section-title"><Crop size={15} /> Crop & framing</div>
              <div className="range-property"><label>Crop top <strong>{selectedClip.cropTop ?? 0}%</strong></label><input type="range" min="0" max="40" disabled={selectedAsset.kind !== 'video'} value={selectedClip.cropTop ?? 0} onChange={(event) => updateSelectedClip({ cropTop: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Crop right <strong>{selectedClip.cropRight ?? 0}%</strong></label><input type="range" min="0" max="40" disabled={selectedAsset.kind !== 'video'} value={selectedClip.cropRight ?? 0} onChange={(event) => updateSelectedClip({ cropRight: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Crop bottom <strong>{selectedClip.cropBottom ?? 0}%</strong></label><input type="range" min="0" max="40" disabled={selectedAsset.kind !== 'video'} value={selectedClip.cropBottom ?? 0} onChange={(event) => updateSelectedClip({ cropBottom: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Crop left <strong>{selectedClip.cropLeft ?? 0}%</strong></label><input type="range" min="0" max="40" disabled={selectedAsset.kind !== 'video'} value={selectedClip.cropLeft ?? 0} onChange={(event) => updateSelectedClip({ cropLeft: Number(event.target.value) })} /></div>
              <button className="inspector-action" onClick={() => updateSelectedClip({ cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, scale: 100, rotation: 0, positionX: 0, positionY: 0, opacity: 100, keyframes: [] })}><Focus size={14} /> Reset framing</button>
            </div>
            <div className="inspector-section"><div className="section-title"><Move size={15} /> Transform & keyframes</div>
              <div className="range-property keyframe-property"><label>Horizontal position <strong>{Math.round(clipAnimatedValue(selectedClip, 'positionX', selectedLocalTime, selectedClip.positionX ?? 0))}%</strong></label><div className="keyframe-control"><input type="range" min="-100" max="100" disabled={selectedAsset.kind !== 'video'} value={clipAnimatedValue(selectedClip, 'positionX', selectedLocalTime, selectedClip.positionX ?? 0)} onChange={(event) => updateAnimatedProperty('positionX', Number(event.target.value))} /><button className={(selectedClip.keyframes ?? []).some((frame) => frame.property === 'positionX' && Math.abs(frame.time - selectedLocalTime) < 0.025) ? 'keyframe-btn active' : 'keyframe-btn'} title="Add/remove position keyframe" onClick={() => toggleKeyframe('positionX')}><Diamond size={13} /></button></div></div>
              <div className="range-property keyframe-property"><label>Vertical position <strong>{Math.round(clipAnimatedValue(selectedClip, 'positionY', selectedLocalTime, selectedClip.positionY ?? 0))}%</strong></label><div className="keyframe-control"><input type="range" min="-100" max="100" disabled={selectedAsset.kind !== 'video'} value={clipAnimatedValue(selectedClip, 'positionY', selectedLocalTime, selectedClip.positionY ?? 0)} onChange={(event) => updateAnimatedProperty('positionY', Number(event.target.value))} /><button className={(selectedClip.keyframes ?? []).some((frame) => frame.property === 'positionY' && Math.abs(frame.time - selectedLocalTime) < 0.025) ? 'keyframe-btn active' : 'keyframe-btn'} onClick={() => toggleKeyframe('positionY')}><Diamond size={13} /></button></div></div>
              <div className="range-property keyframe-property"><label>Scale <strong>{Math.round(clipAnimatedValue(selectedClip, 'scale', selectedLocalTime, selectedClip.scale ?? 100))}%</strong></label><div className="keyframe-control"><input type="range" min="25" max="300" disabled={selectedAsset.kind !== 'video'} value={clipAnimatedValue(selectedClip, 'scale', selectedLocalTime, selectedClip.scale ?? 100)} onChange={(event) => updateAnimatedProperty('scale', Number(event.target.value))} /><button className={(selectedClip.keyframes ?? []).some((frame) => frame.property === 'scale' && Math.abs(frame.time - selectedLocalTime) < 0.025) ? 'keyframe-btn active' : 'keyframe-btn'} onClick={() => toggleKeyframe('scale')}><Diamond size={13} /></button></div></div>
              <div className="range-property keyframe-property"><label>Rotation <strong>{Math.round(clipAnimatedValue(selectedClip, 'rotation', selectedLocalTime, selectedClip.rotation ?? 0))}°</strong></label><div className="keyframe-control"><input type="range" min="-180" max="180" disabled={selectedAsset.kind !== 'video'} value={clipAnimatedValue(selectedClip, 'rotation', selectedLocalTime, selectedClip.rotation ?? 0)} onChange={(event) => updateAnimatedProperty('rotation', Number(event.target.value))} /><button className={(selectedClip.keyframes ?? []).some((frame) => frame.property === 'rotation' && Math.abs(frame.time - selectedLocalTime) < 0.025) ? 'keyframe-btn active' : 'keyframe-btn'} onClick={() => toggleKeyframe('rotation')}><Diamond size={13} /></button></div></div>
              <div className="range-property keyframe-property"><label>Opacity <strong>{Math.round(clipAnimatedValue(selectedClip, 'opacity', selectedLocalTime, selectedClip.opacity ?? 100))}%</strong></label><div className="keyframe-control"><input type="range" min="0" max="100" disabled={selectedAsset.kind !== 'video'} value={clipAnimatedValue(selectedClip, 'opacity', selectedLocalTime, selectedClip.opacity ?? 100)} onChange={(event) => updateAnimatedProperty('opacity', Number(event.target.value))} /><button className={(selectedClip.keyframes ?? []).some((frame) => frame.property === 'opacity' && Math.abs(frame.time - selectedLocalTime) < 0.025) ? 'keyframe-btn active' : 'keyframe-btn'} onClick={() => toggleKeyframe('opacity')}><Diamond size={13} /></button></div></div>
              <div className="tool-note">Move the playhead, click a diamond to add a keyframe, then adjust the property at another time. Values interpolate between keyframes.</div>
              <button className="inspector-action" disabled={selectedAsset.kind !== 'video'} onClick={addMotionPathPoint}><Focus size={14} /> Add motion path point (X + Y)</button>
              <div className="tool-note">Manual motion path: mark the subject position at successive times by adjusting X/Y and adding a point. Automatic object detection and tracking are not included yet.</div>
              <div className="keyframe-list">{(selectedClip.keyframes ?? []).map((frame) => <div className="keyframe-row" key={frame.id}><span><Diamond size={11} /> {frame.property} · {fmt(frame.time)}</span><select value={frame.easing} onChange={(event) => updateKeyframeEasing(frame.id, event.target.value as ClipKeyframe['easing'])}><option value="linear">Linear</option><option value="ease-in">Ease in</option><option value="ease-out">Ease out</option><option value="ease-in-out">Ease in/out</option></select></div>)}</div>
            </div>
            <div className="inspector-section"><div className="section-title"><Settings2 size={15} /> Transitions</div>
              <div className="property"><label>Transition in</label><select disabled={selectedAsset.kind !== 'video'} value={selectedClip.transitionIn ?? 'none'} onChange={(event) => updateSelectedClip({ transitionIn: event.target.value as TransitionPreset })}><option value="none">None</option><option value="fade">Fade</option><option value="wipe">Wipe</option><option value="zoom">Zoom</option></select></div>
              <div className="property"><label>Transition out</label><select disabled={selectedAsset.kind !== 'video'} value={selectedClip.transitionOut ?? 'none'} onChange={(event) => updateSelectedClip({ transitionOut: event.target.value as TransitionPreset })}><option value="none">None</option><option value="fade">Fade</option><option value="wipe">Wipe</option><option value="zoom">Zoom</option></select></div>
              <div className="property"><label>Duration (sec)</label><input type="number" min="0.1" max="3" step="0.1" disabled={selectedAsset.kind !== 'video'} value={selectedClip.transitionDuration ?? 0.6} onChange={(event) => updateSelectedClip({ transitionDuration: Number(event.target.value) })} /></div>
              <button className="inspector-action" onClick={splitSelected}><Scissors size={14} /> Split at playhead</button><button className="inspector-action" onClick={() => deleteSelected(true)}><Trash2 size={14} /> Ripple delete</button>
              {selectedAsset.kind !== 'video' && <span className="coming-soon">Colour filters and visual transitions are available on video clips only.</span>}
              <span className="coming-soon">Effects, transitions, titles, subtitles and audio are rendered in the full timeline export.</span>
            </div>
          </> : <div className="inspector-empty">Select a clip or a text block on the timeline to edit its properties.</div>}
        </aside>
      </main>

      <footer className="statusbar"><span><span className="status-dot" />{message}</span><span>FrameForge v1.6 · {window.frameforge?.isDesktop ? 'Windows desktop' : 'Web editor'}</span></footer>

      {showShortcuts && <div className="modal-backdrop" onClick={() => setShowShortcuts(false)}><div className="shortcuts-modal" onClick={(event) => event.stopPropagation()}><div className="modal-title"><b>Keyboard shortcuts</b><button className="tiny-icon" onClick={() => setShowShortcuts(false)}><X size={17} /></button></div><div className="shortcut-row"><span>Play / pause</span><kbd>Space</kbd></div><div className="shortcut-row"><span>Split selected clip at playhead</span><kbd>S</kbd></div><div className="shortcut-row"><span>Delete selected clip</span><kbd>Delete</kbd></div><div className="shortcut-row"><span>Undo</span><kbd>Ctrl / ⌘ + Z</kbd></div><div className="shortcut-row"><span>Redo</span><kbd>Ctrl / ⌘ + Y</kbd></div><div className="shortcut-row"><span>Redo (alternate)</span><kbd>Ctrl / ⌘ + Shift + Z</kbd></div></div></div>}
      {showExportSettings && <div className="modal-backdrop" onClick={() => { if (!exporting) setShowExportSettings(false); }}>
        <div className="shortcuts-modal export-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-title"><b>Export full timeline</b><button className="tiny-icon" disabled={exporting} onClick={() => setShowExportSettings(false)}><X size={17} /></button></div>
          <p className="export-description">Render every visible video layer, timed text overlay, transition and active audio track into one MP4 file.</p>
          <div className="export-field"><label>Resolution</label><select value={exportResolution} onChange={(event) => setExportResolution(event.target.value)} disabled={exporting}><option value="720p">HD · 1280 × 720</option><option value="1080p">Full HD · 1920 × 1080</option><option value="1440p">QHD · 2560 × 1440</option><option value="4K">4K UHD · 3840 × 2160</option></select></div>
          <div className="export-field"><label>Frame rate</label><select value={exportFps} onChange={(event) => setExportFps(Number(event.target.value))} disabled={exporting}><option value={24}>24 FPS · Cinema</option><option value={30}>30 FPS · Standard</option><option value={60}>60 FPS · Smooth</option><option value={120}>120 FPS · High frame rate</option></select></div>
          <div className="export-field"><label>Quality</label><select value={exportQuality} onChange={(event) => setExportQuality(event.target.value as 'draft' | 'balanced' | 'high')} disabled={exporting}><option value="draft">Draft · Faster export</option><option value="balanced">Balanced · Recommended</option><option value="high">High · Larger file</option></select></div>
          <div className="export-summary"><span>{timelineClips.length} timeline clips</span><span>{textOverlays.length} text overlays</span><span>{tracks.filter((track) => track.kind === 'audio' && !track.muted).length} active audio tracks</span></div>
          {exporting && <div className="render-progress-wrap"><div className="render-progress-track"><div className="render-progress-fill" style={{ width: `${exportProgress}%` }} /></div><span>{exportProgress}%</span></div>}
          <button className="export-btn export-confirm" disabled={exporting} onClick={() => void exportTimeline()}><Download size={15} />{exporting ? 'Rendering timeline…' : 'Start MP4 export'}</button>
          <div className="export-footnote">Windows export requires FFmpeg and FFprobe available on PATH. Browser export uses FFmpeg WebAssembly and needs sufficient memory for the media files.</div>
        </div>
      </div>}
    </div>
  );
}
