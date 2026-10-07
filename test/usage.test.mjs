import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageOf } from '../src/ui/usage.mjs';

// Local times, so day columns follow the reader's calendar whatever the test machine's time zone.
const at = (month, day, hour) => new Date(2026, month - 1, day, hour).toISOString();
const call = (source, status, when, cost, knownCost) => ({ source, status, at: when, cost, ...(knownCost ? { knownCost } : {}) });

test('usage counts the window’s receipts and reports by day and source, keeping unknown cost apart from no charge', () => {
  const now = new Date(2026, 9, 5, 15).getTime(); // Monday, October 5
  const snapshot = {
    items: [{
      calls: [call('hackernews', 'success', at(10, 5, 10), []), call('hackernews', 'empty', at(10, 4, 9), [])],
      reportDetails: [{ source: 'hackernews', at: at(10, 5, 11) }, { source: 'x', at: at(10, 3, 12) }, { source: 'exa', at: at(8, 2, 12) }],
    }],
    live: [
      call('x', 'failed', at(10, 5, 11), null),
      call('x', 'success', at(10, 3, 9), null, [{ amount: 0.002, unit: 'USD' }]),
      call('reddit', 'success', at(9, 29, 12), [{ amount: 2, unit: 'credits' }]),
      call('exa', 'success', at(8, 1, 12), [{ amount: 0.01, unit: 'USD' }]),
      call('exa', 'success', 'not a time', [{ amount: 5, unit: 'USD' }]),
    ],
  };

  const week = usageOf(snapshot, { days: 7, now });
  assert.equal(week.weekly, false); assert.equal(week.buckets.length, 7);
  assert.equal(week.start, new Date(2026, 8, 29).getTime(), 'Seven days are today and the six before it');
  assert.deepEqual(week.buckets.at(-1), { start: new Date(2026, 9, 5).getTime(), results: 1, empty: 0, failed: 1, total: 2 });
  assert.equal(week.buckets.at(-2).empty, 1);
  assert.deepEqual([week.totals.total, week.totals.results, week.totals.empty, week.totals.failed, week.totals.reports], [5, 3, 1, 1, 2]);
  // A known subtotal still counts its call as incompletely priced; free calls are not unknown.
  assert.deepEqual(week.totals.cost, { byUnit: { USD: 0.002, credits: 2 }, unknownCalls: 2, freeCalls: 2 });
  assert.deepEqual(week.sources.map(s => [s.id, s.total, s.failed, s.reports]), [['hackernews', 2, 0, 1], ['x', 2, 1, 1], ['reddit', 1, 0, 0]]);
  assert.deepEqual(week.sources.find(s => s.id === 'x').cost, { byUnit: { USD: 0.002 }, unknownCalls: 2, freeCalls: 0 });

  const month = usageOf(snapshot, { days: 30, now });
  assert.equal(month.buckets.length, 30); assert.equal(month.totals.total, 5); assert.equal(month.totals.reports, 2);

  // All time starts at the first dated record; past about two months it counts by week from a Monday.
  const all = usageOf(snapshot, { days: 0, now });
  assert.equal(all.weekly, true);
  assert.equal(new Date(all.buckets[0].start).getDay(), 1); assert.ok(all.buckets[0].start <= new Date(2026, 7, 1).getTime());
  assert.equal(all.totals.total, 6); assert.equal(all.totals.reports, 3);
  assert.equal(all.buckets.reduce((sum, b) => sum + b.total, 0), all.totals.total, 'Every call lands in exactly one column');
  assert.deepEqual(all.totals.cost.byUnit, { USD: 0.012, credits: 2 });
});

test('a quiet window is not mistaken for a library with no research yet', () => {
  const now = new Date(2026, 9, 5, 15).getTime();
  assert.equal(usageOf({ items: [], live: [] }, { days: 0, now }).recorded, 0);
  // A started dig with no calls, and a receipt without a readable time, are not usage.
  assert.equal(usageOf({ items: [{ calls: [], reportDetails: [] }], live: [call('exa', 'success', 'not a time', [])] }, { days: 0, now }).recorded, 0);
  const older = { items: [{ calls: [call('hackernews', 'success', at(8, 2, 10), [])], reportDetails: [{ source: 'hackernews', at: at(8, 2, 11) }] }], live: [] };
  const week = usageOf(older, { days: 7, now });
  assert.deepEqual([week.totals.total, week.totals.reports, week.recorded], [0, 0, 2]);
});
