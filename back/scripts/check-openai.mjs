import { readLocalVars, resolveOpenAIKey } from './local-env.mjs';
import { syntheticJPEG } from './fw-simulator.mjs';
import { callDecisions, callNarration, summarizeCalls } from '../src/openai.ts';
import { narrationPayload } from '../src/narration.ts';
import { writeFile } from 'node:fs/promises';
const local = await readLocalVars();
  try {
    const key = await resolveOpenAIKey(local);
    const jpeg = await syntheticJPEG(0);
    const observation = await callDecisions(key, {
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'This is a synthetic robot simulator image. Answer only about what is visibly depicted; do not infer hidden feelings.' }, { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` }] }],
      questions: [{ type: 'predicate', name: 'smiling_face_depicted', instructions: 'Is a smiling face depicted in this image, including a drawn or synthetic face?' }]
    });
    const choice = await callDecisions(key, {
      input: JSON.stringify({ robot: { personality: 'shy', happiness: .8, shyness: .8 }, visible_observation: observation.body.answers, public_message_received: '一緒に見てみよう！' }),
      questions: [{ type: 'choice', name: 'intention', instructions: 'Choose this fictional shy robot\'s own response to a friendly invitation. Its inner happiness need not appear as a broad smile.', choices: [{ value: 'reply', description: 'Accept the invitation with a restrained polite nod' }, { value: 'rest', description: 'Remain quietly at rest' }] }]
    });
    const narration = await callNarration(key, narrationPayload({ self: { device_id: 'stackchan-02', personality: 'shy', emotion: { happiness: .8, shyness: .8 } }, received_utterance: { text: '一緒に見てみよう！' } }, 'reply:stackchan-01'), true);
    const report = { verified_at: new Date().toISOString(), ai: summarizeCalls([observation.metrics, choice.metrics, narration.metrics], true), observation: observation.body.answers, intention: choice.body.answers, narration: narration.text };
    const i = process.argv.indexOf('--output'); if (i >= 0 && process.argv[i + 1]) await writeFile(process.argv[i + 1], JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
