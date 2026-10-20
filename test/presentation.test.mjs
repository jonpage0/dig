import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { startDig, recordCall, saveReport, finishDig, listLibrary } from '../src/library.mjs';
import { savedResearch } from '../src/surfaces.mjs';
import { presentResearch, CARD_SCHEMA } from '../src/presentation.mjs';
import { report } from './report-fixture.mjs';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dig-presentation-'));
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
const insight = file => ({ title: 'A useful interpretation', statement: 'The original supports this bounded finding.', evidence: [file], details: [{ label: 'Original', value: 'An inspected excerpt', url: 'https://example.test/page' }], limits: ['One sample'], nextStep: { label: 'Draft next check', prompt: 'Read this original and inspect the unresolved condition.' } });

test('saved card derives title and author assessments while preserving report cost ownership and units', async () => {
  const f = await setup();
  try {
    const card = savedResearch(f.snapshot, f.file, await readFile(f.saved.path, 'utf8'));
    assert.equal(card.title, 'A concise saved title'); assert.equal(card.question, 'Original full research question');
    assert.deepEqual(card.findings, ['A retained finding']); assert.deepEqual(card.contradictions, ['A contrary finding']);
    assert.deepEqual(card.followUps, ['Read the full source']); assert.equal(card.confidence, 'low');
    assert.deepEqual(card.cost, { byUnit: { USD: .02, credits: 2 }, unknownCalls: 1, freeCalls: 1, totalCalls: 3, scope: 'report' });
    assert.equal(CARD_SCHEMA.safeParse(card).success, true);
    assert.deepEqual(card.insights, []);
  } finally { await f.cleanup(); }
});

test('presentation resolves canonical owned evidence and remains a read-only projection', async () => {
  const f = await setup();
  try {
    const raw = f.snapshot.items[0].calls.find(c => c.source === 'video').rawFile;
    const before = JSON.stringify(await listLibrary(f.c));
    const input = insight(raw); input.evidence.push(join(f.c.library, raw));
    const output = await presentResearch(f.c, f.snapshot, { file: f.saved.path, insights: [input] });
    assert.equal(output.file, f.file); assert.equal(output.card.insights[0].evidence.length, 1);
    assert.equal(output.card.insights[0].evidence[0].file, raw);
    assert.equal(output.card.cost.totalCalls, 3, 'A referenced shared-tool original does not change report attribution');
    assert.equal(JSON.stringify(await listLibrary(f.c)), before);
    assert.equal(CARD_SCHEMA.safeParse(output.card).success, true);
  } finally { await f.cleanup(); }
});

test('cross-dig evidence, calls.jsonl and path escapes do not become card evidence', async () => {
  const f = await setup();
  try {
    const other = await saveReport(f.c, { project: f.root, source: 'hackernews', content: report, question: 'Another question', session: 'other' });
    const current = await listLibrary(f.c);
    await assert.rejects(presentResearch(f.c, current, { file: f.file, insights: [insight(other.path)] }), /associated with the selected dig/);
    const raw = f.snapshot.items[0].calls[0].rawFile;
    const calls = raw.replace(/\/raw\/[^/]+$/, '/calls.jsonl');
    await assert.rejects(presentResearch(f.c, current, { file: f.file, insights: [insight(calls)] }), /associated with the selected dig/);
    const outside = join(f.root, 'outside.md'); await writeFile(outside, 'not library evidence');
    await assert.rejects(presentResearch(f.c, current, { file: f.file, insights: [insight(outside)] }));
    const escaped = join(f.group.path, 'escape.md'); await symlink(outside, escaped);
    await assert.rejects(presentResearch(f.c, current, { file: f.file, insights: [insight(escaped)] }));
    await assert.rejects(presentResearch(f.c, current, { file: join(f.group.path, 'dig.md'), insights: [insight(f.file)] }), /not part of a dig/);
  } finally { await f.cleanup(); }
});

test('composed answers use dig-wide cost but only already-named source reports', async () => {
  const f = await setup();
  try {
    const second = await saveReport(f.c, { project: f.root, dig: f.group.dig, source: 'hackernews', content: report, session: 'worker' });
    const answer = await finishDig(f.c, { project: f.root, dig: f.group.dig, answer: 'A complete synthesis.', status: 'answered', reports: [f.saved.report] });
    const snapshot = await listLibrary(f.c);
    const output = await presentResearch(f.c, snapshot, { file: answer.path, insights: [insight(f.file)] });
    assert.equal(output.card.cost.scope, 'dig'); assert.equal(output.card.cost.totalCalls, 4); assert.equal(output.card.cost.byUnit.USD, 1.02);
    await assert.rejects(presentResearch(f.c, snapshot, { file: answer.path, insights: [insight(second.path)] }), /named reports/);
  } finally { await f.cleanup(); }
});

test('unsafe URLs, invented authoritative fields and excessive presentation payloads are rejected', async () => {
  const f = await setup();
  try {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'https://user:password@example.test/x']) {
      const item = insight(f.file); item.details[0].url = url;
      await assert.rejects(presentResearch(f.c, f.snapshot, { file: f.file, insights: [item] }));
    }
    await assert.rejects(presentResearch(f.c, f.snapshot, { file: f.file, cost: 0, insights: [insight(f.file)] }));
    await assert.rejects(presentResearch(f.c, f.snapshot, { file: f.file, insights: [{ ...insight(f.file), confidence: 'verified' }] }));
    const big = { ...insight(f.file), statement: '界'.repeat(1500), details: Array.from({length:4},()=>({label:'Detail',value:'界'.repeat(1000)})) };
    await assert.rejects(presentResearch(f.c, f.snapshot, { file: f.file, insights: [big,big,big] }), /48000 UTF-8 bytes/);
  } finally { await f.cleanup(); }
});

test('unsupported nested source-card structures remain explicit rather than confident projected findings', async () => {
  const f = await setup();
  try {
    const text = (await readFile(f.saved.path,'utf8')).replace('["A retained finding"]', '[{"unexpected":"nested"}]');
    const card = savedResearch(f.snapshot, f.file, text);
    assert.deepEqual(card.findings, []); assert.equal(card.confidence, null); assert.equal(card.schemaWarnings.length, 1);
  } finally { await f.cleanup(); }
});
