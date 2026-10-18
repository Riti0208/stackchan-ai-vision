import { readLocalVars, resolveOpenAIKey } from './local-env.mjs';
import { syntheticJPEG } from './fw-simulator.mjs';
import { callDecisions, summarizeCalls } from '../src/openai.ts';
import { initialMind, socialContext } from '../src/social.ts';
import { evaluationPayload, parseEvaluation, emotionKeys } from '../src/perception.ts';
import { writeFile } from 'node:fs/promises';
try {
  const key = await resolveOpenAIKey(await readLocalVars()), jpeg = await syntheticJPEG(0);
  const image = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  const before = { happiness: .5, curiosity: .5, excitement: .5, shyness: .5, trust: .5 };
  const scenarios = [['curious_friendly', 'curious', true], ['shy_friendly', 'shy', true], ['curious_tense', 'curious', false]];
  const results = [], metrics = [];
  for (const [name, personality, friendly] of scenarios) {
    const self = initialMind('stackchan-test', personality);
    const history = Array.from({ length: 3 }, (_, i) => ({ at: Date.now() - (3 - i) * 6000, kind: friendly ? 'dialogue' : 'observation', message_id: friendly ? `fictional-greeting-${i}` : null, emotion_before: { ...before }, emotion_after: { ...before, happiness: friendly ? .8 : .35, shyness: friendly ? .2 : .7, trust: friendly ? .8 : .2 }, intent: friendly ? 'engage' : 'avert', expression: friendly ? 'smiling' : 'tense_looking' }));
    const context = socialContext(self, before, undefined, [], undefined, Date.now(), []);
    const response = await callDecisions(key, evaluationPayload(image, context, history, false));
    const evaluation = parseEvaluation(response.body); metrics.push(response.metrics); results.push({ name, personality, same_image: true, same_previous_emotion: before, ...evaluation });
  }
  const different = (a, b) => emotionKeys.some(k => Math.abs(a.emotion[k] - b.emotion[k]) >= .05);
  const report = { verified_at: new Date().toISOString(), synthetic_image: true, same_previous_emotion: true, personality_difference_observed: different(results[0], results[1]), experience_difference_observed: different(results[0], results[2]), ai: summarizeCalls(metrics, true), cases: results };
  const i = process.argv.indexOf('--output'); if (i >= 0 && process.argv[i + 1]) await writeFile(process.argv[i + 1], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.personality_difference_observed || !report.experience_difference_observed) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
