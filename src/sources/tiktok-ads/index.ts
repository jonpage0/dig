/**
 * TikTok Ads source plugin (Effect 4.1.5):
 * - tiktok_ads_search: Creative Center top-performing ad search via TikHub (`PaidHttp`, unknown cost)
 * - tiktok_ads_top: Creative Center top-ads spotlight via TikHub (`PaidHttp`, unknown cost)
 * - tiktok_ads_detail: Creative Center ad details + CTR percentile + retention + optional similar ads via TikHub (`PaidHttp`, unknown cost)
 * - tiktok_ad_library: public TikTok Ad Library search via ScrapeCreators (`PaidHttp`, `scrapecreatorsBilling`)
 */
import { Effect, Schema } from "effect";
import type { PaidHttp } from "../../core/http.ts";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  type ActionContext,
  type SourcePlugin,
} from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import {
  MISSING_SCRAPECREATORS_KEY,
  SCRAPECREATORS_PROVIDER,
  asArray,
  asNumber,
  asRecord,
  continuesAfter,
  displayLimit,
  knownCharge,
  scrapecreatorsBilling,
  scrapecreatorsHeaders,
  scrapecreatorsRequest,
} from "../shared/scrapecreators.ts";
import {
  MISSING_TIKHUB_KEY,
  TIKHUB_PROVIDER,
  tikhubHeaders as baseTikhubHeaders,
  tikhubRequest,
} from "../shared/tikhub.ts";
import { TIKTOK_AD_INDUSTRIES, type TikTokAdIndustry } from "./industries.ts";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const PERIOD_VALUES = [7, 30, 120, 180] as const;
const OBJECTIVE_VALUES = [
  "traffic",
  "app_installs",
  "conversion",
  "video_views",
  "reach",
  "lead_generation",
  "product_sales",
] as const;
const PERFORMANCE_VALUES = ["top_20", "top_40", "top_60", "top_80"] as const;
const AD_FORMAT_VALUES = ["spark", "non_spark"] as const;
const ORDER_BY_VALUES = ["for_you", "likes"] as const;

const OBJECTIVE_CODES: Record<(typeof OBJECTIVE_VALUES)[number], number> = {
  traffic: 1,
  app_installs: 2,
  conversion: 3,
  video_views: 4,
  reach: 5,
  lead_generation: 6,
  product_sales: 7,
};
const PERFORMANCE_CODES: Record<(typeof PERFORMANCE_VALUES)[number], number> = {
  top_20: 1,
  top_40: 2,
  top_60: 3,
  top_80: 4,
};
const AD_FORMAT_CODES: Record<(typeof AD_FORMAT_VALUES)[number], number> = {
  spark: 1,
  non_spark: 2,
};

interface CreativeCenterAd {
  readonly id: string;
  readonly title: string | null;
  readonly brand: string | null;
  readonly industryId: string | null;
  readonly industry: string | null;
  readonly objective: string | null;
  readonly costTier: number | null;
  readonly ctr: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
  readonly durationSeconds: number | null;
  readonly cover: string | null;
  readonly landingPage: string | null;
  readonly countries: string[];
  readonly highlight: string | null;
}

interface LibraryAd {
  readonly id: string;
  readonly advertiserIds: string | null;
  readonly advertiser: string | null;
  readonly url: string | null;
  readonly firstShown: string | null;
  readonly lastShown: string | null;
  readonly estimatedAudience: string | null;
  readonly spent: string | null;
  readonly impressions: number | null;
  readonly videoCount: number;
  readonly imageCount: number;
  readonly cover: string | null;
}

const INDUSTRY_BY_ID = new Map(TIKTOK_AD_INDUSTRIES.map((entry) => [entry.id, entry]));
const SUB_INDUSTRIES_BY_NAME = TIKTOK_AD_INDUSTRIES.reduce((byName, entry) => {
  if (entry.parent) {
    byName.set(entry.name.toLowerCase(), [...(byName.get(entry.name.toLowerCase()) ?? []), entry]);
  }
  return byName;
}, new Map<string, TikTokAdIndustry[]>());
const TOP_INDUSTRY_BY_NAME = new Map(
  TIKTOK_AD_INDUSTRIES.filter((entry) => !entry.parent).map((entry) => [entry.name.toLowerCase(), entry]),
);

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function fmtNum(value: number | null): string {
  if (value === null) return "n/a";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function fmtPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}

