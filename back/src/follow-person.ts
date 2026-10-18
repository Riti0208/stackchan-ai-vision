import type { HeadAction } from './protocol.ts';
export type BehaviorMode = 'follow_person' | 'autonomous';
export const behaviorMode = (env: { BEHAVIOR_MODE?: string }): BehaviorMode => env.BEHAVIOR_MODE === 'follow_person' ? 'follow_person' : 'autonomous';
export const FOLLOW_MAX_AGE_MS = 6000, FOLLOW_CONFIDENCE = .65;
export type Position = {
  horizontal: { label: 'far_left' | 'left' | 'center' | 'right' | 'far_right' | 'unknown'; confidence: number };
  vertical: { label: 'far_upper' | 'upper' | 'center' | 'lower' | 'far_lower' | 'unknown'; confidence: number };
};
export type FollowGate = { stream: string; order: number; frameAt: number; until: number };
export function followFresh(gate: FollowGate | undefined, stream: string | null, now: number) {
  return !!gate && gate.stream === stream && now < gate.until && now - gate.frameAt <= FOLLOW_MAX_AGE_MS;
}
const clamp = (n: number) => Math.max(-1, Math.min(1, n));
// One bounded correction per fresh Decisions observation. Keepalive re-sends
// the absolute target; it must never accumulate another step from old evidence.
const axis = (label: string, confidence: number, steps: Record<string, number>) =>
  !Number.isFinite(confidence) || confidence < FOLLOW_CONFIDENCE ? undefined : steps[label];
export function coarseTarget(pan: number, tilt: number, position: Position) {
  if (!Number.isFinite(pan) || !Number.isFinite(tilt)) return null;
  // Current FW maps normalized pan/tilt to 30/15 degrees respectively.
  const x = axis(position.horizontal.label, position.horizontal.confidence, { far_left: -.4, left: -.2, center: 0, right: .2, far_right: .4 });
  const y = axis(position.vertical.label, position.vertical.confidence, { far_lower: -.32, lower: -.16, center: 0, upper: .16, far_upper: .32 });
  if (x === undefined && y === undefined) return null;
  return { pan: clamp(pan + (x ?? 0)), tilt: clamp(tilt + (y ?? 0)) };
}
export function manualTarget(pan: number, tilt: number, action: HeadAction) {
  if (action === 'center') return { pan: 0, tilt: 0 };
  return { pan: clamp(pan + (action === 'right' ? .2 : action === 'left' ? -.2 : 0)), tilt: clamp(tilt + (action === 'up' ? .2 : action === 'down' ? -.2 : 0)) };
}
