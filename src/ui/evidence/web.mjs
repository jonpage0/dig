// Exa and Perplexity: what was asked, and the pages that came back.
// Adapted from Dig's dashboard/ui/evidence/web.ts (MIT, same author).
import { hostname, plural, shortDate } from '../format.mjs';
import { failedCall, noItems, obj, objs, query, scope, str, strs } from './read.mjs';

function asked(call) {
  const a = call.args;
  const q = str(a.query) ?? (strs(a.query).join(' | ') || undefined);
  if (q) return q;
  return str(objs(a.messages).filter(m => m.role === 'user').at(-1)?.content) ?? str(a.instructions);
}

function action(call) {
  const a = call.args; const q = asked(call); const urls = strs(a.urls);
  switch (call.tool) {
    case 'exa_search': return ['searched the web with Exa for', ...query(q), ...scope([str(a.type) && str(a.type) !== 'auto' ? str(a.type) : undefined, str(a.category)])];
    case 'exa_contents': return [`fetched ${urls.length ? plural(urls.length, 'page') : 'pages'} with Exa`];
    case 'exa_similar': return ['asked Exa for pages like', str(a.url) ?? 'a page'];
    case 'exa_research': return ['ran Exa research on', ...query(q)];
    case 'perplexity_search': return ['searched the web with Perplexity for', ...query(q)];
    case 'perplexity_research': return ['ran Perplexity deep research on', ...query(q)];
    default: return [call.source === 'perplexity' ? 'asked Perplexity' : `called ${call.tool} with`, ...query(q)];
  }
}

function addPage(pages, p) {
  const url = str(p.url);
  if (!url || pages.has(url)) return;
  const date = str(p.publishedDate) ?? str(p.date) ?? str(p.last_updated);
  pages.set(url, { kind: 'page', key: url, title: str(p.title) ?? url.replace(/^https?:\/\//, ''), url, meta: [hostname(url), str(p.author), date && !Number.isNaN(Date.parse(date)) ? shortDate(date) : date].filter(Boolean) });
}

export function readWeb(call, bodies) {
  const pages = new Map();
  for (const body of bodies) {
    const b = obj(body);
    if (!b) continue;
    for (const r of objs(b.results)) addPage(pages, r);
    for (const r of objs(b.search_results)) addPage(pages, r);
    for (const url of strs(b.citations)) addPage(pages, { url });
    for (const item of objs(b.output)) {
      for (const r of objs(item.results)) addPage(pages, r);
      for (const r of objs(item.contents)) addPage(pages, r);
      for (const c of objs(item.content)) for (const note of objs(c.annotations)) addPage(pages, note);
    }
    for (const g of objs(obj(b.output)?.grounding)) for (const c of objs(g.citations)) addPage(pages, c);
  }
  return { action: action(call), result: failedCall(call) ? undefined : pages.size ? plural(pages.size, 'page') : noItems(call), items: [...pages.values()] };
}
