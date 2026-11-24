import { compact, plural, shortDate } from "../format.ts";
import {
  excerpt,
  failedCall,
  noItems,
  nonEmpty,
  numv,
  obj,
  objs,
  query,
  scope,
  str,
  type EvidenceCall,
  type EvidenceContext,
  type EvidenceItem,
  type EvidenceResult,
} from "./read.ts";

const TEXT_EXCERPT = 200;
const LIST_KEYS = ["posts", "comments", "videos", "items", "data", "results", "threads"];

function community(p: Record<string, unknown>): string | undefined {
  const sub = p.subreddit;
  const name =
    str(obj(sub)?.name) ??
    str(obj(sub)?.display_name) ??
    str(sub) ??
    str(p.subreddit_name_prefixed) ??
    str(p.channel);
  return name ? (name.startsWith("r/") || !("subreddit" in p) ? name : `r/${name}`) : undefined;
}

function link(p: Record<string, unknown>): string | undefined {
  const permalink = str(p.permalink);
  if (permalink?.startsWith("/r/")) return `https://www.reddit.com${permalink}`;
  return permalink ?? str(p.url) ?? str(p.share_url) ?? str(p.link);
}

function when(p: Record<string, unknown>): string | undefined {
  const iso = str(p.created_at_iso) ?? str(p.created_at) ?? str(p.date);
  if (iso && !/^\d+(\.\d+)?$/.test(iso)) return iso;
  const secs = numv(p.created_utc) ?? numv(p.create_time) ?? numv(p.created_at);
  return secs ? new Date(secs * 1000).toISOString() : undefined;
}

function post(p: Record<string, unknown>, kind = "post"): EvidenceItem | undefined {
  const text =
    str(p.title) ?? str(p.body) ?? str(p.text) ?? str(p.desc) ?? str(p.caption) ?? str(p.description);
  if (!text) return undefined;
  const url = link(p);
  const score = numv(p.score) ?? numv(p.ups) ?? numv(p.like_count) ?? numv(p.digg_count);
  const replies = numv(p.num_comments) ?? numv(p.comment_count);
  const at = when(p);
  return {
    kind,
    key: str(p.id) ?? str(p.post_id) ?? str(p.name) ?? url ?? text,
    title: excerpt(text, TEXT_EXCERPT),
    url,
    meta: nonEmpty([
      community(p),
      str(p.author) ?? str(obj(p.author)?.username) ?? str(p.username),
      score === undefined ? undefined : `${compact(score)} points`,
      replies === undefined ? undefined : `${compact(replies)} replies`,
      at ? shortDate(at) : undefined,
    ]),
  };
}

interface MainSelector {
  readonly key: string;
  readonly row: (p: Record<string, unknown>) => EvidenceItem | undefined;
}

const commentsSelector = (call: EvidenceCall): MainSelector | undefined =>
  ["tiktok_comments", "instagram_comments"].includes(call.tool) ||
  (["tiktok_read", "instagram_read"].includes(call.tool) && call.args.kind === "replies")
    ? { key: "comments", row: (p) => post(p, "comment") }
    : undefined;

const counted = (n: number | undefined, word: string): string | undefined =>
  n === undefined ? undefined : `${compact(n)} ${word}`;

function row(
  text: string | undefined,
  url: string | undefined,
  key: string | undefined,
  meta: readonly (string | undefined)[],
): EvidenceItem | undefined {
  return text
    ? {
        kind: "post",
        key: key ?? url ?? text,
        title: excerpt(text, TEXT_EXCERPT),
        url,
        meta: nonEmpty(meta),
      }
    : undefined;
}

function linkedinPost(p: Record<string, unknown>): EvidenceItem | undefined {
  const at = str(p.datePublished);
  return row(str(p.description) ?? str(p.text), str(p.url), str(p.id), [
    str(obj(p.author)?.name),
    counted(numv(p.likeCount), "likes"),
    counted(numv(p.commentCount), "comments"),
    at ? shortDate(at) : undefined,
  ]);
}

function telegramPost(p: Record<string, unknown>): EvidenceItem | undefined {
  const at = str(p.published_at);
  return row(str(p.text), str(p.url), str(p.id), [
    str(p.author_name),
    counted(numv(p.view_count), "views"),
    counted(numv(p.reaction_count), "reactions"),
    at ? shortDate(at) : undefined,
  ]);
}

const MAIN: Record<string, (call: EvidenceCall) => MainSelector | undefined> = {
  tiktok: commentsSelector,
  instagram: commentsSelector,
  linkedin: (call) =>
    call.tool === "scrapecreators_linkedin" &&
    (call.args.kind === "search" || call.args.kind === "company_posts")
      ? { key: "posts", row: linkedinPost }
      : undefined,
  telegram: (call) =>
    call.tool === "scrapecreators_telegram" && call.args.kind === "posts"
      ? { key: "posts", row: telegramPost }
      : undefined,
};

function plain(call: EvidenceCall): EvidenceResult {
  const q = str(call.args.query) ?? str(call.args.question) ?? str(call.args.url);
  const rest = Object.entries(call.args)
    .filter(
      ([key, value]) =>
        value !== undefined && value !== null && value !== "" && str(value) !== q && key !== "query",
    )
    .slice(0, 3)
    .map(([key, value]) => `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return {
    action: [
      `called ${call.tool}`,
      ...(q ? ["for", ...query(q)] : []),
      ...(rest.length ? [`(${rest.join(", ")})`] : []),
    ],
    items: [],
  };
}

function readMain(
  call: EvidenceCall,
  responseBodies: readonly unknown[],
  context: EvidenceContext,
  main: MainSelector | undefined,
): EvidenceResult {
  if (!main) return plain(call);
  const rows = new Map<string, EvidenceItem>();
  for (const body of responseBodies) {
    for (const item of objs(obj(body)?.[main.key])) {
      const found = main.row(item);
      if (found && !rows.has(found.key)) rows.set(found.key, found);
    }
  }
  const q = str(call.args.query);
  const items = [...rows.values()];
  return {
    action: q ? [`searched ${context.label(call.source)} for`, ...query(q)] : plain(call).action,
    result: failedCall(call) ? undefined : items.length ? plural(items.length, items[0].kind) : noItems(call),
    items,
  };
}

export function readSocial(
  call: EvidenceCall,
  responseBodies: readonly unknown[],
  context: EvidenceContext,
): EvidenceResult {
  if (Object.hasOwn(MAIN, call.source)) {
    return readMain(call, responseBodies, context, MAIN[call.source](call));
  }
  const posts = new Map<string, EvidenceItem>();
  for (const body of responseBodies) {
    const b = obj(body);
    if (!b) continue;
    const singleObj = obj(b.post);
    const single = singleObj ? post(singleObj) : undefined;
    if (single) posts.set(single.key, single);
    for (const key of LIST_KEYS) {
      for (const item of objs(b[key])) {
        const found = post(item);
        if (found && !posts.has(found.key)) posts.set(found.key, found);
      }
    }
  }
  const a = call.args;
  const q = str(a.query) ?? str(a.keyword) ?? str(a.handle) ?? str(a.url);
  return {
    action: [
      q ? `searched ${context.label(call.source)} for` : `called ${call.tool}`,
      ...query(q),
      ...scope([
        str(a.sort) && str(a.sort) !== "relevance" ? str(a.sort) : undefined,
        str(a.timeframe) ? `past ${str(a.timeframe)}` : undefined,
      ]),
    ],
    result: failedCall(call) ? undefined : posts.size ? plural(posts.size, "post") : noItems(call),
    items: [...posts.values()],
  };
}
