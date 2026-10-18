import { watchPaidSession } from './paid-session.mjs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { access, copyFile, readFile } from 'node:fs/promises';
import { readLocalVars, prepareOpenAIConfig, prepareMockConfig, demoLimits } from './local-env.mjs';
import { Simulator, startGateway } from './fw-simulator.mjs';
const limits = demoLimits(process.argv.slice(2));
try { await access('.dev.vars'); } catch { await copyFile('.dev.vars.example', '.dev.vars'); }
// Read only the non-executable dotenv ROOM_CONFIG field; never evaluate shell text.
const raw = await readFile('.dev.vars', 'utf8');
const configLine = raw.split('\n').find(line => line.startsWith('ROOM_CONFIG='));
if (!configLine) throw new Error('ROOM_CONFIG is missing from .dev.vars');
let value = configLine.slice('ROOM_CONFIG='.length).trim();
if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
const config = JSON.parse(value);
const useOpenAI = process.argv.includes('--openai');
const local = await readLocalVars();
const fps = Number(local.STREAM_FPS || 60);
if (!Number.isFinite(fps) || fps < 1 || fps > 60) throw new Error('STREAM_FPS must be between 1 and 60');
try { const existing = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(500) }); if (existing.ok) throw new Error('DEMO_PORT_IN_USE'); } catch (error) { if (error.message === 'DEMO_PORT_IN_USE') throw new Error('Port 8787 is already in use. Stop the existing demo first.'); }
const prepared = useOpenAI ? await prepareOpenAIConfig(local, limits) : await prepareMockConfig(local);
const wrangler = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', prepared?.path || 'wrangler.local.jsonc', '--ip', '127.0.0.1', '--port', '8787', '--persist-to', resolve('.wrangler/state')], { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '.wrangler/logs/demo.log' } });
wrangler.on('exit', () => prepared?.cleanup());
wrangler.on('error', () => { prepared?.cleanup(); stop(); });
const simulators = new Map(); let gateway, stopped = false, cancelWatch, ready = false;
function stop() { if (stopped) return; stopped = true; cancelWatch?.(); for (const sim of simulators.values()) sim.stop(); gateway?.close(); wrangler.kill('SIGTERM'); }
if (useOpenAI) cancelWatch = watchPaidSession({ expiresAt: prepared.expiresAt, stop, readStatus: async () => {
  // Startup has no camera/simulator traffic. Allow Wrangler to become ready first.
  if (!ready) return { active: true };
  return (await (await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(1500) })).json()).paid_session;
}, report: (reason, status) => console.log(`Paid session stopped: ${reason} (${status?.used_calls ?? 'unknown'} reserved calls)`) });
process.on('SIGINT', stop); process.on('SIGTERM', stop); wrangler.on('exit', stop);
for (let i = 0; i < 60 && !stopped; i++) {
  try { const r = await fetch('http://127.0.0.1:8787/health'); if (r.ok && (await r.json()).ok) { ready = true; break; } } catch {}
  await new Promise(r => setTimeout(r, 500));
}
if (!ready && !stopped) { stop(); throw new Error('Local Worker did not start'); }
if (stopped) process.exit(0);
if (useOpenAI) {
  console.log(`Paid session limits: ${limits.seconds}s / ${limits.maxCalls} total API calls. Restart explicitly for another session.`);
}
for (const [id, token] of Object.entries(config.main?.devices || {})) simulators.set(id, new Simulator({ id, token, fps, sharedImage: process.argv.includes('--same-image'), notify(event) { gateway?.notify(event); if (event.type === 'action') console.log(`[${id}] ${event.data.action} pan=${event.data.pan.toFixed(2)} tilt=${event.data.tilt.toFixed(2)} expression=${event.data.expression} seq=${event.data.seq}`); } }));
gateway = startGateway(simulators);
for (const sim of simulators.values()) sim.start();
console.log('\nLocal E2E lab: http://127.0.0.1:8787\nControl token: use control_token from your .dev.vars (example: dev-control-main)\nAI mode: ' + (useOpenAI ? 'OpenAI Decisions + Luna Responses (API usage is billed)' : 'mock observations + mock narration (no OpenAI requests)') + '. Ctrl+C stops all demo processes.\n');
