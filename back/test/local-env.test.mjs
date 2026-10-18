import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLocalVars, resolveOpenAIKey, prepareOpenAIConfig } from '../scripts/local-env.mjs';
test('1Password reads only the specified field and suppresses raw CLI errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-op-test-'));
  try {
    const executable = join(directory, 'op');
    await writeFile(executable, '#!/bin/sh\nif [ "$1" = read ] && [ "$2" = "op://test-vault/test-item/credential" ] && [ "$3" = --no-newline ]; then printf fixture-secret; else printf PRIVATE_ERROR >&2; exit 1; fi\n', { mode: 0o700 });
    const key = await resolveOpenAIKey({ OPENAI_API_KEY_REF: 'op://test-vault/test-item/credential', OP_BIN: executable }, {});
    assert.ok(key === 'fixture-secret');
    await assert.rejects(resolveOpenAIKey({ OPENAI_API_KEY_REF: 'op://different/item/key', OP_BIN: executable }, {}), error => !error.message.includes('PRIVATE_ERROR'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('Wrangler secret materialization is restricted, whitelisted and cleaned up', async () => {
  const original = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'fixture-secret'; let prepared;
  try {
    const roomConfig = JSON.stringify({ main: { control_token: 'test-control', devices: { 'stackchan-01': 'test-device' } } });
    prepared = await prepareOpenAIConfig({ ROOM_CONFIG: roomConfig, SESSION_SECRET: 'fixture-session', ALLOWED_ORIGIN: 'http://127.0.0.1:8787', STREAM_FPS: '4', EVAL_INTERVAL_MS: '1500', UNRELATED_SECRET: 'do-not-copy' });
    const directory = prepared.path.slice(0, prepared.path.lastIndexOf('/'));
    assert.equal((await stat(`${directory}/.dev.vars`)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const raw = await readFile(`${directory}/.dev.vars`, 'utf8');
    assert.ok(!raw.includes('do-not-copy')); assert.ok(raw.includes('fixture-secret'));
    const parsed = await readLocalVars(`${directory}/.dev.vars`); assert.ok(parsed.OPENAI_API_KEY === 'fixture-secret');
    assert.equal(parsed.AI_MODE, 'decisions'); assert.equal(parsed.PAID_SESSION_MAX_CALLS, '30'); assert.ok(Number(parsed.PAID_SESSION_UNTIL) <= Date.now() + 60000); assert.ok(parsed.PAID_SESSION_ID);
    assert.equal(parsed.ROOM_CONFIG, roomConfig); assert.equal(parsed.STREAM_FPS,'4'); assert.equal(parsed.EVAL_INTERVAL_MS,'1500');
    await prepared.cleanup(); await assert.rejects(stat(prepared.path), { code: 'ENOENT' });
  } finally { await prepared?.cleanup(); if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original; }
});
