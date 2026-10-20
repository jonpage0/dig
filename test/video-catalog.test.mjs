import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_MODULES, MODULES, SOURCE_GROUPS, moduleAgents, moduleEnvironment, moduleSkills, reportSources } from '../src/providers/modules.ts';
import { initializeConfig, loadConfig, loadKeys, updateConfig, WORKER_TABLES } from '../src/config.mjs';
import { prepareKeysFile, settingsDocument, sourceInfo } from '../src/catalog.mjs';
import { startDig, recordCall, saveReport, finishDig, listLibrary } from '../src/library.mjs';
import { createCatalog } from '../src/ui/catalog.mjs';
import { costSummary } from '../src/providers/library/cost.ts';
import { report } from './report-fixture.mjs';

test('video is a shared tool with helper guidance and one existing settings switch, never a report method', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-video-catalog-'));
  try {
    const initial = await initializeConfig(state);
    assert.deepEqual(initial.sources.enabled, ['hackernews'], 'Adding the utility does not enable it by default');
    assert.ok(ALL_MODULES.includes('video'));
    assert.ok(!reportSources(ALL_MODULES).includes('video'));
    assert.deepEqual(moduleAgents(['video']), []);
    assert.ok(!WORKER_TABLES.includes('video') && !WORKER_TABLES.includes('video-analyze'));
    assert.deepEqual(moduleSkills(['video']), ['dig', 'library', 'setup', 'video-analyze']);
    assert.deepEqual(moduleEnvironment(['video']), ['ELORIAN_API_KEY']);
    assert.deepEqual(SOURCE_GROUPS.find(group => group.id === 'tools').sources, ['video', 'evidence']);
    const enabled = await updateConfig({ video_enabled: true }, state);
    assert.deepEqual(enabled.sources.enabled, ['hackernews', 'video']);
    const document = settingsDocument(enabled);
    assert.equal(document.values.video_enabled, true);
    assert.deepEqual(document.layout.find(group => group.title === 'Shared tools').items, [{ kind: 'property', property: 'video_enabled' }, { kind: 'property', property: 'evidence_enabled' }]);
    assert.ok(!Object.keys(document.schema.properties).some(name => /^video.*worker/.test(name)));
    assert.doesNotMatch(await readFile(join(state, 'config.toml'), 'utf8'), /\[video\]|\[tools\]|video_enabled/);
    const info = sourceInfo(enabled, 'video').sources[0];
    assert.equal(info.kind, 'tool');
    assert.deepEqual(info.methods, []);
    assert.deepEqual(info.tools, ['video_analyze']);
    assert.match(info.helperSkillPath, /\/skills\/video-analyze\/SKILL\.md$/);
    assert.deepEqual(info.credentials.map(({ name, required }) => ({ name, required })), [{ name: 'ELORIAN_API_KEY', required: true }]);
    const prepared = await prepareKeysFile('video', state);
    assert.deepEqual(prepared.added, ['ELORIAN_API_KEY']);
    assert.match(await readFile(prepared.path, 'utf8'), /^ELORIAN_API_KEY=$/m);
    const env = { ELORIAN_API_KEY: 'catalog-synthetic-environment-key' };
    loadKeys(env, state);
    assert.equal(env.ELORIAN_API_KEY, undefined, 'An inherited credential is not automatically used');
    await writeFile(prepared.path, 'ELORIAN_API_KEY=catalog-synthetic-file-key\n');
    loadKeys(env, state);
    assert.equal(env.ELORIAN_API_KEY, 'catalog-synthetic-file-key');
    const catalog = createCatalog(MODULES);
    assert.equal(catalog.groupLabel(['youtube']), 'Sources');
    assert.equal(catalog.groupLabel(['youtube', 'video']), 'Sources & tools');
    assert.equal(catalog.label('video'), 'Video analysis');
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('a source report cannot claim its worker’s video utility receipt or create a video report', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-video-attribution-'));
  try {
    const config = await loadConfig(state);
    const group = await startDig(config, state, 'Inspect the supplied video', 'thread-parent');
    const at = '2026-01-01T00:00:00.000Z';
    for (const source of ['youtube', 'video']) await recordCall(config, state, group.dig, {
      source, tool: source === 'video' ? 'video_analyze' : 'youtube', args: {}, at, ms: 10,
      status: 'success', cost: source === 'video' ? null : [], responses: [], session: 'thread-worker',
    });
    const saved = await saveReport(config, { project: state, dig: group.dig, source: 'youtube', content: report, session: 'thread-worker' });
    await assert.rejects(saveReport(config, { project: state, dig: group.dig, source: 'video', content: report, session: 'thread-worker' }), /source must name a report source/);
    const before = (await listLibrary(config)).items[0];
    assert.equal(before.calls.length, 2);
    assert.ok(before.calls.find(call => call.source === 'youtube').claimedBy.endsWith('/youtube.md'));
    assert.equal(before.calls.find(call => call.source === 'video').claimedBy, null);
    assert.deepEqual(costSummary(before.calls), { byUnit: {}, unknownCalls: 1, freeCalls: 1 });
    assert.deepEqual(before.sources, ['youtube']);
    assert.deepEqual(before.methods, ['youtube']);
    await finishDig(config, { project: state, dig: group.dig, answer: 'The video analysis is supporting evidence for the source report.', status: 'answered', reports: [saved.report] });
    const after = (await listLibrary(config)).items[0];
    assert.equal(after.calls.find(call => call.source === 'video').claimedBy, null, 'Finishing in another session does not invent report ownership');
    assert.equal(after.calls.length, 2, 'The supporting utility remains in this dig’s retrievals and cost');
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
