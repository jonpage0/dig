import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageOf, toolHistory } from '../src/ui/usage.mjs';

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

test('tool history gives each tool’s calls, failure rate, median time and typical cost over the window, busiest first', () => {
  const now = new Date(2026, 9, 5, 15).getTime();
  const receipt = (tool, status, when, ms, cost, knownCost) => ({ ...call(tool.split('_')[0], status, when, cost, knownCost), tool, ms });
  const calls = [
    receipt('exa_search', 'success', at(10, 5, 10), 400, [{ amount: 0.01, unit: 'USD' }]),
    receipt('exa_search', 'failed', at(10, 4, 10), 100, null),
    receipt('exa_search', 'success', at(10, 3, 10), 300, [{ amount: 0.03, unit: 'USD' }, { amount: 2, unit: 'fixture credits' }]),
    receipt('exa_search', 'empty', at(10, 2, 10), 200, []),
    receipt('exa_search', 'partial', at(10, 1, 10), undefined, null, [{ amount: 0.5, unit: 'USD' }]),
    receipt('exa_search', 'cancelled', at(10, 5, 11), 50, null),
    receipt('exa_search', 'skipped', at(10, 5, 12), 0, []),
    receipt('exa_search', 'success', at(6, 1, 10), 900, [{ amount: 9, unit: 'USD' }]),
    receipt('exa_search', 'success', 'not a time', 900, [{ amount: 9, unit: 'USD' }]),
    receipt('hackernews_read', 'success', at(9, 30, 10), 120, []),
    receipt('hackernews_read', 'failed', at(9, 29, 10), 80, []),
    receipt('hackernews_read', 'success', at(9, 28, 10), 100, []),
    receipt('x_search', 'success', at(10, 1, 9), undefined, null),
    receipt('reddit_search', 'cancelled', at(10, 1, 9), 10, null),
  ];
  const rows = toolHistory(calls, { now });
  assert.deepEqual(rows.map(row => row.tool), ['exa_search', 'hackernews_read', 'x_search'], 'Busiest first; a tool with only cancelled calls has no row');
  const exa = rows[0];
  // Cancelled, skipped, out-of-window and undated receipts are left out; the even count's median time averages the middle two.
  assert.deepEqual([exa.source, exa.calls, exa.failed, exa.failureRate, exa.medianMs, exa.lastAt], ['exa', 5, 1, 0.2, 250, at(10, 5, 10)]);
  // Unknown (null, even with a known part) is kept apart from no charge; each unit's median counts a priced call without it as 0.
  assert.deepEqual([exa.pricedCalls, exa.unknownCalls, exa.freeCalls], [3, 2, 1]);
  assert.deepEqual(exa.typicalCost, [{ amount: 0.01, unit: 'USD' }]);
  const hn = rows[1];
  assert.deepEqual([hn.calls, hn.failed, hn.failureRate, hn.medianMs, hn.typicalCost, hn.freeCalls], [3, 1, 1 / 3, 100, [], 3], 'The odd count’s median is the middle value; typically free reads as []');
  assert.deepEqual([rows[2].medianMs, rows[2].typicalCost, rows[2].pricedCalls, rows[2].unknownCalls], [null, null, 0, 1], 'No priced call: typical cost null; no timed call: median null');
  // A mix of units: each unit's median on its own, never added together.
  const mixed = toolHistory([
    receipt('commerce_product', 'success', at(10, 5, 1), 1, [{ amount: 2, unit: 'Scrape.do credits' }, { amount: 0.02, unit: 'USD' }]),
    receipt('commerce_product', 'success', at(10, 5, 2), 1, [{ amount: 4, unit: 'Scrape.do credits' }, { amount: 0.04, unit: 'USD' }]),
    receipt('commerce_product', 'success', at(10, 5, 3), 1, [{ amount: 6, unit: 'Scrape.do credits' }]),
  ], { now })[0];
  assert.deepEqual(mixed.typicalCost, [{ amount: 4, unit: 'Scrape.do credits' }, { amount: 0.02, unit: 'USD' }]);
  // The window: days back from now.
  assert.deepEqual(toolHistory(calls, { now, days: 3 }).map(row => [row.tool, row.calls]), [['exa_search', 3]]);
  assert.deepEqual(toolHistory(calls, { now, days: 200 }).find(row => row.tool === 'exa_search').calls, 6);
  assert.deepEqual(toolHistory([], { now }), []);
});
