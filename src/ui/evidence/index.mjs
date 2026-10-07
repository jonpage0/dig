// Every provider call as one plain-language line, built from its receipt and retained raw response, plus the
// items it brought back. One reader per source family; a source without one says which tool ran with what,
// and the view falls back to the original JSON. These are views of retained evidence, never a second store.
// Adapted from Dig's dashboard/ui/evidence/index.ts (MIT, same author).
import { readDeepwiki, readGithub } from './code.mjs';
import { readHackerNews } from './hackernews.mjs';
import { readPapersCall } from './papers.mjs';
import { readPolymarket } from './polymarket.mjs';
import { obj, query, str } from './read.mjs';
import { readSocial } from './social.mjs';
import { readWeb } from './web.mjs';
import { readX } from './x.mjs';
import { readYoutube } from './youtube.mjs';

export { bodies, ITEM_NOUNS } from './read.mjs';

const ARG_SUMMARY_MAX = 3;

function readGeneric(call) {
  const q = str(call.args.query) ?? str(call.args.question) ?? str(call.args.url);
  const rest = Object.entries(call.args)
    .filter(([key, value]) => value !== undefined && value !== null && value !== '' && str(value) !== q && key !== 'query')
    .slice(0, ARG_SUMMARY_MAX)
    .map(([key, value]) => `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return { action: [`called ${call.tool}`, ...(q ? ['for', ...query(q)] : []), ...(rest.length ? [`(${rest.join(', ')})`] : [])], items: [] };
}

const READERS = {
  x: readX,
  hackernews: readHackerNews,
  papers: readPapersCall,
  youtube: readYoutube,
  github: readGithub,
  deepwiki: readDeepwiki,
  polymarket: readPolymarket,
  exa: readWeb,
  perplexity: readWeb,
  reddit: readSocial,
  'tikhub-reddit': readSocial,
  tiktok: readSocial,
  instagram: readSocial,
  linkedin: readSocial,
  telegram: readSocial,
  'china-social': readSocial,
};

/** Whether a source has a source-shaped reader; otherwise the reader shows the original JSON first. */
export const hasSourceView = source => Object.hasOwn(READERS, source);

/**
 * A call as a sentence plus its items. `context.label(sourceId)` names sources from the catalog.
 * Without retained bodies nothing can be said about what came back, so there is no result.
 */
export function evidence(receipt, responseBodies, context) {
  const call = { tool: String(receipt.tool ?? 'unknown tool'), source: String(receipt.source ?? ''), status: String(receipt.status ?? ''), args: obj(receipt.args) ?? {} };
  const read = READERS[call.source] ?? readGeneric;
  const e = read(call, responseBodies, context);
  return responseBodies.length ? e : { ...e, result: undefined, items: [] };
}

/** The whole line as plain text: `Searched Hacker News for “sqlite” (stories) → 3 of 108 stories`. */
export function sentenceText(e) {
  const action = e.action.map(p => (typeof p === 'string' ? p : `“${p.query}”`)).join(' ');
  const line = `${action[0]?.toUpperCase() ?? ''}${action.slice(1)}`;
  return e.result ? `${line} → ${e.result}` : line;
}
