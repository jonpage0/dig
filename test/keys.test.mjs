import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environmentValues, initializeConfig, loadConfig, loadKeys } from '../src/config.mjs';
import { copyEnvironmentKeys, prepareKeysFile, sourceInfo } from '../src/catalog.mjs';
import { ACCOUNTS } from '../src/providers/modules.ts';

test('the accounts list names every credential a source reports, each under exactly one provider account', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-keys-accounts-')); await initializeConfig(state);
  const reported = new Set(sourceInfo(await loadConfig(state)).sources.flatMap(source => source.credentials.map(c => c.name)));
  const owned = ACCOUNTS.flatMap(account => [...account.keys.flat(), ...(account.optional ?? [])]);
  assert.equal(owned.length, new Set(owned).size, 'No name belongs to two accounts');
  assert.deepEqual(owned.toSorted(), [...reported].toSorted());
});

test('X is ready with both its xAI and X API keys, partly ready with one, and needs setup with neither; the sign-in and TikHub keys are optional', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-keys-x-readiness-')); await initializeConfig(state);
  const config = { ...(await loadConfig(state)), sources: { enabled: ['x'] } };
  const signIn = ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
  const names = ['XAI_API_KEY', 'X_BEARER_TOKEN', ...signIn, 'TIKHUB_API_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const x = keys => {
    for (const name of names) if (keys.includes(name)) process.env[name] = `${name.toLowerCase()}-fixture-value`; else delete process.env[name];
    return sourceInfo(config, 'x').sources[0];
  };
  try {
    const both = x(['XAI_API_KEY', 'X_BEARER_TOKEN']);
    assert.equal(both.readiness.status, 'ready');
    assert.deepEqual(both.credentials.map(c => [c.name, c.required]), [['XAI_API_KEY', true], ['X_BEARER_TOKEN', true], ...signIn.map(name => [name, false]), ['TIKHUB_API_KEY', false]]);
    const xApiOnly = x(['X_BEARER_TOKEN', ...signIn, 'TIKHUB_API_KEY']);
    assert.equal(xApiOnly.readiness.status, 'partial');
    assert.match(xApiOnly.readiness.message, /^Missing XAI_API_KEY in Dig’s keys\.env\./);
    const xaiOnly = x(['XAI_API_KEY']);
    assert.equal(xaiOnly.readiness.status, 'partial');
    assert.match(xaiOnly.readiness.message, /^Missing X_BEARER_TOKEN in Dig’s keys\.env\./);
    assert.equal(x(['TIKHUB_API_KEY', ...signIn]).readiness.status, 'setup-required');
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('credentials come only from keys.env; the starting environment is set aside, and other settings fall back to it', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-keys-load-'));
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

test('Use existing key copies one source’s environment credentials into keys.env; Update key from env replaces a different value', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-keys-copy-'));
  const env = { DATAFORSEO_USERNAME: 'env-login', DATAFORSEO_PASSWORD: 'env-password-value', EXA_API_KEY: 'env-exa-value' };
  await prepareKeysFile('dataforseo', state);
  loadKeys(env, state);
  const first = await copyEnvironmentKeys('dataforseo', state, env);
  assert.deepEqual(first.copied, ['DATAFORSEO_USERNAME', 'DATAFORSEO_PASSWORD']);
  const text = await readFile(first.path, 'utf8');
  assert.match(text, /^DATAFORSEO_USERNAME=env-login\nDATAFORSEO_PASSWORD=env-password-value$/m, 'Placeholder lines are filled in place');
  assert.equal(env.DATAFORSEO_PASSWORD, 'env-password-value', 'The copy applies at once');
  assert.equal(env.EXA_API_KEY, undefined, 'Another source’s environment key stays set aside');
  assert.deepEqual((await copyEnvironmentKeys('dataforseo', state, env)).copied, []);

  await writeFile(first.path, text.replace('DATAFORSEO_PASSWORD=env-password-value', 'DATAFORSEO_PASSWORD=file-password-value'));
  loadKeys(env, state);
  assert.equal(env.DATAFORSEO_PASSWORD, 'file-password-value', 'keys.env wins until the user asks to update');
  const update = await copyEnvironmentKeys('dataforseo', state, env);
  assert.deepEqual(update.copied, ['DATAFORSEO_PASSWORD']);
  assert.equal(env.DATAFORSEO_PASSWORD, 'env-password-value');
  assert.equal((await readFile(first.path, 'utf8')).match(/^DATAFORSEO_PASSWORD=/gm).length, 1);

  const exa = await copyEnvironmentKeys('exa', state, env);
  assert.match(await readFile(exa.path, 'utf8'), /^# Exa: EXA_API_KEY\nEXA_API_KEY=env-exa-value$/m, 'A name without a line is appended under its source');
  assert.equal((await stat(exa.path)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify([first, update, exa]), /env-login|env-password-value|env-exa-value/);
});

test('Edit keys.env creates a private file and adds an empty line for every credential name the file lacks, once', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-keys-prepare-'));
  const first = await prepareKeysFile('dataforseo', state);
  assert.deepEqual([first.created, first.added], [true, ['DATAFORSEO_USERNAME', 'DATAFORSEO_PASSWORD']]);
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  const created = await readFile(first.path, 'utf8');
  assert.match(created, /^# DataForSEO: .+\nDATAFORSEO_USERNAME=\nDATAFORSEO_PASSWORD=$/m);
  const loaded = {}; loadKeys(loaded, state);
  assert.deepEqual(loaded, {}, 'Empty lines are placeholders, not values');
  const again = await prepareKeysFile('dataforseo', state);
  assert.deepEqual([again.created, again.added], [false, []]);
  assert.equal(await readFile(first.path, 'utf8'), created);

  // Without a source, every source is covered, enabled or not: only names the file already assigns (even commented
  // out) are skipped, and a name several sources share is written once, labeled with each of them.
  await writeFile(first.path, `${created}EXA_API_KEY=user-exa-value\n# TIKHUB_API_KEY=\n`);
  const all = await prepareKeysFile(undefined, state);
  assert.ok(all.added.includes('XAI_API_KEY') && all.added.includes('NEXSCOPE_API_KEY'));
  assert.ok(!['EXA_API_KEY', 'TIKHUB_API_KEY', 'DATAFORSEO_USERNAME'].some(name => all.added.includes(name)));
  const text = await readFile(first.path, 'utf8');
  assert.ok(text.startsWith(`${created}EXA_API_KEY=user-exa-value\n# TIKHUB_API_KEY=\n`), 'Existing lines stay as they were');
  assert.equal(text.match(/^SCRAPECREATORS_API_KEY=$/gm).length, 1);
});

test('Edit keys.env offers a source’s settings, such as the Unpaywall contact email, as empty lines that say what they are for', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-keys-settings-'));
  const prepared = await prepareKeysFile('papers', state);
  assert.equal(prepared.added.at(-1), 'PAPER_SEARCH_MCP_UNPAYWALL_EMAIL');
  const text = await readFile(prepared.path, 'utf8');
  assert.match(text, /^# Unpaywall contact email \(Papers\): Unpaywall looks up a legal free copy.+\nPAPER_SEARCH_MCP_UNPAYWALL_EMAIL=$/m);
  const loaded = { PAPER_SEARCH_MCP_UNPAYWALL_EMAIL: 'exported@example.com' }; loadKeys(loaded, state);
  assert.equal(loaded.PAPER_SEARCH_MCP_UNPAYWALL_EMAIL, 'exported@example.com', 'An empty line leaves the environment’s address in effect');
  await writeFile(prepared.path, text.replace(/^PAPER_SEARCH_MCP_UNPAYWALL_EMAIL=$/m, 'PAPER_SEARCH_MCP_UNPAYWALL_EMAIL=me@example.com'));
  loadKeys(loaded, state);
  assert.equal(loaded.PAPER_SEARCH_MCP_UNPAYWALL_EMAIL, 'me@example.com');
  assert.deepEqual((await prepareKeysFile('papers', state)).added, []);
});
