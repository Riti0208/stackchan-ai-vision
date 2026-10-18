export type PaidEnv = { AI_MODE?: string; PAID_SESSION_ID?: string; PAID_SESSION_UNTIL?: string; PAID_SESSION_MAX_CALLS?: string };
export function paidSession(env: PaidEnv, used = 0, now = Date.now()) {
  const expires_at = Number(env.PAID_SESSION_UNTIL), max_calls = Number(env.PAID_SESSION_MAX_CALLS);
  const configured = !!env.PAID_SESSION_ID && /^[a-zA-Z0-9_-]{1,80}$/.test(env.PAID_SESSION_ID) && Number.isSafeInteger(expires_at) && expires_at > 0 && Number.isSafeInteger(max_calls) && max_calls > 0 && max_calls <= 1000;
  const reason = env.AI_MODE !== 'decisions' ? 'mock' : !configured ? 'not_started' : now >= expires_at ? 'expired' : used >= max_calls ? 'call_limit' : null;
  return { active: reason === null, reason, expires_at: configured ? expires_at : null, max_calls: configured ? max_calls : 0, used_calls: used };
}
// A single internal Room actor owns the count for every device and room in a session.
// Reserve durably before sending: failures and interrupted calls still consume a slot.
export async function reservePaidCall(storage: DurableObjectStorage, env: PaidEnv, reserve: boolean) {
  if (['mock', 'not_started'].includes(paidSession(env).reason || '')) return paidSession(env);
  return storage.transaction(async tx => {
    const key = `paid-session:${env.PAID_SESSION_ID}`;
    const used = await tx.get<number>(key) || 0;
    const status = paidSession(env, used);
    if (reserve && status.active) {
      await tx.put(key, used + 1);
      return { ...paidSession(env, used + 1), active: true, reason: null };
    }
    return status;
  });
}
export function guardedFetch(env: PaidEnv, reserve: () => Promise<{ active: boolean; reason: string | null; expires_at: number | null }>, outbound: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (!paidSession(env).active) throw new Error('Paid API session is not active');
    const permission = await reserve();
    if (!permission.active || !permission.expires_at || Date.now() >= permission.expires_at) throw new Error(`Paid API session stopped: ${permission.reason || 'expired'}`);
    const deadline = AbortSignal.timeout(Math.max(1, permission.expires_at - Date.now()));
    const original = init?.signal || (input instanceof Request ? input.signal : undefined);
    return outbound(input, { ...init, signal: original ? AbortSignal.any([original, deadline]) : deadline });
  };
}
