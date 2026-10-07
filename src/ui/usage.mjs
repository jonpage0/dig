// Usage at the top of the Library page, derived in the view from the library snapshot it already holds: every
// retained provider-call receipt (claimed by a saved report or answer, or still live) and every saved report's date.
// Nothing is stored. Costs keep the receipts' own semantics: summed per unit and never converted, with unknown kept
// apart from no charge. Bars are SVG drawn from numbers, so no inline style is needed, and each outcome has a
// word in the legend and its own fill pattern, never colour alone. The figures, source chart and legend are shared
// with an open dig's Retrievals summary (retrievals.mjs).
import { costSummary } from '../providers/library/cost.ts';
import { MODULES } from '../providers/modules.ts';
import { attr, button, keyed, node, rebuild } from './dom.mjs';
import { COST_CAVEAT, COST_SCOPE, costAmounts, costShort, num, plural, shortDate } from './format.mjs';
import { mark } from './sources.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const DAY_MS = 86400000;
// Beyond about two months a column per day is too thin to read; All time then counts by week.
const MAX_DAILY_COLUMNS = 62;
const PREFIX = 'usage';
export const WINDOWS = [{ days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 0, label: 'All time' }];
/**
 * Receipt status → the charts' three outcomes. A cancelled or skipped call is not a provider failure, but it returned
 * nothing usable either. Each chart's patterns carry an id prefix, so two charts on one page never share an id.
 */
const outcomes = prefix => [
  { id: 'results', label: 'Returned results', fill: 'var(--primary)' },
  { id: 'empty', label: 'No results', fill: `url(#${prefix}-dots)` },
  { id: 'failed', label: 'Failed or stopped', fill: `url(#${prefix}-hatch)` },
];
export const outcomeOf = status => (status === 'success' || status === 'partial' ? 'results' : status === 'empty' ? 'empty' : 'failed');
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
const iso = time => new Date(time).toISOString();
const labelOf = id => MODULES.find(m => m.id === id)?.label ?? 'Unknown source';

