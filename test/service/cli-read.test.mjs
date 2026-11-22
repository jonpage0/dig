import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../../src/config.mjs';
import { finishDig, projectFolder, recordCall, saveReport, startDig } from '../../src/library.mjs';
import { report } from '../report-fixture.mjs';

const CLI = resolve('src/service/cli.ts');
const TS_HOOK = resolve('scripts/typescript.mjs');

function runCli(state, args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--conditions=development', '--import', TS_HOOK, CLI, ...args], {
      env: { DIG_STATE_DIR: state, PATH: process.env.PATH, HOME: state },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', fail);
    child.once('exit', code => done({ code, stdout, stderr }));
  });
}

async function seedLibrary(state) {
  const projectA = join(state, 'proj-alpha');
  const projectB = join(state, 'proj-beta');
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  const c = await loadConfig(state);
  const digA = await startDig(c, projectA, 'How does SQLite WAL perform under concurrent readers?', undefined, { ownSession: true });
  const reportA = await saveReport(c, {
    project: projectA, dig: digA.dig, source: 'hackernews',
    content: report.replace('## Summary', '# SQLite WAL concurrency benchmarks\n\n## Summary').replace('A small inspected sample, not a representative survey.', 'SQLite WAL scales concurrent reads cleanly without blocking writers.'),
    session: digA.dig,
  });
  await finishDig(c, {
    project: projectA, dig: digA.dig,
    answer: '# SQLite WAL concurrency\n\nWAL mode enables concurrent readers alongside a single writer.',
    status: 'answered', reports: [reportA.report],
  });
  const now = new Date();
  const oldDate = new Date(now.getTime() - 120 * 86_400_000).toISOString();
  await recordCall(c, projectA, digA.dig, {
    tool: 'hackernews', source: 'hackernews', args: { query: 'sqlite wal' }, declared: ['query'],
    at: now.toISOString(), ms: 120, status: 'success', cost: [], responses: [], session: digA.dig,
  });
  await recordCall(c, projectA, digA.dig, {
    tool: 'xsearch', source: 'x', args: { query: 'sqlite wal' }, declared: ['query'],
    at: oldDate, ms: 900, status: 'success', cost: [{ amount: 0.025, unit: 'USD' }], responses: [], session: digA.dig,
  });

  const digB = await startDig(c, projectB, 'What are the best Rust async runtimes in 2026?', undefined, { ownSession: true });
  const reportB = await saveReport(c, {
    project: projectB, dig: digB.dig, source: 'reddit',
    content: report.replace('source: "hackernews"', 'source: "reddit"').replace('## Summary', '# Rust async runtime comparison\n\n## Summary').replace('A small inspected sample, not a representative survey.', 'Tokio dominates production Rust workloads with mature ecosystem support.'),
    session: digB.dig,
  });
  await recordCall(c, projectB, digB.dig, {
    tool: 'reddit_search', source: 'reddit', args: { query: 'rust tokio' }, declared: ['query'],
    at: now.toISOString(), ms: 340, status: 'failed', cost: null, responses: [], error: 'rate limited', session: digB.dig,
  });

  return {
    projectA, projectB,
    handleA: `${projectFolder(projectA)}/${digA.dig}`,
    handleB: `${projectFolder(projectB)}/${digB.dig}`,
    reportAFile: `${projectFolder(projectA)}/digs/${digA.dig}/${reportA.report}`,
    reportBFile: `${projectFolder(projectB)}/digs/${digB.dig}/${reportB.report}`,
  };
}

test('CLI read-only subcommands handle an empty library cleanly', async t => {
  const state = await mkdtemp(join(tmpdir(), 'dig-cli-empty-')); t.after(() => rm(state, { recursive: true, force: true }));
  const listRes = await runCli(state, ['list', '--json']);
  assert.equal(listRes.code, 0, listRes.stderr);
  const listData = JSON.parse(listRes.stdout);
  assert.equal(listData.total, 0);
  assert.deepEqual(listData.items, []);

  const statsRes = await runCli(state, ['stats', '--json']);
  assert.equal(statsRes.code, 0, statsRes.stderr);
  const statsData = JSON.parse(statsRes.stdout);
  assert.equal(statsData.questions, 0);
  assert.equal(statsData.usage.totals.total, 0);
  assert.deepEqual(statsData.tools, []);
});

test('CLI list supports text and --json output with project, source, query, limit and offset filters', async t => {
  const state = await mkdtemp(join(tmpdir(), 'dig-cli-list-')); t.after(() => rm(state, { recursive: true, force: true }));
  const seeded = await seedLibrary(state);

  const textRes = await runCli(state, ['list']);
  assert.equal(textRes.code, 0, textRes.stderr);
  assert.match(textRes.stdout, /2 of 2 saved questions/);
  assert.match(textRes.stdout, /SQLite WAL concurrency/);
  assert.match(textRes.stdout, /What are the best Rust async runtimes in 2026\?/);

  const jsonRes = await runCli(state, ['list', '--json', '--project', seeded.projectA]);
  assert.equal(jsonRes.code, 0, jsonRes.stderr);
  const byProject = JSON.parse(jsonRes.stdout);
  assert.equal(byProject.total, 1);
  assert.equal(byProject.items[0].dig, seeded.handleA);

  const bySource = JSON.parse((await runCli(state, ['list', '--json', '--source', 'reddit'])).stdout);
  assert.equal(bySource.total, 1);
  assert.equal(bySource.items[0].dig, seeded.handleB);

  const byQuery = JSON.parse((await runCli(state, ['list', '--json', '--query', 'tokio'])).stdout);
  assert.equal(byQuery.total, 1);
  assert.equal(byQuery.items[0].dig, seeded.handleB);

  const paged = JSON.parse((await runCli(state, ['list', '--json', '--limit', '1', '--offset', '0'])).stdout);
  assert.equal(paged.items.length, 1);
  assert.equal(paged.total, 2);
  assert.equal(paged.nextOffset, 1);

  const page2 = JSON.parse((await runCli(state, ['list', '--json', '--limit', '1', '--offset', '1'])).stdout);
  assert.equal(page2.items.length, 1);
  assert.equal(page2.nextOffset, null);
  assert.notEqual(page2.items[0].dig, paged.items[0].dig);
});