function fmtDate(epochMs: number | null): string | null {
  if (epochMs === null) return null;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function truncate(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function industryName(id: string | null): string | null {
  if (!id) return null;
  const entry = INDUSTRY_BY_ID.get(id);
  if (!entry) return null;
  return entry.parent ? `${entry.parent} > ${entry.name}` : entry.name;
}

function topLevelIndustryId(id: string | null): string | null {
  if (!id) return null;
  const entry = INDUSTRY_BY_ID.get(id);
  if (!entry) return id;
  if (!entry.parent) return entry.id;
  return TOP_INDUSTRY_BY_NAME.get(entry.parent.toLowerCase())?.id ?? entry.id;
}

function industryByName(name: string): { entry?: TikTokAdIndustry; error?: string } {
  const top = TOP_INDUSTRY_BY_NAME.get(name.toLowerCase());
  if (top) return { entry: top };
  const subs = SUB_INDUSTRIES_BY_NAME.get(name.toLowerCase()) ?? [];
  if (subs.length > 1) {
    return {
      error: `TikTok ad industry "${name}" exists under more than one parent: ${subs.map((entry) => `${entry.parent} > ${entry.name} (${entry.id})`).join(", ")}. To choose one, pass the id.`,
    };
  }
  return { entry: subs[0] };
}

function resolveIndustryIds(input: string | undefined): { ids: string | undefined; error?: string } {
  if (!input?.trim()) return { ids: undefined };
  const whole = industryByName(input.trim());
  if (whole.error) return { ids: undefined, error: whole.error };
  if (whole.entry) return { ids: whole.entry.id };
  const ids: string[] = [];
  for (const raw of input.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    if (/^\d{11}$/.test(token)) {
      ids.push(token);
      continue;
    }
    const { entry, error } = industryByName(token);
    if (error) return { ids: undefined, error };
    if (!entry) {
      return {
        ids: undefined,
        error: `Unknown TikTok ad industry "${token}". Pass an 11-digit industry id or one of the published names (top level: ${TIKTOK_AD_INDUSTRIES.filter((e) => !e.parent)
          .map((e) => e.name)
          .join(", ")}).`,
      };
    }
    ids.push(entry.id);
  }
  return { ids: ids.length ? ids.join(",") : undefined };
}

function objectiveLabel(key: unknown): string | null {
  const value = asTrimmedString(key);
  return value ? value.replace(/^campaign_objective_/, "") : null;
}

function tikhubPostHeaders(): Record<string, string> | null {
  const base = baseTikhubHeaders();
  if (!base) return null;
  return { ...base, "Content-Type": "application/json" };
}

function tikhubPost(
  endpoint: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<
  { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly cancelled: boolean; readonly error: string },
  never,
  PaidHttp
> {
  return Effect.gen(function* () {
    const res = yield* tikhubRequest({
      path: endpoint,
      method: "POST",
      body,
      headers,
      ctx,
      label: endpoint,
    });
    if (!res.ok) {
      if (res.cancelled) return { ok: false as const, cancelled: true, error: res.error };
      if (res.status !== undefined) {
        return { ok: false as const, cancelled: false, error: `TikHub ${endpoint} returned HTTP ${res.status}` };
      }
      return {
        ok: false as const,
        cancelled: false,
        error: `${res.error}. TikHub may have received and charged this request, but no complete response arrived; its cost is unknown.`,
      };
    }
    const outer = asRecord(res.payload);
    if (!outer) {
      return { ok: false as const, cancelled: false, error: `TikHub ${endpoint} returned HTTP ${res.status}` };
    }
    const outerCode = asNumber(outer.code);
    if (outerCode !== 200) {
      return {
        ok: false as const,
        cancelled: false,
        error: redactText(
          `TikHub ${endpoint} returned code ${outerCode ?? "unknown"}: ${asTrimmedString(outer.message) ?? asTrimmedString(outer.detail) ?? "no message"}`,
          knownSecrets(),
        ),
      };
    }
    const inner = asRecord(outer.data);
    if (!inner) return { ok: true as const, data: null };
    const innerCode = asNumber(inner.code);
    if (innerCode !== null && innerCode !== 0) {
      return {
        ok: false as const,
        cancelled: false,
        error: redactText(
          `TikTok Creative Center returned code ${innerCode}: ${asTrimmedString(inner.msg) ?? "no message"}`,
          knownSecrets(),
        ),
      };
    }
    return { ok: true as const, data: "data" in inner ? inner.data : inner };
  });
}

function normalizeCreativeCenterAd(raw: unknown): CreativeCenterAd | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asTrimmedString(record.id);
  if (!id) return null;
  const video = asRecord(record.video_info);
  const industryId = asTrimmedString(record.industry_key)?.replace(/^label_/, "") ?? null;
  const countries = asArray(record.country_code)
    .map(asTrimmedString)
    .filter((value): value is string => value !== null);
  return {
    id,
    title: asTrimmedString(record.ad_title),
    brand: asTrimmedString(record.brand_name),
    industryId,
    industry: industryName(industryId),
    objective: objectiveLabel(record.objective_key),
    costTier: asNumber(record.cost),
    ctr: asNumber(record.ctr),
    likes: asNumber(record.like),
    comments: asNumber(record.comment),
    shares: asNumber(record.share),
    durationSeconds: asNumber(video?.duration),
    cover: asTrimmedString(video?.cover),
    landingPage: asTrimmedString(record.landing_page),
    countries,
    highlight: asTrimmedString(record.highlight) ?? asTrimmedString(record.highlight_text),
  };
}

function formatCreativeCenterAd(ad: CreativeCenterAd, index: number): string {
  const lines: string[] = [];
  const title = truncate(ad.title, 160) ?? "(untitled)";
  lines.push(`${index + 1}. ${title}`);
  lines.push(`   Ad id: ${ad.id}${ad.brand ? ` | Brand: ${ad.brand}` : ""}`);
  lines.push(
    `   CTR: ${fmtPercent(ad.ctr)} | Likes: ${fmtNum(ad.likes)}` +
      (ad.comments !== null ? ` | Comments: ${fmtNum(ad.comments)}` : "") +
      (ad.shares !== null ? ` | Shares: ${fmtNum(ad.shares)}` : "") +
      (ad.costTier !== null ? ` | Cost tier: ${ad.costTier}` : "") +
      (ad.durationSeconds !== null ? ` | Duration: ${ad.durationSeconds.toFixed(0)}s` : ""),
  );
  const context: string[] = [];
  if (ad.industry) context.push(`Industry: ${ad.industry}`);
  else if (ad.industryId) context.push(`Industry id: ${ad.industryId}`);
  if (ad.objective) context.push(`Objective: ${ad.objective}`);
  if (ad.countries.length) context.push(`Countries: ${ad.countries.join(", ")}`);
  if (context.length) lines.push(`   ${context.join(" | ")}`);
  if (ad.landingPage) lines.push(`   Landing page: ${ad.landingPage}`);
  if (ad.highlight) lines.push(`   Why it works (TikTok): ${truncate(ad.highlight, 240)}`);
  if (ad.cover) lines.push(`   Cover: ${ad.cover}`);
  return lines.join("\n");
}

const CREATIVE_CENTER_CAVEAT =
  "TikTok's Creative Center is a curated set of popular ads, not a census; absence here does not mean an advertiser is not running ads. CTR and likes are TikTok-reported; cost tier is TikTok's relative bucket, not spend.";

// ---------------------------------------------------------------------------
// Action 1: tiktok_ads_search (TikHub, unknown billing)
// ---------------------------------------------------------------------------

const TikTokAdsSearchSchema = Schema.Struct({
  keyword: Schema.optionalKey(
    Schema.String.annotate({ description: "Search keyword; omit to browse under the other filters." }),
  ),
  industry: Schema.optionalKey(
    Schema.String.annotate({
      description: "Published industry names or 11-digit ids, comma-separated (e.g. 'Travel', 'Live Events').",
    }),
  ),
  country_code: Schema.optionalKey(
    Schema.String.annotate({ description: "Two-letter country code (default: US)." }),
  ),
  period: Schema.optionalKey(
    Schema.Literals(PERIOD_VALUES).annotate({ description: "Lookback window in days (default: 180)." }),
  ),
  objective: Schema.optionalKey(
    Schema.Literals(OBJECTIVE_VALUES).annotate({ description: "Campaign objective." }),
  ),
  performance: Schema.optionalKey(
    Schema.Literals(PERFORMANCE_VALUES).annotate({ description: "Performance band by CTR percentile." }),
  ),
  order_by: Schema.optionalKey(
    Schema.Literals(ORDER_BY_VALUES).annotate({
      description: "for_you (TikTok's ranking, default) or likes.",
    }),
  ),
  ad_format: Schema.optionalKey(
    Schema.Literals(AD_FORMAT_VALUES).annotate({ description: "Spark Ads or non-Spark ads." }),
  ),
  ad_language: Schema.optionalKey(
    Schema.String.annotate({ description: "Ad language code, e.g. en." }),
  ),
  page: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Page number (default: 1)." }),
  ),
  limit: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT })).annotate({
      description: "Ads per page (default: 20, max: 50).",
    }),
  ),
});

