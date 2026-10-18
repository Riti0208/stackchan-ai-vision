import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export async function readLocalVars(path = '.dev.vars') {
  let raw; try { raw = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    values[match[1]] = value;
  }
  return values;
}
export async function resolveOpenAIKey(local, env = process.env) {
  const key = env.OPENAI_API_KEY || local.OPENAI_API_KEY;
  if (key?.trim()) return key.trim();
  const ref = env.OPENAI_API_KEY_REF || local.OPENAI_API_KEY_REF;
  if (!ref?.startsWith('op://') || /[\r\n]/.test(ref)) throw new Error('Set OPENAI_API_KEY_REF (op://...) or OPENAI_API_KEY in back/.dev.vars.');
  try {
    const { stdout } = await promisify(execFile)(env.OP_BIN || local.OP_BIN || 'op', ['read', ref, '--no-newline'], { encoding: 'utf8', maxBuffer: 16384, timeout: 120000, env });
    if (!stdout.trim()) throw new Error('empty');
    return stdout.trim();
  } catch { throw new Error('Could not read the selected 1Password field. Check CLI integration, authentication and the secret reference.'); }
}
export function demoLimits(args = []) {
  const allowed = new Set(['--openai', '--same-image', '--seconds', '--max-calls']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Unknown option: ${args[i]}`);
    if (['--seconds', '--max-calls'].includes(args[i])) i++;
  }
  const number = (name, fallback, max) => {
    const positions = args.flatMap((v, i) => v === name ? [i] : []);
    if (positions.length > 1) throw new Error(`Duplicate option: ${name}`);
    const value = positions.length ? Number(args[positions[0] + 1]) : fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
    return value;
  };
  return { seconds: number('--seconds', 60, 600), maxCalls: number('--max-calls', 30, 1000) };
}
export async function prepareMockConfig(local) { return prepareConfig(local, null, null); }
export async function prepareOpenAIConfig(local, limits = demoLimits()) {
  // Deadline includes credential resolution and startup; it can never be extended by reload.
  const session = { PAID_SESSION_ID: crypto.randomUUID(), PAID_SESSION_UNTIL: String(Date.now() + limits.seconds * 1000), PAID_SESSION_MAX_CALLS: String(limits.maxCalls) };
  const key = await resolveOpenAIKey(local);
  return prepareConfig(local, key, session);
}
async function prepareConfig(local, key, session) {
  await mkdir('.wrangler', { recursive: true });
  const directory = await mkdtemp(resolve('.wrangler/openai-'));
  try {
    const configuration = JSON.parse(await readFile(key ? 'wrangler.openai.jsonc' : 'wrangler.local.jsonc', 'utf8'));
    delete configuration.$schema; configuration.main = resolve('src/index.ts'); configuration.assets.directory = resolve('lab');
    await writeFile(`${directory}/wrangler.jsonc`, JSON.stringify(configuration), { mode: 0o600 });
    const vars = Object.fromEntries(['ROOM_CONFIG', 'SESSION_SECRET', 'ALLOWED_ORIGIN'].map(name => [name, local[name]]));
    for (const name of ['STREAM_FPS','EVAL_INTERVAL_MS','NARRATION_INTERVAL_MS','BEHAVIOR_MODE']) if (local[name]) vars[name] = local[name];
    vars.AI_MODE = key ? 'decisions' : 'mock';
    if (key) Object.assign(vars, { OPENAI_API_KEY: key }, session);
    // dotenv preserves backslashes before quotes; JSON.stringify is not dotenv escaping.
    const lines = Object.entries(vars).map(([name, value]) => {
      const text = value || '';
      const quote = ["'", '"', '`'].find(q => !text.includes(q));
      if (!quote || /[\r\n]/.test(text)) throw new Error('Local secret configuration contains unsupported quoting or line breaks.');
      return `${name}=${quote}${text}${quote}`;
    });
    await writeFile(`${directory}/.dev.vars`, lines.join('\n') + '\n', { mode: 0o600 });
    return { path: `${directory}/wrangler.jsonc`, expiresAt: session ? Number(session.PAID_SESSION_UNTIL) : null, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
