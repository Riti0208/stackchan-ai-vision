import { resolve } from 'node:path';
import { readLocalVars, prepareMockConfig } from './local-env.mjs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const prepared = args[0] === 'dev' && args.includes('wrangler.local.jsonc') ? await prepareMockConfig(await readLocalVars()) : null;
if (prepared) {
  args[args.indexOf('wrangler.local.jsonc')] = prepared.path;
  if (!args.includes('--persist-to')) args.push('--persist-to', resolve('.wrangler/state'));
}
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
  stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '.wrangler/logs/cli.log' }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => prepared?.cleanup());
child.on('exit', async code => { await prepared?.cleanup(); process.exitCode = code ?? 1; });
