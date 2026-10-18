/** Authenticated, ephemeral inspection only. Never put these bodies in telemetry/storage/logs. */
export const DEBUG_BODY_BYTES = 24 * 1024;
export const DEBUG_CACHE_BYTES = 1024 * 1024;
export const DEBUG_CACHE_CALLS = 20;
export const DEBUG_TTL_MS = 10 * 60 * 1000;
export type DebugBody = { body: unknown; bytes: number; truncated: boolean; images_omitted: number };
export type APIDebug = {
  method: 'POST'; url: string; request: DebugBody; response: DebugBody | null;
  error: { name: string; message: string; phase: string; guard_reason: string | null } | null;
};
const encoder = new TextEncoder();
export const debugBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
export function redactDebugText(text: string, secret: string): string {
  let safe = secret ? text.split(secret).join('[REDACTED]') : text;
  // A truncated raw response may end halfway through a reflected key.
  if (secret) for (let n = Math.min(secret.length - 1, safe.length); n >= 8; n--) if (safe.endsWith(secret.slice(0, n))) { safe = safe.slice(0, -n) + '[REDACTED]'; break; }
  return safe
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(?:authorization|cookie|set-cookie|x-api-key|api[-_]?key|access_token|refresh_token|client_secret|password)["']?\s*[:=]\s*[^\r\n]+/gi, '[REDACTED HEADER]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[image omitted]');
}
/** Preserves ordinary JSON; explicit markers replace images and oversized/deep values. */
export function captureDebug(value: unknown, bytes: number, secret: string, sourceTruncated = false): DebugBody {
  let nodes = 0, images = 0, truncated = sourceTruncated, remaining = DEBUG_BODY_BYTES;
  const clipped = (text: string, limit: number) => {
    const safe = redactDebugText(text, secret);
    if (encoder.encode(safe).length <= limit) return safe;
    truncated = true;
    // A code unit is at most three UTF-8 bytes; reserve room for the marker.
    return safe.slice(0, Math.max(0, Math.floor((limit - 60) / 3))) + '… [truncated]';
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 1200 || depth > 12 || remaining <= 80) { truncated = true; return '[truncated]'; }
    remaining -= 12;
    if (typeof item === 'string') {
      const image = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(item);
      if (image) {
        images++;
        const payload = image[2], padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
        return { omitted: 'image', mime_type: image[1], bytes: Math.max(0, Math.floor(payload.length * 3 / 4) - padding) };
      }
      const safe = clipped(item, Math.max(80, Math.min(remaining, 12000)));
      remaining -= encoder.encode(safe).length;
      return safe;
    }
    if (Array.isArray(item)) return item.slice(0, 150).map(v => visit(v, depth + 1)).concat(item.length > 150 ? (truncated = true, ['[truncated]']) : []);
    if (item && typeof item === 'object') {
      const result: Record<string, unknown> = Object.create(null);
      let count = 0;
      for (const [key, child] of Object.entries(item)) {
        if (++count > 150 || remaining <= 80) { result._truncated = true; truncated = true; break; }
        const safeKey = clipped(key, 200); remaining -= encoder.encode(safeKey).length;
        result[safeKey] = /^(authorization|cookie|set-cookie|api[-_]?key|x-api-key|access_token|refresh_token|secret|client_secret|password|token)$/i.test(key) ? '[REDACTED]' : visit(child, depth + 1);
      }
      return result;
    }
    return item ?? null;
  };
  let body = visit(value, 0);
  if (debugBytes(body) > DEBUG_BODY_BYTES) { body = { preview: clipped(JSON.stringify(body), DEBUG_BODY_BYTES / 2), omitted: 'oversized JSON' }; truncated = true; }
  return { body, bytes, truncated, images_omitted: images };
}
/** Error bodies are read only to the inspection limit; never consume an unbounded error stream. */
export async function captureErrorResponse(response: Response, secret: string): Promise<DebugBody> {
  const reader = response.body?.getReader();
  if (!reader) return captureDebug(null, 0, secret);
  const chunks: Uint8Array[] = []; let length = 0, truncated = false;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      const available = DEBUG_BODY_BYTES - length;
      chunks.push(next.value.slice(0, available)); length += Math.min(available, next.value.byteLength);
      if (next.value.byteLength > available || length === DEBUG_BODY_BYTES) { truncated = true; await reader.cancel(); break; }
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  const text = new TextDecoder().decode(bytes);
  let body: unknown = text; try { body = JSON.parse(text); } catch { /* non-JSON/partial error response */ }
  return captureDebug(body, length, secret, truncated);
}
export class APIDebugCache {
  private entries = new Map<string, { at: number; bytes: number; detail: APIDebug }>();
  private bytes = 0;
  private prune(now: number) {
    for (const [key, entry] of this.entries) if (now - entry.at >= DEBUG_TTL_MS) this.remove(key);
  }
  private remove(key: string) { const old = this.entries.get(key); if (old) this.bytes -= old.bytes; this.entries.delete(key); }
  put(key: string, detail: APIDebug, now = Date.now()) {
    this.prune(now); this.remove(key);
    const bytes = debugBytes(detail); if (bytes > DEBUG_CACHE_BYTES) return;
    this.entries.set(key, { at: now, bytes, detail }); this.bytes += bytes;
    while (this.entries.size > DEBUG_CACHE_CALLS || this.bytes > DEBUG_CACHE_BYTES) this.remove(this.entries.keys().next().value!);
  }
  get(key: string, now = Date.now()): APIDebug | null { this.prune(now); return this.entries.get(key)?.detail ?? null; }
}
