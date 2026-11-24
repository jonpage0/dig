import { compact, num, plural, shortDate } from "../format.ts";
import {
  attempted,
  excerpt,
  failedCall,
  ITEM_NOUNS,
  noItems,
  nonEmpty,
  numv,
  obj,
  objs,
  query,
  scope,
  str,
  strs,
  type ActionPart,
  type EvidenceCall,
  type EvidenceItem,
  type EvidenceResult,
} from "./read.ts";

const POST_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
const ACCOUNT_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/i\/user\/(\d+)/;
const SNOWFLAKE_EPOCH = 1288834974657;
const SNOWFLAKE_SHIFT = 22n;

function postDate(id: string): string | undefined {
  try {
    const ms = Number(BigInt(id) >> SNOWFLAKE_SHIFT) + SNOWFLAKE_EPOCH;
    return Number.isFinite(ms) ? shortDate(new Date(ms).toISOString()) : undefined;
  } catch {
    return undefined;
  }
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };

function day(value: string, back = 0): { label: string; month: string; year: string } | undefined {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() - back);
  return {
    label: date.toLocaleDateString("en-US", DAY_FORMAT),
    month: date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    year: String(date.getUTCFullYear()),
  };
}

function dateWindow(from: string | undefined, to: string | undefined): string | undefined {
  const a = from ? day(from) : undefined;
  const b = to ? day(to, /^\d{4}-\d{2}-\d{2}$/.test(to) ? 1 : 0) : undefined;
  if (a && b) {
    if (a.label === b.label) return a.label;
    if (a.month === b.month && a.year === b.year) return `${a.label}–${b.label.slice(a.month.length + 1)}`;
    return `${a.label} – ${b.label}`;
  }
  if (a) return `since ${a.label}`;
  if (b) return `until ${b.label}`;
  return undefined;
}

const handles = (v: unknown): string[] => strs(v).map((h) => `@${h.replace(/^@/, "")}`);

const METRIC = /(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?\s+(likes?|reposts?|retweets?|views?)\b/g;
const SCALE: Record<string, number> = { k: 1e3, m: 1e6 };
const METRIC_NAMES: Record<string, "likes" | "reposts" | "views"> = {
  like: "likes",
  repost: "reposts",
  retweet: "reposts",
  view: "views",
};

interface GrokMetrics {
  likes?: number;
  reposts?: number;
  views?: number;
}

function readMetrics(segment: string): GrokMetrics {
  const found: GrokMetrics = {};
  for (const m of segment.matchAll(METRIC)) {
    const name = METRIC_NAMES[m[3].toLowerCase().replace(/s$/, "")];
    const n = Number(m[1].replace(/,/g, "")) * (m[2] ? (SCALE[m[2].toLowerCase()] ?? 1) : 1);
    if (name && Number.isFinite(n)) found[name] ??= n;
  }
  return found;
}

interface CitedPost {
  readonly url: string;
  title?: string;
  readonly handle?: string;
  readonly id?: string;
  readonly account?: string;
  at: number[];
}

function postMetrics(answer: string, post: CitedPost, others: readonly number[]): GrokMetrics {
  for (const at of post.at) {
    const lineEnd = answer.indexOf("\n", at) < 0 ? answer.length : answer.indexOf("\n", at);
    const next = others.filter((o) => o > at && o < lineEnd);
    const found = readMetrics(answer.slice(at, next.length ? Math.min(...next) : lineEnd));
    if (Object.keys(found).length) return found;
  }
  return {};
}

function mentions(answer: string, post: CitedPost, annotated: readonly number[]): number[] {
  const at = [...annotated];
  const lower = answer.toLowerCase();
  const find = (needle: string) => {
    for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + 1)) at.push(i);
  };
  if (post.id) find(`status/${post.id}`);
  if (post.handle) find(`@${post.handle.toLowerCase()}`);
  return [...new Set(at)].sort((a, b) => a - b);
}

