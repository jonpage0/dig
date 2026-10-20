import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectResearch, projectMethodCoverage, projectConversation, projectRecordedActivity, steeringPrompt } from '../src/frontend/library/research-state.ts';

const report = { file: 'p/digs/a/x-judge.md', source: 'x', method: 'x-judge', at: '2026-10-20T10:00:00Z', status: 'partial' };
const call = { id: 'same-id', source: 'x', tool: 'x_post', session: 'worker', at: '2026-10-20T09:00:00Z', ms: 500, status: 'partial', cost: null, knownCost: [{ unit: 'USD', amount: .25 }], rawFile: 'p/sessions/worker/raw/a.json' };
const item = { id: 'a', project: '/project', session: 'parent', title: 'Compare the evidence', status: 'report saved', startedAt: '2026-10-20T08:00:00Z', planned: ['x-judge', 'x-breadth'], reports: [report.file], reportDetails: [report], sources: ['x'], methods: ['x-judge'], calls: [call] };

test('planned methods without a saved report do not become running work and unclaimed source calls are not assigned to a method', () => {
  const rows = projectMethodCoverage(item);
  assert.equal(rows[0].reportState, 'report-saved');
  assert.equal(rows[1].reportState, 'no-report-saved');
  assert.deepEqual(rows.map(row => row.claimedCalls.length), [0, 0]);
  const claimed = projectMethodCoverage({ ...item, calls: [{ ...call, claimedBy: report.file }] });
  assert.deepEqual(claimed.map(row => row.claimedCalls.length), [1, 0]);
});

test('saved research state, report assessment and tool outcomes remain separate', () => {
  const result = projectResearch({ ...item, answer: 'p/digs/a/answer.md', status: 'answered', reportDetails: [{ ...report, status: 'failed' }] });
  assert.equal(result.savedState, 'Answer saved');
  assert.equal(result.reportCount, 1);
  assert.deepEqual(result.sourcesWithReports, ['x']);
  assert.equal(result.callOutcomes.partial, 1);
  assert.match(result.reviewSignals[0], /report marked failed by its author/);
  assert.equal(result.progress, undefined);
  assert.equal(result.running, undefined);
});

test('coverage counts saved methods and retained bundles without inventing evidence or request counts', () => {
  const result = projectResearch({ ...item, calls: [call, { ...call, id: 'b' }] });
  assert.equal(result.plannedMethodCount, 2);
  assert.equal(result.plannedMethodsWithReports, 1);
  assert.equal(result.callCount, 2);
  assert.equal(result.retainedOriginalCount, 1);
  assert.equal(result.cost.unknownCalls, 2);
  assert.equal(result.cost.byUnit.USD, .5);
});

test('conversation costs include named-dig worker receipts and only its own unassigned receipts', () => {
  const own = { ...call, session: 'parent', cost: [{ unit: 'credits', amount: 3 }], knownCost: undefined };
  const other = { ...call, session: 'elsewhere', cost: [{ unit: 'USD', amount: 99 }] };
  const result = projectConversation({ items: [item, { ...item, id: 'other', session: 'elsewhere' }], live: [own, other] }, 'parent');
  assert.equal(result.digs.length, 1);
  assert.equal(result.calls.length, 2);
  assert.equal(result.cost.byUnit.USD, .25);
  assert.equal(result.cost.byUnit.credits, 3);
  assert.equal(result.otherUnassignedCallCount, 1);
  const unidentified = projectConversation({ items: [item], live: [own, other] }, null);
  assert.equal(unidentified.identified, false);
  assert.equal(unidentified.calls.length, 0);
  assert.equal(unidentified.digs.length, 0);
});

test('activity preserves the recorded timestamp grain rather than treating a call as a current heartbeat', () => {
  const events = projectRecordedActivity(item);
  assert.equal(events[0].kind, 'report-saved');
  const event = events.find(event => event.kind === 'recorded-call');
  assert.equal(event.at, call.at);
  assert.match(event.detail, /recorded call start/);
  assert.match(event.detail, /500 ms elapsed/);
});

test('steering uses the original question and canonical saved references with an explicit evidence-reading instruction', () => {
  const prompt = steeringPrompt(item, '/library', 'gaps');
  assert.match(prompt, /Compare the evidence/);
  assert.match(prompt, /\/library\/p\/digs\/a\/x-judge.md/);
  assert.match(prompt, /missing report does not establish whether a worker is running/);
  assert.match(prompt, /Reuse existing evidence/);
  assert.doesNotMatch(prompt, /run every source|cancel all|pause the worker/i);
});