export const tiktokAdsSearchAction = defineAction({
  name: "tiktok_ads_search",
  description:
    "Search TikTok's Creative Center (via TikHub) for top-performing ads by keyword, industry, country, period, objective, and performance band. " +
    "Returns ad id, title, brand, industry, objective, CTR, likes, cost tier, duration, cover, and landing page. " +
    "Requires TIKHUB_API_KEY. The Creative Center is curated, not a census. Metered per request.",
  schema: TikTokAdsSearchSchema,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const headers = tikhubPostHeaders();
      if (!headers) return failed(MISSING_TIKHUB_KEY);
      const industry = resolveIndustryIds(args.industry);
      if (industry.error) return failed(industry.error);
      if (args.period !== undefined && !(PERIOD_VALUES as readonly number[]).includes(args.period)) {
        return failed(`period must be one of ${PERIOD_VALUES.join(", ")} days.`);
      }
      if (args.objective !== undefined && !(args.objective in OBJECTIVE_CODES)) {
        return failed(`objective must be one of ${OBJECTIVE_VALUES.join(", ")}.`);
      }
      if (args.performance !== undefined && !(args.performance in PERFORMANCE_CODES)) {
        return failed(`performance must be one of ${PERFORMANCE_VALUES.join(", ")}.`);
      }
      if (args.ad_format !== undefined && !(args.ad_format in AD_FORMAT_CODES)) {
        return failed(`ad_format must be one of ${AD_FORMAT_VALUES.join(", ")}.`);
      }
      if (args.order_by !== undefined && !(ORDER_BY_VALUES as readonly string[]).includes(args.order_by)) {
        return failed(`order_by must be one of ${ORDER_BY_VALUES.join(", ")}.`);
      }

      const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
      const page = Math.max(1, Math.floor(args.page ?? 1));
      const countryCode = (args.country_code ?? "US").trim().toUpperCase();
      const period = args.period ?? 180;
      const body: Record<string, unknown> = {
        period,
        page,
        limit,
        order_by: args.order_by ?? "for_you",
        country_code: countryCode,
      };
      if (args.keyword?.trim()) body.keyword = args.keyword.trim();
      if (industry.ids) body.industry = industry.ids;
      if (args.objective) body.objective = OBJECTIVE_CODES[args.objective];
      if (args.performance) body.like = PERFORMANCE_CODES[args.performance];
      if (args.ad_format) body.ad_format = AD_FORMAT_CODES[args.ad_format];
      if (args.ad_language?.trim()) body.ad_language = args.ad_language.trim();

      const res = yield* tikhubPost("/api/v1/tiktok/ads/search_ads", body, headers, ctx);
      if (!res.ok) return outcome(res.cancelled ? "cancelled" : "failed", `ERROR: ${res.error}`);

      const data = asRecord(res.data);
      if (!data || !Array.isArray(data.materials)) {
        return failed(
          "TikTok Creative Center response has no materials array; response shape unavailable, not an empty search.",
        );
      }
      const ads = asArray(data.materials)
        .map(normalizeCreativeCenterAd)
        .filter((ad): ad is CreativeCenterAd => ad !== null);
      if (data.materials.length > 0 && ads.length === 0) {
        return failed("TikTok Creative Center returned materials but none could be normalized; not an empty search.");
      }
      const pagination = asRecord(data.pagination);
      const total = asNumber(pagination?.total_count) ?? asNumber(pagination?.total);
      const hasMore = pagination?.has_more === true;

      const filters: string[] = [`country ${countryCode}`, `period ${period}d`];
      if (args.keyword?.trim()) filters.unshift(`keyword "${args.keyword.trim()}"`);
      if (industry.ids) {
        filters.push(
          `industry ${industry.ids
            .split(",")
            .map((id) => industryName(id) ?? id)
            .join(" + ")}`,
        );
      }
      if (args.objective) filters.push(`objective ${args.objective}`);
      if (args.performance) filters.push(`performance ${args.performance}`);
      if (args.ad_format) filters.push(`format ${args.ad_format}`);
      if (args.ad_language) filters.push(`language ${args.ad_language}`);
      const header = `TikTok Creative Center search (${filters.join(", ")}; order ${String(body.order_by)}; page ${page})`;

      if (ads.length === 0) {
        return outcome(
          "empty",
          `${header}\n\nNo ads matched. ${CREATIVE_CENTER_CAVEAT} Try fewer filters or a broader period.`,
          { provider: "tikhub", ads: 0, total, hasMore: false, page, cost_note: "metered TikHub request" },
        );
      }
      return outcome(
        "success",
        [
          header,
          `Showing ${ads.length} of ${total ?? "?"} ads${hasMore ? "; more pages available" : ""}.`,
          "",
          ...ads.map(formatCreativeCenterAd),
          "",
          CREATIVE_CENTER_CAVEAT,
        ].join("\n"),
        { provider: "tikhub", ads: ads.length, total, hasMore, page, ad_ids: ads.map((ad) => ad.id) },
      );
    }),
});

