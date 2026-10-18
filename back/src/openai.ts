export const DECISIONS_MODEL = 'gpt-6-luna';
export type CallMetrics = { model: string; endpoint: 'decisions' | 'responses'; request_id: string | null; input_tokens: number; output_tokens: number; latency_ms: number };
export type APITiming = { endpoint: CallMetrics['endpoint']; model: string; started_at: number; completed_at: number; rtt_ms: number; headers_ms: number | null; status: number | null; request_id: string | null; outcome: 'success' | 'http_error' | 'timeout' | 'network_error' | 'invalid_response' | 'configuration_error'; input_tokens: number | null; output_tokens: number | null };
type TimingContext = { sample: APITiming; phase: 'config' | 'fetch' | 'body' | 'validate'; start: number };
async function measured<T>(endpoint: CallMetrics['endpoint'], observer: ((timing: APITiming) => void) | undefined, operation: (context: TimingContext) => Promise<T>): Promise<T> {
  const context: TimingContext = { phase: 'config', start: performance.now(), sample: { endpoint, model: DECISIONS_MODEL, started_at: Date.now(), completed_at: 0, rtt_ms: 0, headers_ms: null, status: null, request_id: null, outcome: 'success', input_tokens: null, output_tokens: null } };
  try { return await operation(context); }
  catch (error) {
    context.sample.outcome = context.phase === 'config' ? 'configuration_error' : error instanceof Error && ['TimeoutError','AbortError'].includes(error.name) ? 'timeout' : error instanceof OpenAIError ? 'http_error' : context.phase === 'fetch' ? 'network_error' : 'invalid_response';
    throw error;
  } finally {
    context.sample.completed_at = Date.now(); context.sample.rtt_ms = Math.round(performance.now() - context.start);
    // Diagnostics must never change request success or leak request/response content.
    try { observer?.({ ...context.sample }); } catch { /* observer failure is isolated */ }
  }
}
export class OpenAIError extends Error {
  status: number; retryAfterMs: number; requestId: string | null;
  constructor(status: number, retryAfterMs: number, requestId: string | null = null) {
    super(status === 401 ? 'OpenAI authentication failed (401)' : status === 429 ? 'OpenAI rate limit or API credit limit (429)' : `OpenAI request failed (${status})`);
    this.status = status; this.retryAfterMs = retryAfterMs; this.requestId = requestId;
  }
}
async function requestOpenAI(
  apiKey: string,
  endpoint: CallMetrics['endpoint'],
  payload: object,
  fetcher: typeof fetch = fetch,
  timeoutMs = 4000,
  timing?: TimingContext
): Promise<{ body: any; metrics: CallMetrics }> {
  if (!apiKey.trim()) throw new OpenAIError(401, 60000);
  const started = Date.now();
  if (timing) timing.phase = 'fetch';
  const response = await fetcher(`https://api.openai.com/v1/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, model: DECISIONS_MODEL }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const requestId = response.headers.get('x-request-id');
  if (timing) { timing.phase = 'body'; timing.sample.status = response.status; timing.sample.request_id = requestId; timing.sample.headers_ms = Math.round(performance.now() - timing.start); }
  if (!response.ok) {
    const header = response.headers.get('retry-after');
    const seconds = header ? Number(header) : NaN;
    const date = header ? Date.parse(header) : NaN;
    const retry = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : response.status === 429 ? 30000 : 10000;
    // Never forward raw error bodies: they may contain reflected request data.
    await response.body?.cancel();
    throw new OpenAIError(response.status, [401, 403, 404].includes(response.status) ? 60000 : Math.max(5000, Math.min(60000, retry)), requestId);
  }
  const body: any = await response.json();
  if (!Number.isSafeInteger(body.usage?.input_tokens) || body.usage.input_tokens < 0 || !Number.isSafeInteger(body.usage?.output_tokens) || body.usage.output_tokens < 0) throw new Error('Invalid OpenAI usage');
  if (timing) { timing.phase = 'validate'; timing.sample.input_tokens = body.usage.input_tokens; timing.sample.output_tokens = body.usage.output_tokens; }
  return { body, metrics: { model: DECISIONS_MODEL, endpoint, request_id: requestId, input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens, latency_ms: Date.now() - started } };
}
export async function callDecisions(apiKey: string, payload: object, fetcher: typeof fetch = fetch, timeoutMs = 4000, observer?: (sample: APITiming) => void) {
  return measured('decisions', observer, async timing => {
  const result = await requestOpenAI(apiKey, 'decisions', payload, fetcher, timeoutMs, timing);
  if (!Array.isArray(result.body.answers)) throw new Error('Invalid Decisions API response');
  return result;
  });
}
export async function callNarration(apiKey: string, payload: object, speech: boolean, fetcher: typeof fetch = fetch, timeoutMs = 3000, observer?: (sample: APITiming) => void) {
  return measured('responses', observer, async timing => {
  const result = await requestOpenAI(apiKey, 'responses', payload, fetcher, timeoutMs, timing);
  const body = result.body;
  if (body.status !== 'completed' || !Array.isArray(body.output)) throw new Error('Incomplete narration');
  const content = body.output.filter((item: any) => item.type === 'message' && item.role === 'assistant').flatMap((item: any) => item.content || []);
  if (content.some((item: any) => item.type === 'refusal')) throw new Error('Narration refused');
  const parts = content.filter((item: any) => item.type === 'output_text');
  if (parts.length !== 1 || typeof parts[0].text !== 'string') throw new Error('Invalid narration output');
  let text: any;
  try { text = JSON.parse(parts[0].text); } catch { throw new Error('Invalid narration JSON'); }
  const valid = (s: unknown, max: number) => typeof s === 'string' && s.trim().length > 0 && [...s].length <= max && !/[\u0000-\u001f\u007f]/u.test(s);
  if (!text || Object.keys(text).sort().join(',') !== 'public_text,thought' || !valid(text.thought, 160) || (speech ? !valid(text.public_text, 100) : text.public_text !== null)) throw new Error('Invalid narration fields');
  return { text: { thought: text.thought.trim() as string, public_text: text.public_text?.trim() as string | undefined ?? null }, metrics: result.metrics };
  });
}
export function summarizeCalls(calls: CallMetrics[], live: boolean) {
  return { provider: live ? 'openai' as const : 'mock' as const, model: live ? DECISIONS_MODEL : null, requests: calls.length, input_tokens: calls.reduce((sum, c) => sum + c.input_tokens, 0), output_tokens: calls.reduce((sum, c) => sum + c.output_tokens, 0), latency_ms: calls.reduce((sum, c) => sum + c.latency_ms, 0), request_ids: calls.flatMap(c => c.request_id ? [c.request_id] : []), calls };
}
