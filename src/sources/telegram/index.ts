/**
 * Public Telegram source plugin backed by ScrapeCreators (`PaidHttp`).
 *
 * Reads public channels, channel posts, and individual posts via Telegram's public web preview:
 * - kind='channel' -> GET /v1/telegram/channel
 * - kind='posts'   -> GET /v1/telegram/channel/posts
 * - kind='post'    -> GET /v1/telegram/post
 */
import { Effect, Schema } from "effect";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  type SourcePlugin,
} from "../../core/plugin.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  CACHE_MAX_AGE_VALUES,
  cleanText,
  continuesAfter,
  displayLimit,
  expectArray,
  failText,
  fmtNum,
  knownCharge,
  MISSING_SCRAPECREATORS_KEY,
  provenanceLine,
  SCRAPECREATORS_BILLING,
  SCRAPECREATORS_PROVIDER,
  scrapecreatorsBilling,
  scrapecreatorsHeaders,
  scrapecreatorsRequest,
  truncate,
  validateEnum,
} from "../shared/scrapecreators.ts";

const TELEGRAM_KIND_VALUES = ["channel", "posts", "post"] as const;
const TELEGRAM_HANDLE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,}$/;
const MAX_LIMIT = 40;

function unreadableLine(count: number, kind: string): string {
  return `Unreadable entries: ${count} returned entr${count === 1 ? "y" : "ies"} lacked a readable ${kind} record and ${count === 1 ? "was" : "were"} skipped.`;
}

function normalizeTelegramHandle(value: string): { readonly handle: string } | { readonly error: string } {
  let raw = value.trim();
  const asUrl = raw.includes("/") ? raw : null;
  if (asUrl) {
    let parsed: URL;
    try {
      parsed = new URL(/^https?:\/\//i.test(asUrl) ? asUrl : `https://${asUrl}`);
    } catch {
      return { error: "handle must be a public Telegram handle, @handle, or t.me channel URL." };
    }
    if (!/^(t\.me|telegram\.me|telegram\.dog)$/i.test(parsed.hostname)) {
      return { error: "Telegram URLs must be on t.me." };
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] === "s") segments.shift();
    raw = segments[0] ?? "";
  }
  if (raw.startsWith("@")) raw = raw.slice(1);
  if (raw.startsWith("+") || /^joinchat$/i.test(raw)) {
    return {
      error:
        "private or invite-only Telegram channels and groups are not supported; only public handles with a web preview work.",
    };
  }
  if (/^\d+$/.test(raw)) {
    return { error: "numeric Telegram ids are not supported; use the public handle." };
  }
  if (!TELEGRAM_HANDLE_PATTERN.test(raw)) {
    return {
      error:
        "handle must be a public Telegram handle (letters, digits, underscores), @handle, or t.me channel URL.",
    };
  }
  return { handle: raw };
}

function normalizeTelegramPostUrl(value: string): { readonly url: string } | { readonly error: string } {
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  } catch {
    return { error: "url must be a public Telegram post URL such as https://t.me/durov/543." };
  }
  if (!/^(t\.me|telegram\.me|telegram\.dog)$/i.test(parsed.hostname)) {
    return { error: "Telegram post URLs must be on t.me." };
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] === "s") segments.shift();
  const [handle, postId] = segments;
  if (!handle || handle.startsWith("+") || /^joinchat$/i.test(handle)) {
    return { error: "private or invite-only Telegram posts are not supported." };
  }
  if (!TELEGRAM_HANDLE_PATTERN.test(handle) || !postId || !/^\d+$/.test(postId)) {
    return {
      error: "url must be a public Telegram post URL of the form https://t.me/<handle>/<post id>.",
    };
  }
  return { url: `https://t.me/${handle}/${postId}` };
}