/** One row per source with calls or saved reports: its outcome counts, reports and cost, busiest first. */
export function sourceRows(calls, reports = []) {
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

function svg(viewBox, className, ...children) {
  const element = document.createElementNS(SVG, 'svg');
  element.setAttribute('viewBox', viewBox); element.setAttribute('class', className);
  element.setAttribute('aria-hidden', 'true'); element.setAttribute('focusable', 'false');
  element.append(...children.flat().filter(Boolean));
  return element;
}
function shape(tag, attributes, ...children) {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  element.append(...children);
  return element;
}
const title = value => { const element = document.createElementNS(SVG, 'title'); element.textContent = value; return element; };
/** The two patterns a chart fills from, with ids under `prefix`; one copy per render, so the ids stay unique. */
export function patterns(prefix) {
  return svg('0 0 0 0', 'usage-defs', shape('defs', {},
    shape('pattern', { id: `${prefix}-hatch`, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
      shape('rect', { width: 4, height: 4, class: 'hatch-ground' }), shape('rect', { width: 1.6, height: 4, class: 'hatch-line' })),
    shape('pattern', { id: `${prefix}-dots`, width: 4, height: 4, patternUnits: 'userSpaceOnUse' },
      shape('rect', { width: 4, height: 4, class: 'dots-ground' }), shape('circle', { cx: 2, cy: 2, r: 0.9, class: 'dots-dot' }))));
}
const breakdown = counts => outcomes(PREFIX).filter(o => counts[o.id]).map(o => `${num(counts[o.id])} ${o.label.toLowerCase()}`).join(', ');
const bucketName = (usage, bucket) => (usage.weekly ? `Week of ${shortDate(iso(bucket.start))}` : shortDate(iso(bucket.start)));

/** Retrievals per day (or week), stacked by outcome; the summary is the chart's accessible name. */
function columns(usage) {
  const width = 600; const height = 180; const slot = width / usage.buckets.length; const bar = Math.max(2, Math.min(slot * 0.72, 48));
  const max = Math.max(1, ...usage.buckets.map(b => b.total));
  const busiest = usage.buckets.reduce((best, b) => (b.total > (best?.total ?? 0) ? b : best), null);
  const unit = usage.weekly ? 'week' : 'day';
  const groups = usage.buckets.map((bucket, index) => {
    let y = height;
    const x = index * slot + (slot - bar) / 2;
    const parts = outcomes(PREFIX).filter(o => bucket[o.id]).map(o => {
      const size = (bucket[o.id] / max) * height; y -= size;
      return shape('rect', { x, y, width: bar, height: size, fill: o.fill, class: `fill-${o.id}` });
    });
    return shape('g', {}, title(`${bucketName(usage, bucket)}: ${plural(bucket.total, 'retrieval')}${bucket.total ? ` (${breakdown(bucket)})` : ''}`), ...parts);
  });
  const summary = busiest ? `Retrievals per ${unit}, ${bucketName(usage, usage.buckets[0])} to ${bucketName(usage, usage.buckets.at(-1))}: ${num(usage.totals.total)} in total; the busiest ${unit} was ${bucketName(usage, busiest)} with ${num(busiest.total)}.` : `No retrievals per ${unit} in this window.`;
  const last = usage.buckets.at(-1);
  return node('figure', 'chart',
    node('div', 'chart-head', node('figcaption', 'chart-title', `Retrievals per ${unit}`), busiest ? node('span', 'meta', `Busiest ${unit}: ${num(busiest.total)}`) : null),
    attr(attr(node('div', 'chart-frame', svg(`0 0 ${width} ${height}`, 'columns', shape('line', { x1: 0, y1: height - 0.5, x2: width, y2: height - 0.5, class: 'baseline' }), groups)), 'role', 'img'), 'aria-label', summary),
    node('div', 'axis', node('span', '', bucketName(usage, usage.buckets[0])), node('span', '', usage.weekly ? bucketName(usage, last) : 'Today')));
}

// The busiest sources show at once and the rest wait behind a disclosure that stays as the reader left it.
const SHOWN_SOURCES = 6;
let moreOpen = false;
/**
 * One row per source, each bar on the same scale as the busiest source's and its cost under it. `shown` rows show at
 * once; the rest sit behind a disclosure.
 */
export function sourceChart(rows, prefix, shown = SHOWN_SOURCES) {
  const max = Math.max(1, ...rows.map(s => s.total));
  const width = 240; const height = 10;
  const items = rows.map(row => {
    let x = 0;
    const parts = outcomes(prefix).filter(o => row[o.id]).map(o => {
      const size = (row[o.id] / max) * width; const part = shape('rect', { x, y: 0, width: size, height, fill: o.fill, class: `fill-${o.id}` }); x += size; return part;
    });
    const module = MODULES.find(m => m.id === row.id);
    const detail = `${plural(row.total, 'retrieval')}${row.total ? ` (${breakdown(row)})` : ''}, ${plural(row.reports, 'report')} saved`;
    return attr(node('li', 'source-row',
      node('span', 'who', module ? mark(module, true) : null, node('span', 'who-name', labelOf(row.id))),
      node('span', 'track', svg(`0 0 ${width} ${height}`, 'bar', shape('rect', { width, height, class: 'bar-ground' }), parts)),
      node('span', 'count', num(row.total)),
      node('span', 'meta row-cost', costShort(row.cost, row.total)),
      node('span', 'sr-only', detail)), 'title', detail);
  });
  const rest = items.slice(shown);
  const more = rest.length ? node('details', 'more-sources', keyed(node('summary', 'meta', `${plural(rest.length, 'more source')}`), `${prefix}-more`), node('ul', 'source-rows', rest)) : null;
  if (more) { more.open = moreOpen; more.addEventListener('toggle', () => { moreOpen = more.open; }); }
  return node('figure', 'chart',
    node('div', 'chart-head', node('figcaption', 'chart-title', 'Retrievals by source'), node('span', 'meta', 'Cost under each bar')),
    items.length ? [node('ul', 'source-rows', items.slice(0, shown)), more] : node('p', 'meta', 'No source was used in this window.'));
}
/** The outcome legend: each outcome's word beside its fill. */
export function legend(prefix) {
  return node('div', 'legend', outcomes(prefix).map(o => node('span', 'legend-item', svg('0 0 10 10', 'swatch', shape('rect', { width: 10, height: 10, rx: 2, fill: o.fill, class: `fill-${o.id}` })), o.label)));
}

export function metric(label, value, note) {
  return node('div', 'metric', node('dt', '', label), node('dd', '', node('span', 'metric-value', value), note ? node('span', 'metric-note', note) : null));
}
/** The provider cost figure for `total` calls: each unit on its own line, since dollars and each provider's credits are never added together, and how much of it is known. */
export function costMetric(cost, total) {
  const amounts = costAmounts(cost);
  const value = !total ? '—' : amounts.length ? amounts.map(amount => node('span', 'cost-unit', amount)) : cost.unknownCalls ? 'Unknown' : 'No charge recorded';
  const note = !total ? 'No retrievals' : cost.unknownCalls ? `${num(cost.unknownCalls)} of ${plural(total, 'retrieval')} incompletely priced` : 'Every retrieval’s cost is known';
  return metric('Provider cost', value, note);
}
function metrics(usage) {
  const { totals } = usage;
  const share = totals.total ? `${Math.round((totals.failed / totals.total) * 100)}% of retrievals` : 'None in this window';
  const reportSources = usage.sources.filter(s => s.reports).length;
  return node('dl', 'metrics',
    metric('Retrievals', num(totals.total), totals.total ? `${num(totals.results)} with results` : 'None in this window'),
    metric('Reports saved', num(totals.reports), totals.reports ? `from ${plural(reportSources, 'source')}` : 'None in this window'),
    metric('Failed or stopped', num(totals.failed), share),
    costMetric(totals.cost, totals.total));
}

/**
 * Renders the usage section for `usage` into `container`. `choose(days)` switches the window; the window buttons
 * keep keyboard focus when the section is rebuilt by a later snapshot. A library with nothing dated in any window
 * says so instead of showing empty figures and a window it cannot fill.
 */
export function renderUsage(container, usage, choose) {
  const heading = attr(node('h3', '', 'Usage'), 'id', 'usage-title');
  if (!usage.recorded) {
    rebuild(container, [node('div', 'usage-head', node('div', '', heading,
      node('p', 'usage-empty', 'No usage yet'),
      node('p', 'meta', 'Retrievals, saved reports and what providers reported they cost are counted here once you research a question.')))]);
    return;
  }
  const scope = usage.days ? `Last ${usage.days} days` : `All time, since ${shortDate(iso(usage.start))}`;
  const picker = attr(node('div', 'segmented', WINDOWS.map(w => attr(keyed(button('btn-ghost', w.label, () => choose(w.days)), `usage-window:${w.days}`), 'aria-pressed', String(w.days === usage.days)))), 'aria-label', 'Usage window');
  attr(picker, 'role', 'group');
  rebuild(container, [
    patterns(PREFIX),
    node('div', 'usage-head', node('div', '', heading, node('p', 'meta', `${scope} · every project in this library`)), picker),
    metrics(usage),
    usage.totals.total || usage.totals.reports ? node('div', 'charts', columns(usage), sourceChart(usage.sources, PREFIX)) : node('p', 'meta', 'No retrievals or reports in this window.'),
    usage.totals.total ? legend(PREFIX) : null,
    node('p', 'meta usage-scope', `${COST_SCOPE}. ${COST_CAVEAT} `, node('span', 'usage-counts', 'Counts come from the receipts Dig keeps for each provider call.')),
  ].filter(Boolean));
}
