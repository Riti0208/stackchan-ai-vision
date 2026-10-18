import type { APITiming } from './openai';
export type Stage = 'perception' | 'intention' | 'narration';
export type APISample = APITiming & { stage: Stage; run_id: string; stream_id: string };
export type Pipeline = { id: string; stream_id: string; frame_id: number; frame_received_at: number; started_at: number; completed_at: number; duration_ms: number; outcome: 'committed' | 'discarded' | 'error'; reason: string; api: APISample[] };
export type History = { version: 1; api: APISample[]; pipelines: Omit<Pipeline, 'api'>[]; api_attempts_total: number; pipeline_total: number };
export type Transport = { stream_id: string | null; frames: { at: number; bytes: number }[]; received_total: number; bytes_total: number; viewer_rtt: number[]; action_rtt: number[]; frame_to_action_ack: number[]; upload_rtt: number[]; rejected_actions: number; input_format: 'rgb565le-v2'; input_byte_order: 'little' | 'big'; byte_order_override: boolean; conversion_ms: number[]; converted_total: number; published_total: number; conversion_dropped: number; conversion_errors: number };
export const newHistory = (): History => ({ version: 1, api: [], pipelines: [], api_attempts_total: 0, pipeline_total: 0 });
export const newTransport = (stream_id: string | null, input_byte_order: 'little' | 'big' = 'little'): Transport => ({ stream_id, frames: [], received_total: 0, bytes_total: 0, viewer_rtt: [], action_rtt: [], frame_to_action_ack: [], upload_rtt: [], rejected_actions: 0, input_format: 'rgb565le-v2', input_byte_order, byte_order_override: input_byte_order === 'big', conversion_ms: [], converted_total: 0, published_total: 0, conversion_dropped: 0, conversion_errors: 0 });
export function stats(values: number[]) {
  const sorted = values.filter(n => Number.isFinite(n) && n >= 0).sort((a,b) => a-b);
  const at = (p: number) => sorted.length ? Math.round(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]) : null;
  return { count: sorted.length, p50_ms: at(.5), p95_ms: at(.95), max_ms: sorted.length ? Math.round(sorted.at(-1)!) : null };
}
export function addSample(values: number[], value: number) { if (Number.isFinite(value) && value >= 0) { values.push(Math.round(value)); if (values.length > 120) values.shift(); } }
export function recordRun(history: History, run: Pipeline) {
  history.api_attempts_total += run.api.length; history.pipeline_total++;
  history.api = [...history.api, ...run.api].slice(-120);
  const { api, ...summary } = run; history.pipelines = [...history.pipelines, summary].slice(-60);
}
export function receiveFrame(transport: Transport, bytes: number, at: number) {
  transport.received_total++; transport.bytes_total += bytes;
  transport.frames.push({ at, bytes });
  if (transport.frames.length > 120) transport.frames.shift();
}
export function pacing(env: { STREAM_FPS?: string; EVAL_INTERVAL_MS?: string; NARRATION_INTERVAL_MS?: string }) {
  const number = (v: string | undefined, fallback: number, min: number, max: number) => v?.trim() && Number.isFinite(Number(v)) && Number(v)>=min && Number(v)<=max ? Number(v) : fallback;
  return { stream_fps: number(env.STREAM_FPS, 60, 1, 60), evaluation_interval_ms: number(env.EVAL_INTERVAL_MS, 1000, 500, 10000), narration_interval_ms: number(env.NARRATION_INTERVAL_MS, 2000, 1000, 30000) };
}
export function snapshot(history: History, transport: Transport, configuration: ReturnType<typeof pacing>, now = Date.now()) {
  const entries = (['perception','intention','narration'] as Stage[]).map(stage => {
    const all = history.api.filter(a=>a.stage===stage), current = all.filter(a=>a.stream_id===transport.stream_id);
    return [stage, { ...stats(all.map(a=>a.rtt_ms)), errors: all.filter(a=>a.outcome!=='success').length, timeouts: all.filter(a=>a.outcome==='timeout').length, interval: stats(current.slice(1).map((a,i)=>a.started_at-current[i].started_at)) }] as const;
  });
  const stages = Object.fromEntries(entries) as Record<Stage, typeof entries[number][1]>;
  const frames = transport.frames.filter(f=>now-f.at<=30000), intervals=frames.slice(1).map((f,i)=>f.at-frames[i].at);
  const span = frames.length>1 ? frames.at(-1)!.at-frames[0].at : 0;
  return { version: 1, recorded_at: now, stream_id: transport.stream_id, pacing: configuration, api_attempts_total: history.api_attempts_total, pipeline_total: history.pipeline_total, stages,
    pipeline: { ...stats(history.pipelines.map(p=>p.duration_ms)), discarded: history.pipelines.filter(p=>p.outcome==='discarded').length, errors: history.pipelines.filter(p=>p.outcome==='error').length, frame_age_at_start: stats(history.pipelines.map(p=>p.started_at-p.frame_received_at)) },
    transport: { input_format: transport.input_format, input_byte_order: transport.input_byte_order, byte_order_override: transport.byte_order_override, conversion: { timing: 'encode_and_yield_wall_ms' as const, ...stats(transport.conversion_ms), published_total: transport.published_total, converted_total: transport.converted_total, dropped_total: transport.conversion_dropped, errors: transport.conversion_errors }, frames_received: transport.received_total, bytes_received: transport.bytes_total, received_fps: span>0 ? Math.round((frames.length-1)*10000/span)/10 : 0, frame_interval: stats(intervals), viewer_ack_rtt: stats(transport.viewer_rtt), action_ack_rtt: stats(transport.action_rtt), frame_to_action_ack: stats(transport.frame_to_action_ack), upload_rtt: stats(transport.upload_rtt), rejected_actions: transport.rejected_actions },
    samples: { api: history.api, pipelines: history.pipelines } };
}