function telegramChannelLines(channel: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const name = cleanText(channel.name) ?? "(name unavailable)";
  const handle = asString(channel.handle);
  lines.push(
    `Channel: ${name}${handle ? ` (@${handle})` : ""}${channel.is_verified === true ? " — verified" : ""}`,
  );
  if (asString(channel.url)) lines.push(`URL: ${asString(channel.url)}`);
  const subscribers = asNumber(channel.subscriber_count);
  const members = asNumber(channel.member_count);
  const audience: string[] = [];
  if (subscribers !== null) {
    audience.push(
      `${fmtNum(subscribers)} subscribers${asString(channel.subscriber_count_text) ? ` (${asString(channel.subscriber_count_text)})` : ""}`,
    );
  }
  if (members !== null) {
    audience.push(
      `${fmtNum(members)} members${asString(channel.member_count_text) ? ` (${asString(channel.member_count_text)})` : ""}`,
    );
  }
  lines.push(`Audience: ${audience.length ? audience.join(" | ") : "not exposed by the public preview"}`);
  const counters = (["photo_count", "video_count", "file_count", "link_count"] as const)
    .map((key) => {
      const count = asNumber(channel[key]);
      return count === null ? null : `${key.replace("_count", "s")}: ${fmtNum(count)}`;
    })
    .filter((value): value is string => value !== null);
  if (counters.length) lines.push(`Public media counters: ${counters.join(" | ")}`);
  if (cleanText(channel.description)) {
    lines.push(`Description: ${truncate(cleanText(channel.description), 500)}`);
  }
  return lines;
}

function telegramPostLines(post: Record<string, unknown>, index: number | null): string[] {
  const lines: string[] = [];
  const id = asString(post.id) ?? (asNumber(post.id) !== null ? String(post.id) : null);
  const prefix = index === null ? "" : `${index + 1}. `;
  const author = cleanText(post.author_name);
  lines.push(
    `${prefix}${author ? `${author} — ` : ""}${truncate(cleanText(post.text), 300) || "(no text; media-only or unavailable in the preview)"}`,
  );
  const views = asNumber(post.view_count);
  const reactionTotal = asNumber(post.reaction_count);
  const reactions = asArray(post.reactions)
    .map((entry) => {
      const reaction = asRecord(entry);
      const count = asNumber(reaction?.count);
      if (count === null) return null;
      const label =
        asString(reaction?.emoji) ??
        (asString(reaction?.emoji_id) ? `custom emoji ${asString(reaction?.emoji_id)}` : "reaction");
      return `${label} ${fmtNum(count)}`;
    })
    .filter((value): value is string => value !== null)
    .slice(0, 6);
  const indent = index === null ? "" : "   ";
  lines.push(
    `${indent}Published: ${asString(post.published_at) ?? "unknown"} | Views: ${views !== null ? fmtNum(views) : "not exposed"} | Reactions: ${reactionTotal !== null ? fmtNum(reactionTotal) : "not exposed"}${reactions.length ? ` (${reactions.join(", ")})` : ""}`,
  );
  if (asString(post.url)) lines.push(`${indent}URL: ${asString(post.url)}${id ? ` (post ${id})` : ""}`);
  const forwarded = asRecord(post.forwarded_from);
  if (forwarded) {
    const from =
      cleanText(forwarded.name) ??
      cleanText(forwarded.author_name) ??
      asString(forwarded.handle) ??
      asString(forwarded.url);
    if (from) {
      lines.push(
        `${indent}Forwarded from: ${from}${asString(forwarded.url) && asString(forwarded.url) !== from ? ` (${asString(forwarded.url)})` : ""}`,
      );
    }
  } else if (typeof post.forwarded_from === "string" && post.forwarded_from.trim()) {
    lines.push(`${indent}Forwarded from: ${post.forwarded_from.trim()}`);
  }
  const media = asArray(post.media);
  if (media.length) {
    const kinds = media.map((entry) => asString(asRecord(entry)?.type) ?? "media");
    lines.push(
      `${indent}Media: ${media.length} item${media.length === 1 ? "" : "s"} (${kinds.join(", ")}); previews only, downloadable URLs may be absent`,
    );
  }
  const preview = asRecord(post.link_preview);
  if (preview) {
    const title = cleanText(preview.title) ?? cleanText(preview.site_name);
    const link = asString(preview.url);
    if (title || link) {
      lines.push(`${indent}Link preview: ${title ?? ""}${title && link ? " — " : ""}${link ?? ""}`);
    }
  }
  return lines;
}

