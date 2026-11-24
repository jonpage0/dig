import { Duration, Effect, Result, Schema } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { FollowRedirectsEnabled, FreeHttp, freeRequest } from "../../core/http.ts";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  type ActionContext,
  type ActionOutcome,
  type SourcePlugin,
} from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import { USER_AGENT } from "../../version.ts";

const ARCHIVE = "https://web.archive.org";
const MATCHES = ["exact", "prefix", "host", "domain"] as const;
const MATCH_TEXT: Record<string, string> = {
  exact: "this exact address",
  prefix: "addresses under this prefix",
  host: "this host",
  domain: "this domain and its subdomains",
};
const FIELDS = ["timestamp", "original", "mimetype", "statuscode", "length"] as const;
const MAX_REDIRECTS = 3;
const READ_LIMIT = 40_000;
const READ_MAX = 100_000;
const TIMEOUT_MS = 60_000;
const DAY = 86_400_000;

/** An http(s) web address, `https://` added to a bare host; anything else is refused before any request. */
export function webAddress(value: unknown): URL {
  const text = String(value ?? "").trim();
  let url: URL | undefined;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) ? text : `https://${text}`);
  } catch {
    // handled below
  }
  if (
    !url ||
    !/^https?:$/.test(url.protocol) ||
    !url.hostname.includes(".") ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "url must be an http(s) web address, such as example.com/page or https://example.com/page",
    );
  }
  return url;
}

/** A 14-digit capture timestamp as epoch milliseconds, or undefined when it is not a real UTC time. */
function stamp(ts: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const at = Date.UTC(y, mo - 1, d, h, mi, s);
  const date = new Date(at);
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    h < 24 &&
    mi < 60 &&
    s < 60
    ? at
    : undefined;
}

const readable = (ts: string): string =>
  `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)} UTC`;

/** `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (or, for a read, a 14-digit timestamp): the archive's digits and the UTC period they cover. */
function period(
  value: unknown,
  name: string,
  exact = false,
): { readonly digits: string; readonly start: number; readonly end: number } {
  const text = String(value).trim();
  if (exact && /^\d{14}$/.test(text)) {
    const at = stamp(text);
    if (at === undefined) throw new Error(`${name} ${text} is not a real time`);
    return { digits: text, start: at, end: at + 1000 };
  }
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text);
  if (!m) {
    throw new Error(
      `${name} must be YYYY, YYYY-MM or YYYY-MM-DD${exact ? ", or a 14-digit capture timestamp" : ""}`,
    );
  }
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : 1;
  const d = m[3] ? Number(m[3]) : 1;
  const start = Date.UTC(y, mo - 1, d);
  const date = new Date(start);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new Error(`${name} ${text} is not a real date`);
  }
  const end = m[3]
    ? Date.UTC(y, mo - 1, d + 1)
    : m[2]
      ? Date.UTC(y, mo, 1)
      : Date.UTC(y + 1, 0, 1);
  return { digits: text.replaceAll("-", ""), start, end };
}

