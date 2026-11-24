/**
 * Polymarket prediction market search, price history, and resolution evidence.
 *
 * Uses Polymarket's free public Gamma API and Data API v2 (no auth required).
 */
import { Effect, Result, Schema } from "effect";
import { freeRequest, type FreeHttp } from "../../core/http.ts";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  type ActionContext,
  type ActionOutcome,
  type SourcePlugin,
} from "../../core/plugin.ts";
import { USER_AGENT } from "../../version.ts";

interface PolymarketMarket {
  readonly id: string;
  readonly conditionId?: string;
  readonly clobTokenIds?: string;
  readonly question: string;
  readonly groupItemTitle?: string;
  readonly description?: string;
  readonly outcomes: string;
  readonly outcomePrices: string;
  readonly volume?: string;
  readonly volumeNum?: number;
  readonly volume24hr?: number;
  readonly volume1wk?: number;
  readonly volume1mo?: number;
  readonly liquidity?: string;
  readonly liquidityNum?: number;
  readonly endDate?: string;
  readonly closed: boolean;
  readonly active: boolean;
  readonly slug?: string;
  readonly oneDayPriceChange?: number;
  readonly oneWeekPriceChange?: number;
  readonly oneMonthPriceChange?: number;
  readonly bestBid?: number;
  readonly bestAsk?: number;
  readonly spread?: number;
}

interface PolymarketEvent {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly description?: string;
  readonly markets: readonly PolymarketMarket[];
  readonly volume?: number;
  readonly volume24hr?: number;
  readonly liquidity?: number;
  readonly competitive?: number;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly active?: boolean;
  readonly closed?: boolean;
  readonly tags?: ReadonlyArray<{ readonly label?: string; readonly slug?: string }>;
}

