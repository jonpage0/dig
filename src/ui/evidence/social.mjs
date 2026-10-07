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
function post(p) {
  const text = str(p.title) ?? str(p.body) ?? str(p.text) ?? str(p.desc) ?? str(p.caption) ?? str(p.description);
  if (!text) return undefined;
  const url = link(p); const score = numv(p.score) ?? numv(p.ups) ?? numv(p.like_count) ?? numv(p.digg_count);
  const replies = numv(p.num_comments) ?? numv(p.comment_count); const at = when(p);
  return {
    kind: 'post', key: str(p.id) ?? str(p.post_id) ?? str(p.name) ?? url ?? text, title: excerpt(text, TEXT_EXCERPT), url,
    meta: [community(p), str(p.author) ?? str(obj(p.author)?.username) ?? str(p.username), score === undefined ? undefined : `${compact(score)} points`, replies === undefined ? undefined : `${compact(replies)} replies`, at ? shortDate(at) : undefined].filter(Boolean),
  };
}

export function readSocial(call, bodies, context) {
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
