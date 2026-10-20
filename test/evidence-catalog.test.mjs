import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNTS, ALL_MODULES, moduleAgents, moduleEnvironment, moduleSkills, reportSources } from '../src/providers/modules.ts';
import { loadConfig, loadKeys, updateConfig, WORKER_TABLES } from '../src/config.mjs';
import { prepareKeysFile, settingsDocument, sourceInfo } from '../src/catalog.mjs';
import { listLibrary, recordCall, saveReport, startDig } from '../src/library.mjs';
import { report } from './report-fixture.mjs';

test('evidence ranking is independently disabled by default and discovers guidance without a report method', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-evidence-catalog-'));
  try {
    const initial = await loadConfig(state);
    assert.deepEqual(initial.sources.enabled, ['hackernews']);
    assert.equal(sourceInfo(initial, 'evidence').sources[0].enabled, false);
    const enabled = await updateConfig({ evidence_enabled: true }, state);
    assert.deepEqual(enabled.sources.enabled, ['hackernews', 'evidence']);
    const info = sourceInfo(enabled, 'evidence').sources[0];
    assert.equal(info.kind, 'tool');
    assert.deepEqual(info.tools, ['evidence_rank']);
    assert.deepEqual(info.methods, []);
    assert.deepEqual(moduleAgents(['evidence']), []);
    assert.deepEqual(moduleSkills(['evidence']), ['dig', 'library', 'setup', 'evidence-rank']);
    assert.ok(!reportSources(ALL_MODULES).includes('evidence'));
    assert.ok(!WORKER_TABLES.includes('evidence') && !WORKER_TABLES.includes('evidence-rank'));
    assert.match(await readFile(info.helperSkillPath, 'utf8'), /name: evidence-rank/);
    const settings = settingsDocument(enabled);
    assert.equal(settings.values.evidence_enabled, true);
    assert.equal(settings.values.video_enabled, false);
    assert.ok(!Object.keys(settings.schema.properties).some(name => /^evidence.*worker/.test(name)));
    assert.doesNotMatch(await readFile(enabled.path, 'utf8'), /\[evidence\]|evidence_enabled/);
    assert.deepEqual((await updateConfig({ evidence_enabled: false }, state)).sources.enabled, ['hackernews']);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('evidence ranking uses the one private credential file and has a unique provider account', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-evidence-keys-'));
  try {
    assert.deepEqual(moduleEnvironment(['evidence']), ['TYPESAFE_API_KEY']);
    const accounts = ACCOUNTS.filter(account => account.keys.flat().includes('TYPESAFE_API_KEY'));
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].signup, 'https://console.typesafe.ai/keys');
    const prepared = await prepareKeysFile('evidence', state);
    assert.deepEqual(prepared.added, ['TYPESAFE_API_KEY']);
    const env = { TYPESAFE_API_KEY: 'synthetic-environment-typesafe-key' };
    loadKeys(env, state);
    assert.equal(env.TYPESAFE_API_KEY, undefined, 'An inherited key is not automatically used');
    await writeFile(prepared.path, 'TYPESAFE_API_KEY=synthetic-file-typesafe-key\n');
    loadKeys(env, state);
    assert.equal(env.TYPESAFE_API_KEY, 'synthetic-file-typesafe-key');
    const info = sourceInfo(await loadConfig(state), 'evidence').sources[0];
    assert.deepEqual(info.credentials.map(({ name, required }) => ({ name, required })), [{ name: 'TYPESAFE_API_KEY', required: true }]);
    assert.doesNotMatch(JSON.stringify(prepared), /synthetic-/);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('ranking receipts count toward the named dig without being claimed by another source report', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-evidence-ownership-'));
  try {
    const config = await loadConfig(state);
    const group = await startDig(config, state, 'Which retained passages answer this question?', 'parent');
    for (const [source, tool] of [['hackernews', 'hackernews'], ['evidence', 'evidence_rank']]) {
      await recordCall(config, state, group.dig, { source, tool, status: 'success', cost: source === 'evidence' ? null : [], args: {}, responses: [], at: '2026-01-01T00:00:00Z', ms: 1, session: 'worker' });
    }
    await saveReport(config, { project: state, dig: group.dig, source: 'hackernews', content: report, session: 'worker' });
    await assert.rejects(saveReport(config, { project: state, dig: group.dig, source: 'evidence', content: report, session: 'worker' }), /report source/);
    const item = (await listLibrary(config)).items[0];
    assert.equal(item.calls.length, 2);
    assert.ok(item.calls.find(call => call.source === 'hackernews').claimedBy.endsWith('/hackernews.md'));
    assert.equal(item.calls.find(call => call.source === 'evidence').claimedBy, null);
    assert.equal(item.calls.find(call => call.source === 'evidence').cost, null);
    assert.deepEqual(item.sources, ['hackernews']);
    assert.deepEqual(item.methods, ['hackernews']);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
