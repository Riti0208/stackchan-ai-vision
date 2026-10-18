import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emotionKeys, visibleQuestions, evaluationPayload, parseEvaluation, mockEvaluation, projectExperiences } from '../src/perception.ts';
const initial = { happiness: .5, curiosity: .5, excitement: .2, shyness: .5, trust: .5 };
function answers() { return { answers: [
  ...visibleQuestions.map(([name]) => ({ name, type: 'predicate', probability: .9 })),
  { name: 'apparent_expression', type: 'choice', choice: 'sad_looking', confidence: .8 },
  ...emotionKeys.map(name => ({ name: `affect_${name}`, type: 'score', score: 1, confidence: .8 }))
] }; }
test('eight visible cues, one facial-display choice and five personal scores share one image request', () => {
  const payload = evaluationPayload('data:image/jpeg;base64,SAME', { self: { personality: 'shy', emotion: initial } }, [], false);
  assert.equal(payload.questions.length, 14);
  assert.equal(payload.questions.filter(q => q.type === 'score').length, 5);
  assert.equal(payload.input[0].content.filter(c => c.type === 'input_image').length, 1);
  assert.ok(payload.questions.some(q => q.name === 'tears_visible')); assert.ok(payload.questions.some(q => q.name === 'frowning'));
});
test('score normalization applies the model emotion directly without a smiling bonus', () => {
  const result = parseEvaluation(answers());
  assert.equal(result.observations.smiling, .9); assert.equal(result.observations.apparent_expression.label, 'sad_looking');
  assert.deepEqual(result.emotion, Object.fromEntries(emotionKeys.map(k => [k, .25])));
});
for (const [name, modify] of [
  ['refused emotion', a => { a.type = 'refusal'; }], ['out-of-range score', a => { a.score = 4.01; }],
  ['NaN', a => { a.score = NaN; }], ['invalid confidence', a => { a.confidence = -1; }]
]) test(`${name} rejects the whole evaluation before applying any new emotion`, () => {
  const body = answers(); modify(body.answers.find(a => a.name === 'affect_happiness')); assert.throws(() => parseEvaluation(body));
});
test('a valid uncertain score retains its weighted mean and confidence separately', () => {
  const body = answers(); body.answers.find(a => a.name === 'affect_happiness').confidence = .2;
  const result = parseEvaluation(body); assert.equal(result.emotion.happiness, .25); assert.equal(result.confidence.happiness, .2);
});
test('own experience projection is bounded and excludes extra private fields', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ at: i, kind: 'dialogue', message_id: `message-${i}`, emotion_before: initial, emotion_after: initial, intent: 'engage', expression: 'neutral', peer_thought: 'PEER_SECRET' }));
  const safe = projectExperiences(history); assert.equal(safe.length, 6); assert.equal(safe[0].at, 4); assert.ok(!JSON.stringify(safe).includes('PEER_SECRET'));
});
test('same offline scene can produce different affect for personality and previous experience', () => {
  const a = mockEvaluation(0, initial, 'curious', false, []), b = mockEvaluation(0, initial, 'shy', false, []);
  assert.deepEqual(a.observations, b.observations); assert.ok(a.emotion.curiosity > b.emotion.curiosity); assert.ok(b.emotion.shyness > a.emotion.shyness);
  const experienced = mockEvaluation(0, initial, 'curious', false, [{ kind: 'dialogue' }]);
  assert.ok(experienced.emotion.trust > a.emotion.trust);
});
