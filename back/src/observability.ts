import type { Pipeline } from './telemetry';
import type { TelemetrySummary } from './protocol';
type Context = { room: string; id: string; stream: string | null };
/** Explicit field allowlists: never log credentials, JPEGs, prompts or robot thoughts. */
function emit(event: string, context: Context, fields: object) {
  console.log({ event, room: context.room, device_id: context.id, stream_id: context.stream, ...fields });
}
const closeReasons = new Set(['status_timeout','controller_timeout','session_expired','replaced','slow_viewer','frame_too_large','invalid_raw_frame','message_too_large']);
export function logConnection(context: Context, online: boolean, close?: { code: number; reason: string }) {
  emit('device_connection', context, { online, ...(close ? { close_code: close.code, close_reason: closeReasons.has(close.reason) ? close.reason : '' } : {}) });
}
export function logCloseRequested(context: Context, role: string, code: number, reason: string) {
  emit('peer_close_requested', context, { role, code, reason: closeReasons.has(reason) ? reason : '' });
}
export function logRun(context: Context, run: Pipeline) {
  for (const sample of run.api) emit('openai_call', context, {
    run_id: run.id, frame_id: run.frame_id, stage: sample.stage, endpoint: sample.endpoint,
    model: sample.model, request_id: sample.request_id, status: sample.status,
    outcome: sample.outcome, rtt_ms: sample.rtt_ms, input_tokens: sample.input_tokens, output_tokens: sample.output_tokens
  });
  emit('pipeline_completed', context, { run_id: run.id, frame_id: run.frame_id, outcome: run.outcome, reason: run.reason, duration_ms: run.duration_ms, api_calls: run.api.length });
}
export function logTransport(context: Context, data: TelemetrySummary) {
  emit('device_transport', context, { frames_received: data.transport.frames_received, bytes_received: data.transport.bytes_received,
    received_fps: data.transport.received_fps, upload_rtt: data.transport.upload_rtt,
    action_ack_rtt: data.transport.action_ack_rtt, rejected_actions: data.transport.rejected_actions });
}