function size(length: string): string {
  const n = Number(length);
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(n)) return "size not recorded";
  return `${n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`} stored`;
}

function distance(at: number, asked: { readonly start: number; readonly end: number }): string {
  if (at >= asked.start && at < asked.end) {
    return asked.end - asked.start === 1000 ? "this is that capture" : "the capture falls within it";
  }
  const ms = at < asked.start ? asked.start - at : at - asked.end + 1;
  const days = Math.round(ms / DAY);
  return `the nearest capture is ${days < 1 ? "less than a day" : days === 1 ? "1 day" : `${days.toLocaleString("en-US")} days`} ${at < asked.start ? "before" : "after"} it`;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  euro: "€",
  pound: "£",
  cent: "¢",
  sect: "§",
  para: "¶",
  shy: "",
};

function entities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? whole;
    const code =
      name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });
}

const BLOCK =
  "address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul";

/** A page's title and readable text: scripts, styles, templates, SVG and comments dropped; block ends and <br> as line breaks; link text kept. */
export function pageText(html: string): { readonly title: string; readonly text: string } {
  const clean = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  const title = entities(
    /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(clean)?.[1].replace(/<[^>]*>/g, "") ?? "",
  )
    .replace(/\s+/g, " ")
    .trim();
  const text = entities(
    clean
      .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "")
      .replace(/\s+/g, " ")
      .replace(new RegExp(`<\\/?(?:${BLOCK})\\b[^>]*>|<br\\b[^>]*>`, "gi"), "\n")
      .replace(/<\/?(?:td|th)\b[^>]*>/gi, " ")
      .replace(/<[^>]*>/g, ""),
  );
  return {
    title,
    text: text
      .split("\n")
      .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodeCaptureBytes(bytes: Uint8Array, contentType: string): string {
  const declared =
    /charset=["']?([\w.:-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(
      new TextDecoder("latin1").decode(bytes.subarray(0, 4096)),
    )?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(declared ?? "utf-8");
  } catch {
    decoder = new TextDecoder();
  }
  return decoder.decode(bytes);
}

/**
 * Fetch one Wayback capture via `FreeHttp`, enforcing that redirects stay within
 * `web.archive.org`, skipping binary captures before buffering, and decoding text
 * with its declared character set before redacting and retaining it.
 */
function fetchWaybackCapture(
  initialTarget: URL,
  listedOriginal: string,
  askedArg: string | undefined,
  asked: { readonly digits: string; readonly start: number; readonly end: number } | undefined,
  url: URL,
  offset: number,
  limit: number,
  ctx: ActionContext,
): Effect.Effect<ActionOutcome, never, FreeHttp> {
  return Effect.gen(function* () {
    const client = yield* FreeHttp;
    let target = initialTarget;

    const withDeadline = <A>(
      eff: Effect.Effect<A, HttpClientError.HttpClientError>,
      req: HttpClientRequest.HttpClientRequest,
      label: string,
      remainingMs: number,
    ): Effect.Effect<A, HttpClientError.HttpClientError> => {
      const sig = ctx.signal;
      if (sig.aborted) {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: req,
              description: `${label} cancelled`,
            }),
          }),
        );
      }
      const abortWait = Effect.callback<never, HttpClientError.HttpClientError>((resume) => {
        const onAbort = () =>
          resume(
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request: req,
                  description: `${label} cancelled`,
                }),
              }),
            ),
          );
        sig.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => sig.removeEventListener("abort", onAbort));
      });
      return Effect.raceFirst(eff, abortWait).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(Math.max(1, remainingMs)),
          orElse: () =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request: req,
                  description: `${label} timed out after ${TIMEOUT_MS}ms`,
                }),
              }),
            ),
        }),
      );
    };

    for (let hop = 0; ; hop++) {
      if (ctx.signal.aborted) {
        return outcome("cancelled", "Wayback Machine read cancelled");
      }
      const hopLabel = `capture ${/^\/web\/(\d{1,14})/.exec(target.pathname)?.[1] ?? hop}`;
      const startedAt = performance.now();
      const req = HttpClientRequest.setHeaders(HttpClientRequest.get(target.href), {
        "User-Agent": USER_AGENT,
      });

      const stepResult = yield* Effect.scoped(
        Effect.gen(function* () {
          const execRes = yield* Effect.result(
            withDeadline(
              client.execute(req).pipe(Effect.provideService(FollowRedirectsEnabled, false)),
              req,
              hopLabel,
              TIMEOUT_MS,
            ),
          );
          if (Result.isFailure(execRes)) {
            if (ctx.signal.aborted) {
              return { kind: "done" as const, outcome: outcome("cancelled", "Wayback Machine read cancelled") };
            }
            ctx.keep(hopLabel, "error", execRes.failure.message);
            return {
              kind: "done" as const,
              outcome: failed(`Wayback Machine read failed: ${execRes.failure.message}`),
            };
          }

          const response = execRes.success;
          const location = response.headers.location;
          if (response.status >= 300 && response.status < 400 && location) {
            const rem = TIMEOUT_MS - (performance.now() - startedAt);
            const redirectBodyRes = yield* Effect.result(
              withDeadline(response.text, req, hopLabel, rem),
            );
            const redirectText = Result.isSuccess(redirectBodyRes)
              ? redactText(redirectBodyRes.success, knownSecrets())
              : "";
            ctx.keep(hopLabel, response.status, redirectText);
            let next: URL;
            try {
              next = new URL(location, target);
            } catch {
              return {
                kind: "done" as const,
                outcome: failed("The archive returned an invalid redirect location"),
              };
            }
            if (next.hostname !== "web.archive.org" || !/^https?:$/.test(next.protocol)) {
              return {
                kind: "done" as const,
                outcome: failed(
                  `The archive redirected the capture to another host (${next.host}); Dig follows redirects only within web.archive.org`,
                ),
              };
            }
            if (hop >= MAX_REDIRECTS) {
              return {
                kind: "done" as const,
                outcome: failed(`The archive redirected the capture more than ${MAX_REDIRECTS} times`),
              };
            }
            next.protocol = "https:";
            return { kind: "redirect" as const, next };
          }

          // If FreeHttp followed redirects internally, verify the resolved URL stayed on web.archive.org.
          let resolvedTarget = target;
          if (response.request.url) {
            try {
              const candidate = new URL(response.request.url);
              if (candidate.hostname !== "web.archive.org" || !/^https?:$/.test(candidate.protocol)) {
                return {
                  kind: "done" as const,
                  outcome: failed(
                    `The archive redirected the capture to another host (${candidate.host}); Dig follows redirects only within web.archive.org`,
                  ),
                };
              }
              resolvedTarget = candidate;
            } catch {
              // keep current target
            }
          }

          const label = `capture ${/^\/web\/(\d{1,14})/.exec(resolvedTarget.pathname)?.[1] ?? "page"}`;
          const hasMemento = "memento-datetime" in response.headers;
          const isOk = response.status >= 200 && response.status < 300;
          if (!hasMemento && !isOk) {
            const rem = TIMEOUT_MS - (performance.now() - startedAt);
            const errTextRes = yield* Effect.result(withDeadline(response.text, req, label, rem));
            const errText = Result.isSuccess(errTextRes)
              ? redactText(errTextRes.success, knownSecrets())
              : "";
            ctx.keep(label, response.status, errText);
            return {
              kind: "done" as const,
              outcome: failed(`The Wayback Machine returned HTTP ${response.status} for the capture`),
            };
          }

          const finalMatch = /^\/web\/(\d{14})id_\/(.+)$/.exec(
            `${resolvedTarget.pathname}${resolvedTarget.search}`,
          );
          const at = finalMatch ? stamp(finalMatch[1]) : undefined;
          if (!finalMatch || at === undefined) {
            const rem = TIMEOUT_MS - (performance.now() - startedAt);
            const rawRes = yield* Effect.result(withDeadline(response.text, req, label, rem));
            ctx.keep(
              label,
              response.status,
              Result.isSuccess(rawRes) ? redactText(rawRes.success, knownSecrets()) : "",
            );
            return {
              kind: "done" as const,
              outcome: failed(
                "Wayback Machine read failed: the archive answered from an address that names no capture",
              ),
            };
          }

          const [, ts, original] = finalMatch;
          const contentTypeHeader = response.headers["content-type"] ?? "";
          const type = contentTypeHeader.split(";")[0].trim().toLowerCase();
          const head = [
            `Captured ${readable(ts)}${response.status === 200 ? "" : `; the page answered HTTP ${response.status} when captured`}; ${type || "no media type given"}.`,
            ...(asked ? [`Asked for ${askedArg}: ${distance(at, asked)}.`] : []),
            `Capture: ${ARCHIVE}/web/${ts}/${original}`,
            `Original: ${original}`,
            ...(original !== listedOriginal
              ? [`The archive redirected the capture of ${listedOriginal} here.`]
              : []),
          ];

          if (type && !/^text\//.test(type) && type !== "application/xhtml+xml") {
            ctx.keep(
              label,
              response.status,
              `[${type} capture not retained: Dig reads only HTML and text captures]`,
            );
            return {
              kind: "done" as const,
              outcome: outcome(
                "partial",
                `# ${original}\n\n${head.join("\n")}\n\nDig reads only HTML and text captures, and this capture is ${type}; open it at the capture address.`,
              ),
            };
          }

          const rem = TIMEOUT_MS - (performance.now() - startedAt);
          const bufRes = yield* Effect.result(withDeadline(response.arrayBuffer, req, label, rem));
          if (Result.isFailure(bufRes)) {
            ctx.keep(label, response.status, "", undefined, true);
            if (ctx.signal.aborted) {
              return { kind: "done" as const, outcome: outcome("cancelled", "Wayback Machine read cancelled") };
            }
            return {
              kind: "done" as const,
              outcome: failed(`Wayback Machine read failed: ${bufRes.failure.message}`),
            };
          }

          const decodedBody = decodeCaptureBytes(new Uint8Array(bufRes.success), contentTypeHeader);
          const body = redactText(decodedBody, knownSecrets());
          ctx.keep(label, response.status, body);

          const isHtml =
            type === "text/html" ||
            type === "application/xhtml+xml" ||
            (!type && /<(?:!doctype html|html|body)\b/i.test(body));
          const page = isHtml ? pageText(body) : { title: "", text: body };
          const name = page.title || original;
          if (!page.text.trim()) {
            return {
              kind: "done" as const,
              outcome: outcome(
                "empty",
                `# ${name}\n\n${head.join("\n")}\n\nThe capture has no readable text. Pages built by scripts in the browser often capture this way: the archive keeps the page as the server sent it, before any script ran.`,
              ),
            };
          }
          if (offset > 0 && offset >= page.text.length) {
            return {
              kind: "done" as const,
              outcome: failed(
                `Wayback Machine read failed: offset ${offset} is past the end of the text (${page.text.length} characters)`,
              ),
            };
          }
          const slice = page.text.slice(offset, offset + limit);
          const end = offset + slice.length;
          const more = end < page.text.length ? end : null;
          return {
            kind: "done" as const,
            outcome: outcome(
              "success",
              `# ${name}\n\n${head.join("\n")}\nCharacters ${offset}–${end} of ${page.text.length}${more === null ? ", complete" : ""}.\n\n${slice}${more === null ? "" : `\n\nThe text continues: call wayback_read with url "${url.href}", date "${ts}" and offset ${more}.`}`,
              {
                capture: `${ARCHIVE}/web/${ts}/${original}`,
                totalCharacters: page.text.length,
                nextOffset: more,
              },
            ),
          };
        }),
      );

      if (stepResult.kind === "redirect") {
        target = stepResult.next;
        continue;
      }
      return stepResult.outcome;
    }
  });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const waybackSnapshotsSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Web address, with or without https://, such as example.com/pricing.",
  }),
  from: Schema.optionalKey(
    Schema.String.annotate({
      description: "Earliest capture date, YYYY, YYYY-MM or YYYY-MM-DD (inclusive).",
    }),
  ),
  to: Schema.optionalKey(
    Schema.String.annotate({
      description: "Latest capture date, YYYY, YYYY-MM or YYYY-MM-DD (inclusive).",
    }),
  ),
  match: Schema.optionalKey(
    Schema.Literals(MATCHES).annotate({
      description:
        "Which addresses to list: exact (default) this address, prefix every address under it, host its whole host, domain the host and its subdomains.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description: "Captures to list, default 20, at most 100.",
    }),
  ),
  changesOnly: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Leave out a capture identical to the one before it, so the list shows when the content changed. Default true.",
    }),
  ),
  resumeKey: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The resumeKey a previous call printed; repeat its other arguments to list the next page.",
    }),
  ),
});

