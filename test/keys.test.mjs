import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environmentValues, initializeConfig, loadConfig, loadKeys } from '../src/config.mjs';
import { sourceInfo } from '../src/catalog.mjs';
import { ACCOUNTS } from '../src/providers/modules.ts';
import { providerTools } from '../src/providers/index.ts';

test('the accounts list names every credential a source reports, each under exactly one provider account', async t => {
  const state = await mkdtemp(join(tmpdir(), 'dig-keys-accounts-')); t.after(() => rm(state, { recursive: true, force: true })); await initializeConfig(state);
  const reported = new Set(sourceInfo(await loadConfig(state)).sources.flatMap(source => source.credentials.map(c => c.name)));
  const owned = ACCOUNTS.flatMap(account => [...account.keys.flat(), ...(account.optional ?? [])]);
  assert.equal(owned.length, new Set(owned).size, 'No name belongs to two accounts');
  assert.deepEqual(owned.toSorted(), [...reported].toSorted());
});

test('X is ready with both its xAI and X API keys, partly ready with one, and needs setup with neither; the sign-in, TikHub and ScrapeCreators keys are optional', async t => {
  const state = await mkdtemp(join(tmpdir(), 'dig-keys-x-readiness-')); t.after(() => rm(state, { recursive: true, force: true })); await initializeConfig(state);
  const config = { ...(await loadConfig(state)), sources: { enabled: ['x'] } };
  const signIn = ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
  const names = ['XAI_API_KEY', 'X_BEARER_TOKEN', ...signIn, 'TIKHUB_API_KEY', 'SCRAPECREATORS_API_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const x = keys => {
    for (const name of names) if (keys.includes(name)) process.env[name] = `${name.toLowerCase()}-fixture-value`; else delete process.env[name];
    return sourceInfo(config, 'x').sources[0];
  };
  try {
    const both = x(['XAI_API_KEY', 'X_BEARER_TOKEN']);
    assert.equal(both.readiness.status, 'ready');
    assert.deepEqual(both.credentials.map(c => [c.name, c.required]), [['XAI_API_KEY', true], ['X_BEARER_TOKEN', true], ...signIn.map(name => [name, false]), ['TIKHUB_API_KEY', false], ['SCRAPECREATORS_API_KEY', false]]);
    const xApiOnly = x(['X_BEARER_TOKEN', ...signIn, 'TIKHUB_API_KEY', 'SCRAPECREATORS_API_KEY']);
    assert.equal(xApiOnly.readiness.status, 'partial');
    assert.match(xApiOnly.readiness.message, /^Missing XAI_API_KEY in Dig’s keys\.env\./);
    const xaiOnly = x(['XAI_API_KEY']);
    assert.equal(xaiOnly.readiness.status, 'partial');
    assert.match(xaiOnly.readiness.message, /^Missing X_BEARER_TOKEN in Dig’s keys\.env\./);
    assert.equal(x(['TIKHUB_API_KEY', 'SCRAPECREATORS_API_KEY', ...signIn]).readiness.status, 'setup-required');
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('DataForSEO is ready only with both its login and password; with one, it needs setup and names the other', async t => {
  const state = await mkdtemp(join(tmpdir(), 'dig-keys-dataforseo-readiness-')); t.after(() => rm(state, { recursive: true, force: true })); await initializeConfig(state);
  const config = { ...(await loadConfig(state)), sources: { enabled: ['dataforseo'] } };
  const names = ['DATAFORSEO_USERNAME', 'DATAFORSEO_PASSWORD'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const dataforseo = keys => {
    for (const name of names) if (keys.includes(name)) process.env[name] = `${name.toLowerCase()}-fixture-value`; else delete process.env[name];
    return sourceInfo(config, 'dataforseo').sources[0].readiness;
  };
  try {
    assert.equal(dataforseo(names).status, 'ready');
    const login = dataforseo(['DATAFORSEO_USERNAME']);
    assert.equal(login.status, 'setup-required');
    assert.match(login.message, /^Missing DATAFORSEO_PASSWORD in Dig’s keys\.env\./);
    const password = dataforseo(['DATAFORSEO_PASSWORD']);
    assert.equal(password.status, 'setup-required');
    assert.match(password.message, /^Missing DATAFORSEO_USERNAME in Dig’s keys\.env\./);
    assert.equal(dataforseo([]).status, 'setup-required');
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('readiness and the X tool’s own message say how to set a missing key, in words true in any host', async t => {
  const state = await mkdtemp(join(tmpdir(), 'dig-keys-host-words-')); await initializeConfig(state);
  const config = { ...(await loadConfig(state)), sources: { enabled: ['exa', 'x'] } };
  const saved = { DIG_STATE_DIR: process.env.DIG_STATE_DIR, EXA_API_KEY: process.env.EXA_API_KEY, XAI_API_KEY: process.env.XAI_API_KEY };
  t.after(async () => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; await rm(state, { recursive: true, force: true }); });
  process.env.DIG_STATE_DIR = state; delete process.env.EXA_API_KEY; delete process.env.XAI_API_KEY;
  const ctx = { sessionID: 'test', directory: state, worktree: state, abort: new AbortController().signal, keep() {} };
  assert.equal(sourceInfo(config, 'exa').sources[0].readiness.message, 'Missing EXA_API_KEY in Dig’s keys.env. The user sets it outside chat, on the page Dig’s keys tool opens or in keys.env; Dig reloads keys.env when it is saved.');
  assert.equal((await providerTools.xsearch.execute({ query: 'agents' }, ctx)).text, "ERROR: XAI_API_KEY is not set in Dig's keys.env. The user sets it outside chat, on the page Dig's keys tool opens or in keys.env.");
});

test('credentials come only from keys.env; the starting environment is set aside, and other settings fall back to it', async t => {
  const state = await mkdtemp(join(tmpdir(), 'dig-keys-load-')); t.after(() => rm(state, { recursive: true, force: true }));
  const file = join(state, 'keys.env');
  const env = { EXA_API_KEY: 'exported-exa-value', XAI_API_KEY: 'exported-xai-value', TIKHUB_BASE_URL: 'https://exported.example' };
  await writeFile(file, 'XAI_API_KEY="file-xai-value"\nPERPLEXITY_API_KEY=first\nPERPLEXITY_API_KEY=second\nTIKHUB_API_KEY=\nNOT_A_DIG_NAME=ignored\n');
  loadKeys(env, state);
  assert.deepEqual(env, { XAI_API_KEY: 'file-xai-value', PERPLEXITY_API_KEY: 'first', TIKHUB_BASE_URL: 'https://exported.example' });
  assert.deepEqual(Object.fromEntries(environmentValues(env)), { EXA_API_KEY: 'exported-exa-value', XAI_API_KEY: 'exported-xai-value', TIKHUB_BASE_URL: 'https://exported.example' });
  await writeFile(file, 'XAI_API_KEY=rotated-xai-value\nTIKHUB_BASE_URL=https://file.example\n');
  loadKeys(env, state);
  assert.deepEqual(env, { XAI_API_KEY: 'rotated-xai-value', TIKHUB_BASE_URL: 'https://file.example' });
  await rm(file);
  loadKeys(env, state);
  assert.deepEqual(env, { TIKHUB_BASE_URL: 'https://exported.example' });
});
