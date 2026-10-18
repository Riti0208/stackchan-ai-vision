import type { Observation } from './perception';
export const humanCueKeys = ['person_present', 'waving', 'smiling', 'frowning', 'eyes_wide', 'mouth_open', 'tears_visible', 'looking_at_robot'] as const;
export type HumanCue = typeof humanCueKeys[number];
export type HumanActionEvent = { id: string; stream_id: string; frame_id: number; observed_at: number; expires_at: number; changes: string[] };
type Cue = { active: boolean; on: number; off: number; last_event_at: number };
export type HumanActionState = { cues: Record<HumanCue, Cue>; order: number; at: number; pending: HumanActionEvent[] };
export function initialHumanActions(saved?: HumanActionState): HumanActionState {
  return { cues: Object.fromEntries(humanCueKeys.map(k => [k, { active: saved?.cues[k]?.active || false, on: 0, off: 0, last_event_at: saved?.cues[k]?.last_event_at || 0 }])) as Record<HumanCue, Cue>, order: -1, at: 0, pending: [] };
}
const names: Record<HumanCue, string> = { person_present: 'person_appeared', waving: 'hand_raised', smiling: 'smile_started', frowning: 'frown_started', eyes_wide: 'eyes_widened', mouth_open: 'mouth_opened', tears_visible: 'tears_appeared', looking_at_robot: 'looked_at_robot' };
export function scanHumanActions(previous: HumanActionState, observations: Observation, frame: { order: number; frame_id: number; stream_id: string; at: number }) {
  const state = structuredClone(previous);
  state.pending = state.pending.filter(e => e.expires_at > frame.at);
  if (frame.order <= state.order) return { state, created: null };
  const gap = state.at && frame.at - state.at > 6000;
  state.order = frame.order; state.at = frame.at;
  const changes: string[] = [];
  for (const key of humanCueKeys) {
    const cue = state.cues[key];
    if (gap) { cue.on = 0; cue.off = 0; }
    // A drawn face or ambiguous human presence must never create a human-action event.
    const probability = key === 'person_present' ? observations[key] : observations.person_present >= .8 ? observations[key] : observations.person_present <= .3 ? 0 : .5;
    if (probability >= .8) { cue.on++; cue.off = 0; }
    else if (probability <= .3) { cue.off++; cue.on = 0; }
    else { cue.on = 0; cue.off = 0; }
    if (!cue.active && cue.on >= 2) {
      cue.active = true;
      if (!cue.last_event_at || frame.at - cue.last_event_at >= 6000) { changes.push(names[key]); cue.last_event_at = frame.at; }
    } else if (cue.active && cue.off >= 2) {
      cue.active = false;
      if (key === 'person_present') changes.push('person_left');
    }
  }
  const created: HumanActionEvent | null = changes.length ? { id: crypto.randomUUID(), stream_id: frame.stream_id, frame_id: frame.frame_id, observed_at: frame.at, expires_at: frame.at + 10000, changes } : null;
  if (created) state.pending = [...state.pending, created].slice(-4);
  return { state, created };
}
export function consumeHumanAction(state: HumanActionState, id: string) { state.pending = state.pending.filter(e => e.id !== id); }