interface PublicSearchResponse {
  readonly events?: readonly PolymarketEvent[] | null;
  readonly pagination?: { readonly hasMore?: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function marketIds(market: PolymarketMarket, indent: string): string[] {
  return [
    ...(market.conditionId ? [`${indent}Condition ID: ${market.conditionId}`] : []),
    ...(market.clobTokenIds ? [`${indent}Outcome token IDs (outcome order): ${market.clobTokenIds}`] : []),
  ];
}

function expandQueries(query: string): string[] {
  const queries = [query];
  const words = query.split(/\s+/).filter((w) => w.length > 2);
  const lowSignal = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "will",
    "what",
    "how",
    "who",
    "when",
    "best",
    "top",
    "new",
    "latest",
    "odds",
    "prediction",
  ]);
  if (words.length >= 2) {
    for (const word of words) {
      if (!lowSignal.has(word.toLowerCase())) {
        queries.push(word);
      }
    }
  }
  const seen = new Set<string>();
  return queries
    .filter((q) => {
      const key = q.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function tokenOverlap(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const textTokens = new Set(text.toLowerCase().split(/\s+/));
  let matches = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) matches++;
  }
  return matches / queryTokens.size;
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (!value) return fallback;
  try {
    if (typeof value === "object") return value as T;
    if (typeof value !== "string") return fallback;
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function shortenQuestion(question: string): string {
  const q = question.trim().replace(/\?$/, "");
  const match = q.match(
    /^Will\s+(.+?)\s+(?:win|be|make|reach|have|lose|qualify|advance|strike|agree|pass|sign|get|become|remain|stay|leave|survive)\b/i,
  );
  if (match?.[1]) return match[1].trim();
  const m2 = q.match(/^Will\s+(.+?)\s+/i);
  if (m2?.[1] && m2[1].split(" ").length <= 4) return m2[1].trim();
  return question.length > 40 ? `${question.slice(0, 40)}…` : question;
}

function priceOf(value: string | undefined): number | null {
  const price = value === undefined || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(price) ? price : null;
}

function percent(price: number | null): string {
  return price === null ? "n/a" : `${(price * 100).toFixed(1)}%`;
}

function formatPriceMovement(market: PolymarketMarket): string | null {
  const changes: Array<[number, number, string]> = [
    [Math.abs(market.oneDayPriceChange || 0), market.oneDayPriceChange || 0, "24 hours"],
    [Math.abs(market.oneWeekPriceChange || 0), market.oneWeekPriceChange || 0, "7 days"],
    [Math.abs(market.oneMonthPriceChange || 0), market.oneMonthPriceChange || 0, "30 days"],
  ];
  changes.sort((a, b) => b[0] - a[0]);
  const top = changes[0];
  if (!top || top[0] < 0.01) return null;
  const [absChange, rawChange, period] = top;
  const direction = rawChange > 0 ? "↑" : "↓";
  return `${direction} ${(absChange * 100).toFixed(1)} percentage points over the rolling ${period}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

const PolymarketSearchSchema = Schema.Struct({
  query: Schema.String.annotate({ description: "Prediction-market topic, entity, event, or question." }),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Max events (default: 10, max: 30)." }),
  ),
  page: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Pagination page (default: 1)." }),
  ),
});

export const polymarketAction = defineAction({
  name: "polymarket",
  description:
    "Search Polymarket prediction markets for real-money odds on any topic. " +
    "Uses the Gamma /public-search API (free, no auth, 350 req/10s). " +
    "Returns events with nested markets showing probabilities, volume, liquidity, and price movement. " +
    "Best for elections, geopolitics, tech milestones, sports, crypto, and any topic " +
    "where people are betting real money on outcomes. " +
    "Outcomes/prices are parsed from JSON-encoded strings automatically.",
  schema: PolymarketSearchSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const limit = Math.min(args.limit ?? 10, 30);
      const page = args.page ?? 1;
      const queries = expandQueries(args.query);

      const searched = yield* Effect.forEach(
        queries,
        (q) =>
          Effect.gen(function* () {
            const url =
              `https://gamma-api.polymarket.com/public-search?` +
              `q=${encodeURIComponent(q)}` +
              `&page=${page}` +
              `&events_status=active` +
              `&keep_closed_markets=0`;
            const res = yield* Effect.result(
              freeRequest({
                url,
                method: "GET",
                headers: { "User-Agent": USER_AGENT },
                timeoutMs: 60_000,
                signal: ctx.signal,
                label: `search ${q}`,
                keep: ctx.keep,
              }),
            );
            if (Result.isFailure(res)) {
              const reason = res.failure instanceof Error ? res.failure.message : "request failed";
              return { ok: false as const, error: reason, status: undefined as number | undefined };
            }
            const { status, isJson, payload } = res.success;
            if (status < 200 || status >= 300) {
              return { ok: false as const, error: `HTTP ${status}`, status };
            }
            if (!isJson || !isRecord(payload)) {
              return { ok: false as const, error: "invalid JSON response", status };
            }
            return { ok: true as const, data: payload as PublicSearchResponse };
          }),
        { concurrency: "unbounded" },
      );

      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");

      const main = searched[0];
      if (!main || !main.ok) {
        if (main?.status !== undefined) {
          return failed(`Polymarket API returned ${main.status}`);
        }
        return failed(`Failed to search Polymarket: ${main?.error ?? "Unknown error"}`);
      }

      const allEvents = new Map<string, PolymarketEvent>();
      const failedQueries: string[] = [];
      const hasMore: boolean[] = [];

      searched.forEach((result, i) => {
        if (!result.ok) {
          failedQueries.push(`"${queries[i]}" (${result.error})`);
          return;
        }
        if (typeof result.data.pagination?.hasMore === "boolean") {
          hasMore.push(result.data.pagination.hasMore);
        }
        for (const event of result.data.events ?? []) {
          if (!allEvents.has(event.id)) {
            allEvents.set(event.id, event);
          }
        }
      });

