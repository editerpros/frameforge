export type AnimatedProperty = 'positionX' | 'positionY' | 'scale' | 'rotation' | 'opacity';
export type KeyframeEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
export type ClipKeyframe = { id: string; property: AnimatedProperty; time: number; value: number; easing: KeyframeEasing };

export const ANIMATED_DEFAULTS: Record<AnimatedProperty, number> = {
  positionX: 0,
  positionY: 0,
  scale: 100,
  rotation: 0,
  opacity: 100,
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const round = (value: number) => Number(value.toFixed(4)).toString();

function ease(progress: number, easing: KeyframeEasing): number {
  const p = clamp(progress, 0, 1);
  if (easing === 'ease-in') return p * p;
  if (easing === 'ease-out') return 1 - (1 - p) * (1 - p);
  if (easing === 'ease-in-out') return p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
  return p;
}

export function getAnimatedValue(
  keyframes: ClipKeyframe[] | undefined,
  property: AnimatedProperty,
  time: number,
  fallback = ANIMATED_DEFAULTS[property],
): number {
  const points = (keyframes ?? []).filter((frame) => frame.property === property).sort((a, b) => a.time - b.time);
  if (!points.length) return fallback;
  if (time <= points[0].time) return points[0].value;
  if (time >= points[points.length - 1].time) return points[points.length - 1].value;
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (time <= right.time) {
      const progress = (time - left.time) / Math.max(0.0001, right.time - left.time);
      return left.value + (right.value - left.value) * ease(progress, left.easing);
    }
  }
  return points[points.length - 1].value;
}

/** Build an FFmpeg expression using clip-local `t` time. */
export function buildKeyframeExpression(
  keyframes: ClipKeyframe[] | undefined,
  property: AnimatedProperty,
  fallback = ANIMATED_DEFAULTS[property],
): string {
  const points = (keyframes ?? []).filter((frame) => frame.property === property).sort((a, b) => a.time - b.time);
  if (!points.length) return round(fallback);
  if (points.length === 1) return round(points[0].value);

  let expression = round(points[points.length - 1].value);
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const left = points[index];
    const right = points[index + 1];
    const span = Math.max(0.0001, right.time - left.time);
    const raw = `(t-${round(left.time)})/${round(span)}`;
    let eased = raw;
    if (left.easing === 'ease-in') eased = `pow(${raw},2)`;
    else if (left.easing === 'ease-out') eased = `1-pow(1-${raw},2)`;
    else if (left.easing === 'ease-in-out') eased = `if(lt(${raw},0.5),2*pow(${raw},2),1-2*pow(1-${raw},2))`;
    const interpolated = `${round(left.value)}+(${round(right.value - left.value)})*(${eased})`;
    expression = `if(lt(t,${round(right.time)}),${interpolated},${expression})`;
  }
  return `if(lt(t,${round(points[0].time)}),${round(points[0].value)},${expression})`;
}

export function upsertKeyframe(
  keyframes: ClipKeyframe[] | undefined,
  property: AnimatedProperty,
  time: number,
  value: number,
): ClipKeyframe[] {
  const existing = [...(keyframes ?? [])];
  const index = existing.findIndex((frame) => frame.property === property && Math.abs(frame.time - time) < 0.025);
  if (index >= 0) existing[index] = { ...existing[index], value };
  else existing.push({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, property, time: clamp(time, 0, 86400), value, easing: 'linear' });
  return existing.sort((a, b) => a.time - b.time);
}
