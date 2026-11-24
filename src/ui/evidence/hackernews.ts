import { hostname, num, plural, shortDate } from "../format.ts";
import {
  attempted,
  excerpt,
  failedCall,
  htmlText,
  noItems,
  nonEmpty,
  numv,
  obj,
  objs,
  query,
  scope,
  str,
  type EvidenceCall,
  type EvidenceItem,
  type EvidenceResult,
} from "./read.ts";

const ITEM_URL = "https://news.ycombinator.com/item?id=";
const COMMENT_EXCERPT = 280;
const TYPE_LABEL: Record<string, string> = { story: "stories", comment: "comments" };

const countComments = (item: Record<string, unknown>): number =>
  objs(item.children).reduce((n, child) => n + (str(child.text) ? 1 : 0) + countComments(child), 0);

function story(hit: Record<string, unknown>, id: string): { points: number; item: EvidenceItem } {
  const url = str(hit.url);
  const points = numv(hit.points);
  const comments = numv(hit.num_comments);
  const created = str(hit.created_at) ? shortDate(str(hit.created_at)) : undefined;
  return {
    points: points ?? 0,
    item: {
      kind: "story",
      key: id,
      title: str(hit.title) ?? `Item ${id}`,
      url: `${ITEM_URL}${id}`,
      meta: nonEmpty([
        str(hit.author),
        created,
        points === undefined ? undefined : plural(points, "point"),
        comments === undefined ? undefined : plural(comments, "comment"),
        url ? hostname(url) : undefined,
      ]),
      links: url ? [{ label: "Linked page", url }] : [],
    },
  };
}

function comment(
  id: string,
  text: string,
  author: string | undefined,
  on: string | undefined,
  created: string | undefined,
): EvidenceItem {
  return {
    kind: "comment",
    key: id,
    title: excerpt(htmlText(text), COMMENT_EXCERPT),
    url: `${ITEM_URL}${id}`,
    meta: nonEmpty([author, created ? shortDate(created) : undefined, on ? `on “${on}”` : undefined]),
  };
}

function readItem(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  const root = responseBodies.map(obj).find((b) => b && Array.isArray(b.children));
  const id = str(root?.id) ?? str(call.args.item) ?? "?";
  const item = !root
    ? undefined
    : str(root.title)
      ? story(root, id).item
      : str(root.text)
        ? comment(id, str(root.text)!, str(root.author), undefined, str(root.created_at))
        : undefined;
  return {
    action: [attempted(call.status, "read", "read"), `Hacker News item ${id}`],
    result: failedCall(call) ? undefined : root ? plural(countComments(root), "comment") : noItems(call),
    items: item ? [item] : [],
  };
}

export function readHackerNews(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  if (call.tool === "hackernews_read") return readItem(call, responseBodies);
  const stories = new Map<string, { points: number; item: EvidenceItem }>();
  const comments = new Map<string, EvidenceItem>();
  const threads = new Set<string>();
  let matches: number | undefined;
  for (const body of responseBodies) {
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
    const id = str(b.id);
    if (!id || !Array.isArray(b.children)) continue;
    threads.add(id);
    if (!stories.has(id) && str(b.title)) stories.set(id, story(b, id));
  }
  for (const id of threads) stories.get(id)?.item.meta.push("thread read");
  const a = call.args;
  const type = str(a.type);
  const days = numv(a.days);
  const found = [...stories.values()].sort((x, y) => y.points - x.points).map((s) => s.item);
  const shown = type === "comment" ? comments.size : stories.size;
  const noun: readonly [string, string] =
    type === "comment" ? ["comment", "comments"] : ["story", "stories"];
  const parts = nonEmpty([
    shown || matches
      ? matches !== undefined && matches > shown
        ? `${num(shown)} of ${plural(matches, noun[0], noun[1])}`
        : plural(shown, noun[0], noun[1])
      : undefined,
    threads.size ? `${plural(threads.size, "thread")} read` : undefined,
  ]);
  return {
    action: [
      "searched Hacker News for",
      ...query(str(a.query)),
      ...scope([
        type && type !== "all" ? (TYPE_LABEL[type] ?? type) : undefined,
        days ? `last ${plural(days, "day")}` : undefined,
        str(a.sort) === "date" ? "newest first" : undefined,
      ]),
    ],
    result: failedCall(call) ? undefined : parts.length ? parts.join(", ") : noItems(call),
    items: [...found, ...comments.values()],
  };
}
