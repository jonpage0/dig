// The Retrievals summary at the top of an open dig: every provider call saved with the dig, whichever report or
// conversation made it, in the figures and source chart of the Library's Usage, then every call grouped by what saved it.
// Derived in the view from the dig's receipts; nothing is stored.
import { costSummary } from '../providers/library/cost.ts';
import { callWord, runWord } from '../status.mjs';
import { attr, button, fold, keyed, node, rebuild, tag } from './dom.mjs';
import { COST_CAVEAT, COST_SCOPE, absTime, clock, costShort, duration, num, plural } from './format.mjs';
import { callSentence } from './reader.mjs';
import { costMetric, legend, metric, outcomeCounts, outcomeOf, patterns, sourceChart, sourceRows } from './usage.mjs';

const PREFIX = 'dig';
const UNSAVED = 'unsaved';
const time = call => { const at = Date.parse(call.at); return Number.isFinite(at) ? at : 0; };
// Failed or stopped calls lead their group, then the rest in the order they ran.
const order = (a, b) => (outcomeOf(b.status) === 'failed') - (outcomeOf(a.status) === 'failed') || time(a) - time(b);

/**
 * The dig's calls grouped by what saved them: each report in the order it was saved, then the conversation that started
 * the dig, then calls that named the dig but that no report or answer saved. Empty groups are left out.
 */
export function retrievalGroups(item) {
  const reports = Array.isArray(item.reportDetails) ? item.reportDetails : [];
  const groups = [...reports.map(report => ({ key: report.file, report, calls: [] })), { key: 'main', calls: [] }, { key: UNSAVED, calls: [] }];
  const byKey = new Map(groups.map(group => [group.key, group]));
  for (const call of item.calls ?? []) (byKey.get(call.claimedBy ?? UNSAVED) ?? byKey.get(UNSAVED)).calls.push(call);
  for (const group of groups) group.calls.sort(order);
  return groups.filter(group => group.calls.length);
}

function callLine(call, catalog, inspect) {
  const facts = [call.source ? catalog.label(call.source) : null, clock(call.at), duration(call.ms), costShort(costSummary([call]), 1)].filter(Boolean).join(' · ');
  return node('li', 'retrieval',
    node('div', 'retrieval-line', tag(callWord(call.status)), node('span', 'retrieval-what', callSentence(call, catalog))),
    call.error ? node('p', 'retrieval-error', call.error) : null,
    node('div', 'retrieval-foot', attr(node('span', 'meta', facts), 'title', absTime(call.at)),
      call.rawFile ? keyed(button('btn-ghost retrieval-raw', 'Open original response', () => inspect(call.rawFile)), `raw:${call.rawFile}`) : node('span', 'meta', 'Original response not retained')));
}
function groupHead(group, catalog) {
  const cost = costShort(costSummary(group.calls), group.calls.length);
  const counts = node('span', 'meta', `${plural(group.calls.length, 'retrieval')}${cost ? ` · ${cost}` : ''}`);
  if (group.report) {
    const status = runWord(group.report.status);
    return node('h4', 'retrieval-group-title', catalog.fileLabel(group.report.file), status ? tag(status) : null, counts);
  }
  return node('h4', 'retrieval-group-title', group.key === 'main' ? 'The conversation that started this dig' : 'Not in a saved report or answer', counts);
}
function groupView(group, catalog, inspect) {
  return node('section', 'retrieval-group',
    groupHead(group, catalog),
    group.key === UNSAVED ? node('p', 'meta', 'These calls named this dig, but no report or answer saved them, as when a worker stops before saving. They count in this dig’s retrievals and cost.') : null,
    node('ul', 'retrieval-list', group.calls.map(call => callLine(call, catalog, inspect))));
}

// The list fold belongs to the open dig: built once per dig, so a live update rebuilds only its title, gist and
// contents and leaves it open or closed; another dig starts closed.
let list = null; let listTitle = null; let listDig = null;
/** Renders `item`'s Retrievals summary into `container`; `inspect(rawFile)` opens a retained original response. */
export function renderRetrievals(container, item, catalog, inspect) {
  const calls = Array.isArray(item.calls) ? item.calls : [];
  const head = node('div', 'usage-head', node('div', '', attr(node('h3', '', 'Retrievals'), 'id', 'retrievals-title'), node('p', 'meta', 'Every provider call saved with this dig, from its reports and the conversations that worked on it.')));
  if (!calls.length) { rebuild(container, [head, node('p', 'meta', 'No provider call has been saved with this dig yet.')]); return; }
  const key = `${item.project}:${item.id}`;
  if (listDig !== key) { listTitle = node('span', 'fold-title'); list = fold('retrievals-fold', 'retrievals-all', listTitle); listDig = key; }
  const groups = retrievalGroups(item);
  const unsaved = groups.find(group => group.key === UNSAVED)?.calls.length ?? 0;
  listTitle.textContent = `All ${plural(calls.length, 'retrieval')}`;
  list.gist.textContent = `${unsaved ? `${num(unsaved)} not in a saved report · ` : ''}grouped by report, failed first`;
  rebuild(list.body, groups.map(group => groupView(group, catalog, inspect)));
  const counts = outcomeCounts(calls); const cost = costSummary(calls);
  const reports = Array.isArray(item.reportDetails) ? item.reportDetails : [];
  const rows = sourceRows(calls, reports);
  rebuild(container, [
    patterns(PREFIX),
    head,
    // The figures sit beside the chart, so its bars keep Usage's proportions instead of stretching across the page.
    node('div', 'retrievals-body',
      node('dl', 'metrics',
        metric('Retrievals', num(counts.total), `${num(counts.results)} with results`),
        metric('Sources', num(rows.length), `${plural(reports.length, 'report')} saved`),
        metric('Failed or stopped', num(counts.failed), `${Math.round((counts.failed / counts.total) * 100)}% of retrievals`),
        costMetric(cost, counts.total)),
      sourceChart(rows, PREFIX, Infinity)),
    legend(PREFIX),
    node('p', 'meta usage-scope', `${COST_SCOPE}. ${COST_CAVEAT}`),
    list.element,
  ]);
}