// ---------------------------------------------------------------------------
// Action 2: tiktok_ads_top (TikHub, unknown billing)
// ---------------------------------------------------------------------------

const TikTokAdsTopSchema = Schema.Struct({
  industry: Schema.optionalKey(
    Schema.String.annotate({
      description: "One published industry name or 11-digit id; omit for the cross-industry list.",
    }),
  ),
  page: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Page number (default: 1)." }),
  ),
  limit: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT })).annotate({
      description: "Ads per page (default: 20, max: 50).",
    }),
  ),
});

export const tiktokAdsTopAction = defineAction({
  name: "tiktok_ads_top",
  description:
    "List TikTok's Creative Center top-ads spotlight (via TikHub): the ads TikTok itself highlights, optionally within one industry, each with TikTok's own note on why it works plus CTR, likes, and cost tier. " +
    "Requires TIKHUB_API_KEY. Metered per request.",
  schema: TikTokAdsTopSchema,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const headers = tikhubPostHeaders();
      if (!headers) return failed(MISSING_TIKHUB_KEY);
      const industry = resolveIndustryIds(args.industry);
      if (industry.error) return failed(industry.error);
      if (industry.ids?.includes(",")) return failed("tiktok_ads_top accepts one industry at a time.");

      const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
      const page = Math.max(1, Math.floor(args.page ?? 1));
      const body: Record<string, unknown> = { page, limit };
      if (industry.ids) body.industry = industry.ids;

      const res = yield* tikhubPost("/api/v1/tiktok/ads/get_top_ads_spotlight", body, headers, ctx);
      if (!res.ok) return outcome(res.cancelled ? "cancelled" : "failed", `ERROR: ${res.error}`);

      const data = asRecord(res.data);
      if (!data || !Array.isArray(data.materials)) {
        return failed(
          "TikTok Creative Center spotlight response has no materials array; response shape unavailable, not an empty spotlight.",
        );
      }
      const ads = asArray(data.materials)
        .map(normalizeCreativeCenterAd)
        .filter((ad): ad is CreativeCenterAd => ad !== null);
      if (data.materials.length > 0 && ads.length === 0) {
        return failed("TikTok Creative Center returned spotlight materials but none could be normalized.");
      }
      const pagination = asRecord(data.pagination);
      const total = asNumber(pagination?.total) ?? asNumber(pagination?.total_count);
      const hasMore = pagination?.has_more === true;
      const scope = industry.ids ? (industryName(industry.ids) ?? industry.ids) : "all industries";
      const header = `TikTok Creative Center top-ads spotlight (${scope}; page ${page})`;

      if (ads.length === 0) {
        return outcome(
          "empty",
          `${header}\n\nNo spotlight ads returned. TikTok curates spotlight lists for only some industries; omit industry for the cross-industry list, or use tiktok_ads_search with an industry filter. ${CREATIVE_CENTER_CAVEAT}`,
          { provider: "tikhub", ads: 0, total, hasMore: false, page },
        );
      }
      return outcome(
        "success",
        [
          header,
          `Showing ${ads.length} of ${total ?? "?"} spotlight ads${hasMore ? "; more pages available" : ""}. Spotlight rows carry TikTok's note but no title; call tiktok_ads_detail on an ad id for its title, objective, and landing page.`,
          "",
          ...ads.map(formatCreativeCenterAd),
          "",
          CREATIVE_CENTER_CAVEAT,
        ].join("\n"),
        { provider: "tikhub", ads: ads.length, total, hasMore, page, ad_ids: ads.map((ad) => ad.id) },
      );
    }),
});