      const failedNote = failedQueries.length
        ? `Expansion queries that failed, so results may be incomplete: ${failedQueries.join(", ")}.`
        : "";
      const events = [...allEvents.values()];
      if (events.length === 0) {
        return outcome(
          failedQueries.length ? "partial" : "empty",
          `No Polymarket events found for "${args.query}".${failedNote ? `\n${failedNote}` : ""}`,
        );
      }

      const queryLower = args.query.toLowerCase();
      const queryTokens = new Set(queryLower.split(/\s+/).filter((t) => t.length > 2));

      const scored = events
        .filter((e) => !e.closed && e.active !== false)
        .map((event) => {
          const markets = (event.markets || []).filter((m) => m.active && !m.closed);
          if (markets.length === 0) return null;

          const titleLower = event.title.toLowerCase();
          let textScore = titleLower.includes(queryLower) ? 1.0 : tokenOverlap(queryTokens, titleLower);

          const matchedOutcomes: Array<{ readonly market: string; readonly label: string; readonly price: number | null }> = [];
          for (const market of markets) {
            const outcomes = safeJsonParse<string[]>(market.outcomes, []);
            const prices = safeJsonParse<string[]>(market.outcomePrices, []);
            for (let i = 0; i < outcomes.length; i++) {
              const label = outcomes[i];
              if (!label) continue;
              const outcomeLower = label.toLowerCase();
              if (
                outcomeLower.includes(queryLower) ||
                queryLower.includes(outcomeLower) ||
                tokenOverlap(queryTokens, outcomeLower) > 0.6
              ) {
                if (outcomeLower === "yes" || outcomeLower === "no") continue;
                textScore = Math.max(textScore, 0.85);
                matchedOutcomes.push({
                  market: market.question,
                  label,
                  price: priceOf(prices[i]),
                });
              }
            }
            if (market.question !== event.title) {
              const qLower = market.question.toLowerCase();
              if (qLower.includes(queryLower) || tokenOverlap(queryTokens, qLower) > 0.5) {
                textScore = Math.max(textScore, 0.75);
              }
            }
          }

          const topMarket = markets[0];
          const vol24h = event.volume24hr || topMarket.volume24hr || 0;
          const volTotal = event.volume || topMarket.volumeNum || (event.volume ?? topMarket.volumeNum ?? null);
          const liq = event.liquidity || topMarket.liquidityNum || 0;
          const volScore = Math.min(1.0, Math.log1p(vol24h) / 14);
          const liqScore = Math.min(1.0, Math.log1p(liq) / 14);

          const dayChange = Math.abs(topMarket.oneDayPriceChange || 0) * 3;
          const weekChange = Math.abs(topMarket.oneWeekPriceChange || 0) * 2;
          const monthChange = Math.abs(topMarket.oneMonthPriceChange || 0);
          const movementScore = Math.min(1.0, Math.max(dayChange, weekChange, monthChange) * 5);
          const competitive = event.competitive || 0;

          const marketQuality =
            0.5 * volScore + 0.25 * liqScore + 0.15 * movementScore + 0.1 * competitive;
          const relevance = Math.min(1.0, textScore * (0.75 + 0.25 * marketQuality));

          return { event, markets, relevance, matchedOutcomes, topMarket, vol24h, volTotal };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);

      if (scored.length === 0) {
        return outcome(
          failedQueries.length ? "partial" : "empty",
          `No open Polymarket events with open markets found for "${args.query}" (${events.length} returned events were closed or inactive).${failedNote ? `\n${failedNote}` : ""}`,
        );
      }

      scored.sort((a, b) => b.relevance - a.relevance);
      const topEvents = scored.slice(0, limit);

      const results = topEvents.map(({ event, markets, matchedOutcomes, topMarket, vol24h, volTotal }) => {
        const lines: string[] = [];
        lines.push(`**${event.title}**`);
        lines.push(
          `  Volume: ${volTotal === null ? "n/a" : `$${formatNumber(volTotal)}`} total` +
            (vol24h ? ` | $${formatNumber(vol24h)} 24h` : "") +
            (event.endDate ? ` | Ends: ${event.endDate.split("T")[0]}` : ""),
        );
        if (event.slug) lines.push(`  URL: https://polymarket.com/event/${event.slug}`);

        const movement = formatPriceMovement(topMarket);
        if (movement) {
          lines.push(`  Movement of "${topMarket.groupItemTitle?.trim() || topMarket.question}": ${movement}`);
        }
        if (matchedOutcomes.length > 0) {
          lines.push("  Matched outcomes:");
          for (const mo of matchedOutcomes) {
            lines.push(`    → ${mo.label}: ${percent(mo.price)} — "${mo.market}"`);
          }
        }

        const allBinary = markets.every((m) => {
          const outcomes = safeJsonParse<string[]>(m.outcomes, []);
          return outcomes.length === 2 && outcomes.map((o) => o.toLowerCase()).includes("yes");
        });

        if (allBinary && markets.length > 1) {
          const leaderboard = markets
            .map((m) => {
              const prices = safeJsonParse<string[]>(m.outcomePrices, []);
              const outcomes = safeJsonParse<string[]>(m.outcomes, []);
              const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
              const yesPrice = yesIdx >= 0 ? priceOf(prices[yesIdx]) : null;
              return { question: m.groupItemTitle?.trim() || shortenQuestion(m.question), price: yesPrice, market: m };
            })
            .filter((x) => x.price === null || x.price > 0.005)
            .sort((a, b) => (b.price ?? -1) - (a.price ?? -1));

          lines.push("  Odds:");
          for (const item of leaderboard.slice(0, 8)) {
            lines.push(`    ${item.question}: ${percent(item.price)}`, ...marketIds(item.market, "      "));
          }
          if (leaderboard.length > 8) {
            lines.push(`    ... +${leaderboard.length - 8} more`);
          }
        } else {
          for (const market of markets.slice(0, 3)) {
            const outcomes = safeJsonParse<string[]>(market.outcomes, []);
            const prices = safeJsonParse<string[]>(market.outcomePrices, []);
            if (outcomes.length <= 2) {
              const oddsStr = outcomes.map((o, i) => `${o}: ${percent(priceOf(prices[i]))}`).join(" / ");
              lines.push(`  📊 ${market.question} — ${oddsStr}`);
            } else {
              const pairs = outcomes
                .map((o, i) => ({ label: o, price: priceOf(prices[i]) }))
                .sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
              lines.push(`  📊 ${market.question}`);
              for (const p of pairs.slice(0, 5)) {
                lines.push(`    ${p.label}: ${percent(p.price)}`);
              }
              if (pairs.length > 5) {
                lines.push(`    ... +${pairs.length - 5} more outcomes`);
              }
            }
            lines.push(...marketIds(market, "    "));
          }
          if (markets.length > 3) {
            lines.push(`  ... +${markets.length - 3} more markets`);
          }
        }

        return lines.join("\n");
      });

      const header = [
        `Polymarket results for "${args.query}" (${topEvents.length} events, ${queries.length} query expansions):`,
        `${topEvents.length} of ${scored.length} matching open events shown; provider reports more: ${hasMore.includes(true) ? "yes" : hasMore.length ? "no" : "not stated"}.`,
        ...(failedNote ? [failedNote] : []),
        "",
      ].join("\n");

      return outcome(failedQueries.length ? "partial" : "success", header + results.join("\n\n"));
    }),
});