export const waybackReadSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Web address, with or without https://, such as example.com/pricing.",
  }),
  date: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Date to read the page as of: YYYY, YYYY-MM, YYYY-MM-DD or a 14-digit capture timestamp. The nearest capture is read; without a date, the newest.",
    }),
  ),
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Character offset to continue from (default: 0).",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: READ_MAX })).annotate({
      description: "Characters to return (default: 40000, max: 100000).",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const waybackSnapshotsAction = defineAction({
  name: "wayback_snapshots",
  description:
    "List the captures the Internet Archive's Wayback Machine holds for a web address, oldest first, from its CDX server: each capture's time (UTC), HTTP status, media type, stored size (the archive's compressed record, not the page's size) and the address that opens it. " +
    "Narrow by from/to dates; match the exact address (default), every address under a path prefix, a host or a whole domain. " +
    "By default a capture identical to the one before is left out, so the list shows when the content changed. " +
    "When there are more captures, the text gives the resumeKey for the next page. Free; no account or key.",
  schema: waybackSnapshotsSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      let url: URL;
      let match: (typeof MATCHES)[number];
      let limit: number;
      let changesOnly: boolean;
      let from: ReturnType<typeof period> | undefined;
      let to: ReturnType<typeof period> | undefined;
      let resumeKey: string | undefined;
      try {
        url = webAddress(args.url);
        match = args.match ?? "exact";
        limit = args.limit ?? 20;
        changesOnly = args.changesOnly ?? true;
        if (!(MATCHES as readonly string[]).includes(match)) {
          throw new Error(`match must be one of ${MATCHES.join(", ")}`);
        }
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new Error("limit must be a whole number from 1 to 100");
        }
        from = args.from === undefined ? undefined : period(args.from, "from");
        to = args.to === undefined ? undefined : period(args.to, "to");
        if (from && to && from.start >= to.end) throw new Error("from must not be after to");
        resumeKey = args.resumeKey === undefined ? undefined : String(args.resumeKey).trim();
        if (resumeKey === "") {
          throw new Error("resumeKey must be the key a previous wayback_snapshots call printed");
        }
      } catch (error) {
        return failed(
          `Wayback Machine captures failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }

      const query = new URLSearchParams({
        url: url.href,
        output: "json",
        fl: FIELDS.join(","),
        limit: String(limit),
        showResumeKey: "true",
      });
      if (match !== "exact") query.set("matchType", match);
      if (from) query.set("from", from.digits);
      if (to) query.set("to", to.digits);
      if (changesOnly) query.set("collapse", "digest");
      if (resumeKey) query.set("resumeKey", resumeKey);

      const res = yield* Effect.result(
        freeRequest({
          url: `${ARCHIVE}/cdx/search/cdx?${query}`,
          method: "GET",
          headers: { "User-Agent": USER_AGENT },
          timeoutMs: TIMEOUT_MS,
          signal: ctx.signal,
          label: "captures",
          keep: ctx.keep,
        }),
      );

      if (Result.isFailure(res)) {
        if (ctx.signal.aborted) return outcome("cancelled", "Wayback Machine captures cancelled");
        return failed(`Wayback Machine captures failed: ${res.failure.message}`);
      }

      const { status, payload: rows } = res.success;
      if (status < 200 || status >= 300) {
        return failed(`The Wayback Machine's capture index returned HTTP ${status}`);
      }

      const range = [from ? `from ${args.from}` : "", to ? `to ${args.to}` : ""]
        .filter(Boolean)
        .join(" ");
      if (!Array.isArray(rows)) {
        return failed("Wayback Machine captures failed: the capture index returned an unexpected response");
      }
      if (!rows.length) {
        return outcome(
          "empty",
          `The Wayback Machine has no capture of ${url.href}${range ? ` ${range}` : ""} (${MATCH_TEXT[match]}).`,
        );
      }
      const [head, ...rest] = rows;
      if (!Array.isArray(head) || head.join(",") !== FIELDS.join(",")) {
        return failed("Wayback Machine captures failed: the capture index returned an unexpected header");
      }
      const captures: string[][] = [];
      let next: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        const row = rest[i];
        if (Array.isArray(row) && row.length === 0) {
          const nextRow = rest[i + 1];
          const keyVal = Array.isArray(nextRow) ? nextRow[0] : undefined;
          if (typeof keyVal !== "string" || !keyVal) {
            return failed(
              "Wayback Machine captures failed: the capture index returned an unreadable resume key",
            );
          }
          next = keyVal;
          break;
        }
        if (
          !Array.isArray(row) ||
          row.length !== FIELDS.length ||
          row.some((field) => typeof field !== "string") ||
          stamp(row[0] as string) === undefined
        ) {
          return failed("Wayback Machine captures failed: the capture index returned a malformed capture");
        }
        captures.push(row as string[]);
      }

      const scope = [
        MATCH_TEXT[match],
        range,
        changesOnly ? "identical consecutive captures left out" : "every capture",
      ]
        .filter(Boolean)
        .join(", ");
      const more = next
        ? `More captures: call wayback_snapshots again with the same arguments and resumeKey "${next}".`
        : resumeKey
          ? "No further captures."
          : "These are all the captures.";
      if (!captures.length) {
        return outcome("empty", `The Wayback Machine has no further captures of ${url.href} (${scope}).`);
      }
      const lines = captures.map(
        ([ts, original, type, statusCode, length]) =>
          `- ${readable(ts)} · HTTP ${statusCode} · ${type} · ${size(length)} · ${ARCHIVE}/web/${ts}/${original}`,
      );
      return outcome(
        "success",
        `Wayback Machine captures of ${url.href} (${scope}): ${captures.length} shown, oldest first${resumeKey ? ", continuing an earlier list" : ""}.\n\n${lines.join("\n")}\n\n${more}`,
        { captures: captures.length, ...(next ? { resumeKey: next } : {}) },
      );
    }),
});

