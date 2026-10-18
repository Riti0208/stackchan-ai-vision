import { PaidSessionStopped } from './api-outcomes.ts';
export { PaidSessionStopped } from './api-outcomes.ts';
export type PaidEnv = { AI_MODE?: string; PAID_SESSION_ID?: string; PAID_SESSION_UNLIMITED?: string; PAID_SESSION_UNTIL?: string; PAID_SESSION_MAX_CALLS?: string };
export function paidSession(env: PaidEnv, used = 0, now = Date.now()) {
  const unlimited = env.PAID_SESSION_UNLIMITED === 'true';
  const expires_at = Number(env.PAID_SESSION_UNTIL), max_calls = Number(env.PAID_SESSION_MAX_CALLS);
  const configured = !!env.PAID_SESSION_ID && /^[a-zA-Z0-9_-]{1,80}$/.test(env.PAID_SESSION_ID) && (unlimited ? env.PAID_SESSION_UNTIL === '0' : Number.isSafeInteger(expires_at) && expires_at > 0) && !!env.PAID_SESSION_MAX_CALLS?.trim() && Number.isSafeInteger(max_calls) && max_calls >= 0;
  const reason = env.AI_MODE !== 'decisions' ? 'mock' : !configured ? 'not_started' : !unlimited && now >= expires_at ? 'expired' : max_calls > 0 && used >= max_calls ? 'call_limit' : null;
  return { active: reason === null, reason, expires_at: configured && !unlimited ? expires_at : null, max_calls: configured ? max_calls : 0, used_calls: used };
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
    const status = paidSession(env);
    if (!status.active) throw new PaidSessionStopped(status.reason || 'not_started', 'Paid API session is not active');
    const permission = await reserve();
    if (!permission.active || (permission.expires_at === null ? env.PAID_SESSION_UNLIMITED !== 'true' : Date.now() >= permission.expires_at)) throw new PaidSessionStopped(permission.reason || 'expired');
    const deadline = permission.expires_at === null ? undefined : AbortSignal.timeout(Math.max(1, permission.expires_at - Date.now()));
    const original = init?.signal || (input instanceof Request ? input.signal : undefined);
    return outbound(input, { ...init, signal: deadline ? original ? AbortSignal.any([original, deadline]) : deadline : original });
  };
}

export type ControlledPaidEnv = PaidEnv & { ENABLE_PAID_CONTROL?: string; PAID_CONTROL_ROOM?: string; OPENAI_API_KEY?: string; VERSION_METADATA?: { id: string } };
type ManualSession = { id: string; epoch: string; until: number | null; max: number; used: number; stopped: boolean };
export type BudgetStatus = ReturnType<typeof paidSession> & { session_id?: string | null };
function manualStatus(record: ManualSession | undefined, env: ControlledPaidEnv): BudgetStatus {
  const base = { expires_at: record?.until || null, max_calls: record?.max || 0, used_calls: record?.used || 0, session_id: record?.id || null };
  const reason = !record ? 'not_started' : record.stopped ? 'stopped' : record.epoch !== (env.VERSION_METADATA?.id || 'local') ? 'deployment_changed' : record.until !== null && Date.now() >= record.until ? 'expired' : record.max > 0 && record.used >= record.max ? 'call_limit' : null;
  return { ...base, active: reason === null, reason };
}
export async function controlledBudget(storage: DurableObjectStorage, env: ControlledPaidEnv, reserve = false, expected?: string): Promise<BudgetStatus> {
  return storage.transaction(async tx => {
    const record = await tx.get<ManualSession>('manual-paid-session');
    const status = manualStatus(record, env);
    if (reserve && expected !== record?.id) return { ...status, active: false, reason: 'session_changed' };
    if (reserve && status.active && record) {
      record.used++; await tx.put('manual-paid-session', record);
      // The final reserved call is authorized; subsequent reservations see the cap.
      return { ...manualStatus(record, env), active: true, reason: null };
    }
    return status;
  });
}
export async function updatePaidSession(storage: DurableObjectStorage, env: ControlledPaidEnv, command: { action: 'start' | 'stop'; seconds?: number; max_calls?: number }): Promise<BudgetStatus> {
  if (env.ENABLE_PAID_CONTROL !== 'true') throw new Error('control_disabled');
  if (command.action === 'start') {
    if (!env.OPENAI_API_KEY?.trim()) throw new Error('key_not_configured');
    if (!Number.isSafeInteger(command.seconds) || command.seconds! < 0 || command.seconds! > 600 || !Number.isSafeInteger(command.max_calls) || command.max_calls! < 0) throw new Error('invalid_limits');
  }
  return storage.transaction(async tx => {
    let record = await tx.get<ManualSession>('manual-paid-session');
    if (command.action === 'start') {
      if (manualStatus(record, env).active) throw new Error('already_active');
      record = { id: crypto.randomUUID(), epoch: env.VERSION_METADATA?.id || 'local', until: command.seconds === 0 ? null : Date.now() + command.seconds! * 1000, max: command.max_calls!, used: 0, stopped: false };
    } else record = { ...(record || { id: crypto.randomUUID(), epoch: env.VERSION_METADATA?.id || 'local', until: 0, max: 0, used: 0 }), stopped: true };
    await tx.put('manual-paid-session', record);
    return manualStatus(record, env);
  });
}
