// X. xsearch (xAI's Grok searching X) reports how many posts it read (`usage.num_sources_used`) but returns only the
// posts its answer cites, as `url_citation` annotations and `citations`; neither carries post metrics, so metrics come
// only from numbers Grok states beside a post. The X API tools (x_post, x_search_posts, x_count_posts, x_users, x_news,
// x_explore, x_bookmarks, x_likes, x_community) return X's own objects: posts with their authors and public counts,
// accounts, count buckets, News stories, trends, Spaces and Communities. TikHub stands in for some: x_post's fallback
// copy of one post, Communities search without sign-in, and a Community's details and posts (x_community).
// Adapted from Dig's dashboard/ui/evidence/x.ts (MIT, same author).
import { compact, num, plural, shortDate } from '../format.mjs';
import { excerpt, failedCall, ITEM_NOUNS, noItems, numv, obj, objs, query, scope, str, strs } from './read.mjs';

const POST_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
/** X ids are snowflakes: milliseconds since this epoch, shifted left 22 bits. */
const SNOWFLAKE_EPOCH = 1288834974657;
const SNOWFLAKE_SHIFT = 22n;

function postDate(id) {
  try { const ms = Number(BigInt(id) >> SNOWFLAKE_SHIFT) + SNOWFLAKE_EPOCH; return Number.isFinite(ms) ? shortDate(new Date(ms).toISOString()) : undefined; } catch { return undefined; }
}

const DAY_FORMAT = { month: 'short', day: 'numeric', timeZone: 'UTC' };
/** A date-only argument ("2026-09-01") as "Sep 1"; dates stay in UTC so no timezone moves them. */
function day(value) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  return { label: date.toLocaleDateString('en-US', DAY_FORMAT), month: date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), year: String(date.getUTCFullYear()) };
}
/** "Sep 1–27", "Aug 28 – Sep 27", "since Sep 1", "until Sep 27". */
function dateWindow(from, to) {
  const a = from ? day(from) : undefined; const b = to ? day(to) : undefined;
  if (a && b) {
    if (a.label === b.label) return a.label;
    if (a.month === b.month && a.year === b.year) return `${a.label}–${b.label.slice(a.month.length + 1)}`;
    return `${a.label} – ${b.label}`;
  }
  if (a) return `since ${a.label}`;
  if (b) return `until ${b.label}`;
  return undefined;
}
const handles = v => strs(v).map(h => `@${h.replace(/^@/, '')}`);

/** "412 likes", "38.2K views", "10,147 likes", "1.2M views". */
const METRIC = /(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?\s+(likes?|reposts?|retweets?|views?)\b/g;
const SCALE = { k: 1e3, m: 1e6 };
const METRIC_NAMES = { like: 'likes', repost: 'reposts', retweet: 'reposts', view: 'views' };
function readMetrics(segment) {
  const found = {};
  for (const m of segment.matchAll(METRIC)) {
    const name = METRIC_NAMES[m[3].toLowerCase().replace(/s$/, '')];
    const n = Number(m[1].replace(/,/g, '')) * (m[2] ? SCALE[m[2].toLowerCase()] : 1);
    if (name && Number.isFinite(n)) found[name] ??= n;
  }
  return found;
}
/** Numbers after a mention of the post on the same line, up to the next other post's mention, so a neighbour never lends its numbers. */
function postMetrics(answer, post, others) {
  for (const at of post.at) {
    const lineEnd = answer.indexOf('\n', at) < 0 ? answer.length : answer.indexOf('\n', at);
    const next = others.filter(o => o > at && o < lineEnd);
    const found = readMetrics(answer.slice(at, next.length ? Math.min(...next) : lineEnd));
    if (Object.keys(found).length) return found;
  }
  return {};
}
/** Where a post is mentioned: its citations' offsets, its status link, and its @handle. */
function mentions(answer, post, annotated) {
  const at = [...annotated]; const lower = answer.toLowerCase();
  const find = needle => { for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + 1)) at.push(i); };
  if (post.id) find(`status/${post.id}`);
  if (post.handle) find(`@${post.handle.toLowerCase()}`);
  return [...new Set(at)].sort((a, b) => a - b);
}

