// Reading views for one dig's files: the question, source reports (with the source's own card), the answer,
// and retained original responses as source-shaped evidence with the verbatim JSON always reachable.
import { answerWord, callWord, runWord } from '../status.mjs';
import { attr, externalLink, httpUrl, node, tag } from './dom.mjs';
import { frontMatter, renderMarkdown, sourceCard } from './markdown.mjs';
import { bodies, evidence, hasSourceView, ITEM_NOUNS, sentenceText } from './evidence/index.mjs';
import { absTime, basename, costText, duration, num, plural } from './format.mjs';
import { costSummary } from '../providers/library/cost.ts';
import { fileKind } from './catalog.mjs';

const CARD_LISTS = [['contradictions', 'Contradictions'], ['negative_evidence', 'Negative evidence'], ['follow_up_targets', 'Follow-up targets']];
const PERCENT = 100;

const facts = parts => node('p', 'doc-facts', parts.filter(Boolean).flatMap((part, i) => (i ? [node('span', 'sep', ' · '), part] : [part])));
const fact = (label, value) => (value === undefined || value === null || value === '' ? null : node('span', '', node('span', 'fact-label', `${label} `), value));

function reportFacts(meta, catalog) {
  return facts([
    fact('Method', typeof meta.agent === 'string' ? catalog.methodLabel(meta.agent) : null),
    fact('Saved', meta.generated_at ? absTime(meta.generated_at) : null),
    fact('Topic', meta.topic),
    fact('Topic changes', meta.topic_volatility),
    fact('Corrects', meta.supersedes ? catalog.fileLabel(meta.supersedes) : null),
  ]);
}
function answerFacts(meta, catalog) {
  const reports = Array.isArray(meta.reports) ? meta.reports.map(report => catalog.fileLabel(String(report))).join(', ') : null;
  return facts([meta.status ? tag(answerWord(meta.status) ?? String(meta.status)) : null, fact('Written', meta.finished_at ? absTime(meta.finished_at) : null), fact('Relies on', reports || null)]);
}
function questionFacts(meta, catalog) {
  const planned = Array.isArray(meta.planned) ? meta.planned.map(method => catalog.methodLabel(String(method))).join(', ') : null;
  return facts([fact('Started', meta.started_at ? absTime(meta.started_at) : null), fact('Planned methods', planned || null), fact('Refreshes', meta.refreshes)]);
}

/** The report's own source_card, presented as the source worker's assessment, never as verification. */
function cardSummary(card) {
  const { fields, lists } = card;
  const findings = lists.strongest_findings ?? [];
  const verbatim = node('details', 'card-yaml', node('summary', '', card.partial ? 'The card as written (part of it is shown only here)' : 'The card as written'), node('pre', 'code', card.yaml));
  if (card.partial) verbatim.setAttribute('open', '');
  return node('section', 'source-card',
    node('p', 'eyebrow', 'Source report’s own assessment'),
    node('p', 'meta', 'Written by the source worker in its source card. Dig records it as reported; it is not an independent check.'),
    facts([runWord(fields.status) ? node('span', '', node('span', 'fact-label', 'Run status '), tag(runWord(fields.status))) : null, fact('Evidence grade', fields.evidence_grade), fact('Confidence', fields.confidence), fact('Reported cost (USD)', fields.reported_cost_usd === undefined ? null : String(fields.reported_cost_usd))]),
    findings.length ? [node('h4', 'card-title', 'Strongest findings, as reported'), node('ul', 'card-list', findings.map(f => node('li', '', f)))] : null,
    CARD_LISTS.map(([key, title]) => (lists[key]?.length ? node('details', 'card-more', node('summary', '', `${title} (${num(lists[key].length)})`), node('ul', 'card-list', lists[key].map(f => node('li', '', f)))) : null)),
    verbatim,
  );
}
/** A question, report or answer file rendered for reading. */
export function documentView(file, text, catalog) {
  const { meta, body } = frontMatter(text);
  const kind = fileKind(file);
  if (kind === 'report') {
    const { card, body: rest } = sourceCard(body);
    return node('div', 'doc', reportFacts(meta, catalog), card ? cardSummary(card) : node('p', 'meta', 'This report has no readable source card.'), renderMarkdown(rest));
  }
  return node('div', 'doc', kind === 'answer' ? answerFacts(meta, catalog) : questionFacts(meta, catalog), renderMarkdown(body));
}