const TelegramSchema = Schema.Struct({
  kind: Schema.Literals(TELEGRAM_KIND_VALUES).annotate({
    description: "channel details, one page of channel posts, or one public post.",
  }),
  handle: Schema.optionalKey(Schema.String).annotate({
    description:
      "kind='channel' or 'posts'. Public handle, @handle, or t.me channel URL. Private/invite-only channels are unsupported.",
  }),
  url: Schema.optionalKey(Schema.String).annotate({
    description: "kind='post'. Public post URL such as https://t.me/durov/543.",
  }),
  cursor: Schema.optionalKey(Schema.String).annotate({
    description: "kind='posts'. Numeric cursor from the previous page; omit for the latest posts.",
  }),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT })),
  ).annotate({
    description:
      "kind='posts'. Max posts to display from the page (default: every post returned; max: 40). Does not reduce what is fetched or billed.",
  }),
  cache_max_age: Schema.optionalKey(Schema.Literals(CACHE_MAX_AGE_VALUES)).annotate({
    description: "Accept a cached response this old or newer; cache hits cost 0 credits.",
  }),
});

export const telegramAction = defineAction({
  name: "scrapecreators_telegram",
  description:
    "Read public Telegram channels and groups via ScrapeCreators using Telegram's public web preview (no Telegram account or login). " +
    "kind='channel': name, description, verification, subscriber/member counts, media counters. kind='posts': one page of public posts (text, date, views, reactions when exposed, forwards, media previews, link previews) with a cursor for older pages. " +
    "kind='post': one public post by URL. Private and invite-only channels, groups, and posts are not supported. Requires SCRAPECREATORS_API_KEY; 1 credit per request, cache hits free with cache_max_age.",
  schema: TelegramSchema,
  billing: scrapecreatorsBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const headers = scrapecreatorsHeaders();
      if (!headers) return failed(MISSING_SCRAPECREATORS_KEY);
      const invalid =
        validateEnum("kind", args.kind, TELEGRAM_KIND_VALUES) ??
        validateEnum("cache_max_age", args.cache_max_age, CACHE_MAX_AGE_VALUES);
      if (invalid) return failed(invalid);
      const kind = args.kind;
      const cacheMaxAge = args.cache_max_age;

      if (kind === "post") {
        if (args.handle !== undefined) {
          return failed("handle applies to kind='channel' or 'posts'; kind='post' takes url.");
        }
        if (args.cursor !== undefined || args.limit !== undefined) {
          return failed("cursor and limit apply to kind='posts' only.");
        }
        if (!args.url?.trim()) return failed("url is required for kind='post'.");
        const normalized = normalizeTelegramPostUrl(args.url);
        if ("error" in normalized) return failed(normalized.error);
        const response = yield* scrapecreatorsRequest(
          "/v1/telegram/post",
          { url: normalized.url, cache_max_age: cacheMaxAge },
          headers,
          ctx,
          "ScrapeCreators Telegram post",
        );
        if (!response.ok) {
          return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
        }
        const lines = [
          `Telegram post: ${normalized.url}`,
          "Source: Telegram public post widget; fields Telegram does not expose are reported as such.",
          provenanceLine(response.payload, response.charges),
          "",
          ...telegramPostLines(response.payload, null),
        ];
        return outcome("success", lines.join("\n"), {
          provider: "scrapecreators",
          kind,
          url: normalized.url,
          post_id: asString(response.payload.id),
          channel_handle: asString(response.payload.channel_handle),
          cached: response.payload.cached === true,
          credits_charged: knownCharge(response.charges),
        });
      }

      if (args.url !== undefined) return failed("url applies to kind='post'; use handle for channels.");
      if (!args.handle?.trim()) return failed(`handle is required for kind='${kind}'.`);
      const normalized = normalizeTelegramHandle(args.handle);
      if ("error" in normalized) return failed(normalized.error);
      const handle = normalized.handle;

      if (kind === "channel") {
        if (args.cursor !== undefined || args.limit !== undefined) {
          return failed("cursor and limit apply to kind='posts' only.");
        }
        const response = yield* scrapecreatorsRequest(
          "/v1/telegram/channel",
          { handle, cache_max_age: cacheMaxAge },
          headers,
          ctx,
          "ScrapeCreators Telegram channel",
        );
        if (!response.ok) {
          return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
        }
        const lines = [
          `Telegram channel lookup: @${handle}`,
          "Source: Telegram public web preview; no logged-in account.",
          provenanceLine(response.payload, response.charges),
          "",
          ...telegramChannelLines(response.payload),
        ];
        return outcome("success", lines.join("\n"), {
          provider: "scrapecreators",
          kind,
          handle,
          subscriber_count: asNumber(response.payload.subscriber_count),
          member_count: asNumber(response.payload.member_count),
          cached: response.payload.cached === true,
          credits_charged: knownCharge(response.charges),
        });
      }

      const cursor = args.cursor?.trim();
      if (cursor && !/^\d+$/.test(cursor)) {
        return failed("cursor must be the numeric cursor returned by the previous posts page.");
      }
      const limit = displayLimit(args.limit, MAX_LIMIT);
      const response = yield* scrapecreatorsRequest(
        "/v1/telegram/channel/posts",
        { handle, cursor: cursor || undefined, cache_max_age: cacheMaxAge },
        headers,
        ctx,
        "ScrapeCreators Telegram channel posts",
      );
      if (!response.ok) {
        return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
      }
      const listed = expectArray(response.payload, "posts", "ScrapeCreators Telegram channel posts");
      if (!listed.ok) return failed(listed.error);
      const posts = listed.items.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
      const unreadable = listed.items.length - posts.length;

      const dated = posts.map((post) => ({
        post,
        at: Date.parse(asString(post.published_at) ?? ""),
      }));
      const ordered = [
        ...dated
          .filter((entry) => !Number.isNaN(entry.at))
          .sort((a, b) => b.at - a.at)
          .map((entry) => entry.post),
        ...dated.filter((entry) => Number.isNaN(entry.at)).map((entry) => entry.post),
      ];
      const undated = dated.filter((entry) => Number.isNaN(entry.at)).length;
      const shown = ordered.slice(0, limit);
      const nextCursor =
        asString(response.payload.cursor) ??
        (asNumber(response.payload.cursor) !== null ? String(response.payload.cursor) : null);
      const hasMore = typeof response.payload.has_more === "boolean" ? response.payload.has_more : null;
      const channel = asRecord(response.payload.channel);
      const lines = [
        `Telegram channel posts: @${handle}${cursor ? ` (page before cursor ${cursor})` : " (latest page)"}`,
        "Source: Telegram public web preview; one page per request; reactions and media URLs are absent when Telegram does not expose them.",
        `Order: newest first by published_at within this page (the provider delivers the page oldest-first)${undated ? `; ${undated} post${undated === 1 ? "" : "s"} without a parseable date listed last, unranked` : ""}.`,
        provenanceLine(response.payload, response.charges),
        `Posts: ${shown.length} shown of ${posts.length} returned on this page`,
        hasMore === false
          ? "Older posts: provider reports this is the terminal page"
          : nextCursor
            ? `Older posts: pass cursor="${nextCursor}"${hasMore === null ? " (has_more not reported)" : ""}${continuesAfter(shown.length, posts.length, "posts")}`
            : "Older posts: no cursor returned and has_more not reported; continuation unavailable",
      ];
      if (unreadable) lines.push(unreadableLine(unreadable, "post"));
      if (channel) lines.push("", ...telegramChannelLines(channel));
      if (shown.length === 0) lines.push("", "The provider returned an empty post list for this page.");
      for (const [index, post] of shown.entries()) lines.push("", ...telegramPostLines(post, index));

      const status = listed.items.length === 0 ? "empty" : unreadable ? "partial" : "success";
      return outcome(status, lines.join("\n"), {
        provider: "scrapecreators",
        kind,
        handle,
        returned: posts.length,
        shown: shown.length,
        unreadable,
        undated,
        cursor: hasMore === false ? null : nextCursor,
        has_more: hasMore,
        cached: response.payload.cached === true,
        credits_charged: knownCharge(response.charges),
        post_ids: shown
          .map((post) => asString(post.id) ?? (asNumber(post.id) !== null ? String(post.id) : null))
          .filter((value): value is string => value !== null),
      });
    }),
});

export const telegramSource: SourcePlugin = defineSource({
  id: "telegram",
  group: "social",
  label: "Telegram",
  description: "Public channels and posts",
  about:
    "Public Telegram channels, groups and posts, read through Telegram's public web preview. No Telegram account is used.",
  providers: [SCRAPECREATORS_PROVIDER],
  billing: SCRAPECREATORS_BILLING,
  logo: "telegram",
  env: ["SCRAPECREATORS_API_KEY"],
  keys: ["SCRAPECREATORS_API_KEY"],
  credential: "SCRAPECREATORS_API_KEY",
  actions: [telegramAction],
});

export default telegramSource;
