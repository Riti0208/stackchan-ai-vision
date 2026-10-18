// No outbound network: test the real Worker/DO gate using a failing local response.
import worker, { Room as BackendRoom } from '../../src/index';
export default {
  async fetch(req: Request, env: any) {
    if (new URL(req.url).pathname === '/__test/count') return env.ROOMS.get(env.ROOMS.idFromName(new URL(req.url).searchParams.get('room') || 'main')).fetch(req);
    return worker.fetch(req, env);
  }
};
export class Room extends BackendRoom {
  private calls: number[];
  constructor(ctx: any, env: any) {
    const calls: number[] = [];
    super(ctx, env, async () => { calls.push(Date.now()); return new Response(null, { status: 503 }); });
    this.calls = calls;
  }
  async fetch(req: Request) {
    if (new URL(req.url).pathname === '/__test/count') return Response.json(this.calls);
    return super.fetch(req);
  }
}
