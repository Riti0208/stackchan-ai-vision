import type { HeadAction } from './protocol.ts';
export type BehaviorMode = 'follow_person' | 'autonomous';
export const behaviorMode = (env: { BEHAVIOR_MODE?: string }): BehaviorMode => env.BEHAVIOR_MODE === 'follow_person' ? 'follow_person' : 'autonomous';
export const FOLLOW_MAX_AGE_MS = 6000, FOLLOW_INTERVAL_MS = 100, FOLLOW_CONFIDENCE = .65;
export type Position = {
  horizontal: { label: 'left' | 'center' | 'right' | 'unknown'; confidence: number };
  vertical: { label: 'upper' | 'center' | 'lower' | 'unknown'; confidence: number };
};
export type FollowGate = { stream: string; order: number; frameAt: number; until: number };
export function followFresh(gate: FollowGate | undefined, stream: string | null, now: number) {
  return !!gate && gate.stream === stream && now < gate.until && now - gate.frameAt <= FOLLOW_MAX_AGE_MS;
}
const clamp = (n: number) => Math.max(-1, Math.min(1, n));
const axis = (label: string, confidence: number, negative: string, positive: string, step: number) =>
  !Number.isFinite(confidence) || confidence < FOLLOW_CONFIDENCE || label === 'unknown' ? undefined : label === negative ? -step : label === positive ? step : 0;
export function coarseTarget(pan: number, tilt: number, position: Position) {
  if (!Number.isFinite(pan) || !Number.isFinite(tilt)) return null;
  const x = axis(position.horizontal.label, position.horizontal.confidence, 'left', 'right', .08);
  const y = axis(position.vertical.label, position.vertical.confidence, 'lower', 'upper', .06);
  if (x === undefined && y === undefined) return null;
  return { pan: clamp(pan + (x ?? 0)), tilt: clamp(tilt + (y ?? 0)) };
}
/** FE measurements refine a fresh presence gate; they never establish person presence. */
export function detectedTarget(pan: number, tilt: number, face: { x: number; y: number; width: number; height: number; confidence: number }) {
  if (![pan, tilt, face.x, face.y, face.width, face.height, face.confidence].every(Number.isFinite) || face.confidence < .7 || face.width <= 0 || face.height <= 0 || face.x < 0 || face.y < 0 || face.x + face.width > 1 || face.y + face.height > 1) return null;
  const x = face.x + face.width / 2, y = face.y + face.height / 2;
  const delta = (center: number, step: number) => center >= .4 && center <= .6 ? 0 : Math.max(-step, Math.min(step, (center - .5) * .3));
  return { pan: clamp(pan + delta(x, .08)), tilt: clamp(tilt - delta(y, .06)) };
}

export function manualTarget(pan: number, tilt: number, action: HeadAction) {
  if (action === 'center') return { pan: 0, tilt: 0 };
  return { pan: clamp(pan + (action === 'right' ? .2 : action === 'left' ? -.2 : 0)), tilt: clamp(tilt + (action === 'up' ? .2 : action === 'down' ? -.2 : 0)) };
}