export const waybackReadAction = defineAction({
  name: "wayback_read",
  description:
    "Read what a web page said on a date, from the Internet Archive's Wayback Machine. Finds the capture nearest the date (without a date, the newest capture) through the archive's availability API, confirming against its capture index before saying there is none, then reads the page exactly as captured, without the archive's banner, as readable text. " +
    "The text names the capture's time (UTC), how many days it is from the date asked for, the address that opens the capture and the original address. " +
    "Reads HTML and plain-text captures; a PDF or image capture is named but not read. Use offset to continue a long page. Also recovers a page behind a dead link. Free; no account or key.",
  schema: waybackReadSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      let url: URL;
      let asked: ReturnType<typeof period> | undefined;
      let offset: number;
      let limit: number;
      try {
        url = webAddress(args.url);
        asked = args.date === undefined ? undefined : period(args.date, "date", true);
        offset = args.offset ?? 0;
        limit = args.limit ?? READ_LIMIT;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > READ_MAX
        ) {
          throw new Error(`offset must be a whole number from 0 and limit from 1 to ${READ_MAX}`);
        }
      } catch (error) {
        return failed(
          `Wayback Machine read failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }

      const query = new URLSearchParams({ url: url.href });
      if (asked) query.set("timestamp", asked.digits);
      const lookupRes = yield* Effect.result(
        freeRequest({
          url: `https://archive.org/wayback/available?${query}`,
          method: "GET",
          headers: { "User-Agent": USER_AGENT },
          timeoutMs: TIMEOUT_MS,
          signal: ctx.signal,
          label: "availability",
          keep: ctx.keep,
        }),
      );
      if (Result.isFailure(lookupRes)) {
        if (ctx.signal.aborted) return outcome("cancelled", "Wayback Machine read cancelled");
        return failed(`Wayback Machine read failed: ${lookupRes.failure.message}`);
      }
      if (lookupRes.success.status < 200 || lookupRes.success.status >= 300) {
        return failed(
          `The Wayback Machine's availability lookup returned HTTP ${lookupRes.success.status}`,
        );
      }

      const found = asRecord(lookupRes.success.payload);
      const snapshotsObj = asRecord(found?.archived_snapshots);
      if (!found || !snapshotsObj) {
        return failed(
          "Wayback Machine read failed: the availability lookup returned an unexpected response",
        );
      }

      const closest = asRecord(snapshotsObj.closest);
      let listed: RegExpExecArray | [string, string, string] | null = null;
      if (closest && closest.available !== false) {
        listed = /^https?:\/\/web\.archive\.org\/web\/(\d{14})\/(.+)$/.exec(
          String(closest.url ?? ""),
        );
        if (!listed) {
          return failed(
            "Wayback Machine read failed: the availability lookup returned a capture address Dig cannot read",
          );
        }
      } else {
        const index = new URLSearchParams({
          url: url.href,
          output: "json",
          fl: "timestamp,original",
          filter: "statuscode:200",
          limit: asked ? "1" : "-1",
        });
        if (asked) {
          index.set("closest", asked.digits);
          index.set("sort", "closest");
        }
        const confirmRes = yield* Effect.result(
          freeRequest({
            url: `${ARCHIVE}/cdx/search/cdx?${index}`,
            method: "GET",
            headers: { "User-Agent": USER_AGENT },
            timeoutMs: TIMEOUT_MS,
            signal: ctx.signal,
            label: "capture index",
            keep: ctx.keep,
          }),
        );
        if (Result.isFailure(confirmRes)) {
          if (ctx.signal.aborted) return outcome("cancelled", "Wayback Machine read cancelled");
          return failed(`Wayback Machine read failed: ${confirmRes.failure.message}`);
        }
        if (confirmRes.success.status < 200 || confirmRes.success.status >= 300) {
          return failed(
            `The Wayback Machine's availability lookup named no capture, and its capture index, asked to confirm, returned HTTP ${confirmRes.success.status}. This is not evidence that the archive holds no capture.`,
          );
        }
        const rows = confirmRes.success.payload;
        if (!Array.isArray(rows)) {
          return failed(
            "Wayback Machine read failed: the capture index returned an unexpected response",
          );
        }
        const row = rows[1];
        if (
          !Array.isArray(row) ||
          !/^\d{14}$/.test(String(row[0])) ||
          typeof row[1] !== "string" ||
          !row[1]
        ) {
          return outcome(
            "empty",
            `The Wayback Machine has no capture of ${url.href} that it can show: it holds none, or the site has asked to be excluded.`,
          );
        }
        listed = ["", String(row[0]), row[1]];
      }

      const initialTarget = new URL(`${ARCHIVE}/web/${listed[1]}id_/${listed[2]}`);
      return yield* fetchWaybackCapture(
        initialTarget,
        listed[2],
        args.date,
        asked,
        url,
        offset,
        limit,
        ctx,
      );
    }),
});

export const waybackSource: SourcePlugin = defineSource({
  id: "wayback",
  group: "web",
  label: "Wayback Machine",
  description: "What a web page said on a given date",
  about:
    "Earlier versions of web pages, read from the Internet Archive: the captures it holds for an address, when the content changed, and the text a page had on a given date. It also recovers the page behind a dead link. A capture is what the archive's crawler received at that moment, not what every visitor saw.",
  providers: [{ name: "Internet Archive Wayback Machine", url: "https://web.archive.org" }],
  billing: "Free. No account or key.",
  actions: [waybackSnapshotsAction, waybackReadAction],
});

export default waybackSource;
