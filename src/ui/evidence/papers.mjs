// Papers: the federated bridge (with per-connector health), Semantic Scholar, OpenAlex, and full-text reads and downloads.
// Adapted from Dig's dashboard/ui/evidence/papers.ts (MIT, same author).
import { num, plural } from '../format.mjs';
import { arr, attempted, failedCall, noItems, numv, obj, objs, query, scope, str } from './read.mjs';

const READS = new Set(['papers_fulltext_read', 'papers_pdf_download']);
const INDEX = { papers_semantic_scholar_search: 'Semantic Scholar', papers_openalex_search: 'OpenAlex' };
const SORT = { citationCount: 'most cited', cited_by_count: 'most cited', publicationDate: 'newest first' };

const doiUrl = doi => (doi ? (doi.startsWith('http') ? doi : `https://doi.org/${doi}`) : undefined);
const titleKey = title => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const authorList = names => (names.length ? (names.length > 2 ? `${names[0]} et al.` : names.join(' & ')) : undefined);

function readPapers(b) {
  const papers = [];
  // Federated bridge (papers_multi_search)
  for (const p of objs(b.papers)) {
    const title = str(p.title);
    if (title) papers.push({ title, authors: authorList((str(p.authors) ?? '').split(';').map(x => x.trim()).filter(Boolean)), year: str(p.published_date)?.slice(0, 4), citations: numv(p.citations), url: str(p.url) ?? doiUrl(str(p.doi)), pdf: str(p.pdf_url) });
  }
  // Semantic Scholar search and recommendations
  for (const p of [...objs(b.data), ...objs(b.recommendedPapers)]) {
    const title = str(p.title);
    if (title && 'paperId' in p) papers.push({ title, authors: authorList(objs(p.authors).flatMap(x => str(x.name) ?? [])), year: str(p.year), citations: numv(p.citationCount), url: str(p.url) ?? doiUrl(str(obj(p.externalIds)?.DOI)), pdf: str(obj(p.openAccessPdf)?.url) });
  }
  // OpenAlex works
  for (const w of objs(b.results)) {
    const title = str(w.display_name);
    if (title) papers.push({ title, authors: authorList(objs(w.authorships).flatMap(x => str(obj(x.author)?.display_name) ?? [])), year: str(w.publication_year), citations: numv(w.cited_by_count), url: doiUrl(str(w.doi)) ?? str(obj(w.primary_location)?.landing_page_url) ?? str(w.id), pdf: str(obj(w.best_oa_location)?.pdf_url) ?? str(obj(w.open_access)?.oa_url) });
  }
  return papers;
}
const item = p => ({ kind: 'paper', key: titleKey(p.title), title: p.title, url: p.url, meta: [p.authors, p.year, p.citations === undefined ? undefined : plural(p.citations, 'citation'), p.pdf ? 'open access' : undefined].filter(Boolean), links: p.pdf ? [{ label: 'PDF', url: p.pdf }] : [] });

/** Connectors of the federated bridge that answered, of those asked. */
function connectors(b) {
  const status = obj(b.source_status);
  if (!status) return undefined;
  const states = Object.values(status).map(String);
  return { answered: states.filter(s => s === 'ok' || s === 'partial').length, asked: states.length };
}
function readText(bodies) {
  for (const body of bodies) {
    if (typeof body === 'string') return `${num(body.length)} characters of text`;
    const b = obj(body);
    if (b && str(b.path)) return `saved ${str(b.path)}`;
  }
  return undefined;
}

export function readPapersCall(call, bodies) {
  const a = call.args; const failed = failedCall(call);
  if (READS.has(call.tool)) {
    const what = [str(a.source), str(a.paperId) ?? str(a.doi) ?? str(a.url)].filter(Boolean).join(' ');
    const verb = call.tool === 'papers_fulltext_read' ? 'read the full text of' : 'downloaded the PDF of';
    return { action: [attempted(call.status, verb, call.tool === 'papers_fulltext_read' ? verb : 'download the PDF of'), what || 'a paper'], result: failed ? undefined : readText(bodies), items: [] };
  }
  const byKey = new Map(); let matches; let health;
  for (const body of bodies) {
    const b = obj(body);
    if (!b) continue;
    for (const p of readPapers(b)) if (!byKey.has(titleKey(p.title))) byKey.set(titleKey(p.title), p);
    matches ??= numv(b.total) ?? numv(obj(b.meta)?.count);
    health ??= connectors(b);
  }
  const papers = [...byKey.values()].sort((x, y) => (y.citations ?? -1) - (x.citations ?? -1));
  const found = matches !== undefined && matches > papers.length ? `${num(papers.length)} of ${plural(matches, 'paper')}` : papers.length ? plural(papers.length, 'paper') : noItems(call);
  const index = INDEX[call.tool];
  const action = call.tool === 'papers_multi_search' ? ['searched', health ? `${num(health.asked)} paper indexes for` : 'the paper indexes for', ...query(str(a.query))]
    : call.tool === 'papers_semantic_scholar_recommendations' ? ['asked Semantic Scholar for papers like', str(a.paperId) ?? 'a paper']
      : [index ? `searched ${index} for` : 'searched for papers on', ...query(str(a.query))];
  return {
    action: [...action, ...scope([numv(a.yearFrom) ? `since ${a.yearFrom}` : undefined, SORT[str(a.sort) ?? '']])],
    result: failed ? undefined : health && health.answered < health.asked ? `${found}; ${num(health.answered)} of ${num(health.asked)} answered` : found,
    items: papers.map(item),
    connectors: connectorStates(bodies),
  };
}

/** The federated bridge's health per connector (papers_multi_search). */
function connectorStates(bodies) {
  for (const body of bodies) {
    const b = obj(body); const status = obj(b?.source_status);
    if (!b || !status) continue;
    const results = obj(b.source_results) ?? {}; const errors = obj(b.errors) ?? {}; const warnings = obj(b.warnings) ?? {};
    return Object.entries(status).map(([name, state]) => ({ name, state: String(state), results: numv(results[name]), note: str(errors[name]) ?? (arr(warnings[name]).map(String).join('; ') || undefined) }));
  }
  return [];
}
