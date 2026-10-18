import type { HumanActionEvent } from './human-actions';
import type { Experience } from './perception';
import type { Generation } from './narration';
import { personalities, type Personality } from './personality.ts';
export type { Personality } from './personality.ts';
import type { Intent, Target, Motion, Mind, Behavior, Dialogue } from './protocol.ts';
export type { Intent, Target, Motion, Mind, Behavior, Dialogue } from './protocol.ts';
export type PublicPeer = { device_id: string; stream_id: string; action: string; expression: string };
export type Plan = { intent: Intent; target: Target; thought: string; display_text: string; action: Motion['action']; expression: Motion['expression']; pan?: number; tilt?: number; duration_ms: number };
export const noTarget = (): Target => ({ kind: 'none', device_id: null });
export function initialMind(id: string, personality: Personality): Mind {
  return { device_id: id, revision: 0, personality, intent: 'observe', target: { kind: 'person', device_id: null }, thought: 'どんな出会いがあるかな。', generation: null, relationships: {}, cause: { kind: 'observation', message_id: null }, valid_until: 0 };
}
export function planFor(choice: string, personality: Personality): Plan {
  const shy = personalities[personality].restrained;
  const quiet = personality === 'calm' || personality === 'cautious';
  if (choice.startsWith('greet:')) return {
    intent: 'greet', target: { kind: 'device', device_id: choice.slice(6) },
    thought: quiet ? 'ゆっくり知り合えたらいいな。そっと声をかけてみよう。' : shy ? '仲良くしたいけど、自分から話すのはどきどきする。' : 'あの子と仲良くなって、一緒に見てみたい！',
    display_text: shy ? '平静を装って、小さく会釈する' : '明るい表情で挨拶する',
    action: shy ? 'nod' : 'happy', expression: shy ? 'neutral' : 'happy', duration_ms: 1000
  };
  if (choice.startsWith('listen:')) return {
    intent: 'engage', target: { kind: 'device', device_id: choice.slice(7) },
    thought: '返事をもらえた。一緒にいられて、うれしい！', display_text: '返事を聞いて、うれしそうに小さくうなずく',
    action: 'nod', expression: shy ? 'neutral' : 'happy', duration_ms: 900
  };
  if (choice.startsWith('reply:')) return {
    intent: 'engage', target: { kind: 'device', device_id: choice.slice(6) },
    thought: quiet ? '声をかけてもらえて安心した。落ち着いて応えよう。' : shy ? '声をかけてくれて、すごくうれしい。でも照れる……。' : '返事ができてうれしい。一緒に過ごしたい！',
    display_text: quiet ? '落ち着いた表情で、小さくうなずく' : shy ? 'うれしさを隠して、控えめにうなずく' : '笑顔でうなずいて応える',
    action: 'nod', expression: shy ? 'neutral' : 'happy', duration_ms: 900
  };
  if (choice === 'acknowledge_person' || choice === 'delight') return {
    intent: choice, target: { kind: 'person', device_id: null }, thought: shy ? '気づいているよ。少し照れるけれど、小さく応えよう。' : '気づいてもらえてうれしい。こちらからも応えたい！',
    display_text: choice === 'delight' ? 'うれしさを短いしぐさで表す' : '相手へ小さくうなずく', action: choice === 'delight' ? 'happy' : 'nod', expression: choice === 'delight' ? 'happy' : shy ? 'neutral' : 'happy', duration_ms: 900
  };
  if (choice === 'avert') return {
    intent: 'avert', target: { kind: 'person', device_id: null },
    thought: '気になるけど、見つめられると照れちゃう。そっと目をそらそう。',
    display_text: '落ち着いた表情で、少しだけ目をそらす', action: 'look_at', expression: 'neutral', pan: -.35, tilt: 0, duration_ms: 800
  };
  if (choice === 'rest') return {
    intent: 'rest', target: noTarget(), thought: '今は少しゆっくりしていたい。', display_text: '穏やかな表情で待つ',
    action: 'idle', expression: 'neutral', pan: 0, tilt: 0, duration_ms: 700
  };
  return {
    intent: 'observe', target: { kind: 'person', device_id: null },
    thought: quiet ? '急がず、静かに様子を見ていよう。' : shy ? '少し落ち着いた。もう一度、そっと見てみよう。' : '何をしているんだろう。もう少しよく見たい！',
    display_text: '興味を示しながら、相手へ視線を向ける', action: 'look_at', expression: 'thinking', duration_ms: 500
  };
}
// Construct only from a public projection: no peer emotion, mind, or thought is accepted.
export function socialContext(self: Mind, emotion: unknown, observations: unknown, peers: PublicPeer[], inbox: Dialogue | undefined, now: number, history: Dialogue[] = []) {
  return {
    self: { device_id: self.device_id, personality: self.personality, personality_description: personalities[self.personality].description, emotion, relationships: self.relationships, previous_thought: self.thought, previous_intent: self.intent, previous_intent_valid: now < self.valid_until },
    observations,
    visible_peers: peers.map(p => ({ device_id: p.device_id, action: p.action, expression: p.expression })),
    public_history: history.map(m => ({ from_device_id: m.from_device_id, to_device_id: m.to_device_id, text: m.text, speech_act: m.speech_act })),
    received_utterance: inbox ? { id: inbox.id, from_device_id: inbox.from_device_id, speech_act: inbox.speech_act, text: inbox.text, reply_to: inbox.reply_to } : null
  };
}
export function mockChoice(personality: Personality, available: string[], hasPerson: boolean, previous: Intent, event?: HumanActionEvent, history: Experience[] = []): string {
  const reply = available.find(c => c.startsWith('reply:'));
  if (reply) return reply;
  const listen = available.find(c => c.startsWith('listen:'));
  if (listen) return listen;
  if (event && hasPerson) {
    const familiar = history.some(e => e.kind === 'dialogue' || e.human_action?.changes.includes('hand_raised'));
    if (personality === 'shy' || personality === 'cautious') return familiar ? 'acknowledge_person' : 'avert';
    if (personality === 'calm') return 'observe';
    return event.changes.some(c => ['hand_raised', 'smile_started'].includes(c)) ? 'delight' : 'observe';
  }
  if (['acknowledge_person', 'delight'].includes(previous) && hasPerson) return previous;
  if (!hasPerson) return ['curious', 'cheerful', 'playful'].includes(personality) ? available.find(c => c.startsWith('greet:')) || 'rest' : 'rest';
  if (['curious', 'cheerful', 'playful'].includes(personality)) return available.find(c => c.startsWith('greet:')) || 'observe';
  if (personality === 'calm') return 'observe';
  if (personality === 'cautious') return previous === 'observe' ? 'avert' : 'observe';
  return previous === 'avert' ? 'observe' : 'avert';
}
