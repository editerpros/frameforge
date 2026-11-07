import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { buildRenderPlan } from './renderPlan';
import {
  Aperture, AudioLines, ChevronDown, Clapperboard, Download, FilePlus2, Film,
  FolderOpen, Maximize2, MoreHorizontal, MousePointer2, Play, Plus, Redo2,
  Save, Scissors, Settings2, SkipBack, SkipForward, Trash2, Undo2, Upload,
  Volume2, WandSparkles, ZoomIn, ZoomOut, Video, Music2, Lock, Unlock,
  Eye, EyeOff, Mic2, Layers3, Keyboard, X, Captions, Type, SlidersHorizontal,
} from 'lucide-react';

type MediaKind = 'video' | 'audio';
type MediaAsset = { id: string; name: string; file: File; url: string; duration: number; kind: MediaKind; mime: string };
type Track = { id: string; kind: MediaKind; name: string; muted: boolean; hidden: boolean; locked: boolean };
type FilterPreset = 'none' | 'cinematic' | 'vivid' | 'mono' | 'warm' | 'cool' | 'vintage' | 'noir';
type TransitionPreset = 'none' | 'fade' | 'wipe' | 'zoom';
type TimelineClip = { id: string; assetId: string; trackId: string; position: number; sourceStart: number; sourceEnd: number; playbackRate?: number; volume?: number; filter?: FilterPreset; brightness?: number; contrast?: number; saturation?: number; transitionIn?: TransitionPreset; transitionOut?: TransitionPreset; transitionDuration?: number };
type TextOverlay = { id: string; kind: 'title' | 'subtitle'; text: string; start: number; duration: number; x: number; y: number; fontSize: number; color: string; background: string; bold: boolean; align: 'left' | 'center' | 'right' };
type HistoryState = { clips: TimelineClip[]; tracks: Track[]; overlays: TextOverlay[] };
type ProjectAsset = { id: string; name: string; mime: string; duration: number; kind: MediaKind; data: string };
type ProjectFile = { format: 'frameforge-project'; version: number; name: string; assets: ProjectAsset[]; tracks: Track[]; clips: TimelineClip[]; overlays?: TextOverlay[]; playhead: number };

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
const clipLength = (clip: TimelineClip) => Math.max(0, (clip.sourceEnd - clip.sourceStart) / Math.max(0.25, clip.playbackRate ?? 1));
const normalizeClip = (clip: TimelineClip): TimelineClip => ({ playbackRate: 1, volume: 1, filter: 'none', brightness: 0, contrast: 100, saturation: 100, transitionIn: 'none', transitionOut: 'none', transitionDuration: 0.6, ...clip });
const presetCss: Record<FilterPreset, string> = { none: '', cinematic: 'sepia(.08) contrast(1.12) saturate(.88)', vivid: 'contrast(1.08) saturate(1.35)', mono: 'grayscale(1)', warm: 'sepia(.18) saturate(1.08)', cool: 'hue-rotate(12deg) saturate(.92)', vintage: 'sepia(.28) contrast(.92) saturate(.75)', noir: 'grayscale(1) contrast(1.3)' };
const presetFfmpeg: Record<FilterPreset, string> = { none: '', cinematic: 'eq=contrast=1.12:saturation=0.88', vivid: 'eq=contrast=1.08:saturation=1.35', mono: 'hue=s=0', warm: 'colorbalance=rs=0.05:gs=0.02:bs=-0.03', cool: 'colorbalance=rs=-0.03:gs=0.01:bs=0.05', vintage: 'eq=contrast=0.92:saturation=0.75:brightness=0.02', noir: 'hue=s=0,eq=contrast=1.3' };
const clipFilterCss = (clip: TimelineClip) => `brightness(${1 + (clip.brightness ?? 0) / 100}) contrast(${(clip.contrast ?? 100) / 100}) saturate(${(clip.saturation ?? 100) / 100}) ${presetCss[clip.filter ?? 'none']}`.trim();
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

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const projectPickerRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);

  const selectedClip = timelineClips.find((clip) => clip.id === selectedClipId) ?? null;
  const selectedAsset = selectedClip ? assets.find((asset) => asset.id === selectedClip.assetId) ?? null : null;
  const selectedOverlay = textOverlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;
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
      additions.push({ id: uid(), name: file.name, file, url, duration, kind, mime: file.type || (kind === 'audio' ? 'audio/mpeg' : 'video/mp4') });
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
    commit(timelineClips.map((clip) => clip.id === selectedClip.id ? updated : clip));
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
    const speed = previewVideo.playbackRate ?? 1;
    const sourceTime = previewVideo.sourceStart + (playhead - previewVideo.position) * speed;
    node.playbackRate = speed;
    node.volume = Math.max(0, Math.min(1, previewVideo.volume ?? 1));
    if (Number.isFinite(sourceTime) && Math.abs(node.currentTime - sourceTime) > 0.35) node.currentTime = sourceTime;
    if (playing) void node.play().catch(() => setMessage('This video format could not be played by the browser.'));
    else node.pause();
  }, [assets, playhead, playing, previewVideo?.id, previewVideo?.assetId, previewVideo?.playbackRate, previewVideo?.volume]);

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
    const speed = previewAudio.playbackRate ?? 1;
    const sourceTime = previewAudio.sourceStart + (playhead - previewAudio.position) * speed;
    node.playbackRate = speed;
    node.volume = Math.max(0, Math.min(1, previewAudio.volume ?? 1));
    if (Number.isFinite(sourceTime) && Math.abs(node.currentTime - sourceTime) > 0.4) node.currentTime = sourceTime;
    node.muted = tracks.find((track) => track.id === previewAudio.trackId)?.muted ?? false;
    if (playing) void node.play().catch(() => setMessage('This audio format could not be played by the browser.'));
    else node.pause();
  }, [assets, playhead, playing, previewAudio?.id, previewAudio?.assetId, previewAudio?.playbackRate, previewAudio?.volume, tracks]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const v = videoRef.current;
      const a = audioRef.current;
      if (previewVideo && v && !v.paused && Number.isFinite(v.currentTime)) {
        const nextTime = previewVideo.position + (v.currentTime - previewVideo.sourceStart) / (previewVideo.playbackRate ?? 1);
        setPlayhead(Math.min(previewVideo.position + clipLength(previewVideo), nextTime));
      } else if (!previewVideo && previewAudio && a && !a.paused && Number.isFinite(a.currentTime)) {
        const nextTime = previewAudio.position + (a.currentTime - previewAudio.sourceStart) / (previewAudio.playbackRate ?? 1);
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
        data: bytesToBase64(await asset.file.arrayBuffer()),
      })));
      const project: ProjectFile = { format: 'frameforge-project', version: 2, name: projectName, assets: projectAssets, tracks, clips: timelineClips.map(normalizeClip), overlays: textOverlays, playhead };
      const serialized = JSON.stringify(project);
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
    if (project.format !== 'frameforge-project' || ![1, 2].includes(project.version) || !Array.isArray(project.assets) || !Array.isArray(project.clips) || !Array.isArray(project.tracks)) {
      throw new Error('This is not a supported FrameForge project file.');
    }
    assets.forEach((asset) => URL.revokeObjectURL(asset.url));
    const restoredAssets: MediaAsset[] = project.assets.map((asset) => {
      const bytes = base64ToBytes(asset.data);
      const mediaBlob = new Blob([bytes.buffer as ArrayBuffer], { type: asset.mime });
      const file = new File([mediaBlob], asset.name, { type: asset.mime });
      return { id: asset.id, name: asset.name, file, url: URL.createObjectURL(file), duration: asset.duration, kind: asset.kind, mime: asset.mime };
    });
    const restoredTracks = project.tracks.length ? project.tracks : initialTracks;
    setAssets(restoredAssets);
    setTracks(restoredTracks);
    const restoredClips = project.clips.map(normalizeClip);
    const restoredOverlays = Array.isArray(project.overlays) ? project.overlays : [];
    setTimelineClips(restoredClips);
    setTextOverlays(restoredOverlays);
    setHistory([{ clips: restoredClips, tracks: restoredTracks, overlays: restoredOverlays }]);
    setHistoryIndex(0);
    setSelectedClipId(null);
    setSelectedOverlayId(null);
    setPlayhead(Number(project.playhead) || 0);
    setPlaying(false);
    setProjectName(project.name || 'Untitled Project');
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
        const result = await window.frameforge.exportNative({ bytes, extension: selectedAsset.name.split('.').pop() || 'mp4', start: selectedClip.sourceStart, duration: clipLength(selectedClip), kind: selectedAsset.kind, speed: selectedClip.playbackRate ?? 1, volume: selectedClip.volume ?? 1, filter: selectedClip.filter ?? 'none', brightness: selectedClip.brightness ?? 0, contrast: selectedClip.contrast ?? 100, saturation: selectedClip.saturation ?? 100 });
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
      const aFilters = [`atempo=${speed}`, `volume=${selectedClip.volume ?? 1}`].join(',');
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
        const plan = buildRenderPlan({ assets, tracks, clips: timelineClips, overlays: textOverlays, audioAssetIds, options: { ...dimensions[exportResolution], fps: exportFps, quality: exportQuality, ...(nativeFonts ? { fontFiles: nativeFonts } : {}) } });
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
        const preliminary = buildRenderPlan({ assets, tracks, clips: timelineClips, overlays: textOverlays, audioAssetIds: new Set(assets.filter((asset) => asset.kind === 'audio').map((asset) => asset.id)), options: { ...dimensions[exportResolution], fps: exportFps, quality: exportQuality, fontFiles: WASM_FONT_FILES } });
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
        const plan = buildRenderPlan({ assets, tracks, clips: timelineClips, overlays: textOverlays, audioAssetIds: detectedAudio, options: { ...dimensions[exportResolution], fps: exportFps, quality: exportQuality, fontFiles: WASM_FONT_FILES } });
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
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
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
  const previewStyle = previewVideo ? { filter: clipFilterCss(previewVideo), ...clipTransitionStyle(previewVideo, playhead) } : undefined;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-icon"><Aperture size={19} /></div><span>FRAME<span className="brand-accent">FORGE</span></span><span className="version">V1.3</span></div>
        <div className="project-name-wrap"><input className="project-name-input" value={projectName} onChange={(event) => setProjectName(event.target.value)} aria-label="Project name" /><ChevronDown size={14} /></div>
        <div className="top-actions">
          <button className="icon-btn" title="Keyboard shortcuts" onClick={() => setShowShortcuts(true)}><Keyboard size={17} /></button>
          <button className="secondary-btn" onClick={() => void openProject()}><FolderOpen size={15} /> Open</button>
          <button className="secondary-btn" onClick={() => void saveProject()}><Save size={15} /> Save project</button>
          <button className="export-btn" onClick={() => setShowExportSettings(true)} disabled={exporting || (!timelineClips.length && !textOverlays.length)}><Download size={16} />{exporting ? `Rendering ${exportProgress}%` : 'Export timeline'}</button>
        </div>
      </header>

      <main className="workspace">
        <aside className="media-panel">
          <input ref={projectPickerRef} type="file" accept=".ffproj,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void openProject(file); event.target.value = ''; }} />
          <div className="panel-tabs">{['Media', 'Effects', 'Text', 'Audio'].map((item) => <button key={item} className={tab === item ? 'selected' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
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
          </div> : tab === 'Text' ? <div className="tool-pane">
            <div className="media-heading">TITLES & SUBTITLES</div>
            <button className="import-card tool-add" onClick={() => addTextOverlay('title')}><Type size={22} /><b>Add title</b><span>Headline or on-screen text at the playhead</span></button>
            <button className="import-card tool-add" onClick={() => addTextOverlay('subtitle')}><Captions size={22} /><b>Add subtitle</b><span>Caption-style text at the playhead</span></button>
            <div className="media-heading">PROJECT TEXT <span className="panel-count">{textOverlays.length}</span></div>
            <div className="overlay-list">{textOverlays.map((overlay) => <button key={overlay.id} className={`overlay-item ${selectedOverlayId === overlay.id ? 'active' : ''}`} onClick={() => { setSelectedOverlayId(overlay.id); setSelectedClipId(null); seek(overlay.start); }}><span className="overlay-icon">{overlay.kind === 'title' ? <Type size={15} /> : <Captions size={15} />}</span><span><b>{overlay.text || (overlay.kind === 'title' ? 'Untitled title' : 'Untitled subtitle')}</b><small>{fmt(overlay.start)} · {fmt(overlay.duration)}</small></span></button>)}</div>
            {!textOverlays.length && <div className="tool-note">Add a title or subtitle. Drag its block on the TEXT timeline lane to change its timing.</div>}
          </div> : <div className="tool-pane">
            <div className="media-heading">CLIP AUDIO</div>
            {selectedClip ? <><div className="audio-tool-card"><AudioLines size={20} /><b>{selectedAsset?.name ?? 'Selected clip'}</b><span>Set the clip's playback volume.</span><label>Volume <strong>{Math.round((selectedClip.volume ?? 1) * 100)}%</strong></label><input type="range" min="0" max="100" value={Math.round(Math.min(1, selectedClip.volume ?? 1) * 100)} onChange={(event) => updateSelectedClip({ volume: Number(event.target.value) / 100 })} /></div><div className="tool-note">Audio fades and multi-track mixing are planned for a later release. Volume changes affect preview and selected-clip export.</div></> : <div className="media-empty"><Volume2 size={24} /><b>Select a clip</b><span>Select a video or audio clip to control its volume.</span></div>}
          </div>}
        </aside>

        <section className="editor-center">
          <div className="preview-top"><span>PREVIEW MONITOR</span><span className="preview-quality">FIT <ChevronDown size={12} /></span></div>
          <div className="preview-stage"><div className="video-frame">
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
                        <div className="clip-pattern">{track.kind === 'video' ? '▥ ▥ ▥ ▥ ▥ ▥ ▥' : '▂▅▃▇▂▆▃▅▁▇▃▆'}</div><b>{asset.name}</b><small>{fmt(clipLength(clip))}</small>
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
              <div className="range-property"><label>Volume <strong>{Math.round((selectedClip.volume ?? 1) * 100)}%</strong></label><input type="range" min="0" max="100" value={Math.round(Math.min(1, selectedClip.volume ?? 1) * 100)} onChange={(event) => updateSelectedClip({ volume: Number(event.target.value) / 100 })} /></div>
            </div>
            <div className="inspector-section"><div className="section-title"><WandSparkles size={15} /> Colour & effects</div>
              <div className="property"><label>Preset</label><select disabled={selectedAsset.kind !== 'video'} value={selectedClip.filter ?? 'none'} onChange={(event) => updateSelectedClip({ filter: event.target.value as FilterPreset })}><option value="none">Original</option><option value="cinematic">Cinematic</option><option value="vivid">Vivid</option><option value="mono">Monochrome</option><option value="warm">Warm</option><option value="cool">Cool</option><option value="vintage">Vintage</option><option value="noir">Noir</option></select></div>
              <div className="range-property"><label>Brightness <strong>{selectedClip.brightness ?? 0}</strong></label><input type="range" min="-50" max="50" disabled={selectedAsset.kind !== 'video'} value={selectedClip.brightness ?? 0} onChange={(event) => updateSelectedClip({ brightness: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Contrast <strong>{selectedClip.contrast ?? 100}%</strong></label><input type="range" min="50" max="150" disabled={selectedAsset.kind !== 'video'} value={selectedClip.contrast ?? 100} onChange={(event) => updateSelectedClip({ contrast: Number(event.target.value) })} /></div>
              <div className="range-property"><label>Saturation <strong>{selectedClip.saturation ?? 100}%</strong></label><input type="range" min="0" max="200" disabled={selectedAsset.kind !== 'video'} value={selectedClip.saturation ?? 100} onChange={(event) => updateSelectedClip({ saturation: Number(event.target.value) })} /></div>
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

      <footer className="statusbar"><span><span className="status-dot" />{message}</span><span>FrameForge v1.3 · {window.frameforge?.isDesktop ? 'Windows desktop' : 'Web editor'}</span></footer>

      {showShortcuts && <div className="modal-backdrop" onClick={() => setShowShortcuts(false)}><div className="shortcuts-modal" onClick={(event) => event.stopPropagation()}><div className="modal-title"><b>Keyboard shortcuts</b><button className="tiny-icon" onClick={() => setShowShortcuts(false)}><X size={17} /></button></div><div className="shortcut-row"><span>Play / pause</span><kbd>Space</kbd></div><div className="shortcut-row"><span>Split selected clip at playhead</span><kbd>S</kbd></div><div className="shortcut-row"><span>Delete selected clip</span><kbd>Delete</kbd></div><div className="shortcut-row"><span>Undo</span><kbd>Ctrl / ⌘ + Z</kbd></div><div className="shortcut-row"><span>Redo</span><kbd>Ctrl / ⌘ + Y</kbd></div><div className="shortcut-row"><span>Redo (alternate)</span><kbd>Ctrl / ⌘ + Shift + Z</kbd></div></div></div>}
      {showExportSettings && <div className="modal-backdrop" onClick={() => { if (!exporting) setShowExportSettings(false); }}>
        <div className="shortcuts-modal export-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-title"><b>Export full timeline</b><button className="tiny-icon" disabled={exporting} onClick={() => setShowExportSettings(false)}><X size={17} /></button></div>
          <p className="export-description">Render every visible video layer, timed text overlay, transition and active audio track into one MP4 file.</p>
          <div className="export-field"><label>Resolution</label><select value={exportResolution} onChange={(event) => setExportResolution(event.target.value)} disabled={exporting}><option value="720p">HD · 1280 × 720</option><option value="1080p">Full HD · 1920 × 1080</option><option value="4K">4K UHD · 3840 × 2160</option></select></div>
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
