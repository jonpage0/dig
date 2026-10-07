// Provider responses are untrusted JSON: every source reader goes through these narrow accessors.
// Nothing here touches the DOM. Adapted from Dig's dashboard/ui/evidence/read.ts (MIT, same author).
import { decodeEntities } from '../format.mjs';

export const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
export const arr = v => (Array.isArray(v) ? v : []);
export const objs = v => arr(v).flatMap(x => { const o = obj(x); return o ? [o] : []; });
export const str = v => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
export const numv = v => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; };
export const strs = v => arr(v).flatMap(x => str(x) ?? []);

/** Every response body in a raw file (`{tool, at, responses: [{label, status, body}]}`), in order. */
export function bodies(content) {
  return objs(obj(content)?.responses).map(r => r.body);
}

/** Plural nouns for item kinds, for list headings and result lines. */
export const ITEM_NOUNS = { post: ['post', 'posts'], story: ['story', 'stories'], comment: ['comment', 'comments'], paper: ['paper', 'papers'], video: ['video', 'videos'], repo: ['repository', 'repositories'], event: ['event', 'events'], page: ['page', 'pages'], answer: ['answer', 'answers'], account: ['account', 'accounts'], bucket: ['time bucket', 'time buckets'], trend: ['trend', 'trends'], space: ['Space', 'Spaces'], community: ['Community', 'Communities'] };

/** Provider text that arrives as HTML (Hacker News comments) as plain text; only ever inserted as a text node. */
export function htmlText(html) {
  return decodeEntities(html.replace(/<(?:p|br)\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

export function excerpt(text, max) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max).replace(/\s+\S*$/, '')}…` : clean;
}

/** "(stories, last 30 days)", or nothing when there is no scope to state. */
export function scope(parts) {
  const kept = parts.filter(p => typeof p === 'string' && p.length > 0);
  return kept.length ? [`(${kept.join(', ')})`] : [];
}
/** A query phrase, or nothing when the call had none. */
export const query = value => (value ? [{ query: value }] : []);
/** Reads and downloads say so when they did not work: "read" or "tried to read". */
export const attempted = (status, done, verb) => (status === 'failed' || status === 'cancelled' ? `tried to ${verb}` : done);
/**
 * The result line when a reader recognized no items. Only the receipt's explicit `empty` status establishes that
 * the source returned nothing; otherwise the response has a shape this preview does not read.
 */
export const noItems = call => (call.status === 'empty' ? 'nothing found' : 'no preview items recognized; inspect the original response');
export const failedCall = call => call.status === 'failed' || call.status === 'cancelled';