// ---------------------------------------------------------------------------
// Action 3: tiktok_ads_detail (TikHub, unknown billing)
// ---------------------------------------------------------------------------

interface Retention {
  readonly seconds: number;
  readonly points: readonly { readonly second: number; readonly value: number }[];
  readonly highlightSeconds: readonly number[];
}

function normalizeRetention(raw: unknown): Retention | null {
  const record = asRecord(raw);
  if (!record) return null;
  const points = asArray(record.analysis)
    .map((entry) => {
      const point = asRecord(entry);
      const second = asNumber(point?.second);
      const value = asNumber(point?.value);
      return second === null || value === null ? null : { second, value };
    })
    .filter((point): point is { second: number; value: number } => point !== null);
  if (points.length === 0) return null;
  return {
    seconds: asNumber(record.duration) ?? points[points.length - 1]!.second + 1,
    points,
    highlightSeconds: asArray(record.highlight)
      .map(asNumber)
      .filter((value): value is number => value !== null),
  };
}

function formatRetention(retention: Retention): string {
  const sample = retention.points
    .filter((point) => point.second <= 30 && (point.second < 8 || point.second % 5 === 0))
    .map((point) => `${point.second}s ${fmtPercent(point.value)}`)
    .join(", ");
  const drop = retention.points.reduce<{ second: number; delta: number } | null>((worst, point, index) => {
    if (index === 0) return worst;
    const delta = retention.points[index - 1]!.value - point.value;
    return !worst || delta > worst.delta ? { second: point.second, delta } : worst;
  }, null);
  const lines = [`   Retention curve (${retention.seconds}s, share of viewers still watching, CTR-weighted): ${sample}`];
  if (drop && drop.delta > 0) lines.push(`   Largest drop: ${fmtPercent(drop.delta)} at second ${drop.second}`);
  if (retention.highlightSeconds.length) {
    lines.push(`   TikTok-flagged key frames: second ${retention.highlightSeconds.join(", ")}`);
  }
  return lines.join("\n");
}

const TikTokAdsDetailSchema = Schema.Struct({
  ad_id: Schema.String.annotate({
    description: "Creative Center ad id from tiktok_ads_search or tiktok_ads_top.",
  }),
  analytics: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Also fetch CTR percentile and retention curve (default: true; two extra requests).",
    }),
  ),
  similar: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Also fetch TikTok's recommended similar ads (default: false; one extra request).",
    }),
  ),
});