function itemRow(item) {
  const href = httpUrl(item.url);
  return node('li', 'evidence-item',
    node('p', 'item-title', href ? externalLink(href, item.title) : item.title),
    item.meta?.length ? node('p', 'meta', item.meta.join(' · ')) : null,
    item.excerpt ? node('p', 'item-excerpt', item.excerpt) : null,
    item.outcomes?.length ? node('ul', 'outcomes', item.outcomes.map(o => node('li', '', `${o.label}: ${(o.probability * PERCENT).toFixed(1)}%${typeof o.dayMove === 'number' ? ` (${o.dayMove >= 0 ? '+' : ''}${(o.dayMove * PERCENT).toFixed(1)} points today)` : ''}`))) : null,
    item.links?.length ? node('p', 'meta', item.links.flatMap((l, i) => { const url = httpUrl(l.url); return url ? [i ? ' · ' : '', externalLink(url, l.label)] : []; })) : null,
  );
}
function itemsHeading(items) {
  const kinds = [...new Set(items.map(item => item.kind))];
  const nouns = kinds.length === 1 ? ITEM_NOUNS[kinds[0]] : null;
  return nouns ? plural(items.length, nouns[0], nouns[1]) : plural(items.length, 'item');
}
function connectorTable(connectors) {
  return node('div', 'table-scroll', node('table', '',
    node('thead', '', node('tr', '', ['Connector', 'State', 'Results', 'Note'].map(h => attr(node('th', '', h), 'scope', 'col')))),
    node('tbody', '', connectors.map(c => node('tr', '', node('td', '', c.name), node('td', '', c.state), attr(node('td', '', c.results === undefined ? '' : num(c.results)), 'data-align', 'right'), node('td', '', c.note ?? ''))))));
}
function jsonBlock(text, parsed, open) {
  const pre = node('pre', 'raw');
  const fill = () => { if (!pre.textContent) pre.textContent = parsed === undefined ? text : JSON.stringify(parsed, null, 2); };
  const details = node('details', 'raw-json', node('summary', '', `Original JSON · ${plural(text.length, 'character')}`), pre);
  // Large responses stay cheap until opened.
  if (open) { details.setAttribute('open', ''); fill(); } else details.addEventListener('toggle', fill, { once: true });
  return details;
}

/** One receipt's facts for its original response. Its cost is read through the same summary as dig and conversation totals. */
function callFacts(call, catalog) {
  return facts([tag(callWord(call.status)), call.source ? catalog.label(call.source) : null, call.at ? absTime(call.at) : null, typeof call.ms === 'number' ? duration(call.ms) : null, costText(costSummary([call]))]);
}

/** A retained original response: what the call did and found, from the raw file itself, then the verbatim JSON. */
export function rawView(file, text, call, catalog) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  const receipt = call ?? { tool: parsed?.tool, source: '', status: '', args: {} };
  let preview;
  try {
    const e = evidence(receipt, parsed === undefined ? [] : bodies(parsed), catalog);
    preview = {
      summary: node('p', 'sentence', sentenceText(e)),
      specialized: hasSourceView(receipt.source) && e.items.length > 0,
      content: [
        e.connectors?.length ? [node('h4', 'section-title', 'Connector health'), connectorTable(e.connectors)] : null,
        e.items.length ? [node('h4', 'section-title', `${itemsHeading(e.items)} in this response`), node('ol', 'evidence-items', e.items.map(itemRow))] : null,
      ],
    };
  } catch {
    // Provider-shaped previews are optional; an unreadable preview must not hide retained evidence.
    preview = null;
  }
  const responses = Array.isArray(parsed?.responses) ? parsed.responses : [];
  return node('div', 'doc raw-doc',
    preview?.summary ?? node('p', 'meta', 'The source preview could not be rendered. The original JSON is shown in full below.'),
    call ? callFacts(call, catalog) : node('p', 'meta', 'No call receipt in this dig matches this file; only the response itself is shown.'),
    node('dl', 'call-facts',
      node('dt', '', 'Retrieval'), node('dd', '', call?.id ?? basename(file)),
      node('dt', '', 'Tool'), node('dd', '', String(receipt.tool ?? 'unknown')),
      call?.error ? [node('dt', '', 'Error'), node('dd', '', String(call.error))] : null,
      call ? [node('dt', '', 'Saved with'), node('dd', '', call.claimedBy === 'main' ? 'The conversation that started this dig (no source report claims it)' : call.claimedBy ? catalog.fileLabel(call.claimedBy) : 'Not in a saved report or answer; the call named this dig')] : null,
      node('dt', '', 'Arguments'), node('dd', '', node('pre', 'args', JSON.stringify(receipt.args ?? {}, null, 2))),
      responses.length ? [node('dt', '', 'Responses'), node('dd', '', responses.map((r, i) => `${i ? '; ' : ''}${r?.label ?? 'response'} · HTTP ${r?.status ?? 'status not recorded'}`).join(''))] : null),
    preview?.content,
    preview && !preview.specialized ? node('p', 'meta', parsed === undefined ? 'This file is not valid JSON; its text is shown as saved.' : hasSourceView(receipt.source) ? 'No preview items recognized in this response; the original JSON is shown in full. A missing preview is not evidence that the source returned nothing.' : 'No source-specific view applies to this response, so the original JSON is shown in full.') : null,
    jsonBlock(text, parsed, !preview?.specialized),
  );
}

/** A call as a plain sentence from its receipt alone (no result: that needs the raw response). */
export const callSentence = (call, catalog) => sentenceText(evidence(call, [], catalog));
