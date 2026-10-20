import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNTS, ALL_MODULES, moduleAgents, moduleEnvironment, moduleSkills, reportSources } from '../src/providers/modules.ts';
import { loadConfig, updateConfig, WORKER_TABLES } from '../src/config.mjs';
import { prepareKeysFile, settingsDocument, sourceInfo } from '../src/catalog.mjs';
import { recordCall, saveReport, startDig, listLibrary } from '../src/library.mjs';
import { frontMatter } from '../src/ui/markdown.mjs';
import { report } from './report-fixture.mjs';

test('YouTube video analysis is a full source method with a packaged hidden skill and ordinary worker guidance', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-youtube-method-'));
  try {
    const config = await updateConfig({ youtube_enabled: true }, state);
    const source = sourceInfo(config, 'youtube').sources[0];
    const method = source.methods.find(method => method.name === 'youtube-video');
    assert.ok(method);
    assert.equal(method.helper, false);
    assert.ok(method.tools.includes('youtube_analyze'));
    assert.ok(method.tools.includes('youtube_analysis_status'));
    assert.ok(method.tools.includes('research_save'));
    assert.match(method.workerDefault.basis, /guidance|Guidance/);
    assert.ok(WORKER_TABLES.includes('youtube-video'));
    assert.equal(settingsDocument(config).values.youtube_video_worker_model, method.workerDefault.model);
    assert.equal(moduleAgents(['youtube']).find(method => method.name === 'youtube-video').module, 'youtube');
    assert.ok(moduleSkills(['youtube']).includes('youtube-video'));
    assert.ok(reportSources(ALL_MODULES).includes('youtube'));
    assert.ok(!reportSources(ALL_MODULES).includes('youtube-video'));
    assert.match(await readFile(method.skillPath, 'utf8'), /agent: "youtube-video"/);
    assert.match(await readFile(join(method.skillPath, '../agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
    assert.deepEqual(moduleAgents(['video']), [], 'Glimpse remains a standalone utility, not a research method');
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('Gemini is an optional YouTube credential with its own account and does not disable configured transcript research', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-youtube-gemini-key-'));
  const names = ['GEMINI_API_KEY', 'OPENCODE_RESEARCH_GOOGLE_API_KEY', 'SCRAPECREATORS_API_KEY', 'PATH'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    const bin = join(state, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'yt-dlp'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    process.env.PATH = bin;
    for (const name of names.filter(name => name !== 'PATH')) delete process.env[name];
    const config = await updateConfig({ youtube_enabled: true }, state);
    const without = sourceInfo(config, 'youtube').sources[0];
    assert.equal(without.readiness.status, 'ready');
    assert.deepEqual(without.credentials.find(credential => credential.name === 'GEMINI_API_KEY'), {
      name: 'GEMINI_API_KEY', required: false, available: false, environment: 'absent',
    });
    assert.match(without.readiness.message, /search and transcript methods do not need it/);
    process.env.GEMINI_API_KEY = 'gemini-catalog-synthetic-value';
    const withGemini = sourceInfo(config, 'youtube').sources[0];
    assert.equal(withGemini.readiness.status, 'ready');
    assert.equal(withGemini.credentials.find(credential => credential.name === 'GEMINI_API_KEY').available, true);
    assert.match(withGemini.readiness.message, /GEMINI_API_KEY present; no local video tools needed/);
    assert.doesNotMatch(JSON.stringify(withGemini), /gemini-catalog-synthetic-value/);
    assert.ok(moduleEnvironment(['youtube']).includes('GEMINI_API_KEY'));
    assert.ok(!moduleEnvironment(ALL_MODULES).includes('GOOGLE_API_KEY'), 'The Gemini credential has one canonical name');
    const account = ACCOUNTS.find(account => account.keys.flat().includes('GEMINI_API_KEY'));
    assert.equal(account.signup, 'https://aistudio.google.com/apikey');
    const prepared = await prepareKeysFile('youtube', state);
    assert.ok(prepared.added.includes('GEMINI_API_KEY'));
    assert.match(await readFile(prepared.path, 'utf8'), /^GEMINI_API_KEY=$/m);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(state, { recursive: true, force: true });
  }
});

test('the YouTube video method saves an ordinary immutable YouTube report and claims only YouTube calls', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-youtube-video-report-'));
  try {
    const config = await loadConfig(state);
    const group = await startDig(config, state, 'How does this demonstration work?', 'parent');
    for (const [tool, source] of [['youtube_analyze', 'youtube'], ['youtube_analysis_status', 'youtube'], ['video_analyze', 'video']]) {
      await recordCall(config, state, group.dig, { tool, source, args: {}, status: 'success', cost: null, responses: [], at: '2026-01-01T00:00:00Z', ms: 1, session: 'youtube-worker' });
    }
    const saved = await saveReport(config, { project: state, dig: group.dig, source: 'youtube', agent: 'youtube-video', session: 'youtube-worker', content: report.replace('hackernews', 'youtube') });
    assert.equal(saved.report, 'youtube-video.md');
    const text = await readFile(saved.path, 'utf8');
    const { meta } = frontMatter(text);
    assert.equal(meta.source, 'youtube');
    assert.equal(meta.agent, 'youtube-video');
    const item = (await listLibrary(config)).items[0];
    assert.deepEqual(item.sources, ['youtube']);
    assert.deepEqual(item.methods, ['youtube-video']);
    assert.ok(item.calls.filter(call => call.source === 'youtube').every(call => call.claimedBy.endsWith('/youtube-video.md')));
    assert.equal(item.calls.find(call => call.source === 'video').claimedBy, null);
    const second = await saveReport(config, { project: state, dig: group.dig, source: 'youtube', agent: 'youtube-video', session: 'youtube-worker', content: report });
    assert.equal(second.report, 'youtube-video-2.md');
    assert.equal(await readFile(saved.path, 'utf8'), text);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