export const tiktokAdsDetailAction = defineAction({
  name: "tiktok_ads_detail",
  description:
    "Fetch one TikTok Creative Center ad by id (via TikHub) with its title, brand, objective, landing page, countries, CTR, likes, comments, shares, and cost tier; by default also its CTR percentile within the industry and second-by-second retention curve, and optionally TikTok's recommended similar ads. " +
    "Requires TIKHUB_API_KEY. Each analytics block is a separate metered request.",
  schema: TikTokAdsDetailSchema,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const headers = tikhubPostHeaders();
      if (!headers) return failed(MISSING_TIKHUB_KEY);
      const adId = args.ad_id?.trim();
      if (!adId) return failed("ad_id is required.");
      const withAnalytics = args.analytics ?? true;
      const withSimilar = args.similar ?? false;

      const detailResult = yield* tikhubPost("/api/v1/tiktok/ads/get_ads_detail", { ads_id: adId }, headers, ctx);
      if (!detailResult.ok) return outcome(detailResult.cancelled ? "cancelled" : "failed", `ERROR: ${detailResult.error}`);

      const ad = normalizeCreativeCenterAd(detailResult.data);
      if (!ad) {
        return outcome(
          "empty",
          `No Creative Center ad found for id ${adId}. Ids come from tiktok_ads_search or tiktok_ads_top; the library only covers ads TikTok has featured.`,
        );
      }

      const detailRecord = asRecord(detailResult.data);
      const objectives = asArray(detailRecord?.objectives)
        .map((entry) => objectiveLabel(asRecord(entry)?.label))
        .filter((value): value is string => value !== null);
      const source = asTrimmedString(detailRecord?.source);
      const voiceOver = detailRecord?.voice_over === true;
      const patternLabels = asArray(detailRecord?.pattern_label)
        .map(asTrimmedString)
        .filter((value): value is string => value !== null);

      const notes: string[] = [];
      let percentile: number | null = null;
      let retention: Retention | null = null;
      let similar: CreativeCenterAd[] = [];
      const sendSimilar = withSimilar && !!ad.industryId;

      const [percentileResult, retentionResult, similarResult] = yield* Effect.all(
        [
          withAnalytics
            ? tikhubPost("/api/v1/tiktok/ads/get_ad_percentile", { material_id: adId, metric: "ctr_percentile" }, headers, ctx)
            : Effect.succeed(null),
          withAnalytics
            ? tikhubPost("/api/v1/tiktok/ads/get_ad_keyframe_analysis", { material_id: adId, metric: "retain_ctr" }, headers, ctx)
            : Effect.succeed(null),
          sendSimilar
            ? tikhubPost(
                "/api/v1/tiktok/ads/get_recommended_ads",
                {
                  material_id: adId,
                  country_code: ad.countries[0] ?? "US",
                  industry: topLevelIndustryId(ad.industryId),
                },
                headers,
                ctx,
              )
            : Effect.succeed(null),
        ],
        { concurrency: "unbounded" },
      );

      if (percentileResult && !percentileResult.ok) notes.push(`CTR percentile unavailable: ${percentileResult.error}`);
      else if (percentileResult) percentile = asNumber(asRecord(percentileResult.data)?.ctr_percentile);

      if (retentionResult && !retentionResult.ok) notes.push(`Retention curve unavailable: ${retentionResult.error}`);
      else if (retentionResult) retention = normalizeRetention(retentionResult.data);

      if (withSimilar && !ad.industryId) {
        notes.push("Similar ads skipped: the ad carries no industry code, and TikHub would default to Games.");
      } else if (similarResult && !similarResult.ok) {
        notes.push(`Similar ads unavailable: ${similarResult.error}`);
      } else if (similarResult) {
        similar = asArray(asRecord(similarResult.data)?.materials)
          .map(normalizeCreativeCenterAd)
          .filter((entry): entry is CreativeCenterAd => entry !== null);
      }

      const lines: string[] = [`TikTok Creative Center ad ${ad.id}`, "", formatCreativeCenterAd(ad, 0)];
      const extra: string[] = [];
      if (objectives.length > 1) extra.push(`All objectives: ${objectives.join(", ")}`);
      if (source) extra.push(`Source: ${source}`);
      if (voiceOver) extra.push("Voice-over: yes");
      if (patternLabels.length) extra.push(`Creative patterns: ${patternLabels.join(", ")}`);
      if (extra.length) lines.push(`   ${extra.join(" | ")}`);
      if (withAnalytics) {
        lines.push("");
        lines.push(
          percentile === null
            ? "   CTR percentile: unavailable"
            : `   CTR percentile within industry (180d): ${fmtPercent(percentile)} — beats that share of peer ads`,
        );
        if (retention) lines.push(formatRetention(retention));
        else lines.push("   Retention curve: unavailable");
      }
      if (withSimilar) {
        lines.push("", `Similar ads (TikTok recommended, ${similar.length}):`);
        if (similar.length) lines.push(...similar.map(formatCreativeCenterAd));
        else lines.push("   none returned");
      }
      if (notes.length) lines.push("", ...notes.map((note) => `Note: ${note}`));
      lines.push("", CREATIVE_CENTER_CAVEAT);

      return outcome(notes.length ? "partial" : "success", lines.join("\n"), {
        provider: "tikhub",
        ad_id: ad.id,
        ctr: ad.ctr,
        ctr_percentile: percentile,
        likes: ad.likes,
        industry: ad.industry,
        objective: ad.objective,
        similar: similar.map((entry) => entry.id),
        requests: 1 + (withAnalytics ? 2 : 0) + (sendSimilar ? 1 : 0),
      });
    }),
});