function readPosts(bodies) {
  const cited = new Map(); const anchors = new Map(); let answer = ''; let fetched;
  const add = (url, title) => {
    const known = cited.get(url);
    if (known) { known.title ??= title; return; }
    const match = POST_URL.exec(url);
    cited.set(url, { url, title, handle: match?.[1], id: match?.[2], at: [] });
  };
  for (const body of bodies) {
    const response = obj(body);
    if (!response) continue;
    for (const item of objs(response.output)) for (const content of objs(item.content)) {
      const offset = answer.length;
      if (typeof content.text === 'string') answer += `${content.text}\n`;
      for (const note of objs(content.annotations)) {
        const url = str(note.url);
        if (note.type !== 'url_citation' || !url) continue;
        add(url, str(note.title));
        const start = numv(note.start_index);
        if (start !== undefined && offset + start < answer.length) anchors.set(url, [...(anchors.get(url) ?? []), offset + start]);
      }
    }
    for (const url of strs(response.citations)) add(url);
    const n = numv(obj(response.usage)?.num_sources_used);
    if (n !== undefined) fetched = (fetched ?? 0) + n;
  }
  const list = [...cited.values()];
  for (const post of list) post.at = mentions(answer, post, anchors.get(post.url) ?? []);
  const posts = list.map(post => {
    const { url, handle, id } = post;
    const m = postMetrics(answer, post, list.filter(o => o !== post).flatMap(o => o.at));
    // xAI sometimes titles a citation with its index or the URL itself; that is no preview.
    const preview = post.title && !/^\d+$/.test(post.title) && post.title !== url ? post.title : undefined;
    return {
      kind: 'post', key: handle && id ? `${handle.toLowerCase()}/${id}` : url, title: preview ?? (handle ? `Post by @${handle}` : url.replace(/^https?:\/\//, '')), url,
      meta: [handle ? `@${handle}` : 'web page', id ? postDate(id) : undefined, m.likes === undefined ? undefined : `${compact(m.likes)} likes (as stated by Grok)`, m.reposts === undefined ? undefined : `${compact(m.reposts)} reposts (as stated by Grok)`, m.views === undefined ? undefined : `${compact(m.views)} views (as stated by Grok)`].filter(Boolean),
    };
  });
  return { posts, fetched };
}

const POST_EXCERPT = 1000;
const STORY_LINKS = 10;
const WORLDWIDE_WOEID = 1;
const permalink = (id, handle) => `https://x.com/${handle ?? 'i'}/status/${id}`;
const dated = value => (str(value) && Number.isFinite(Date.parse(value)) ? shortDate(new Date(value).toISOString()) : undefined);
const counted = (value, noun) => (numv(value) === undefined ? undefined : `${compact(numv(value))} ${noun}`);
const who = user => (user ? [str(user.name), str(user.username) ? `@${str(user.username)}` : undefined].filter(Boolean).join(' ') : undefined);

/** An X API post (either spelling X documents) with its author from the response's expansions. */
function apiPost(p, users) {
  const id = str(p.id);
  const text = str(obj(p.note_post)?.text) ?? str(obj(p.note_tweet)?.text) ?? str(p.text);
  if (!id || text === undefined) return undefined;
  const author = users.get(str(p.author_id));
  const m = obj(p.public_metrics) ?? {};
  return {
    kind: 'post', key: id, title: who(author) ?? `Post ${id}`, url: permalink(id, str(author?.username)), excerpt: excerpt(text, POST_EXCERPT),
    meta: [dated(p.created_at) ?? postDate(id), counted(m.like_count, 'likes'), counted(m.repost_count ?? m.retweet_count, 'reposts'), counted(m.reply_count, 'replies'), counted(m.quote_count, 'quotes'), counted(m.impression_count, 'views')].filter(Boolean),
  };
}
/** TikHub's fetch_tweet_detail copy of one post (x_post's fallback). */
function tikhubPost(p) {
  const id = str(p.id) ?? str(p.tweet_id);
  const author = obj(p.author) ?? obj(p.user_info);
  const text = str(p.text) ?? str(p.display_text);
  if (!id || text === undefined) return undefined;
  return {
    kind: 'post', key: id, title: [str(author?.name), str(author?.screen_name) ? `@${str(author.screen_name)}` : undefined].filter(Boolean).join(' ') || `Post ${id}`, url: permalink(id, str(author?.screen_name)), excerpt: excerpt(text, POST_EXCERPT),
    meta: ['via TikHub', dated(p.created_at) ?? postDate(id), counted(p.likes ?? p.favorites, 'likes'), counted(p.retweets, 'reposts'), counted(p.replies, 'replies'), counted(p.quotes, 'quotes'), counted(p.views, 'views')].filter(Boolean),
  };
}
function account(u) {
  const handle = str(u.username);
  const m = obj(u.public_metrics) ?? {};
  return {
    kind: 'account', key: `@${handle.toLowerCase()}`, title: who(u), url: `https://x.com/${handle}`, excerpt: str(u.description),
    meta: [counted(m.followers_count, 'followers'), counted(m.post_count ?? m.tweet_count, 'posts'), u.verified === true ? `verified${str(u.verified_type) && u.verified_type !== 'none' ? ` ${u.verified_type}` : ''}` : undefined, u.protected === true ? 'protected' : undefined, str(u.location), str(u.created_at) ? `joined ${dated(u.created_at)}` : undefined].filter(Boolean),
  };
}
function bucket(b) {
  const n = numv(b.post_count) ?? numv(b.tweet_count) ?? 0;
  return { kind: 'bucket', key: str(b.start), title: `${str(b.start).replace('T', ' ').replace(/:00(?:\.000)?Z$/, ' UTC')}: ${plural(n, 'post')}`, meta: [], count: n };
}
function story(s) {
  const posts = objs(s.cluster_posts_results).flatMap(p => str(p.post_id) ?? []);
  return {
    kind: 'story', key: str(s.id) ?? str(s.name), title: str(s.name) ?? `Story ${str(s.id)}`, excerpt: str(s.hook) ?? str(s.summary),
    meta: [str(s.category), dated(s.updated_at ?? s.last_updated_at_ms) ? `updated ${dated(s.updated_at ?? s.last_updated_at_ms)}` : undefined, posts.length ? plural(posts.length, 'post') : undefined].filter(Boolean),
    links: posts.slice(0, STORY_LINKS).map((id, i) => ({ label: `Post ${i + 1}`, url: permalink(id) })),
  };
}
const trend = t => ({ kind: 'trend', key: str(t.trend_name), title: str(t.trend_name), url: `https://x.com/search?q=${encodeURIComponent(str(t.trend_name))}`, meta: [counted(t.tweet_count ?? t.post_count, 'posts')].filter(Boolean) });
function space(s, users) {
  const hosts = strs(s.host_ids).map(id => users.get(id)).filter(Boolean).map(u => `@${str(u.username)}`);
  return {
    kind: 'space', key: str(s.id), title: str(s.title) ?? `Space ${str(s.id)}`, url: `https://x.com/i/spaces/${str(s.id)}`,
    meta: [str(s.state), counted(s.participant_count, 'participants'), dated(s.started_at) ? `started ${dated(s.started_at)}` : dated(s.scheduled_start) ? `scheduled ${dated(s.scheduled_start)}` : undefined, hosts.length ? `hosts ${hosts.join(' ')}` : undefined].filter(Boolean),
  };
}
const community = (c, via) => {
  const id = str(c.id) ?? str(c.community_id);
  return { kind: 'community', key: id ?? str(c.name), title: str(c.name) ?? 'Community', url: id ? `https://x.com/i/communities/${id}` : undefined, excerpt: str(c.description), meta: [via, str(c.access), counted(c.member_count, 'members'), str(c.join_policy)].filter(Boolean) };
};

/** One X API object as a preview item, by the fields that identify its kind. */
function apiItem(d, users) {
  if (str(d.start) && (numv(d.post_count) !== undefined || numv(d.tweet_count) !== undefined)) return bucket(d);
  if (str(d.trend_name)) return trend(d);
  if (str(d.name) && (str(d.summary) || str(d.hook) || Array.isArray(d.cluster_posts_results))) return story(d);
  if (str(d.text) || obj(d.note_post) || obj(d.note_tweet)) return apiPost(d, users);
  if (str(d.state) && str(d.id) && (str(d.title) || numv(d.participant_count) !== undefined)) return space(d, users);
  if (numv(d.member_count) !== undefined || str(d.join_policy)) return community(d);
  if (str(d.username)) return account(d);
  return undefined;
}

/** TikHub's envelopes: one post (x_post's fallback), a Community's posts or details, or Communities found by search. */
function tikhubItems(data) {
  if (obj(data.author) || obj(data.user_info)) return [tikhubPost(data)];
  if (Array.isArray(data.timeline)) return objs(data.timeline).map(tikhubPost);
  if (Array.isArray(data.communities)) return objs(data.communities).map(c => community(c, 'via TikHub'));
  if (str(data.name) && numv(data.member_count) !== undefined) return [community(data, 'via TikHub')];
  return undefined;
}

function readApiItems(call, bodies) {
  const users = new Map();
  for (const body of bodies) for (const u of objs(obj(obj(body)?.includes)?.users)) if (str(u.id)) users.set(str(u.id), u);
  // Communities search signed in may return only each Community's id and name.
  const communities = call.tool === 'x_explore' && call.args.kind === 'communities';
  const items = new Map();
  for (const body of bodies) {
    const b = obj(body);
    if (!b) continue;
    const tikhub = numv(b.code) === 200 && obj(b.data) ? tikhubItems(b.data) : undefined;
    const found = tikhub ?? (Array.isArray(b.data) ? objs(b.data) : obj(b.data) ? [obj(b.data)] : []).map(d => (communities && str(d.id) && str(d.name) ? community(d) : apiItem(d, users)));
    for (const item of found) if (item?.key && !items.has(`${item.kind}:${item.key}`)) items.set(`${item.kind}:${item.key}`, item);
  }
  // Bookmark and like reads also keep the signed-in account and folder listings; only their posts are evidence items.
  const all = [...items.values()];
  return call.tool === 'x_bookmarks' || call.tool === 'x_likes' ? all.filter(item => item.kind === 'post') : all;
}

/** "3 accounts, 12 posts". */
function tally(items) {
  const kinds = new Map();
  for (const item of items) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
  return [...kinds].map(([kind, n]) => plural(n, ...(ITEM_NOUNS[kind] ?? ['item']))).join(', ');
}

function apiAction(call) {
  const a = call.args; const n = numv;
  const asked = [a.thread === true ? 'with thread' : undefined, n(a.replies) ? plural(n(a.replies), 'reply', 'replies') : undefined, n(a.quotes) ? plural(n(a.quotes), 'quote') : undefined, n(a.reposters) ? plural(n(a.reposters), 'reposter') : undefined];
  const when = [a.archive === true ? 'full archive' : 'last 7 days', dateWindow(str(a.start_time), str(a.end_time))];
  switch (call.tool) {
    case 'x_post': { const posts = strs(a.posts); return [posts.length === 1 ? 'read X post' : `read ${plural(posts.length, 'X post')}`, ...(posts.length === 1 ? [posts[0]] : []), ...scope(asked)]; }
    case 'x_search_posts': return ['searched X posts for', ...query(str(a.query)), ...scope([...when, str(a.sort) === 'relevancy' ? 'most relevant first' : undefined])];
    case 'x_count_posts': return ['counted X posts for', ...query(str(a.query)), ...scope([...when, `per ${str(a.granularity) ?? 'day'}`])];
    case 'x_users': return [...(strs(a.handles).length ? ['looked up X accounts', handles(a.handles).join(' ')] : ['searched X accounts for', ...query(str(a.query))]), ...scope([n(a.posts) ? `${plural(n(a.posts), 'recent post')} each` : undefined, n(a.mentions) ? `${plural(n(a.mentions), 'mention')} each` : undefined])];
    case 'x_news': return str(a.id) ? [`read X News story ${str(a.id)}`] : ['searched X News for', ...query(str(a.query)), ...scope([n(a.max_age_hours) ? `last ${plural(n(a.max_age_hours), 'hour')}` : undefined])];
    case 'x_explore': {
      if (a.kind === 'trends') return [`read X trends ${(n(a.woeid) ?? WORLDWIDE_WOEID) === WORLDWIDE_WOEID ? 'worldwide' : `for WOEID ${n(a.woeid)}`}`];
      if (a.kind === 'spaces') return ['searched X Spaces for', ...query(str(a.query)), ...scope([str(a.state) && str(a.state) !== 'all' ? str(a.state) : undefined])];
      if (a.kind === 'communities') return ['searched X Communities for', ...query(str(a.query))];
      return [`read X List ${str(a.list) ?? ''}`.trim()];
    }
    case 'x_bookmarks': return [str(a.folder) ? `read X bookmark folder “${str(a.folder)}”` : 'read X bookmarks', ...scope([n(a.limit) ? `up to ${plural(n(a.limit), 'post')}` : undefined, str(a.match) ? `matching “${str(a.match)}”` : undefined])];
    case 'x_likes': return ['read X liked posts', ...scope([n(a.limit) ? `up to ${plural(n(a.limit), 'post')}` : undefined, str(a.match) ? `matching “${str(a.match)}”` : undefined])];
    case 'x_community': return [`read X Community ${str(a.community) ?? ''}`.trim(), ...scope([n(a.posts) === 0 ? 'details only' : `${plural(n(a.posts) ?? 25, 'post')}`, str(a.sort) === 'relevant' ? 'most relevant first' : undefined])];
    default: return [`called ${call.tool}`];
  }
}

function readXApi(call, bodies) {
  const items = readApiItems(call, bodies);
  const buckets = items.filter(item => item.kind === 'bucket');
  const result = failedCall(call) ? undefined
    : buckets.length ? `${plural(buckets.reduce((sum, b) => sum + b.count, 0), 'post')} counted in ${plural(buckets.length, 'time bucket')}`
      : items.length ? `${tally(items)}${items.some(item => item.meta.includes('via TikHub')) ? ' via TikHub' : ''}` : noItems(call);
  return { action: apiAction(call), result, items };
}

export function readX(call, bodies) {
  if (call.tool !== 'xsearch') return readXApi(call, bodies);
  const a = call.args; const only = handles(a.handles); const not = handles(a.excludeHandles);
  const { posts, fetched } = readPosts(bodies); const cited = posts.length;
  return {
    action: ['searched X for', ...query(str(a.query)), ...scope([dateWindow(str(a.fromDate), str(a.toDate)), str(a.depth) ? `${str(a.depth)} depth` : undefined, only.length ? `only ${only.join(' ')}` : undefined, not.length ? `not ${not.join(' ')}` : undefined, a.enableWebSearch === true ? 'plus the web' : undefined, str(a.previousResponseId) ? 'following up' : undefined])],
    result: failedCall(call) ? undefined : fetched === undefined ? (cited ? `${plural(cited, 'post')} cited` : noItems(call)) : `${plural(fetched, 'post')} read, ${num(cited)} cited`,
    items: posts,
  };
}