test('CLI read returns retained research text and --json with offset and limit', async t => {
  const state = await mkdtemp(join(tmpdir(), 'dig-cli-read-')); t.after(() => rm(state, { recursive: true, force: true }));
  const seeded = await seedLibrary(state);

  const full = await runCli(state, ['read', seeded.reportAFile]);
  assert.equal(full.code, 0, full.stderr);
  assert.match(full.stdout, /SQLite WAL scales concurrent reads cleanly/);
  assert.equal(full.stderr, '');

  const sliced = await runCli(state, ['read', seeded.reportAFile, '--offset', '0', '--limit', '40']);
  assert.equal(sliced.code, 0);
  assert.equal(sliced.stdout.length, 40);
  assert.match(sliced.stderr, /continue with --offset 40/);

  const asJson = await runCli(state, ['read', seeded.reportAFile, '--offset', '10', '--limit', '25', '--json']);
  assert.equal(asJson.code, 0, asJson.stderr);
  const data = JSON.parse(asJson.stdout);
  assert.equal(data.offset, 10);
  assert.equal(data.text.length, 25);
  assert.equal(data.nextOffset, 35);
  assert.equal(data.file, seeded.reportAFile);

  const refused = await runCli(state, ['read', '../../etc/passwd']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Only Dig research files/);
});

test('CLI search finds matching passages in text and --json modes with filters', async t => {
  const state = await mkdtemp(join(tmpdir(), 'dig-cli-search-')); t.after(() => rm(state, { recursive: true, force: true }));
  const seeded = await seedLibrary(state);

  const textRes = await runCli(state, ['search', 'concurrent readers', '--mode', 'keyword']);
  assert.equal(textRes.code, 0, textRes.stderr);
  assert.match(textRes.stdout, /hit.*keyword/);
  assert.match(textRes.stdout, /SQLite WAL/i);

  const jsonRes = await runCli(state, ['search', 'Tokio', '--mode', 'keyword', '--source', 'reddit', '--dig', seeded.handleB, '--limit', '5', '--json']);
  assert.equal(jsonRes.code, 0, jsonRes.stderr);
  const data = JSON.parse(jsonRes.stdout);
  assert.equal(data.mode_used, 'keyword');
  assert.ok(data.hits.length >= 1);
  assert.equal(data.hits[0].file, seeded.reportBFile);

  const scopedOut = await runCli(state, ['search', 'Tokio', '--mode', 'keyword', '--dig', seeded.handleA, '--json']);
  assert.equal(scopedOut.code, 0, scopedOut.stderr);
  assert.equal(JSON.parse(scopedOut.stdout).hits.length, 0);
});

test('CLI stats defaults to all time and supports --days and --json', async t => {
  const state = await mkdtemp(join(tmpdir(), 'dig-cli-stats-')); t.after(() => rm(state, { recursive: true, force: true }));
  await seedLibrary(state);

  const allText = await runCli(state, ['stats']);
  assert.equal(allText.code, 0, allText.stderr);
  assert.match(allText.stdout, /Dig library stats \(All time\)/);
  assert.match(allText.stdout, /Questions: 2 · Reports: 2 · Calls: 3/);
  assert.match(allText.stdout, /xsearch:/);
  assert.match(allText.stdout, /hackernews:/);

  const allJson = JSON.parse((await runCli(state, ['stats', '--json'])).stdout);
  assert.equal(allJson.days, 0);
  assert.equal(allJson.questions, 2);
  assert.equal(allJson.usage.totals.total, 3);
  assert.equal(allJson.usage.totals.cost.byUnit.USD, 0.025);
  assert.equal(allJson.tools.length, 3, 'all-time toolHistory includes calls older than 90 days');

  const recentJson = JSON.parse((await runCli(state, ['stats', '--days', '7', '--json'])).stdout);
  assert.equal(recentJson.days, 7);
  assert.equal(recentJson.usage.totals.total, 2, 'excludes the 120-day-old xsearch call');
  assert.equal(recentJson.tools.some(row => row.tool === 'xsearch'), false);
});

test('CLI read-only subcommands reject invalid flags and missing required arguments with exit code 2', async t => {
  const state = await mkdtemp(join(tmpdir(), 'dig-cli-args-')); t.after(() => rm(state, { recursive: true, force: true }));
  for (const args of [['read'], ['search'], ['list', '--limit', '0'], ['stats', '--days', '-1'], ['stats', '--days', '99999'], ['search', 'q', '--mode', 'bogus'], ['list', '--unknown']]) {
    const res = await runCli(state, args);
    assert.equal(res.code, 2, `${args.join(' ')} -> ${res.code} (${res.stderr})`);
  }
});
