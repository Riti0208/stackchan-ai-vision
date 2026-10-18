import { PaidSessionStopped } from './api-outcomes.ts';
import { captureDebug, captureErrorResponse, redactDebugText, type APIDebug } from './api-debug.ts';
export const DECISIONS_MODEL = 'gpt-6-luna';
export type CallMetrics = { model: string; endpoint: 'decisions' | 'responses'; request_id: string | null; input_tokens: number; output_tokens: number; latency_ms: number };
export type APITiming = { endpoint: CallMetrics['endpoint']; model: string; started_at: number; completed_at: number; rtt_ms: number; headers_ms: number | null; status: number | null; request_id: string | null; outcome: 'success' | 'refused' | 'session_stopped' | 'http_error' | 'timeout' | 'network_error' | 'invalid_response' | 'configuration_error'; input_tokens: number | null; output_tokens: number | null };
type TimingContext = { sample: APITiming; phase: 'config' | 'fetch' | 'body' | 'validate'; start: number; debug?: APIDebug };
async function measured<T>(endpoint: CallMetrics['endpoint'], observer: ((timing: APITiming) => void) | undefined, operation: (context: TimingContext) => Promise<T>, secret: string, debugObserver?: (detail: APIDebug) => void): Promise<T> {
  const context: TimingContext = { phase: 'config', start: performance.now(), ...(debugObserver ? { debug: { method: 'POST' as const, url: `https://api.openai.com/v1/${endpoint}`, request: captureDebug(null, 0, secret), response: null, error: null } } : {}), sample: { endpoint, model: DECISIONS_MODEL, started_at: Date.now(), completed_at: 0, rtt_ms: 0, headers_ms: null, status: null, request_id: null, outcome: 'success', input_tokens: null, output_tokens: null } };
  try { return await operation(context); }
  catch (error) {
    context.sample.outcome = error instanceof PaidSessionStopped ? 'session_stopped' : error instanceof DecisionsRefused ? 'refused' : context.phase === 'config' ? 'configuration_error' : error instanceof Error && ['TimeoutError','AbortError'].includes(error.name) ? 'timeout' : error instanceof OpenAIError ? 'http_error' : context.phase === 'fetch' ? 'network_error' : 'invalid_response';
    if (context.debug) {
      const message = redactDebugText(error instanceof Error ? error.message : String(error), secret).slice(0, 2000);
      context.debug.error = { name: redactDebugText(error instanceof Error ? error.name : 'Error', secret).slice(0, 100), message, phase: context.phase, guard_reason: message.startsWith('Paid API session') ? message : null };
    }
    throw error;
  } finally {
    context.sample.completed_at = Date.now(); context.sample.rtt_ms = Math.round(performance.now() - context.start);
    // Diagnostics must never change request success or leak request/response content.
    try { observer?.({ ...context.sample }); } catch { /* observer failure is isolated */ }
    if (context.debug) { try { debugObserver?.(context.debug); } catch { /* body inspection never changes API behavior */ } }
  }
}
export class DecisionsRefused extends Error {
  constructor() { super('Decisions returned an unanswered question'); this.name = 'DecisionsRefused'; }
}
export class OpenAIError extends Error {
  status: number; retryAfterMs: number; requestId: string | null;
  constructor(status: number, retryAfterMs: number, requestId: string | null = null) {
    super(status === 401 ? 'OpenAI authentication failed (401)' : status === 429 ? 'OpenAI rate limit or API credit limit (429)' : `OpenAI request failed (${status})`);
    this.name = 'OpenAIError';
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
  const requestBody = JSON.stringify({ ...payload, model: DECISIONS_MODEL });
  if (timing?.debug) timing.debug.request = captureDebug(JSON.parse(requestBody), new TextEncoder().encode(requestBody).length, apiKey);
  if (!apiKey.trim()) throw new OpenAIError(401, 60000);
  const started = Date.now();
  if (timing) timing.phase = 'fetch';
  const response = await fetcher(`https://api.openai.com/v1/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: requestBody,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const rawRequestId = response.headers.get('x-request-id');
  const requestId = rawRequestId ? redactDebugText(rawRequestId, apiKey).slice(0, 200) : null;
  if (timing) { timing.phase = 'body'; timing.sample.status = response.status; timing.sample.request_id = requestId; timing.sample.headers_ms = Math.round(performance.now() - timing.start); }
  if (!response.ok) {
    const header = response.headers.get('retry-after');
    const seconds = header ? Number(header) : NaN;
    const date = header ? Date.parse(header) : NaN;
    const retry = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : response.status === 429 ? 30000 : 10000;
    // Inspect only bounded, redacted bodies for the authenticated monitor. Logs remain metadata-only.
    if (timing?.debug) {
      try { timing.debug.response = await captureErrorResponse(response, apiKey); }
      catch (error) { timing.debug.response = captureDebug({ body_read_error: redactDebugText(error instanceof Error ? error.message : String(error), apiKey) }, 0, apiKey); }
    } else await response.body?.cancel();
    throw new OpenAIError(response.status, [401, 403, 404].includes(response.status) ? 60000 : Math.max(5000, Math.min(60000, retry)), requestId);
  }
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch (error) {
    if (timing?.debug) timing.debug.response = captureDebug(text, new TextEncoder().encode(text).length, apiKey);
    throw error;
  }
  if (timing?.debug) timing.debug.response = captureDebug(body, new TextEncoder().encode(text).length, apiKey);
  if (!Number.isSafeInteger(body.usage?.input_tokens) || body.usage.input_tokens < 0 || !Number.isSafeInteger(body.usage?.output_tokens) || body.usage.output_tokens < 0) throw new Error('Invalid OpenAI usage');
  if (timing) { timing.phase = 'validate'; timing.sample.input_tokens = body.usage.input_tokens; timing.sample.output_tokens = body.usage.output_tokens; }
  return { body, metrics: { model: DECISIONS_MODEL, endpoint, request_id: requestId, input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens, latency_ms: Date.now() - started } };
}
export async function callDecisions(apiKey: string, payload: object, fetcher: typeof fetch = fetch, timeoutMs = 4000, observer?: (sample: APITiming) => void, debugObserver?: (detail: APIDebug) => void) {
  return measured('decisions', observer, async timing => {
  const result = await requestOpenAI(apiKey, 'decisions', payload, fetcher, timeoutMs, timing);
  if (!Array.isArray(result.body.answers)) throw new Error('Invalid Decisions API response');
  if (result.body.answers.some((answer: any) => answer?.type === 'refusal')) throw new DecisionsRefused();
  return result;
  }, apiKey, debugObserver);
}
export async function callNarration(apiKey: string, payload: object, speech: boolean, fetcher: typeof fetch = fetch, timeoutMs = 3000, observer?: (sample: APITiming) => void, debugObserver?: (detail: APIDebug) => void) {
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
  }, apiKey, debugObserver);
}
export function summarizeCalls(calls: CallMetrics[], live: boolean) {
  return { provider: live ? 'openai' as const : 'mock' as const, model: live ? DECISIONS_MODEL : null, requests: calls.length, input_tokens: calls.reduce((sum, c) => sum + c.input_tokens, 0), output_tokens: calls.reduce((sum, c) => sum + c.output_tokens, 0), latency_ms: calls.reduce((sum, c) => sum + c.latency_ms, 0), request_ids: calls.flatMap(c => c.request_id ? [c.request_id] : []), calls };
}
