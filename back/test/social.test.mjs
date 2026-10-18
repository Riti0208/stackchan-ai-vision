import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialMind, planFor, socialContext, mockChoice } from '../src/social.ts';

test('same visible situation produces different intentions for two personalities', () => {
  const choices = ['observe', 'avert', 'rest', 'greet:other'];
  assert.equal(mockChoice('curious', choices, true, 'observe'), 'greet:other');
  assert.equal(mockChoice('shy', choices, true, 'observe'), 'avert');
  assert.equal(mockChoice('shy', ['observe', 'rest', 'avert'], false, 'observe'), 'rest');
});
test('a curious robot can greet an online peer without a human in its camera', () => {
  assert.equal(mockChoice('curious', ['observe', 'avert', 'rest', 'greet:other'], false, 'rest'), 'greet:other');
  assert.equal(mockChoice('curious', ['observe', 'avert', 'rest'], false, 'rest'), 'rest');
});
test('shy robot expresses happiness as a restrained public nod', () => {
  const p = planFor('reply:other', 'shy');
  assert.match(p.thought, /うれしい/); assert.equal(p.expression, 'neutral'); assert.equal(p.action, 'nod');
  assert.match(p.display_text, /控えめ/); assert.equal(p.target.device_id, 'other');
});
test('public projection strips peer inner state and never passes a private thought', () => {
  const self = initialMind('self', 'curious');
  const peer = { device_id: 'other', stream_id: 'stream', action: 'nod', expression: 'neutral', thought: 'PEER_PRIVATE_THOUGHT', emotion: { happiness: .9 }, relationships: { self: .8 }, mind: { secret: true } };
  const context = socialContext(self, { happiness: .5 }, { smiling: .9 }, [peer], undefined, 0);
  assert.deepEqual(context.visible_peers, [{ device_id: 'other', action: 'nod', expression: 'neutral' }]);
  assert.ok(!JSON.stringify(context).includes('PEER_PRIVATE_THOUGHT'));
  assert.equal(context.received_utterance, null);
});
test('an acknowledgement causes a nonverbal reaction, not another utterance', () => {
  const choices = ['observe', 'avert', 'rest', 'listen:other'];
  const choice = mockChoice('curious', choices, true, 'greet');
  assert.equal(choice, 'listen:other'); assert.equal(planFor(choice, 'curious').action, 'nod');
});
test('turning away is a held absolute gaze target, independent of face coordinates', () => {
  const p = planFor('avert', 'shy'); assert.equal(p.pan, -.35); assert.equal(p.tilt, 0); assert.equal(p.intent, 'avert');
});

test('first-join random selection covers all six profiles; explicit profiles bypass the draw', async () => {
  const { personalityKeys, choosePersonality, personalities } = await import('../src/personality.ts');
  assert.equal(personalityKeys.length, 6);
  assert.deepEqual(personalityKeys.map((_, i) => choosePersonality(undefined, () => (i + .5) / 6)), personalityKeys);
  assert.equal(choosePersonality('calm', () => { throw new Error('should not draw'); }), 'calm');
  for (const p of personalityKeys) assert.ok(personalities[p].description.length > 30);
});
test('all personalities reach model context with distinct descriptions and safe outward plans', async () => {
  const { personalityKeys } = await import('../src/personality.ts');
  const descriptions = new Set();
  for (const p of personalityKeys) {
    descriptions.add(socialContext(initialMind('self', p), {}, {}, [], undefined, 0).self.personality_description);
    for (const choice of ['observe','rest','avert','greet:peer','reply:peer','listen:peer']) {
      const plan = planFor(choice, p); assert.ok(['idle','look_at','nod','shake','happy'].includes(plan.action));
    }
  }
  assert.equal(descriptions.size, 6);
});
