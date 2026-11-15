export type SpeedSegment = { end: number; rate: number };

export function normalizeSpeedSegments(segments: SpeedSegment[] | undefined): Array<{ start: number; end: number; rate: number }> {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const sorted = segments
    .map((segment) => ({ end: Math.max(1, Math.min(100, Number(segment.end) || 100)), rate: Math.max(0.25, Math.min(4, Number(segment.rate) || 1)) }))
    .sort((a, b) => a.end - b.end);
  const result: Array<{ start: number; end: number; rate: number }> = [];
  let cursor = 0;
  for (const item of sorted) {
    const end = Math.max(cursor, item.end);
    if (end - cursor < 0.01) continue;
    result.push({ start: cursor, end, rate: item.rate });
    cursor = end;
    if (cursor >= 99.99) break;
  }
  if (cursor < 99.99) result.push({ start: cursor, end: 100, rate: result[result.length - 1]?.rate ?? 1 });
  return result;
}

export function getRampedDuration(sourceDuration: number, baseRate = 1, segments?: SpeedSegment[]): number {
  const duration = Math.max(0, sourceDuration);
  const base = Math.max(0.25, Math.min(4, baseRate));
  const normalized = normalizeSpeedSegments(segments);
  if (!normalized.length) return duration / base;
  return normalized.reduce((sum, item) => sum + duration * (item.end - item.start) / 100 / (base * item.rate), 0);
}

export function sourceOffsetAtTimelineTime(sourceDuration: number, baseRate: number, segments: SpeedSegment[] | undefined, timelineTime: number): number {
  const duration = Math.max(0, sourceDuration);
  const base = Math.max(0.25, Math.min(4, baseRate));
  const target = Math.max(0, timelineTime);
  const normalized = normalizeSpeedSegments(segments);
  if (!normalized.length) return Math.min(duration, target * base);
  let outCursor = 0;
  for (const item of normalized) {
    const sourceStart = duration * item.start / 100;
    const sourceEnd = duration * item.end / 100;
    const rate = base * item.rate;
    const outLength = (sourceEnd - sourceStart) / rate;
    if (target <= outCursor + outLength) return Math.min(sourceEnd, sourceStart + Math.max(0, target - outCursor) * rate);
    outCursor += outLength;
  }
  return duration;
}

export function timelineOffsetAtSourceTime(sourceDuration: number, baseRate: number, segments: SpeedSegment[] | undefined, sourceOffset: number): number {
  const duration = Math.max(0, sourceDuration);
  const source = Math.max(0, Math.min(duration, sourceOffset));
  const base = Math.max(0.25, Math.min(4, baseRate));
  const normalized = normalizeSpeedSegments(segments);
  if (!normalized.length) return source / base;
  let outCursor = 0;
  for (const item of normalized) {
    const sourceStart = duration * item.start / 100;
    const sourceEnd = duration * item.end / 100;
    const rate = base * item.rate;
    if (source <= sourceEnd) return outCursor + Math.max(0, source - sourceStart) / rate;
    outCursor += (sourceEnd - sourceStart) / rate;
  }
  return outCursor;
}

export function speedAtTimelineTime(sourceDuration: number, baseRate: number, segments: SpeedSegment[] | undefined, timelineTime: number): number {
  const normalized = normalizeSpeedSegments(segments);
  if (!normalized.length) return Math.max(0.25, Math.min(4, baseRate));
  const sourceOffset = sourceOffsetAtTimelineTime(sourceDuration, baseRate, segments, timelineTime);
  const percent = sourceDuration > 0 ? sourceOffset / sourceDuration * 100 : 0;
  return Math.max(0.25, Math.min(4, baseRate * (normalized.find((item) => percent <= item.end + 1e-6)?.rate ?? normalized[normalized.length - 1].rate)));
}