function readDataApi(
  path: string,
  params: Record<string, string | number | undefined>,
  ctx: Pick<ActionContext, "keep" | "signal">,
  isHistory: boolean,
): Effect.Effect<ActionOutcome, never, FreeHttp> {
  return Effect.gen(function* () {
    const url = new URL(`https://data-api.polymarket.com/v2/${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const res = yield* Effect.result(
      freeRequest({
        url: url.href,
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        timeoutMs: 60_000,
        signal: ctx.signal,
        label: path,
        keep: ctx.keep,
      }),
    );

    if (Result.isFailure(res)) {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const msg = res.failure instanceof Error ? res.failure.message : "Polymarket read failed";
      return failed(msg);
    }

    const { status, isJson, payload } = res.success;
    const body = isJson && isRecord(payload) ? payload : null;
    if (status !== 200 || !body || !Array.isArray(body.data) || body.error) {
      return failed(`Polymarket ${path} returned an error or malformed data (HTTP ${status})`);
    }

    const pagination = isRecord(body.pagination) ? body.pagination : null;
    if (isHistory && (!pagination || typeof pagination.has_more !== "boolean")) {
      return failed("Price history omitted its pagination contract");
    }
    if (
      isHistory &&
      body.data.some((row) => {
        const rec = isRecord(row) ? row : null;
        return (
          !rec ||
          typeof rec.price !== "number" ||
          !Number.isFinite(rec.price) ||
          rec.price < 0 ||
          rec.price > 1 ||
          typeof rec.timestamp !== "number" ||
          !Number.isSafeInteger(rec.timestamp)
        );
      })
    ) {
      return failed("Price history returned an invalid price or epoch timestamp");
    }
    if (!isHistory && body.data.some((row) => !isRecord(row) || typeof row.status !== "string")) {
      return failed("Resolution response omitted its status");
    }
    if (
      isHistory &&
      pagination?.has_more &&
      (typeof pagination.next_cursor !== "string" || !pagination.next_cursor)
    ) {
      return failed("Price history claims more pages but provides no cursor");
    }

    const json = JSON.stringify(body);
    const truncated = json.length > 60_000;
    const paging =
      isHistory && pagination
        ? {
            has_more: pagination.has_more as boolean,
            next_cursor: pagination.has_more ? (pagination.next_cursor as string) : null,
          }
        : undefined;

    return outcome(
      truncated ? "partial" : body.data.length ? "success" : "empty",
      `${paging ? `Pagination: has_more: ${paging.has_more}; next_cursor: ${paging.next_cursor ?? "none"}\n` : ""}${
        isHistory
          ? "Prices are market observations in USDC per share; timestamps are epoch seconds. An empty requested resolution does not prove no trading occurred."
          : "Resolution status and payout evidence; expected settlement times are estimates, not deadlines."
      }\n${truncated ? "Output shortened; read the retained original.\n" : ""}${json.slice(0, 60_000)}`,
      paging,
    );
  });
}

const HISTORY_INTERVALS = ["max", "all", "1m", "1w", "1d", "6h", "1h"] as const;

const PolymarketHistorySchema = Schema.Struct({
  token_id: Schema.String.annotate({
    description:
      "Outcome token ID (decimal digits), as the polymarket search prints under Outcome token IDs; not a market or condition ID.",
  }),
  interval: Schema.optionalKey(
    Schema.Literals(HISTORY_INTERVALS).annotate({
      description: "Relative window; exclusive with start/end or as_of.",
    }),
  ),
  start: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Window start, epoch seconds; use with end, exclusive with interval and as_of.",
    }),
  ),
  end: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Window end, epoch seconds, after start.",
    }),
  ),
  as_of: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Price as of this time, epoch seconds; exclusive with interval and start/end.",
    }),
  ),
  bucket_seconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 86400 })).annotate({
      description: "Bucket width in seconds, 60–86400.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })).annotate({
      description: "Points per page, default 200.",
    }),
  ),
  cursor: Schema.optionalKey(
    Schema.String.annotate({ description: "next_cursor from the previous page; repeat the same query with it." }),
  ),
});

export const polymarketHistoryAction = defineAction({
  name: "polymarket_history",
  description:
    "Read one page of Polymarket outcome-token price history. Choose one window: interval, start/end epoch seconds, or as_of epoch seconds. Follow returned cursor using the same query. No trading or account access.",
  schema: PolymarketHistorySchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      if (typeof args.token_id !== "string" || !/^\d+$/.test(args.token_id)) {
        return failed("token_id must be an outcome token's decimal ID, not a market ID");
      }
      const selectors = [
        args.interval !== undefined,
        args.start !== undefined || args.end !== undefined,
        args.as_of !== undefined,
      ].filter(Boolean).length;
      if (selectors !== 1) return failed("Choose exactly one window: interval, start/end, or as_of");
      if (
        args.interval !== undefined &&
        !(HISTORY_INTERVALS as readonly string[]).includes(args.interval)
      ) {
        return failed("Unsupported interval");
      }
      for (const [name, value] of [
        ["start", args.start],
        ["end", args.end],
        ["as_of", args.as_of],
      ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
          return failed(`${name} must be epoch seconds`);
        }
      }
      if (args.end !== undefined && (args.start === undefined || args.end <= args.start)) {
        return failed("end must follow start");
      }
      if (
        args.bucket_seconds !== undefined &&
        (!Number.isInteger(args.bucket_seconds) || args.bucket_seconds < 60 || args.bucket_seconds > 86400)
      ) {
        return failed("bucket_seconds must be 60–86400");
      }
      const limit = args.limit ?? 200;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return failed("limit must be 1–1000");
      }
      return yield* readDataApi(
        "prices-history",
        {
          token_id: args.token_id,
          interval: args.interval,
          start: args.start,
          end: args.end,
          as_of: args.as_of,
          bucket_seconds: args.bucket_seconds,
          limit,
          cursor: args.cursor,
        },
        ctx,
        true,
      );
    }),
});

const PolymarketResolutionSchema = Schema.Struct({
  condition: Schema.optionalKey(
    Schema.String.annotate({
      description: "Up to 20 comma-separated market condition IDs (0x followed by 64 hex digits).",
    }),
  ),
  event_id: Schema.optionalKey(
    Schema.String.annotate({ description: "Up to 20 comma-separated Gamma event IDs (numeric)." }),
  ),
  question_id: Schema.optionalKey(
    Schema.String.annotate({ description: "One UMA question ID (0x followed by 64 hex digits)." }),
  ),
});

export const polymarketResolutionAction = defineAction({
  name: "polymarket_resolution",
  description:
    "Read current Polymarket resolution state by exactly one selector: condition IDs, Gamma event IDs, or one UMA question ID. Returns oracle state and published payouts; settlement estimates are not final outcomes.",
  schema: PolymarketResolutionSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const entries = (
        [
          ["condition", args.condition],
          ["event_id", args.event_id],
          ["question_id", args.question_id],
        ] as const
      ).filter(([, value]) => value !== undefined);
      if (entries.length !== 1) {
        return failed("Choose exactly one of condition, event_id or question_id");
      }
      const [field, rawValue] = entries[0];
      if (typeof rawValue !== "string") return failed("The selector must be a string");
      const ids = [...new Set(rawValue.split(",").map((id) => id.trim()))];
      const maxIds = field === "question_id" ? 1 : 20;
      const validId = (id: string) =>
        field === "event_id" ? /^[1-9]\d*$/.test(id) : /^0x[0-9a-f]{64}$/i.test(id);
      if (!ids.length || ids.length > maxIds || ids.some((id) => !validId(id))) {
        return failed("Invalid selector IDs");
      }
      return yield* readDataApi("resolutions", { [field]: ids.join(",") }, ctx, false);
    }),
});

export const polymarketSource: SourcePlugin = defineSource({
  id: "polymarket",
  group: "markets",
  label: "Polymarket",
  description: "Public prediction-market evidence",
  about:
    "Prediction-market questions with their current odds, volume and liquidity. Prices show what traders are betting, not what is true.",
  providers: [
    { name: "Polymarket Gamma API", url: "https://docs.polymarket.com" },
    { name: "Polymarket Data API", url: "https://docs.polymarket.com" },
  ],
  billing: "Free. No account or key.",
  logo: "polymarket",
  actions: [polymarketAction, polymarketHistoryAction, polymarketResolutionAction],
});

export default polymarketSource;