function readPosts(responseBodies: readonly unknown[]): { posts: EvidenceItem[]; fetched?: number } {
  const cited = new Map<string, CitedPost>();
  const anchors = new Map<string, number[]>();
  let answer = "";
  let fetched: number | undefined;
  const add = (url: string, title?: string) => {
    const known = cited.get(url);
    if (known) {
      known.title ??= title;
      return;
    }
    const match = POST_URL.exec(url);
    cited.set(url, {
      url,
      title,
      handle: match?.[1].toLowerCase() === "i" ? undefined : match?.[1],
      id: match?.[2],
      account: ACCOUNT_URL.exec(url)?.[1],
      at: [],
    });
  };
  for (const body of responseBodies) {
    const response = obj(body);
    if (!response) continue;
    for (const item of objs(response.output)) {
      for (const content of objs(item.content)) {
        const offset = answer.length;
        if (typeof content.text === "string") answer += `${content.text}\n`;
        for (const note of objs(content.annotations)) {
          const url = str(note.url);
          if (note.type !== "url_citation" || !url) continue;
          add(url, str(note.title));
          const start = numv(note.start_index);
          if (start !== undefined && offset + start < answer.length) {
            anchors.set(url, [...(anchors.get(url) ?? []), offset + start]);
          }
        }
      }
    }
    for (const url of strs(response.citations)) add(url);
    const n = numv(obj(response.usage)?.num_sources_used);
    if (n !== undefined) fetched = (fetched ?? 0) + n;
  }
  const list = [...cited.values()];
  for (const post of list) post.at = mentions(answer, post, anchors.get(post.url) ?? []);
  const posts: EvidenceItem[] = list.map((post) => {
    const { url, handle, id, account } = post;
    const preview =
      post.title && !/^\d+$/.test(post.title) && post.title !== url ? post.title : undefined;
    if (account) {
      return { kind: "account", key: account, title: preview ?? `Account ${account}`, url, meta: ["account"] };
    }
    const m = postMetrics(answer, post, list.filter((o) => o !== post).flatMap((o) => o.at));
    return {
      kind: "post",
      key: handle && id ? `${handle.toLowerCase()}/${id}` : (id ?? url),
      title: preview ?? (handle ? `Post by @${handle}` : id ? `Post ${id}` : url.replace(/^https?:\/\//, "")),
      url,
      meta: nonEmpty([
        handle ? `@${handle}` : id ? undefined : "web page",
        id ? postDate(id) : undefined,
        m.likes === undefined ? undefined : `${compact(m.likes)} likes (as stated by Grok)`,
        m.reposts === undefined ? undefined : `${compact(m.reposts)} reposts (as stated by Grok)`,
        m.views === undefined ? undefined : `${compact(m.views)} views (as stated by Grok)`,
      ]),
    };
  });
  return { posts, fetched };
}

const POST_EXCERPT = 1000;
const STORY_LINKS = 10;
const WORLDWIDE_WOEID = 1;
const permalink = (id: string, handle?: string): string => `https://x.com/${handle ?? "i"}/status/${id}`;
const dated = (value: unknown): string | undefined => {
  const s = str(value);
  return s && Number.isFinite(Date.parse(s)) ? shortDate(new Date(s).toISOString()) : undefined;
};
const counted = (value: unknown, noun: string): string | undefined => {
  const n = numv(value);
  return n === undefined ? undefined : `${compact(n)} ${noun}`;
};
const who = (user: Record<string, unknown> | undefined): string | undefined =>
  user
    ? nonEmpty([str(user.name), str(user.username) ? `@${str(user.username)}` : undefined]).join(" ") ||
      undefined
    : undefined;

function apiPost(p: Record<string, unknown>, users: Map<string, Record<string, unknown>>): EvidenceItem | undefined {
  const id = str(p.id);
  const text = str(obj(p.note_post)?.text) ?? str(obj(p.note_tweet)?.text) ?? str(p.text);
  if (!id || text === undefined) return undefined;
  const author = users.get(str(p.author_id) ?? "");
  const m = obj(p.public_metrics) ?? {};
  return {
    kind: "post",
    key: id,
    title: who(author) ?? `Post ${id}`,
    url: permalink(id, str(author?.username)),
    excerpt: excerpt(text, POST_EXCERPT),
    meta: nonEmpty([
      dated(p.created_at) ?? postDate(id),
      counted(m.like_count, "likes"),
      counted(m.repost_count ?? m.retweet_count, "reposts"),
      counted(m.reply_count, "replies"),
      counted(m.quote_count, "quotes"),
      counted(m.impression_count, "views"),
    ]),
  };
}

function scrapecreatorsPost(raw: Record<string, unknown>): EvidenceItem | undefined {
  const p = obj(raw.tweet) ?? raw;
  const legacy = obj(p.legacy) ?? {};
  const url = str(p.url) ?? str(raw.url);
  const urlMatch = url ? POST_URL.exec(url) : null;
  const id =
    str(p.rest_id) ?? str(legacy.id_str) ?? str(p.id_str) ?? str(p.id) ?? urlMatch?.[2];
  const note = obj(obj(obj(p.note_tweet)?.note_tweet_results)?.result);
  const text = str(note?.text) ?? str(legacy.full_text) ?? str(p.full_text) ?? str(p.text);
  if (!id || text === undefined) return undefined;
  const user = obj(obj(obj(p.core)?.user_results)?.result);
  const uCore = obj(user?.core);
  const uLegacy = obj(user?.legacy);
  const urlHandle =
    urlMatch?.[1] && urlMatch[1].toLowerCase() !== "i" ? urlMatch[1] : undefined;
  const handle =
    str(uCore?.screen_name) ?? str(uLegacy?.screen_name) ?? str(user?.screen_name) ?? urlHandle;
  const name = str(uCore?.name) ?? str(uLegacy?.name) ?? str(user?.name);
  return {
    kind: "post",
    key: id,
    title: nonEmpty([name, handle ? `@${handle}` : undefined]).join(" ") || `Post ${id}`,
    url: permalink(id, handle),
    excerpt: excerpt(text, POST_EXCERPT),
    meta: nonEmpty([
      "via ScrapeCreators",
      dated(legacy.created_at ?? p.created_at) ?? postDate(id),
      counted(legacy.favorite_count, "likes"),
      counted(legacy.retweet_count, "reposts"),
      counted(legacy.reply_count, "replies"),
      counted(legacy.quote_count, "quotes"),
      counted(obj(p.views)?.count ?? p.views, "views"),
    ]),
  };
}

function tikhubPost(p: Record<string, unknown>): EvidenceItem | undefined {
  const id = str(p.id) ?? str(p.tweet_id);
  const author = obj(p.author) ?? obj(p.user_info);
  const text = str(p.text) ?? str(p.display_text);
  if (!id || text === undefined) return undefined;
  const screenName = str(author?.screen_name);
  return {
    kind: "post",
    key: id,
    title: nonEmpty([str(author?.name), screenName ? `@${screenName}` : undefined]).join(" ") || `Post ${id}`,
    url: permalink(id, screenName),
    excerpt: excerpt(text, POST_EXCERPT),
    meta: nonEmpty([
      "via TikHub",
      dated(p.created_at) ?? postDate(id),
      counted(p.likes ?? p.favorites, "likes"),
      counted(p.retweets, "reposts"),
      counted(p.replies, "replies"),
      counted(p.quotes, "quotes"),
      counted(p.views, "views"),
    ]),
  };
}

function account(u: Record<string, unknown>): EvidenceItem | undefined {
  const handle = str(u.username);
  if (!handle) return undefined;
  const m = obj(u.public_metrics) ?? {};
  const verifiedType = str(u.verified_type);
  return {
    kind: "account",
    key: `@${handle.toLowerCase()}`,
    title: who(u) ?? `@${handle}`,
    url: `https://x.com/${handle}`,
    excerpt: str(u.description),
    meta: nonEmpty([
      counted(m.followers_count, "followers"),
      counted(m.post_count ?? m.tweet_count, "posts"),
      u.verified === true
        ? `verified${verifiedType && verifiedType !== "none" ? ` ${verifiedType}` : ""}`
        : undefined,
      u.protected === true ? "protected" : undefined,
      str(u.location),
      str(u.created_at) ? `joined ${dated(u.created_at)}` : undefined,
    ]),
  };
}

function bucket(b: Record<string, unknown>): EvidenceItem {
  const n = numv(b.post_count) ?? numv(b.tweet_count) ?? 0;
  const start = str(b.start) ?? "";
  return {
    kind: "bucket",
    key: start,
    title: `${start.replace("T", " ").replace(/:00(?:\.000)?Z$/, " UTC")}: ${plural(n, "post")}`,
    meta: [],
    count: n,
  };
}

function story(s: Record<string, unknown>): EvidenceItem {
  const posts = objs(s.cluster_posts_results).flatMap((p) => {
    const id = str(p.post_id);
    return id ? [id] : [];
  });
  return {
    kind: "story",
    key: str(s.id) ?? str(s.name) ?? "story",
    title: str(s.name) ?? `Story ${str(s.id) ?? ""}`,
    excerpt: str(s.hook) ?? str(s.summary),
    meta: nonEmpty([
      str(s.category),
      dated(s.updated_at) ? `updated ${dated(s.updated_at)}` : undefined,
      posts.length ? plural(posts.length, "post") : undefined,
    ]),
    links: posts.slice(0, STORY_LINKS).map((id, i) => ({ label: `Post ${i + 1}`, url: permalink(id) })),
  };
}

const trend = (t: Record<string, unknown>): EvidenceItem => {
  const name = str(t.trend_name) ?? "";
  return {
    kind: "trend",
    key: name,
    title: name,
    url: `https://x.com/search?q=${encodeURIComponent(name)}`,
    meta: nonEmpty([counted(t.tweet_count ?? t.post_count, "posts")]),
  };
};

function space(s: Record<string, unknown>, users: Map<string, Record<string, unknown>>): EvidenceItem {
  const id = str(s.id) ?? "";
  const hosts = nonEmpty(
    strs(s.host_ids).map((hid) => {
      const u = users.get(hid);
      const uname = str(u?.username);
      return uname ? `@${uname}` : undefined;
    }),
  );
  return {
    kind: "space",
    key: id,
    title: str(s.title) ?? `Space ${id}`,
    url: `https://x.com/i/spaces/${id}`,
    meta: nonEmpty([
      str(s.state),
      counted(s.participant_count, "participants"),
      dated(s.started_at)
        ? `started ${dated(s.started_at)}`
        : dated(s.scheduled_start)
          ? `scheduled ${dated(s.scheduled_start)}`
          : undefined,
      hosts.length ? `hosts ${hosts.join(" ")}` : undefined,
    ]),
  };
}

const community = (c: Record<string, unknown>, via?: string): EvidenceItem => {
  const id = str(c.id) ?? str(c.community_id);
  return {
    kind: "community",
    key: id ?? str(c.name) ?? "community",
    title: str(c.name) ?? "Community",
    url: id ? `https://x.com/i/communities/${id}` : undefined,
    excerpt: str(c.description),
    meta: nonEmpty([via, str(c.access), counted(c.member_count, "members"), str(c.join_policy)]),
  };
};

function apiItem(d: Record<string, unknown>, users: Map<string, Record<string, unknown>>): EvidenceItem | undefined {
  if (str(d.start) && (numv(d.post_count) !== undefined || numv(d.tweet_count) !== undefined)) return bucket(d);
  if (str(d.trend_name)) return trend(d);
  if (str(d.name) && (str(d.summary) || str(d.hook) || Array.isArray(d.cluster_posts_results))) return story(d);
  if (str(d.text) || obj(d.note_post) || obj(d.note_tweet)) return apiPost(d, users);
  if (str(d.state) && str(d.id) && (str(d.title) || numv(d.participant_count) !== undefined)) return space(d, users);
  if (numv(d.member_count) !== undefined || str(d.join_policy)) return community(d);
  if (str(d.username)) return account(d);
  return undefined;
}

function tikhubItems(data: Record<string, unknown>): Array<EvidenceItem | undefined> | undefined {
  if (obj(data.author) || obj(data.user_info)) return [tikhubPost(data)];
  if (Array.isArray(data.timeline)) return objs(data.timeline).map(tikhubPost);
  if (Array.isArray(data.communities)) return objs(data.communities).map((c) => community(c, "via TikHub"));
  if (str(data.name) && numv(data.member_count) !== undefined) return [community(data, "via TikHub")];
  return undefined;
}

function readApiItems(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceItem[] {
  const users = new Map<string, Record<string, unknown>>();
  for (const body of responseBodies) {
    for (const u of objs(obj(obj(body)?.includes)?.users)) {
      const id = str(u.id);
      if (id) users.set(id, u);
    }
  }
  const communities = call.tool === "x_explore" && call.args.kind === "communities";
  const items = new Map<string, EvidenceItem>();
  for (const body of responseBodies) {
    const b = obj(body);
    if (!b) continue;
    const sc =
      call.tool === "x_web_search" && Array.isArray(b.posts)
        ? objs(b.posts).map(scrapecreatorsPost)
        : undefined;
    const tikhubData = obj(b.data);
    const tikhub = !sc && numv(b.code) === 200 && tikhubData ? tikhubItems(tikhubData) : undefined;
    const found =
      sc ??
      tikhub ??
      (Array.isArray(b.data) ? objs(b.data) : tikhubData ? [tikhubData] : []).map((d) =>
        communities && str(d.id) && str(d.name) ? community(d) : apiItem(d, users),
      );
    for (const item of found) {
      if (item?.key && !items.has(`${item.kind}:${item.key}`)) {
        items.set(`${item.kind}:${item.key}`, item);
      }
    }
  }
  const all = [...items.values()];
  if (call.tool === "x_follows") {
    const target = `@${(str(call.args.handle) ?? "").replace(/^@/, "").toLowerCase()}`;
    return all.filter((item) => item.key !== target);
  }
  return call.tool === "x_bookmarks" || call.tool === "x_likes"
    ? all.filter((item) => item.kind === "post")
    : all;
}

function tally(items: readonly EvidenceItem[]): string {
  const kinds = new Map<string, number>();
  for (const item of items) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
  return [...kinds]
    .map(([kind, count]) => {
      const noun = ITEM_NOUNS[kind] ?? ["item", "items"];
      return plural(count, noun[0], noun[1]);
    })
    .join(", ");
}

function apiAction(call: EvidenceCall): ActionPart[] {
  const a = call.args;
  const n = numv;
  const replies = n(a.replies);
  const quotes = n(a.quotes);
  const reposters = n(a.reposters);
  const asked = [
    a.thread === true ? "with thread" : undefined,
    replies ? plural(replies, "reply", "replies") : undefined,
    quotes ? plural(quotes, "quote") : undefined,
    reposters ? plural(reposters, "reposter") : undefined,
  ];
  const when = [
    a.archive === true ? "full archive" : "last 7 days",
    dateWindow(str(a.start_time), str(a.end_time)),
  ];
  switch (call.tool) {
    case "x_post": {
      const posts = strs(a.posts);
      return [
        posts.length === 1 ? "read X post" : `read ${plural(posts.length, "X post")}`,
        ...(posts.length === 1 ? [posts[0]] : []),
        ...scope(asked),
      ];
    }
    case "x_search_posts":
      return [
        "searched X posts for",
        ...query(str(a.query)),
        ...scope([...when, str(a.sort) === "relevancy" ? "most relevant first" : undefined]),
      ];
    case "x_web_search":
      return [
        "searched X web index for",
        ...query(str(a.query)),
        ...scope([str(a.cursor) ? `page ${str(a.cursor)}` : undefined]),
      ];
    case "x_count_posts":
      return [
        "counted X posts for",
        ...query(str(a.query)),
        ...scope([...when, `per ${str(a.granularity) ?? "day"}`]),
      ];
    case "x_users": {
      const posts = n(a.posts);
      const mentionsCount = n(a.mentions);
      return [
        ...(strs(a.handles).length
          ? ["looked up X accounts", handles(a.handles).join(" ")]
          : ["searched X accounts for", ...query(str(a.query))]),
        ...scope([
          posts ? `${plural(posts, "recent post")} each` : undefined,
          mentionsCount ? `${plural(mentionsCount, "mention")} each` : undefined,
        ]),
      ];
    }
    case "x_follows": {
      const whoStr = handles([str(a.handle) ?? ""]).join("");
      const limit = n(a.limit);
      return [
        a.direction === "followers"
          ? `listed accounts following ${whoStr}`
          : `listed accounts ${whoStr} follows`,
        ...scope([limit ? `up to ${plural(limit, "account")}` : undefined, str(a.cursor) ? "next page" : undefined]),
      ];
    }
    case "x_news": {
      const age = n(a.max_age_hours);
      return str(a.id)
        ? [`read X News story ${str(a.id)}`]
        : [
            "searched X News for",
            ...query(str(a.query)),
            ...scope([age ? `last ${plural(age, "hour")}` : undefined]),
          ];
    }
    case "x_explore": {
      const woeid = n(a.woeid) ?? WORLDWIDE_WOEID;
      if (a.kind === "trends") {
        return [`read X trends ${woeid === WORLDWIDE_WOEID ? "worldwide" : `for WOEID ${woeid}`}`];
      }
      if (a.kind === "spaces") {
        return [
          "searched X Spaces for",
          ...query(str(a.query)),
          ...scope([str(a.state) && str(a.state) !== "all" ? str(a.state) : undefined]),
        ];
      }
      if (a.kind === "communities") return ["searched X Communities for", ...query(str(a.query))];
      return [`read X List ${str(a.list) ?? ""}`.trim()];
    }
    case "x_bookmarks": {
      const limit = n(a.limit);
      return [
        str(a.folder) ? `read X bookmark folder “${str(a.folder)}”` : "read X bookmarks",
        ...scope([
          limit ? `up to ${plural(limit, "post")}` : undefined,
          str(a.match) ? `matching “${str(a.match)}”` : undefined,
        ]),
      ];
    }
    case "x_likes": {
      const limit = n(a.limit);
      return [
        "read X liked posts",
        ...scope([
          limit ? `up to ${plural(limit, "post")}` : undefined,
          str(a.match) ? `matching “${str(a.match)}”` : undefined,
        ]),
      ];
    }
    case "x_community": {
      const posts = n(a.posts);
      return [
        `read X Community ${str(a.community) ?? ""}`.trim(),
        ...scope([
          posts === 0 ? "details only" : `${plural(posts ?? 25, "post")}`,
          str(a.sort) === "relevant" ? "most relevant first" : undefined,
        ]),
      ];
    }
    default:
      return [`called ${call.tool}`];
  }
}

function readXApi(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  const items = readApiItems(call, responseBodies);
  const buckets = items.filter((item) => item.kind === "bucket");
  const via = items.some((item) => item.meta.includes("via ScrapeCreators"))
    ? " via ScrapeCreators"
    : items.some((item) => item.meta.includes("via TikHub"))
      ? " via TikHub"
      : "";
  const result = failedCall(call)
    ? undefined
    : buckets.length
      ? `${plural(
          buckets.reduce((sum, b) => sum + (b.count ?? 0), 0),
          "post",
        )} counted in ${plural(buckets.length, "time bucket")}`
      : items.length
        ? `${tally(items)}${via}`
        : noItems(call);
  return { action: apiAction(call), result, items };
}

const PICTURE_NOTE = /^\[picture not retained\] (\S+) · ([^·]+) · ([^·]+) · (.+)$/;

function readImages(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  const notes = responseBodies
    .map((body) => (typeof body === "string" ? PICTURE_NOTE.exec(body) : null))
    .filter((m): m is RegExpExecArray => Boolean(m));
  const items: EvidenceItem[] = notes.map(([, url, type, size, res]) => ({
    kind: "image",
    key: url,
    title: url.split("?")[0].split("/").at(-1) || url,
    url,
    meta: [res, type, size],
  }));
  const shown = notes.filter((note) => note[4] === "shown").length;
  return {
    action: [
      attempted(call.status, "looked at", "look at"),
      plural(strs(call.args.images).length, "X picture"),
      ...scope([str(call.args.size)]),
    ],
    result: failedCall(call)
      ? undefined
      : notes.length
        ? `${num(shown)} of ${plural(notes.length, "picture")} shown; pictures are not retained`
        : noItems(call),
    items,
  };
}

export function readX(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  if (call.tool === "x_images") return readImages(call, responseBodies);
  if (call.tool !== "xsearch") return readXApi(call, responseBodies);
  const a = call.args;
  const only = handles(a.handles);
  const not = handles(a.excludeHandles);
  const { posts, fetched } = readPosts(responseBodies);
  const cited = posts.length;
  return {
    action: [
      "searched X for",
      ...query(str(a.query)),
      ...scope([
        dateWindow(str(a.fromDate), str(a.toDate)),
        str(a.mode) === "semantic" ? "semantic only" : undefined,
        str(a.depth) ? `${str(a.depth)} depth` : undefined,
        only.length ? `only ${only.join(" ")}` : undefined,
        not.length ? `not ${not.join(" ")}` : undefined,
        a.enableWebSearch === true ? "plus the web" : undefined,
        str(a.previousResponseId) ? "following up" : undefined,
      ]),
    ],
    result: failedCall(call)
      ? undefined
      : fetched === undefined
        ? cited
          ? `${plural(cited, "post")} cited`
          : noItems(call)
        : `${plural(fetched, "post")} read, ${num(cited)} cited`,
    items: posts,
  };
}
