// Test entry point only. No configurable external endpoint exists in production.
import worker, { Room as BackendRoom } from '../../src/index';
export default {
  async fetch(req: Request, env: any, ctx: any) {
    const url = new URL(req.url);
    if (['/__test/requests', '/__test/scene'].includes(url.pathname)) return env.ROOMS.get(env.ROOMS.idFromName(url.searchParams.get('room') || 'main')).fetch(req);
    return worker.fetch(req, env, ctx);
  }
};
export class Room extends BackendRoom {
  records: any[];
  scenario: { room: string; scene: string };
  constructor(ctx: any, env: any) {
    const records: any[] = [], scenario = { room: 'main', scene: 'neutral' };
    super(ctx, env, async (url, options) => {
      const body = JSON.parse(options!.body as string), endpoint = String(url).split('/').pop();
      const record = { endpoint, body, at: Date.now() }; records.push(record);
      if (endpoint === 'decisions') {
        const question = body.questions[0];
        const answers = question.type === 'predicate' ? (() => {
          const evidence = JSON.parse(body.input[0].content[0].text.split('\n').at(-1));
          const shy = evidence.robot_context.self.personality === 'shy';
          const feelings: any = { happiness: evidence.received_message_is_new ? .85 : .7, curiosity: shy ? .55 : .85, excitement: .3, shyness: shy ? .85 : .15, trust: evidence.received_message_is_new || evidence.own_affective_history.some((e: any) => e.kind === 'dialogue') ? .8 : .6 };
          return body.questions.map((q: any) => {
            if (q.type === 'predicate' && scenario.room === 'human_actions') return { name: q.name, type: 'predicate', probability: q.name === 'person_present' || q.name === 'looking_at_robot' || (q.name === 'waving' && scenario.scene === 'raised') ? .99 : .05 };
            if (q.type === 'predicate') return { name: q.name, type: 'predicate', probability: scenario.room === 'no_person' ? 0 : scenario.room === 'sad_face' ? (q.name === 'tears_visible' || q.name === 'person_present' ? .9 : .05) : .9 };
            if (q.type === 'choice') return { name: q.name, type: 'choice', choice: scenario.room === 'sad_face' ? 'sad_looking' : scenario.room === 'no_person' ? 'unclear' : 'smiling', confidence: .95 };
            if (scenario.room === 'bad_emotion' && q.name === 'affect_happiness') return { name: q.name, type: 'refusal' };
            return { name: q.name, type: 'score', score: feelings[q.name.slice(7)] * 4, confidence: .95 };
          });
        })() : (() => {
          const available = question.choices.map((c: any) => c.value);
          const context = JSON.parse(body.input);
          const human = context.human_action;
          const familiar = context.own_affective_history?.some((e: any) => e.human_action?.changes.includes('hand_raised'));
          const choice = scenario.room === 'human_actions' ? (human?.changes.includes('hand_raised') ? (context.self.personality === 'curious' ? 'delight' : familiar ? 'acknowledge_person' : 'avert') : context.previous_choice === 'delight' ? 'acknowledge_person' : context.previous_choice === 'acknowledge_person' ? 'delight' : context.previous_choice || 'observe') : available.find((c: string) => c.startsWith('reply:')) || available.find((c: string) => c.startsWith('listen:')) ||
            (context.self.personality === 'curious' ? available.find((c: string) => c.startsWith('greet:')) || 'observe' : 'avert');
          return [{ type: 'choice', name: 'intention', choice, confidence: scenario.room === 'low_intent' ? .2 : .99 }];
        })();
        return Response.json({ answers, usage: { input_tokens: 100, output_tokens: 0 } });
      }
      if (endpoint !== 'responses') throw new Error('Unexpected endpoint in fixture');
      if (scenario.room === 'rate') return new Response('NOT_FOR_CLIENTS', { status: 429, headers: { 'retry-after': '30' } });
      if (scenario.room === 'timeout') {
        await new Promise((_, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason)));
      }
      if (['slow', 'stale', 'self_stale'].includes(scenario.room)) await new Promise(resolve => setTimeout(resolve, 1500));
      const context = JSON.parse(body.input[1].content), choice = context.selected_choice;
      const reply = choice.startsWith('reply:'), speech = reply || choice.startsWith('greet:');
      const text = scenario.room === 'invalid' ? { thought: '', public_text: null } : {
        thought: `${context.self.device_id}だけの本音。${reply ? '声をかけてもらえてうれしい。でも照れる。' : '気になる、もう少し仲良くなりたい。'}`,
        public_text: speech ? (reply ? '…うん、ありがとう。' : scenario.room === 'no_person' ? '少しお話ししない？' : '笑顔が見えたよ。一緒に見よう！') : null
      };
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(text) }] }], usage: { input_tokens: 200, output_tokens: 60 } }, { headers: { 'x-request-id': `fixture-${records.length}` } });
    });
    this.records = records; this.scenario = scenario;
  }
  async fetch(req: Request) {
    this.scenario.room = new URL(req.url).searchParams.get('room') || this.scenario.room;
    if (new URL(req.url).pathname === '/__test/scene') { this.scenario.scene = (await req.json() as any).scene; return Response.json({ ok: true }); }
    if (new URL(req.url).pathname === '/__test/requests') return Response.json(this.records);
    return super.fetch(req);
  }
}
