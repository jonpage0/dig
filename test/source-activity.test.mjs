import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestSourceCalls, activityNote } from '../src/ui/source-guide.mjs';

test('source activity selects the newest dated retained receipt across saved and unclaimed calls', () => {
  const earlier = { source: 'exa', tool: 'exa_search', status: 'success', at: '2026-10-01T10:00:00Z' };
  const latest = { ...earlier, status: 'failed', at: '2026-10-02T10:00:00Z' };
  const other = { source: 'github', tool: 'github_read', status: 'partial', at: '2026-10-03T10:00:00Z' };
  const found = latestSourceCalls({ items: [{ calls: [earlier, other] }], live: [latest, { ...earlier, at: 'invalid date' }] });
  assert.equal(found.get('exa'), latest);
  assert.equal(found.get('github'), other);
  assert.match(activityNote(found.get('exa')), /Last retained call failed/);
  assert.match(activityNote(found.get('github')), /returned partial results/);
  assert.match(activityNote(found.get('youtube')), /No retained call/);
});
