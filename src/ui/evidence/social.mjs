// Reddit and the other social sources: the threads and posts that came back, with scores and replies.
// Adapted from Dig's dashboard/ui/evidence/social.ts (MIT, same author).
import { compact, plural, shortDate } from '../format.mjs';
import { excerpt, failedCall, noItems, numv, obj, objs, query, scope, str } from './read.mjs';

const TEXT_EXCERPT = 200;
const LIST_KEYS = ['posts', 'comments', 'videos', 'items', 'data', 'results', 'threads'];

function community(p) {
  const sub = p.subreddit;
  const name = str(obj(sub)?.name) ?? str(obj(sub)?.display_name) ?? str(sub) ?? str(p.subreddit_name_prefixed) ?? str(p.channel);
  return name ? (name.startsWith('r/') || !('subreddit' in p) ? name : `r/${name}`) : undefined;
}
function link(p) {
  const permalink = str(p.permalink);
  if (permalink?.startsWith('/r/')) return `https://www.reddit.com${permalink}`;
  return permalink ?? str(p.url) ?? str(p.share_url) ?? str(p.link);
}
function when(p) {
  const iso = str(p.created_at_iso) ?? str(p.created_at) ?? str(p.date);
  if (iso && !/^\d+(\.\d+)?$/.test(iso)) return iso;
  const secs = numv(p.created_utc) ?? numv(p.create_time) ?? numv(p.created_at);
  return secs ? new Date(secs * 1000).toISOString() : undefined;
}
function post(p, kind = 'post') {
  const text = str(p.title) ?? str(p.body) ?? str(p.text) ?? str(p.desc) ?? str(p.caption) ?? str(p.description);
  if (!text) return undefined;
  const url = link(p); const score = numv(p.score) ?? numv(p.ups) ?? numv(p.like_count) ?? numv(p.digg_count);
  const replies = numv(p.num_comments) ?? numv(p.comment_count); const at = when(p);
  return {
    kind, key: str(p.id) ?? str(p.post_id) ?? str(p.name) ?? url ?? text, title: excerpt(text, TEXT_EXCERPT), url,
    meta: [community(p), str(p.author) ?? str(obj(p.author)?.username) ?? str(p.username), score === undefined ? undefined : `${compact(score)} points`, replies === undefined ? undefined : `${compact(replies)} replies`, at ? shortDate(at) : undefined].filter(Boolean),
  };
}

// TikTok, Instagram, LinkedIn and Telegram, as Facebook: rows only for the response whose main content this view
// reads, with the figures the tool itself reads from it. Any other response (a search page, a feed, a profile, a
// single post, a transcript) gets the plain reading, and the reader shows its original JSON.
const comments = call => (['tiktok_comments', 'instagram_comments'].includes(call.tool) || (['tiktok_read', 'instagram_read'].includes(call.tool) && call.args.kind === 'replies') ? { key: 'comments', row: p => post(p, 'comment') } : undefined);
const MAIN = {
  tiktok: comments,
  instagram: comments,
  linkedin: call => (call.tool === 'scrapecreators_linkedin' && ['search', 'company_posts'].includes(call.args.kind) ? { key: 'posts', row: linkedinPost } : undefined),
  telegram: call => (call.tool === 'scrapecreators_telegram' && call.args.kind === 'posts' ? { key: 'posts', row: telegramPost } : undefined),
};
const counted = (n, word) => (n === undefined ? undefined : `${compact(n)} ${word}`);
function row(text, url, key, meta) {
  return text ? { kind: 'post', key: key ?? url ?? text, title: excerpt(text, TEXT_EXCERPT), url, meta: meta.filter(Boolean) } : undefined;
}
// formatLinkedInSearch and formatLinkedInCompanyPosts in scrapecreators.ts.
function linkedinPost(p) {
  const at = str(p.datePublished);
  return row(str(p.description) ?? str(p.text), str(p.url), str(p.id), [str(obj(p.author)?.name), counted(numv(p.likeCount), 'likes'), counted(numv(p.commentCount), 'comments'), at ? shortDate(at) : undefined]);
}
// telegramPostLines in scrapecreators.ts.
function telegramPost(p) {
  const at = str(p.published_at);
  return row(str(p.text), str(p.url), str(p.id), [str(p.author_name), counted(numv(p.view_count), 'views'), counted(numv(p.reaction_count), 'reactions'), at ? shortDate(at) : undefined]);
}
/** The reading index.mjs gives a source without a reader: which tool ran, with what. */
function plain(call) {
  const q = str(call.args.query) ?? str(call.args.question) ?? str(call.args.url);
  const rest = Object.entries(call.args)
    .filter(([key, value]) => value !== undefined && value !== null && value !== '' && str(value) !== q && key !== 'query')
    .slice(0, 3)
    .map(([key, value]) => `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return { action: [`called ${call.tool}`, ...(q ? ['for', ...query(q)] : []), ...(rest.length ? [`(${rest.join(', ')})`] : [])], items: [] };
}
function readMain(call, bodies, context, main) {
  if (!main) return plain(call);
  const rows = new Map();
  for (const body of bodies) for (const item of objs(obj(body)?.[main.key])) { const found = main.row(item); if (found && !rows.has(found.key)) rows.set(found.key, found); }
  const q = str(call.args.query);
  const items = [...rows.values()];
  return {
    action: q ? [`searched ${context.label(call.source)} for`, ...query(q)] : plain(call).action,
    result: failedCall(call) ? undefined : items.length ? plural(items.length, items[0].kind) : noItems(call),
    items,
  };
}

export function readSocial(call, bodies, context) {
  if (Object.hasOwn(MAIN, call.source)) return readMain(call, bodies, context, MAIN[call.source](call));
  const posts = new Map();
  for (const body of bodies) {
    const b = obj(body);
    if (!b) continue;
    const single = obj(b.post) && post(obj(b.post));
    if (single) posts.set(single.key, single);
    for (const key of LIST_KEYS) for (const item of objs(b[key])) { const found = post(item); if (found && !posts.has(found.key)) posts.set(found.key, found); }
  }
  const a = call.args; const q = str(a.query) ?? str(a.keyword) ?? str(a.handle) ?? str(a.url);
  return {
    action: [q ? `searched ${context.label(call.source)} for` : `called ${call.tool}`, ...query(q), ...scope([str(a.sort) && str(a.sort) !== 'relevance' ? str(a.sort) : undefined, str(a.timeframe) ? `past ${str(a.timeframe)}` : undefined])],
    result: failedCall(call) ? undefined : posts.size ? plural(posts.size, 'post') : noItems(call),
    items: [...posts.values()],
  };
}
