// The worker enforces each outbound call; this watcher also closes the local demo.
export function watchPaidSession({ expiresAt, readStatus, stop, report = () => {}, intervalMs = 500 }) {
  let stopped = false, checking = false;
  const finish = (reason, status) => { if (stopped) return; cancel(); report(reason, status); stop(); };
  const deadline = setTimeout(() => finish('expired'), Math.max(0, expiresAt - Date.now()));
  const poll = setInterval(async () => {
    if (stopped || checking) return; checking = true;
    try { const status = await readStatus(); if (!status?.active) finish(status?.reason || 'unavailable', status); }
    catch { finish('unavailable'); }
    finally { checking = false; }
  }, intervalMs);
  function cancel() { stopped = true; clearTimeout(deadline); clearInterval(poll); }
  return cancel;
}
