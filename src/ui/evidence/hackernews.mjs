// Hacker News: an Algolia search plus, for the top stories, item fetches that return the whole comment tree.
// Adapted from Dig's dashboard/ui/evidence/hackernews.ts (MIT, same author).
import { hostname, num, plural, shortDate } from '../format.mjs';
import { excerpt, failedCall, htmlText, noItems, numv, obj, objs, query, scope, str } from './read.mjs';

const ITEM_URL = 'https://news.ycombinator.com/item?id=';
const COMMENT_EXCERPT = 280;
const TYPE_LABEL = { story: 'stories', comment: 'comments', ask_hn: 'Ask HN', show_hn: 'Show HN' };

/** Every comment under an item, however deep. */
const countComments = item => objs(item.children).reduce((n, child) => n + (str(child.text) ? 1 : 0) + countComments(child), 0);

function story(hit, id) {
  const url = str(hit.url); const points = numv(hit.points); const comments = numv(hit.num_comments);
  const created = str(hit.created_at) ? shortDate(str(hit.created_at)) : undefined;
  return {
    points: points ?? 0,
    item: {
      kind: 'story', key: id, title: str(hit.title) ?? `Item ${id}`, url: `${ITEM_URL}${id}`,
      meta: [str(hit.author), created, points === undefined ? undefined : plural(points, 'point'), comments === undefined ? undefined : plural(comments, 'comment'), url ? hostname(url) : undefined].filter(Boolean),
      links: url ? [{ label: 'Linked page', url }] : [],
    },
  };
}
function comment(id, text, author, on, created) {
  return { kind: 'comment', key: id, title: excerpt(htmlText(text), COMMENT_EXCERPT), url: `${ITEM_URL}${id}`, meta: [author, created ? shortDate(created) : undefined, on ? `on “${on}”` : undefined].filter(Boolean) };
}

export function readHackerNews(call, bodies) {
  const stories = new Map(); const comments = new Map(); const threads = new Map(); let matches;
  for (const body of bodies) {
    const b = obj(body);
    if (!b) continue;
    if (Array.isArray(b.hits)) {
      matches ??= numv(b.nbHits);
      for (const hit of objs(b.hits)) {
        const id = str(hit.objectID);
        if (!id) continue;
        const text = str(hit.comment_text);
        if (text) comments.set(id, comment(id, text, str(hit.author), str(hit.story_title), str(hit.created_at)));
        else if (str(hit.title)) stories.set(id, story(hit, id));
      }
      continue;
    }
    // An item fetch: a story with its whole comment tree.
    const id = str(b.id);
    if (!id || !Array.isArray(b.children)) continue;
    threads.set(id, countComments(b));
    if (!stories.has(id) && str(b.title)) stories.set(id, story(b, id));
  }
  for (const id of threads.keys()) stories.get(id)?.item.meta.push('thread read');
  const a = call.args; const type = str(a.type); const days = numv(a.days);
  const found = [...stories.values()].sort((x, y) => y.points - x.points).map(s => s.item);
  const shown = type === 'comment' ? comments.size : stories.size;
  const noun = type === 'comment' ? ['comment', 'comments'] : ['story', 'stories'];
  const parts = [
    shown || matches ? (matches !== undefined && matches > shown ? `${num(shown)} of ${plural(matches, noun[0], noun[1])}` : plural(shown, noun[0], noun[1])) : undefined,
    threads.size ? `${plural(threads.size, 'thread')} read` : undefined,
  ].filter(Boolean);
  return {
    action: ['searched Hacker News for', ...query(str(a.query)), ...scope([type && type !== 'all' ? (TYPE_LABEL[type] ?? type) : undefined, days ? `last ${plural(days, 'day')}` : undefined, str(a.sort) === 'date' ? 'newest first' : undefined])],
    result: failedCall(call) ? undefined : parts.length ? parts.join(', ') : noItems(call),
    items: [...found, ...comments.values()],
  };
}
