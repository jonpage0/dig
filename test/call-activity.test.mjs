import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCallActivity } from '../src/call-activity.mjs';
import { projectConversationActivity } from '../src/frontend/library/research-state.ts';

test('executing calls are transient, library-scoped and removed even when execution throws', async () => {
  const activity = createCallActivity();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const identity = { library: '/library', project: '/project', dig: 'one', session: 'worker', source: 'x', tool: 'xsearch', secret: 'not retained' };
  const pending = activity.run(identity, async () => { await gate; return 42; });
  assert.equal(activity.revision, 1);
  assert.equal(activity.snapshot('/different-library').length, 0);
  const shown = activity.snapshot('/library');
  assert.equal(shown.length, 1); assert.equal(shown[0].tool, 'xsearch');
  assert.equal(shown[0].secret, undefined); assert.equal(shown[0].library, undefined);
  shown[0].source = 'tampered'; assert.equal(activity.snapshot('/library')[0].source, 'x');
  release(); assert.equal(await pending, 42);
  assert.equal(activity.snapshot('/library').length, 0); assert.equal(activity.revision, 2);
  await assert.rejects(activity.run(identity, async () => { throw Error('failed'); }), /failed/);
  assert.deepEqual(activity.snapshot('/library'), []); assert.equal(activity.revision, 4);
});

test('conversation activity includes grouped workers, excludes unrelated calls and never treats old receipts as running', () => {
  const item = { id: 'one', project: '/project', session: 'parent', reports: [], calls: [{ id: 'done', session: 'worker', source: 'x', status: 'success', cost: [] }] };
  const active = { id: 'active', project: '/project', dig: 'one', session: 'worker', source: 'exa', tool: 'exa_search' };
  const snapshot = { items: [item], live: [{ id: 'old', session: 'other', source: 'youtube' }], activeCalls: [active, { ...active, id: 'wrong-project', project: '/elsewhere' }, { ...active, id: 'own', dig: undefined, session: 'parent' }] };
  const result = projectConversationActivity(snapshot, 'parent');
  assert.deepEqual(result.activeCalls.map(call => call.id), ['active', 'own']);
  assert.equal(result.calls.length, 1); assert.equal(result.totalCalls, 3);
  assert.deepEqual(result.sources.map(row => row.source), ['exa', 'x']);
  assert.equal(result.sources[1].active.length, 0);
  assert.equal(projectConversationActivity(snapshot, null).totalCalls, 0);
  assert.equal(projectConversationActivity({ items: [item], live: [] }, 'parent').liveAvailable, false);
});
