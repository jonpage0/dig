// Usage at the top of the Library page, derived in the view from the library snapshot it already holds: every
// retained provider-call receipt (claimed by a saved report or answer, or still live) and every saved report's date.
// Nothing is stored. Costs keep the receipts' own semantics: summed per unit and never converted, with unknown kept
// apart from no charge.
import { costSummary } from '../providers/library/cost.ts';

const DAY_MS = 86400000;
// Beyond about two months a column per day is too thin to read; All time then counts by week.
const MAX_DAILY_COLUMNS = 62;
export const WINDOWS = [{ days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 0, label: 'All time' }];
/** Receipt status → the charts' three outcomes. A cancelled or skipped call is not a provider failure, but it returned nothing usable either. */
const outcomeOf = status => (status === 'success' || status === 'partial' ? 'results' : status === 'empty' ? 'empty' : 'failed');
const tally = (target, call) => { target[outcomeOf(call.status)] += 1; target.total += 1; };
/** Outcome counts over some calls: `{ results, empty, failed, total }`. */
export function outcomeCounts(calls) {
  const counts = { results: 0, empty: 0, failed: 0, total: 0 };
  for (const call of calls) tally(counts, call);
  return counts;
}

// Local calendar days, so a column is the reader's day; DST makes some days 23 or 25 hours long.
const midnight = time => { const d = new Date(time); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const shift = (time, days) => { const d = new Date(time); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime(); };
const monday = time => shift(midnight(time), -((new Date(time).getDay() + 6) % 7));

/** One row per source with calls or saved reports: its outcome counts, reports and cost, busiest first. */
function sourceRows(calls, reports = []) {
  const rows = new Map();
  const row = id => { const key = typeof id === 'string' && id ? id : 'unknown'; if (!rows.has(key)) rows.set(key, { id: key, calls: [], results: 0, empty: 0, failed: 0, total: 0, reports: 0 }); return rows.get(key); };
  for (const call of calls) { const source = row(call.source); source.calls.push(call); tally(source, call); }
  for (const report of reports) row(report.source).reports += 1;
  return [...rows.values()].map(({ calls: list, ...rest }) => ({ ...rest, cost: costSummary(list) }))
    .sort((a, b) => b.total - a.total || b.reports - a.reports || a.id.localeCompare(b.id));
}

/**
 * What the snapshot's receipts and reports say about one window: `days` back from today (7, 30), or 0 for
 * everything since the first retained record. Calls and reports outside the window, or without a readable time,
 * are left out. Returns totals, one bucket per day (per week past two months), one row per source, busiest first,
 * and `recorded`: how many dated receipts and reports the library holds in any window, so a quiet week is not
 * mistaken for a library with no research yet.
 */
export function usageOf(snapshot, { days = 30, now = Date.now() } = {}) {
  const timed = list => list.map(entry => ({ ...entry, time: Date.parse(entry.at) })).filter(entry => Number.isFinite(entry.time));
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const receipts = timed([...items.flatMap(item => (Array.isArray(item.calls) ? item.calls : [])), ...(Array.isArray(snapshot?.live) ? snapshot.live : [])]);
  const reports = timed(items.flatMap(item => (Array.isArray(item.reportDetails) ? item.reportDetails : [])));
  const end = shift(midnight(now), 1);
  const first = [...receipts, ...reports].reduce((earliest, entry) => Math.min(earliest, midnight(entry.time)), midnight(now));
  const start = days > 0 ? shift(end, -days) : first;
  const within = entry => entry.time >= start && entry.time < end;
  const calls = receipts.filter(within); const saved = reports.filter(within);
  const weekly = Math.round((end - start) / DAY_MS) > MAX_DAILY_COLUMNS;
  const buckets = [];
  for (let at = weekly ? monday(start) : start; at < end; at = shift(at, weekly ? 7 : 1)) buckets.push({ start: at, results: 0, empty: 0, failed: 0, total: 0 });
  for (const call of calls) {
    let bucket = null; for (const candidate of buckets) if (candidate.start <= call.time) bucket = candidate;
    if (bucket) tally(bucket, call);
  }
  return {
    days, start, end, weekly, buckets, recorded: receipts.length + reports.length,
    totals: { ...outcomeCounts(calls), reports: saved.length, cost: costSummary(calls) },
    sources: sourceRows(calls, saved),
  };
}

