// The saved-research card the views show for a report or an answer (surfaces.mjs savedResearch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { startDig, recordCall, saveReport, finishDig, listLibrary } from '../src/library.mjs';
import { savedResearch } from '../src/surfaces.mjs';
import { report } from './report-fixture.mjs';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dig-saved-card-'));
  const c = await loadConfig(root);
  const group = await startDig(c, root, 'Original full research question', 'parent');
  const calls = [];
  for (const [source, cost, knownCost] of [['hackernews', [{ unit: 'USD', amount: .02 }]], ['hackernews', null, [{ unit: 'credits', amount: 2 }]], ['hackernews', []], ['video', [{ unit: 'USD', amount: 1 }]]]) {
    calls.push(await recordCall(c, root, group.dig, { source, tool: source, status: 'success', cost, ...(knownCost ? { knownCost } : {}), args: {}, at: '2020-01-01T00:00:00Z', ms: 1, session: 'worker', responses: [{ label: 'fixture', status: 200, body: { excerpt: 'Original evidence' } }] }));
  }
  const content = report.replace('strongest_findings: []', 'strongest_findings: ["A retained finding"]')
    .replace('contradictions: []', 'contradictions: ["A contrary finding"]')
    .replace('follow_up_targets: []', 'follow_up_targets: ["Read the full source"]')
    .replace('\n\n## Summary', '\n\n# A concise saved title\n\n## Summary');
  const saved = await saveReport(c, { project: root, dig: group.dig, source: 'hackernews', content, session: 'worker' });
  const file = relative(await realpath(c.library), saved.path);
  return { root, c, group, saved, file, content, snapshot: await listLibrary(c), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('saved card derives title and author assessments while preserving report cost ownership and units', async () => {
  const f = await setup();
  try {
    const card = savedResearch(f.snapshot, f.file, await readFile(f.saved.path, 'utf8'));
    assert.equal(card.title, 'A concise saved title'); assert.equal(card.question, 'Original full research question');
    assert.deepEqual(card.findings, ['A retained finding']); assert.deepEqual(card.contradictions, ['A contrary finding']);
    assert.deepEqual(card.followUps, ['Read the full source']); assert.equal(card.confidence, 'low');
    assert.deepEqual(card.cost, { byUnit: { USD: .02, credits: 2 }, unknownCalls: 1, freeCalls: 1, totalCalls: 3, scope: 'report' });
    assert.deepEqual(card.insights, []);
  } finally { await f.cleanup(); }
});

test('a composed answer’s card counts the whole dig’s cost, every call and unit', async () => {
  const f = await setup();
  try {
    await saveReport(f.c, { project: f.root, dig: f.group.dig, source: 'hackernews', content: report, session: 'worker' });
    const answer = await finishDig(f.c, { project: f.root, dig: f.group.dig, answer: 'A complete synthesis.', status: 'answered', reports: [f.saved.report] });
    const file = relative(await realpath(f.c.library), answer.path);
    const card = savedResearch(await listLibrary(f.c), file, await readFile(answer.path, 'utf8'));
    assert.equal(card.kind, 'answer'); assert.equal(card.cost.scope, 'dig'); assert.equal(card.cost.totalCalls, 4); assert.equal(card.cost.byUnit.USD, 1.02);
  } finally { await f.cleanup(); }
});

test('unsupported nested source-card structures remain explicit rather than confident projected findings', async () => {
  const f = await setup();
  try {
    const text = (await readFile(f.saved.path, 'utf8')).replace('["A retained finding"]', '[{"unexpected":"nested"}]');
    const card = savedResearch(f.snapshot, f.file, text);
    assert.deepEqual(card.findings, []); assert.equal(card.confidence, null); assert.equal(card.schemaWarnings.length, 1);
  } finally { await f.cleanup(); }
});