// ---------------------------------------------------------------------------
// Action 4: tiktok_ad_library (ScrapeCreators, scrapecreatorsBilling)
// ---------------------------------------------------------------------------

function normalizeLibraryAd(raw: unknown): LibraryAd | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asTrimmedString(record.id);
  if (!id) return null;
  const videos = asArray(record.videos);
  const images = asArray(record.image_urls);
  const firstVideo = asRecord(videos[0]);
  const rawImp = asNumber(record.impression);
  return {
    id,
    advertiserIds: asTrimmedString(record.adv_biz_ids),
    advertiser: asTrimmedString(record.name),
    url: asTrimmedString(record.url) ?? `https://library.tiktok.com/ads/detail/?ad_id=${id}`,
    firstShown: fmtDate(asNumber(record.first_shown_date)),
    lastShown: fmtDate(asNumber(record.last_shown_date)),
    estimatedAudience: asTrimmedString(record.estimated_audience),
    spent: asTrimmedString(record.spent),
    impressions: rawImp === null || rawImp === 0 ? null : rawImp,
    videoCount: videos.length,
    imageCount: images.length,
    cover: asTrimmedString(firstVideo?.cover_img) ?? asTrimmedString(images[0]),
  };
}

function formatLibraryAd(ad: LibraryAd, index: number): string {
  const lines = [`${index + 1}. ${ad.advertiser ?? "(advertiser unknown)"} — ad ${ad.id}`];
  if (ad.advertiserIds) lines.push(`   Advertiser business IDs: ${ad.advertiserIds}`);
  const run =
    ad.firstShown && ad.lastShown
      ? ad.firstShown === ad.lastShown
        ? `Shown: ${ad.firstShown}`
        : `Shown: ${ad.firstShown} → ${ad.lastShown}`
      : ad.firstShown
        ? `First shown: ${ad.firstShown}`
        : null;
  const facts: string[] = [];
  if (run) facts.push(run);
  if (ad.estimatedAudience) facts.push(`Audience: ${ad.estimatedAudience}`);
  if (ad.impressions !== null) facts.push(`Impressions: ${fmtNum(ad.impressions)}`);
  if (ad.spent) facts.push(`Spent: ${ad.spent}`);
  facts.push(`Media: ${ad.videoCount} video${ad.videoCount === 1 ? "" : "s"}, ${ad.imageCount} image${ad.imageCount === 1 ? "" : "s"}`);
  lines.push(`   ${facts.join(" | ")}`);
  if (ad.url) lines.push(`   Library page: ${ad.url}`);
  if (ad.cover) lines.push(`   Cover: ${ad.cover}`);
  return lines.join("\n");
}

const TikTokAdLibrarySchema = Schema.Struct({
  advertiser_name: Schema.optionalKey(
    Schema.String.annotate({
      description: "Advertiser to look up in TikTok's public Ad Library. Use either this or query.",
    }),
  ),
  adv_biz_ids: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1)).annotate({
      description:
        "Exact TikTok advertiser business ID from returned ads or See all ads link. Requires advertiser_name; ID-only searches are unsupported.",
    }),
  ),
  query: Schema.optionalKey(
    Schema.String.annotate({
      description: "Free-text library search. Use either this or advertiser_name.",
    }),
  ),
  cursor: Schema.optionalKey(
    Schema.String.annotate({ description: "Opaque cursor from a previous call." }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT })).annotate({
      description:
        "Max ads to display from the page (default: every ad returned; max: 50). Does not reduce what is fetched or billed.",
    }),
  ),
});

