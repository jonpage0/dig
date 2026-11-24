/**
 * Public Threads post and account-posts source plugin backed by ScrapeCreators (`PaidHttp`).
 */
import { Effect, Schema } from "effect";
import { defineAction, defineSource, failed, type SourcePlugin } from "../../core/plugin.ts";
import {
  CACHE_MAX_AGE_VALUES,
  SCRAPECREATORS_BILLING,
  SCRAPECREATORS_PROVIDER,
  scrapecreatorsBilling,
  scrapecreatorsReadPage,
} from "../shared/scrapecreators.ts";

const THREADS_HOSTS = new Set(["threads.com", "www.threads.com", "threads.net", "www.threads.net"]);
const THREADS_HANDLE = /^[A-Za-z0-9_.]{1,64}$/;

function validateThreadsUrl(value: unknown): { readonly ok: true; readonly href: string } | { readonly ok: false; readonly error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: "url is required" };
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: "Use a public HTTPS URL on the requested platform" };
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !THREADS_HOSTS.has(url.hostname.toLowerCase())
  ) {
    return { ok: false, error: "Use a public HTTPS URL on the requested platform" };
  }
  return { ok: true, href: url.href };
}

const ThreadsSchema = Schema.Struct({
  kind: Schema.Literals(["post", "posts"]).annotate({
    description: "Read one post or account posts.",
  }),
  url: Schema.optionalKey(Schema.String).annotate({
    description: "Public HTTPS Threads post URL (required for kind='post').",
  }),
  handle: Schema.optionalKey(Schema.String).annotate({
    description: "Threads account handle (required for kind='posts').",
  }),
  cacheMaxAge: Schema.optionalKey(Schema.Literals(CACHE_MAX_AGE_VALUES)).annotate({
    description: "Provider cache age for a post.",
  }),
});

export const threadsAction = defineAction({
  name: "threads",
  description:
    "Read a public Threads post with comments/continuations or one account's returned posts. " +
    "Supply kind post with url, or kind posts with handle. No login; posts listing has no documented pagination and is not a complete history.",
  schema: ThreadsSchema,
  billing: scrapecreatorsBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (args.kind === "post") {
        const checked = validateThreadsUrl(args.url);
        if (!checked.ok) return failed(checked.error);
        if (
          args.cacheMaxAge !== undefined &&
          !(CACHE_MAX_AGE_VALUES as readonly string[]).includes(args.cacheMaxAge)
        ) {
          return failed("Unsupported cacheMaxAge");
        }
        return yield* scrapecreatorsReadPage(
          "/v1/threads/post",
          { url: checked.href, cache_max_age: args.cacheMaxAge },
          null,
          "Threads post",
          ctx,
        );
      }

      if (args.kind !== "posts") {
        return failed("kind must be post or posts");
      }
      if (args.url !== undefined || args.cacheMaxAge !== undefined) {
        return failed("url and cacheMaxAge belong to kind post");
      }
      if (typeof args.handle !== "string" || !args.handle.trim()) {
        return failed("handle is required");
      }
      const handle = args.handle.trim().replace(/^@/, "");
      if (!THREADS_HANDLE.test(handle)) {
        return failed("Invalid Threads handle");
      }
      return yield* scrapecreatorsReadPage(
        "/v1/threads/user/posts",
        { handle },
        "posts",
        `Threads @${handle} posts`,
        ctx,
        "This endpoint provides no documented pagination.",
      );
    }),
});

export const threadsSource: SourcePlugin = defineSource({
  id: "threads",
  group: "social",
  label: "Threads",
  description: "Public posts, replies and account posts",
  about:
    "Public Threads posts with comments and author continuations, and account posts through ScrapeCreators. No login; provider pages are not complete histories.",
  providers: [SCRAPECREATORS_PROVIDER],
  billing: SCRAPECREATORS_BILLING,
  env: ["SCRAPECREATORS_API_KEY"],
  keys: ["SCRAPECREATORS_API_KEY"],
  credential: "SCRAPECREATORS_API_KEY",
  actions: [threadsAction],
});

export default threadsSource;