export const tiktokAdLibraryAction = defineAction({
  name: "tiktok_ad_library",
  description:
    "Search TikTok's public Ad Library (via ScrapeCreators) for the ads an advertiser is actually running: advertiser, first/last shown dates, estimated audience band, and creative media. " +
    "Search by advertiser_name (resolved to a TikTok advertiser entity when one matches) or by free-text query, not both. " +
    "Requires SCRAPECREATORS_API_KEY. 1 credit per request. No spend or targeting is disclosed for ordinary ads.",
  schema: TikTokAdLibrarySchema,
  billing: scrapecreatorsBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const headers = scrapecreatorsHeaders();
      if (!headers) return failed(MISSING_SCRAPECREATORS_KEY);
      const advertiser = args.advertiser_name?.trim();
      const query = args.query?.trim();
      const advertiserIds = args.adv_biz_ids?.trim();
      if (args.adv_biz_ids !== undefined && (!advertiserIds || !advertiser)) {
        return failed("adv_biz_ids requires a nonempty advertiser_name and business ID; ID-only searches are unsupported.");
      }
      if (!advertiser && !query) return failed("Provide advertiser_name or query.");
      if (advertiser && query) return failed("Provide either advertiser_name or query, not both.");
      const limit = displayLimit(args.limit, MAX_LIMIT);

      const response = yield* scrapecreatorsRequest(
        "/v1/tiktok/ad-library/search",
        {
          advertiser_name: advertiser,
          adv_biz_ids: advertiserIds,
          query,
          cursor: args.cursor?.trim() || undefined,
        },
        headers,
        ctx,
        "ScrapeCreators TikTok Ad Library",
      );
      if (!response.ok) return outcome(response.cancelled ? "cancelled" : "failed", `ERROR: ${response.error}`);

      const payload = response.payload;
      if (!Array.isArray(payload.ads)) {
        return failed(
          "TikTok Ad Library response did not contain an ads array; response shape unavailable, not an empty search.",
        );
      }
      const allAds = asArray(payload.ads)
        .map(normalizeLibraryAd)
        .filter((ad): ad is LibraryAd => ad !== null);
      if (payload.ads.length > 0 && allAds.length === 0) {
        return failed("TikTok Ad Library returned ads but none could be normalized; not an empty search.");
      }
      const ads = allAds.slice(0, limit);
      const matches = asArray(payload.advertiser_matches)
        .map((entry) => {
          const record = asRecord(entry);
          const name = asTrimmedString(record?.name);
          const ids = asTrimmedString(record?.ids);
          return name ? `${name}${ids ? ` (${ids})` : ""}` : null;
        })
        .filter((value): value is string => value !== null);
      const resolved = asTrimmedString(payload.resolved_advertiser_name);
      const total = asNumber(payload.total);
      const cursor = asTrimmedString(payload.cursor);
      const hasMore = payload.has_more === true;
      const credits = knownCharge(response.charges);

      const header = advertiser ? `TikTok Ad Library: advertiser "${advertiser}"` : `TikTok Ad Library: query "${query}"`;
      const scope: string[] = [];
      if (advertiser) {
        scope.push(
          advertiserIds
            ? `Requested exact advertiser business IDs: ${advertiserIds}, with name "${advertiser}". Returned per-ad IDs remain the evidence of identity.`
            : matches.length
              ? `Resolved advertiser entity: ${matches.join("; ")}. Results are that entity's ads.`
              : `No advertiser entity matched "${advertiser}"; TikTok fell back to a name search, so results may be unrelated advertisers whose ads mention those words.`,
        );
        if (resolved && resolved !== advertiser) scope.push(`TikTok resolved the name as "${resolved}".`);
      }

      if (ads.length === 0) {
        return outcome(
          "empty",
          [
            header,
            ...scope,
            "",
            "No ads returned. An empty library result means no public ad matched this search, not that the advertiser has never advertised.",
          ].join("\n"),
          {
            provider: "scrapecreators",
            ads: 0,
            total,
            hasMore,
            cursor,
            requested_adv_biz_ids: advertiserIds ?? null,
            entityMatched: matches.length > 0,
            credits_charged: credits,
          },
        );
      }

      const text = [
        header,
        ...scope,
        ...(allAds.length < payload.ads.length
          ? [`Partial normalization: ${allAds.length} of ${payload.ads.length} returned ads could be read.`]
          : []),
        `${allAds.length > ads.length ? `${ads.length} shown of ${allAds.length} returned on this page` : `Showing ${ads.length}`}${total !== null ? `; library reports ${fmtNum(total)} total` : ""}${hasMore && cursor ? `; pass cursor="${cursor}" for the next page${continuesAfter(ads.length, allAds.length, "ads")}` : ""}.`,
        "",
        ...ads.map(formatLibraryAd),
        "",
        "Dates and audience bands are TikTok's disclosures; the library shows no spend or targeting for ordinary commercial ads.",
      ].join("\n");

      return outcome(allAds.length < payload.ads.length ? "partial" : "success", text, {
        provider: "scrapecreators",
        ads: ads.length,
        total,
        hasMore,
        cursor: hasMore ? cursor : null,
        entityMatched: matches.length > 0,
        resolved_advertiser: resolved,
        requested_adv_biz_ids: advertiserIds ?? null,
        advertiser_ids: Array.from(new Set(ads.flatMap((ad) => (ad.advertiserIds ? [ad.advertiserIds] : [])))),
        credits_charged: credits,
        ad_ids: ads.map((ad) => ad.id),
      });
    }),
});

export const tiktokAdsSource: SourcePlugin = defineSource({
  id: "tiktok-ads",
  group: "markets",
  label: "TikTok ads",
  description: "Creative Center and public Ad Library",
  about:
    "TikTok advertising: top ads from TikTok's Creative Center with click-through and retention analytics, and the public Ad Library of what a named advertiser is running.",
  providers: [TIKHUB_PROVIDER, SCRAPECREATORS_PROVIDER],
  billing: "Creative Center through TikHub (cost shown as unknown); Ad Library through ScrapeCreators credits.",
  logo: "tiktok",
  env: ["TIKHUB_API_KEY", "TIKHUB_BASE_URL", "SCRAPECREATORS_API_KEY"],
  keys: ["TIKHUB_API_KEY", "SCRAPECREATORS_API_KEY"],
  credential: "TIKHUB_API_KEY for Creative Center; SCRAPECREATORS_API_KEY for Ad Library",
  actions: [tiktokAdsSearchAction, tiktokAdsTopAction, tiktokAdsDetailAction, tiktokAdLibraryAction],
});

export default tiktokAdsSource;
