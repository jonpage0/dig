/**
 * Facebook Ads source plugin (Effect 4.1.5):
 * - facebook_ad_library: Meta Ad Library search, company ads, single ad details, advertiser lookup, and ad transcripts.
 *
 * Uses `scrapecreatorsRequest` for GET calls and `paidRequest` (`PaidHttp`, zero retries) for POST continuation pages
 * when a cursor is present on `search`/`company`, with `scrapecreatorsBilling`.
 */
import { Effect, Result, Schema } from "effect";
import { paidRequest, type PaidHttp } from "../../core/http.ts";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  type ActionContext,
  type ActionOutcome,
  type OutcomeStatus,
  type SourcePlugin,
} from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import {
  CACHE_MAX_AGE_VALUES,
  MISSING_SCRAPECREATORS_KEY,
  SCRAPECREATORS_BASE,
  SCRAPECREATORS_BILLING,
  SCRAPECREATORS_PROVIDER,
  SCRAPECREATORS_TIMEOUT_MS,
  UNANSWERED_SCRAPECREATORS_COST,
  asArray,
  asNumber,
  asRecord,
  asString,
  expectArray,
  failText,
  fmtNum,
  isoDate,
  provenanceLine,
  scrapecreatorsBilling,
  scrapecreatorsHeaders,
  scrapecreatorsRequest,
  validateEnum,
  type QueryParams,
  type ScrapeCreatorsResponse,
} from "../shared/scrapecreators.ts";

export const FACEBOOK_AD_KIND_VALUES = ["search", "company", "ad", "companies", "transcript"] as const;
export const FACEBOOK_AD_STATUS_VALUES = ["ALL", "ACTIVE", "INACTIVE"] as const;
export const FACEBOOK_AD_MEDIA_TYPE_VALUES = ["ALL", "IMAGE", "VIDEO", "MEME", "IMAGE_AND_MEME", "NONE"] as const;
export const FACEBOOK_AD_SORT_VALUES = ["total_impressions", "relevancy_monthly_grouped"] as const;
export const FACEBOOK_AD_SEARCH_TYPE_VALUES = ["keyword_unordered", "keyword_exact_phrase"] as const;
export const FACEBOOK_AD_TYPE_VALUES = ["all", "political_and_issue_ads"] as const;

type Kind = (typeof FACEBOOK_AD_KIND_VALUES)[number];
type Fields = Record<string, unknown>;

const FacebookAdLibrarySchema = Schema.Struct({
  kind: Schema.Literals(FACEBOOK_AD_KIND_VALUES).annotate({
    description:
      "search: ads matching a keyword; company: one advertiser's ads by page_id or company_name; ad: one ad's details by ad_id or url; companies: advertiser pages (and their page_id) matching a name; transcript: one video ad's transcript by ad_id or url.",
  }),
  query: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "kind='search': keyword to find in ads. kind='companies': advertiser or page name to look up.",
    }),
  ),
  page_id: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "kind='company'. Numeric Ad Library page id, from kind='companies' or an ad's page id. Use this or company_name.",
    }),
  ),
  company_name: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "kind='company'. Advertiser name, resolved by the provider. Use this or page_id; page_id is exact.",
    }),
  ),
  ad_id: Schema.optionalKey(
    Schema.String.annotate({
      description: "kind='ad' or 'transcript'. Numeric Ad Library id (ad_archive_id). Use this or url.",
    }),
  ),
  url: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "kind='ad' or 'transcript'. Ad Library URL such as https://www.facebook.com/ads/library?id=702369045530963. Use this or ad_id.",
    }),
  ),
  country: Schema.optionalKey(
    Schema.String.annotate({
      description: "kind='search' or 'company'. One two-letter country code, or ALL (provider default: ALL).",
    }),
  ),
  status: Schema.optionalKey(
    Schema.Literals(FACEBOOK_AD_STATUS_VALUES).annotate({
      description:
        "kind='search' or 'company'. Ad delivery status (provider default: ACTIVE, so inactive ads are left out unless ALL or INACTIVE).",
    }),
  ),
  media_type: Schema.optionalKey(
    Schema.Literals(FACEBOOK_AD_MEDIA_TYPE_VALUES).annotate({
      description: "kind='search' or 'company'. Creative media (provider default: ALL). MEME means image with text.",
    }),
  ),
  language: Schema.optionalKey(
    Schema.String.annotate({
      description: "kind='search' or 'company'. Two-letter ad language code such as EN or ES.",
    }),
  ),
  sort_by: Schema.optionalKey(
    Schema.Literals(FACEBOOK_AD_SORT_VALUES).annotate({
      description:
        "kind='search' or 'company'. total_impressions (provider default: impressions, high to low) or relevancy_monthly_grouped (most recent).",
    }),
  ),
  start_date: Schema.optionalKey(
    Schema.String.annotate({
      description: "kind='search' or 'company'. Impressions from this date, YYYY-MM-DD.",
    }),
  ),
  end_date: Schema.optionalKey(
    Schema.String.annotate({
      description: "kind='search' or 'company'. Impressions up to this date, YYYY-MM-DD.",
    }),
  ),
  search_type: Schema.optionalKey(
    Schema.Literals(FACEBOOK_AD_SEARCH_TYPE_VALUES).annotate({
      description: "kind='search'. keyword_unordered (any order) or keyword_exact_phrase.",
    }),
  ),
  ad_type: Schema.optionalKey(
    Schema.Literals(FACEBOOK_AD_TYPE_VALUES).annotate({
      description: "kind='search'. all, or only political and issue ads.",
    }),
  ),
  cursor: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "kind='search' or 'company'. Cursor from the previous page, with the same other arguments; omit for the first page.",
    }),
  ),
  cache_max_age: Schema.optionalKey(
    Schema.Literals(CACHE_MAX_AGE_VALUES).annotate({
      description:
        "kind='ad' or 'transcript'. Accept a cached response this old or newer; cache hits cost 0 credits.",
    }),
  ),
});

type AdLibraryArgs = Schema.Schema.Type<typeof FacebookAdLibrarySchema>;
type ArgumentName = Exclude<keyof AdLibraryArgs, "kind">;

const BASE_PATH = "/v1/facebook/adLibrary";
const LIBRARY_AD_URL = "https://www.facebook.com/ads/library?id=";
const OUTPUT_LIMIT = 60_000;
const TRUNCATION_NOTE =
  "The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file.";
const NUMERIC_ID = /^\d+$/;
const TWO_LETTER_CODE = /^[A-Z]{2}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ALL_COUNTRIES = "ALL";
const UNKNOWN_CATEGORY = "UNKNOWN";
const DYNAMIC_PLACEHOLDER = /\{\{[^{}]+\}\}/;

const EVIDENCE_SCOPE =
  "Evidence scope: the Ad Library shows that an ad ran, what it said, when, where and on which platforms. It reports no clicks, conversions, sales or other performance; impressions, spend and reach appear only where Meta discloses them. Run length and impression ranking are not proof that an ad worked or that its claims are true.";
const MEDIA_NOTE =
  "Media: links are the Facebook CDN URLs as returned and may expire; other variants (SD, resized, watermarked) are in the call's original response. Dig has not viewed the images or watched the videos.";
const DELIVERY_SHARES_NOTE =
  "Values are as Meta reports them: political and issue ad delivery values are fractional shares (0.08 = 8%), while regional transparency data may be absolute reach counts.";

const LIST_FILTERS: readonly ArgumentName[] = [
  "country",
  "status",
  "media_type",
  "language",
  "sort_by",
  "start_date",
  "end_date",
  "cursor",
];
const KIND_ARGUMENTS: Record<Kind, readonly ArgumentName[]> = {
  search: ["query", "search_type", "ad_type", ...LIST_FILTERS],
  company: ["page_id", "company_name", ...LIST_FILTERS],
  ad: ["ad_id", "url", "cache_max_age"],
  companies: ["query"],
  transcript: ["ad_id", "url", "cache_max_age"],
};
const ARGUMENT_NAMES = [...new Set(Object.values(KIND_ARGUMENTS).flat())];

function adLibraryRequest(
  path: string,
  params: QueryParams,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
  label: string,
  method: "GET" | "POST" = "GET",
): Effect.Effect<ScrapeCreatorsResponse, never, PaidHttp> {
  if (method === "GET") {
    return scrapecreatorsRequest(path, params, headers, ctx, label);
  }
  return Effect.gen(function* () {
    if (ctx.signal.aborted) {
      return {
        ok: false as const,
        cancelled: true,
        error: `${label} cancelled before the request was sent`,
        payload: null,
      };
    }
    const url = new URL(path, SCRAPECREATORS_BASE);
    const sent = Object.entries(params).filter(([, value]) => value !== undefined && value !== "");
    const res = yield* Effect.result(
      paidRequest({
        url: url.href,
        method: "POST",
        headers,
        body: Object.fromEntries(sent),
        timeoutMs: SCRAPECREATORS_TIMEOUT_MS,
        signal: ctx.signal,
        label,
        keep: ctx.keep,
      }),
    );
    if (Result.isFailure(res)) {
      if (ctx.signal.aborted) {
        return {
          ok: false as const,
          cancelled: true,
          error: `${label} cancelled while the request was in flight`,
          payload: null,
        };
      }
      const msg = res.failure instanceof Error ? res.failure.message : "Unknown error";
      return {
        ok: false as const,
        cancelled: false,
        error: redactText(`${label} request failed: ${msg}. ${UNANSWERED_SCRAPECREATORS_COST}`, knownSecrets()),
        payload: null,
      };
    }
    const { status, payload } = res.success;
    const record = asRecord(payload);
    const rawMsg = record ? (asString(record.error) ?? asString(record.message)) : null;
    const providerMessage = rawMsg ? redactText(rawMsg, knownSecrets()) : null;
    if (status !== 200) {
      return {
        ok: false as const,
        cancelled: false,
        status,
        error: `${label} returned HTTP ${status}${providerMessage ? `: ${providerMessage}` : ""}`,
        payload: record,
      };
    }
    if (!record) {
      return {
        ok: false as const,
        cancelled: false,
        status,
        error: `${label} returned a non-JSON or empty body`,
        payload: null,
      };
    }
    if (record.success === false) {
      return {
        ok: false as const,
        cancelled: false,
        status,
        error: `${label}: ${providerMessage ?? "request not successful"}`,
        payload: record,
      };
    }
    return { ok: true as const, payload: record, status };
  });
}

function misplacedArgument(args: AdLibraryArgs, kind: Kind): string | null {
  const accepted = KIND_ARGUMENTS[kind];
  const stray = ARGUMENT_NAMES.find((name) => args[name] !== undefined && !accepted.includes(name));
  return stray ? `${stray} does not apply to kind='${kind}', which takes ${accepted.join(", ")}.` : null;
}

function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

interface ListFilters {
  readonly params: QueryParams;
  readonly shown: string[];
}

function listFilters(args: AdLibraryArgs): ListFilters | { error: string } {
  const country = args.country?.trim().toUpperCase() || undefined;
  if (country && country !== ALL_COUNTRIES && !TWO_LETTER_CODE.test(country)) {
    return { error: "country must be one two-letter country code such as US, or ALL." };
  }
  const language = args.language?.trim().toUpperCase() || undefined;
  if (language && !TWO_LETTER_CODE.test(language)) {
    return { error: "language must be a two-letter language code such as EN or ES." };
  }
  const start = args.start_date?.trim() || undefined;
  const end = args.end_date?.trim() || undefined;
  if (start && !isCalendarDay(start)) return { error: "start_date must be a date in YYYY-MM-DD form." };
  if (end && !isCalendarDay(end)) return { error: "end_date must be a date in YYYY-MM-DD form." };
  if (start && end && start > end) return { error: "start_date must not be after end_date." };
  const shown = [
    `status=${args.status ?? "ACTIVE (provider default)"}`,
    `country=${country ?? "ALL (provider default)"}`,
    `media_type=${args.media_type ?? "ALL (provider default)"}`,
    `sort_by=${args.sort_by ?? "total_impressions (provider default)"}`,
  ];
  if (language) shown.push(`language=${language}`);
  if (start) shown.push(`start_date=${start}`);
  if (end) shown.push(`end_date=${end}`);
  return {
    params: {
      country,
      status: args.status,
      media_type: args.media_type,
      language,
      sort_by: args.sort_by,
      start_date: start,
      end_date: end,
    },
    shown,
  };
}

interface AdTarget {
  readonly params: QueryParams;
  readonly id: string | null;
  readonly shown: string;
}

function adTarget(args: AdLibraryArgs, kind: Kind): AdTarget | { error: string } {
  const id = args.ad_id?.trim();
  const url = args.url?.trim();
  if (id && url) return { error: "Provide ad_id or url, not both." };
  if (!id && !url) return { error: `kind='${kind}' needs ad_id or an Ad Library url.` };
  if (id) {
    if (!NUMERIC_ID.test(id)) return { error: "ad_id must be the numeric Ad Library id (ad_archive_id)." };
    return { params: { id }, id, shown: `ad_id=${id}` };
  }
  const urlError =
    "url must be an Ad Library URL naming one ad, such as https://www.facebook.com/ads/library?id=702369045530963.";
  let parsed: URL;
  try {
    parsed = new URL(url!);
  } catch {
    return { error: urlError };
  }
  const named = parsed.searchParams.get("id");
  if (
    !/^https?:$/.test(parsed.protocol) ||
    !/(^|\.)facebook\.com$/i.test(parsed.hostname) ||
    !/^\/ads\/library\/?$/.test(parsed.pathname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    !named ||
    !NUMERIC_ID.test(named)
  ) {
    return { error: urlError };
  }
  return { params: { url: url! }, id: named, shown: `url=${url}` };
}

const field = (record: Fields, snake: string, camel: string): unknown =>
  record[snake] !== undefined ? record[snake] : record[camel];

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function libraryUrlId(value: unknown): string | null {
  const url = asString(value);
  if (!url) return null;
  try {
    const id = new URL(url).searchParams.get("id");
    return id && NUMERIC_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

const adIdOf = (ad: Fields): string | null => idOf(field(ad, "ad_archive_id", "adArchiveID")) ?? libraryUrlId(ad.url);

const present = <T>(value: T | null | undefined | false | ""): value is T =>
  value !== null && value !== undefined && value !== false && value !== "";

function strings(value: unknown): string[] {
  const record = asRecord(value);
  const items = Array.isArray(value) ? value : record ? Object.values(record) : [];
  return items.map(asString).filter(present);
}

function creativeText(value: unknown): string | null {
  const raw = typeof value === "string" ? value : asString(asRecord(value)?.text);
  if (!raw?.trim()) return null;
  return raw.replace(/<br\s*\/?>/gi, "\n");
}

function block(label: string, text: string, indent: string): string[] {
  return [`${indent}${label}:`, ...text.split("\n").map((line) => (line.trim() ? `${indent}  ${line}` : ""))];
}

function disclosed(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value.trim() || null;
  const record = asRecord(value);
  if (!record) return null;
  const lower = asNumber(record.lower_bound);
  const upper = asNumber(record.upper_bound);
  if (lower !== null || upper !== null) return `${lower ?? "?"}–${upper ?? "?"}`;
  return Object.keys(record).length ? JSON.stringify(record) : null;
}

const imageUrl = (media: Fields) =>
  asString(media.original_image_url) ??
  asString(media.resized_image_url) ??
  asString(media.watermarked_resized_image_url);
const videoUrl = (media: Fields) =>
  asString(media.video_hd_url) ??
  asString(media.video_sd_url) ??
  asString(media.watermarked_video_hd_url) ??
  asString(media.watermarked_video_sd_url);

function mediaLines(images: Fields[], videos: Fields[], indent: string): string[] {
  return [
    ...images.map((image, index) => `${indent}Image ${index + 1}: ${imageUrl(image) ?? "(no URL returned)"}`),
    ...videos.map((video, index) => {
      const preview = asString(video.video_preview_image_url);
      return `${indent}Video ${index + 1}: ${videoUrl(video) ?? "(no URL returned)"}${preview ? ` (preview image ${preview})` : ""}`;
    }),
  ];
}

const records = (...values: unknown[]): Fields[] =>
  values.flatMap((value) => asArray(value).map(asRecord).filter(present));

function creativeLines(source: Fields, indent: string): { lines: string[]; media: number; dynamic: boolean } {
  const lines: string[] = [];
  const body = creativeText(source.body);
  if (body) lines.push(...block("Text", body, indent));
  const headline = [
    asString(source.title) && `Headline: ${source.title}`,
    asString(source.link_description) && `Link description: ${source.link_description}`,
  ].filter(present);
  if (headline.length) lines.push(`${indent}${headline.join(" | ")}`);
  const link = asString(source.link_url);
  const caption = asString(source.caption);
  const cta = asString(source.cta_text);
  const action = [
    link && `Link: ${link}`,
    caption && `Caption: ${caption}`,
    cta && `Call to action: ${cta}`,
  ].filter(present);
  if (action.length) lines.push(`${indent}${action.join(" | ")}`);
  const images = records(source.images, source.extra_images);
  const videos = records(source.videos, source.extra_videos);
  if (!images.length && imageUrl(source)) images.push(source);
  if (!videos.length && videoUrl(source)) videos.push(source);
  lines.push(...mediaLines(images, videos, indent));
  return {
    lines,
    media: images.length + videos.length,
    dynamic: DYNAMIC_PLACEHOLDER.test(`${body ?? ""} ${asString(source.title) ?? ""}`),
  };
}

function adLines(ad: Fields, id: string, index: number | null): { lines: string[]; media: number } {
  const indent = index === null ? "" : "   ";
  const snapshot = asRecord(ad.snapshot) ?? {};
  const pageName = asString(field(ad, "page_name", "pageName"));
  const pageId = idOf(field(ad, "page_id", "pageID"));
  const shownName = asString(snapshot.page_name);
  const shownId = idOf(snapshot.page_id);
  const active = field(ad, "is_active", "isActive");
  const lines = [
    `${index === null ? "" : `${index + 1}. `}${pageName ?? shownName ?? "(page name not returned)"} — ad ${id} — ${active === true ? "active" : active === false ? "inactive" : "status not reported"}`,
    `${indent}Ad Library: ${asString(ad.url) ?? `${LIBRARY_AD_URL}${id}`}`,
  ];

  const start = isoDate(field(ad, "start_date", "startDate"));
  const end = isoDate(field(ad, "end_date", "endDate"));
  const platforms = strings(field(ad, "publisher_platform", "publisherPlatform"));
  const format = asString(snapshot.display_format);
  lines.push(
    `${indent}${[
      `Ran: ${start ?? "start not reported"} → ${end ?? "end not reported"}`,
      platforms.length > 0 && `Platforms: ${platforms.join(", ")}`,
      format && `Format: ${format}`,
    ]
      .filter(present)
      .join(" | ")}`,
  );

  const differs =
    pageName !== null &&
    shownName !== null &&
    (shownName !== pageName || (shownId !== null && pageId !== null && shownId !== pageId));
  const headId = pageId ?? (differs ? null : shownId);
  lines.push(
    `${indent}Page: ${pageName ?? shownName ?? "(not returned)"}${headId ? ` (page id ${headId})` : ""}${differs ? `; shown as ${shownName}${shownId ? ` (page id ${shownId})` : ""}` : ""}`,
  );
  const likes = asNumber(snapshot.page_like_count);
  const pageCategories = strings(snapshot.page_categories);
  const profile = [
    asString(snapshot.page_profile_uri),
    likes !== null && `${fmtNum(likes)} page likes`,
    pageCategories.length > 0 && pageCategories.join(", "),
  ].filter(present);
  if (profile.length) lines.push(`${indent}${differs ? "Shown-as page profile" : "Profile"}: ${profile.join(" | ")}`);
  const branded = asRecord(snapshot.branded_content);
  const brandedName = asString(branded?.page_name);
  if (brandedName) {
    lines.push(
      `${indent}Branded content with: ${brandedName}${asString(branded?.page_profile_uri) ? ` (${branded?.page_profile_uri})` : ""}`,
    );
  }
  const sponsor = asString(asRecord(snapshot.instagram_branded_content)?.instagram_bc_sponsor_name);
  if (sponsor) lines.push(`${indent}Instagram branded-content sponsor: ${sponsor}`);
  const disclaimer = [
    asString(snapshot.disclaimer_label) && `Disclaimer: ${snapshot.disclaimer_label}`,
    asString(snapshot.byline) && `Byline: ${snapshot.byline}`,
  ].filter(present);
  if (disclaimer.length) lines.push(`${indent}${disclaimer.join(" | ")}`);

  const categories = strings(ad.categories).filter((category) => category !== UNKNOWN_CATEGORY);
  if (categories.length) lines.push(`${indent}Categories: ${categories.join(", ")}`);
  const collationCount = asNumber(field(ad, "collation_count", "collationCount"));
  const collationId = idOf(field(ad, "collation_id", "collationID"));
  if (collationCount !== null && collationCount > 1) {
    lines.push(`${indent}Related ads: ${collationCount} in Meta's group ${collationId ?? "(id not returned)"}`);
  }
  const reached = strings(field(ad, "targeted_or_reached_countries", "targetedOrReachedCountries"));
  if (reached.length) lines.push(`${indent}Targeted or reached countries: ${reached.join(", ")}`);
  const political = strings(field(ad, "political_countries", "politicalCountries"));
  if (political.length) lines.push(`${indent}Political ad countries: ${political.join(", ")}`);
  if (field(ad, "contains_digital_created_media", "containsDigitallyCreatedMedia") === true) {
    lines.push(`${indent}Meta label: contains digitally created or altered media`);
  }
  if (field(ad, "page_is_deleted", "pageIsDeleted") === true) lines.push(`${indent}Page deleted`);

  const impressions = asString(
    field(asRecord(field(ad, "impressions_with_index", "impressionsWithIndex")) ?? {}, "impressions_text", "impressionsText"),
  );
  const spend = disclosed(ad.spend);
  const reach = disclosed(field(ad, "reach_estimate", "reachEstimate"));
  const currency = asString(ad.currency);
  const delivery = [
    impressions && `impressions ${impressions}`,
    spend && `spend ${spend}${currency ? ` ${currency}` : ""}`,
    reach && `estimated audience ${reach}`,
  ].filter(present);
  lines.push(
    `${indent}${delivery.length ? `Delivery (Meta's disclosure): ${delivery.join(" | ")}` : "Delivery: no impressions, spend or reach disclosed in this record"}`,
  );

  const creative = creativeLines(snapshot, indent);
  const cards = records(snapshot.cards);
  let media = creative.media;
  let dynamic = creative.dynamic;
  lines.push(...creative.lines);
  for (const [cardIndex, card] of cards.entries()) {
    const cardCreative = creativeLines(card, `${indent}  `);
    lines.push(`${indent}Card ${cardIndex + 1}:`, ...cardCreative.lines);
    media += cardCreative.media;
    dynamic ||= cardCreative.dynamic;
  }
  const extraTexts = asArray(snapshot.extra_texts).map(creativeText).filter(present);
  for (const [textIndex, text] of extraTexts.entries()) lines.push(...block(`Extra text ${textIndex + 1}`, text, indent));
  const extraLinks = strings(snapshot.extra_links);
  if (extraLinks.length) lines.push(`${indent}Extra links: ${extraLinks.join(" | ")}`);
  if (!creativeText(snapshot.body) && !cards.length && !extraTexts.length) {
    lines.push(`${indent}Text: none returned for this ad`);
  }
  if (dynamic) {
    lines.push(
      `${indent}Dynamic template: Meta fills the {{…}} placeholders per viewer; the text above is the template.`,
    );
  }
  return { lines, media };
}

function transparencyLines(info: Fields): string[] {
  const lines = ["Transparency (Meta's regulated-ad data):", `  ${DELIVERY_SHARES_NOTE}`];
  const reach = asNumber(info.eu_total_reach);
  const scope = [
    typeof info.targets_eu === "boolean" && `Targets EU: ${info.targets_eu ? "yes" : "no"}`,
    reach !== null && `EU total reach: ${reach}`,
  ].filter(present);
  if (scope.length) lines.push(`  ${scope.join(" | ")}`);
  const ages = asRecord(info.age_audience);
  const audience = [
    asString(info.gender_audience) && `gender ${info.gender_audience}`,
    ages &&
      (asNumber(ages.min) !== null || asNumber(ages.max) !== null) &&
      `ages ${asNumber(ages.min) ?? "?"}–${asNumber(ages.max) ?? "?"}`,
  ].filter(present);
  if (audience.length) lines.push(`  Audience: ${audience.join(", ")}`);
  const locations = records(info.location_audience).map((location) => {
    const name = asString(location.name) ?? "(unnamed)";
    const extra = [
      asString(location.type),
      location.excluded === true && "excluded",
      asNumber(location.reach) !== null && `reach ${asNumber(location.reach)}`,
    ].filter(present);
    return `${name}${extra.length ? ` (${extra.join(", ")})` : ""}`;
  });
  if (locations.length) lines.push(`  Locations: ${locations.join("; ")}`);
  for (const country of records(info.age_country_gender_reach_breakdown)) {
    const rows = records(country.age_gender_breakdowns).map((row) => {
      const values = (["male", "female", "unknown"] as const).flatMap((sex) =>
        asNumber(row[sex]) === null ? [] : [`${sex} ${asNumber(row[sex])}`],
      );
      return `${asString(row.age_range) ?? "?"}: ${values.length ? values.join(", ") : "no values"}`;
    });
    if (rows.length) {
      lines.push(`  Reach by age and gender, ${asString(country.country) ?? "country not named"}: ${rows.join("; ")}`);
    }
  }
  const payers = records(info.payer_beneficiary_data).map(
    (entry) => `payer ${asString(entry.payer) ?? "?"}, beneficiary ${asString(entry.beneficiary) ?? "?"}`,
  );
  if (payers.length) lines.push(`  Payer and beneficiary: ${payers.join("; ")}`);
  if (info.has_violating_payer_beneficiary === true) {
    lines.push("  Meta flags the payer or beneficiary as violating its rules");
  }
  if (info.is_ad_taken_down === true) lines.push("  Meta reports the ad as taken down");
  return lines;
}

function buildResult(status: OutcomeStatus, lines: string[], details: Fields): ActionOutcome {
  const text = lines.join("\n");
  const truncated = text.length > OUTPUT_LIMIT;
  return outcome(
    truncated && status === "success" ? "partial" : status,
    truncated
      ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${text.length} characters. ${TRUNCATION_NOTE}]`
      : text,
    { provider: "scrapecreators", ...details, truncated },
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function listAds(
  kind: "search" | "company",
  args: AdLibraryArgs,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const filters = listFilters(args);
    if ("error" in filters) return failed(filters.error);
    let target: QueryParams;
    let subject: string;
    if (kind === "search") {
      const query = args.query?.trim();
      if (!query) return failed("query is required for kind='search'.");
      target = { query, search_type: args.search_type, ad_type: args.ad_type };
      subject = `Facebook Ad Library search: "${query}"`;
      if (args.search_type) filters.shown.push(`search_type=${args.search_type}`);
      if (args.ad_type) filters.shown.push(`ad_type=${args.ad_type}`);
    } else {
      const pageId = args.page_id?.trim();
      const companyName = args.company_name?.trim();
      if (pageId && companyName) return failed("Provide page_id or company_name for kind='company', not both.");
      if (!pageId && !companyName) return failed("kind='company' needs page_id (exact) or company_name.");
      if (pageId && !NUMERIC_ID.test(pageId)) {
        return failed("page_id must be the numeric Ad Library page id; find it with kind='companies'.");
      }
      target = pageId ? { pageId } : { companyName };
      subject = pageId
        ? `Facebook Ad Library ads for page id ${pageId}`
        : `Facebook Ad Library ads for company name "${companyName}" (resolved by the provider; check the advertiser pages below, or pass page_id for an exact advertiser)`;
    }
    const cursor = args.cursor?.trim() || undefined;
    const method = cursor ? "POST" : "GET";
    const label =
      kind === "search" ? "ScrapeCreators Facebook Ad Library search" : "ScrapeCreators Facebook Ad Library company ads";
    const response = yield* adLibraryRequest(
      kind === "search" ? `${BASE_PATH}/search/ads` : `${BASE_PATH}/company/ads`,
      { ...target, ...filters.params, cursor },
      headers,
      ctx,
      label,
      method,
    );
    if (!response.ok) return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
    const payload = response.payload;
    const listed = expectArray(payload, kind === "search" ? "searchResults" : "results", label);
    if (!listed.ok) return failed(listed.error);

    const ads: Array<{ ad: Fields; id: string }> = [];
    let unreadable = 0;
    for (const entry of listed.items) {
      const ad = asRecord(entry);
      const id = ad ? adIdOf(ad) : null;
      if (ad && id) ads.push({ ad, id });
      else unreadable += 1;
    }
    if (!ads.length && unreadable) {
      return failed(
        `${label} returned an unexpected payload: none of the ${plural(unreadable, "entry", "entries")} carried an ad id (ad_archive_id)`,
      );
    }

    const nextCursor = asString(payload.cursor);
    const total = kind === "search" ? asNumber(payload.searchResultsCount) : null;
    const pages = [
      ...new Map(
        ads.map(({ ad }) => {
          const name = asString(ad.page_name) ?? "(name not returned)";
          const id = idOf(ad.page_id);
          return [`${name}|${id}`, { name, id }] as const;
        }),
      ).values(),
    ];
    const formatted = ads.map(({ ad, id }, index) => adLines(ad, id, index));

    const lines = [
      subject,
      `Filters: ${filters.shown.join(" | ")}`,
      cursor ? "Page: continuation page (cursor sent by POST, as ScrapeCreators documents for long cursors)" : "Page: first page",
      `Order: as returned for ${args.sort_by ?? "total_impressions"}; no local re-ranking. One page per call; no further pages were fetched.`,
      provenanceLine(payload),
      `Ads on this page: ${ads.length}${total !== null ? ` | Ad Library result count reported: ${total}` : ""}`,
      nextCursor
        ? `Next page: pass cursor="${nextCursor}" with the same other arguments`
        : "Next page: no cursor returned; the provider gave no further page.",
    ];
    if (unreadable) {
      lines.push(
        `Unreadable entries: ${plural(unreadable, "returned entry", "returned entries")} carried no ad id and ${unreadable === 1 ? "was" : "were"} skipped; see the retained original.`,
      );
    }
    if (kind === "company" && pages.length) {
      lines.push(
        `Advertiser pages in these results: ${pages.map((page) => `${page.name}${page.id ? ` (${page.id})` : ""}`).join("; ")}`,
      );
    }
    lines.push(EVIDENCE_SCOPE);
    if (formatted.some((ad) => ad.media > 0)) lines.push(MEDIA_NOTE);

    const details: Fields = {
      kind,
      ...(kind === "search"
        ? { query: target.query }
        : { page_id: target.pageId ?? null, company_name: target.companyName ?? null }),
      filters: filters.shown,
      transport: method,
      returned: ads.length,
      unreadable,
      result_count: total,
      cursor: nextCursor,
      ad_ids: ads.map(({ id }) => id),
      page_ids: pages.map((page) => page.id).filter(present),
      credits_charged: asNumber(payload.credits_charged),
    };
    if (!ads.length) {
      lines.push(
        "",
        `The Ad Library returned no ads for this ${kind === "search" ? "query" : "advertiser"} and filter set.${args.status ? "" : " status defaults to ACTIVE, so inactive ads are not included unless status=ALL or INACTIVE."}`,
      );
      return buildResult("empty", lines, details);
    }
    for (const ad of formatted) lines.push("", ...ad.lines);
    return buildResult(unreadable ? "partial" : "success", lines, details);
  });
}

function adDetail(
  args: AdLibraryArgs,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const target = adTarget(args, "ad");
    if ("error" in target) return failed(target.error);
    const label = "ScrapeCreators Facebook Ad Library ad";
    const response = yield* adLibraryRequest(
      `${BASE_PATH}/ad`,
      { ...target.params, cache_max_age: args.cache_max_age },
      headers,
      ctx,
      label,
    );
    if (!response.ok) return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
    const ad = response.payload;
    const returnedId = adIdOf(ad);
    if (!returnedId || !asRecord(ad.snapshot) || !Object.keys(ad.snapshot as Fields).length) {
      return failed(`${label} returned an unexpected payload: an identified ad with a nonempty snapshot is required`);
    }
    if (returnedId !== target.id) {
      return failed(`${label} returned ad ${returnedId} instead of requested ad ${target.id}`);
    }
    const formatted = adLines(ad, returnedId, null);
    const lines = [`Facebook Ad Library ad ${returnedId}`, `Requested: ${target.shown}`, provenanceLine(ad), EVIDENCE_SCOPE];
    if (formatted.media) lines.push(MEDIA_NOTE);
    lines.push("", ...formatted.lines);
    const info = asRecord(ad.aaa_info);
    if (info) lines.push("", ...transparencyLines(info));
    return buildResult("success", lines, {
      kind: "ad",
      ad_id: returnedId,
      page_id: idOf(ad.pageID),
      active: typeof ad.isActive === "boolean" ? ad.isActive : null,
      transparency: info !== null,
      cached: ad.cached === true,
      credits_charged: asNumber(ad.credits_charged),
    });
  });
}

function adTranscript(
  args: AdLibraryArgs,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const target = adTarget(args, "transcript");
    if ("error" in target) return failed(target.error);
    const label = "ScrapeCreators Facebook Ad Library transcript";
    const response = yield* adLibraryRequest(
      `${BASE_PATH}/ad/transcript`,
      { ...target.params, cache_max_age: args.cache_max_age },
      headers,
      ctx,
      label,
    );
    if (!response.ok) return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
    const payload = response.payload;
    const data = asRecord(payload.data);
    if (!data) {
      return failed(
        `${label} returned an unexpected payload: \`data\` is ${payload.data === undefined ? "missing" : "not an object"}`,
      );
    }
    const transcript = data.transcript;
    if (transcript !== null && typeof transcript !== "string") {
      return failed(
        `${label} returned an unexpected payload: \`data.transcript\` is ${transcript === undefined ? "missing" : `neither text nor null (${typeof transcript})`}`,
      );
    }
    const id = idOf(data.ad_id) ?? target.id;
    const available = typeof data.transcript_available === "boolean" ? data.transcript_available : null;
    const lines = [
      `Facebook ad transcript: ad ${id ?? "(id not returned)"}`,
      `Ad Library: ${asString(data.url) ?? (id ? `${LIBRARY_AD_URL}${id}` : target.shown)}`,
      provenanceLine(payload),
    ];
    const details: Fields = {
      kind: "transcript",
      ad_id: id,
      transcript_available: available,
      cached: payload.cached === true,
      credits_charged: asNumber(payload.credits_charged),
    };
    if (transcript === null || !transcript.trim()) {
      lines.push(
        "",
        `No transcript: the provider returned ${transcript === null ? "none (transcript: null" : 'an empty transcript (transcript: ""'}${available === null ? "" : `, transcript_available: ${available}`}). This does not show that the ad has no spoken words. The response's reported charge is shown above; a missing charge stays unknown.`,
      );
      return buildResult("empty", lines, details);
    }
    lines.push(
      "Source: Facebook's captions when it exposes them, otherwise ScrapeCreators' transcription of the public video; the response does not say which. Dig has not watched the video.",
      "",
      ...block("Transcript", transcript, ""),
    );
    return buildResult("success", lines, details);
  });
}

function companySearch(
  args: AdLibraryArgs,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const query = args.query?.trim();
    if (!query) return failed("query is required for kind='companies'.");
    const label = "ScrapeCreators Facebook Ad Library company search";
    const response = yield* adLibraryRequest(`${BASE_PATH}/search/companies`, { query }, headers, ctx, label);
    if (!response.ok) return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
    const listed = expectArray(response.payload, "searchResults", label);
    if (!listed.ok) return failed(listed.error);
    const pages: Array<{ page: Fields; id: string }> = [];
    let unreadable = 0;
    for (const entry of listed.items) {
      const page = asRecord(entry);
      const id = page ? idOf(page.page_id) : null;
      if (page && id) pages.push({ page, id });
      else unreadable += 1;
    }
    if (!pages.length && unreadable) {
      return failed(
        `${label} returned an unexpected payload: none of the ${plural(unreadable, "entry", "entries")} carried a page_id`,
      );
    }
    const lines = [
      `Facebook Ad Library advertiser search: "${query}"`,
      "Source: the Ad Library's page lookup; one request, no paging documented. A page listed here may have no ads running; pass its page_id to kind='company' for its ads.",
      provenanceLine(response.payload),
      `Pages returned: ${pages.length}`,
    ];
    if (unreadable) {
      lines.push(
        `Unreadable entries: ${plural(unreadable, "returned entry", "returned entries")} carried no page_id and ${unreadable === 1 ? "was" : "were"} skipped; see the retained original.`,
      );
    }
    const details: Fields = {
      kind: "companies",
      query,
      returned: pages.length,
      unreadable,
      page_ids: pages.map(({ id }) => id),
      credits_charged: asNumber(response.payload.credits_charged),
    };
    if (!pages.length) {
      lines.push("", "The Ad Library returned no advertiser pages for this name.");
      return buildResult("empty", lines, details);
    }
    for (const [index, { page, id }] of pages.entries()) {
      const likes = asNumber(page.likes);
      const facts = [
        asString(page.category),
        likes !== null && `${fmtNum(likes)} Facebook likes`,
        asString(page.verification) && `verification ${page.verification}`,
        asString(page.country) && `country ${page.country}`,
        page.page_is_deleted === true && "page deleted",
      ].filter(present);
      lines.push("", `${index + 1}. ${asString(page.name) ?? "(name not returned)"} — page id ${id}`);
      if (facts.length) lines.push(`   ${facts.join(" | ")}`);
      const alias = asString(page.page_alias);
      if (alias) lines.push(`   Facebook: https://www.facebook.com/${alias}`);
      const instagram = asString(page.ig_username);
      if (instagram) {
        const followers = asNumber(page.ig_followers);
        lines.push(
          `   Instagram: @${instagram}${followers !== null ? ` (${fmtNum(followers)} followers)` : ""}${page.ig_verification === true ? ", verified" : ""}`,
        );
      }
    }
    return buildResult(unreadable ? "partial" : "success", lines, details);
  });
}

export const facebookAdLibraryAction = defineAction({
  name: "facebook_ad_library",
  description:
    "Read Meta's public Ad Library via ScrapeCreators, one request per call. " +
    "kind='search': ads matching a keyword, with status (provider default ACTIVE), country, media_type, language, date range, sort_by, exact-phrase search_type and political ad_type filters. " +
    "kind='company': one advertiser's ads by page_id (exact) or company_name (resolved by the provider), with the same filters. kind='companies': find advertiser pages and their page_id by name. " +
    "kind='ad': one ad's details by ad_id or Ad Library url, including Meta's EU and political transparency data when present. kind='transcript': one video ad's transcript (null, and free, when there is none). " +
    "search and company return one page and a cursor for the next. Creative text is shown in full with links, run dates, platforms and media URLs. " +
    "The library does not report performance; impressions, spend and reach appear only when Meta discloses them. " +
    "Requires SCRAPECREATORS_API_KEY; 1 credit per request, a transcript only when returned, ad and transcript cache hits free with cache_max_age.",
  schema: FacebookAdLibrarySchema,
  billing: scrapecreatorsBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const headers = scrapecreatorsHeaders();
      if (!headers) return failed(MISSING_SCRAPECREATORS_KEY);
      const invalid =
        validateEnum("kind", args.kind ?? "", FACEBOOK_AD_KIND_VALUES) ??
        validateEnum("status", args.status, FACEBOOK_AD_STATUS_VALUES) ??
        validateEnum("media_type", args.media_type, FACEBOOK_AD_MEDIA_TYPE_VALUES) ??
        validateEnum("sort_by", args.sort_by, FACEBOOK_AD_SORT_VALUES) ??
        validateEnum("search_type", args.search_type, FACEBOOK_AD_SEARCH_TYPE_VALUES) ??
        validateEnum("ad_type", args.ad_type, FACEBOOK_AD_TYPE_VALUES) ??
        validateEnum("cache_max_age", args.cache_max_age, CACHE_MAX_AGE_VALUES);
      if (invalid) return failed(invalid);
      const kind = args.kind as Kind;
      const misplaced = misplacedArgument(args, kind);
      if (misplaced) return failed(misplaced);
      switch (kind) {
        case "search":
        case "company":
          return yield* listAds(kind, args, headers, ctx);
        case "ad":
          return yield* adDetail(args, headers, ctx);
        case "transcript":
          return yield* adTranscript(args, headers, ctx);
        case "companies":
          return yield* companySearch(args, headers, ctx);
      }
    }),
});

export const facebookAdsSource: SourcePlugin = defineSource({
  id: "facebook-ads",
  group: "markets",
  label: "Facebook ads",
  description: "Meta Ad Library advertisers, creatives and transcripts",
  about:
    "Meta's public Ad Library through ScrapeCreators: find advertisers and ads, inspect their creative text, run dates and media, and read available transcripts. Ad presence and run duration are not proof of performance or of a claim in an ad.",
  providers: [SCRAPECREATORS_PROVIDER],
  billing: SCRAPECREATORS_BILLING,
  env: ["SCRAPECREATORS_API_KEY"],
  keys: ["SCRAPECREATORS_API_KEY"],
  credential: "SCRAPECREATORS_API_KEY",
  actions: [facebookAdLibraryAction],
});

export default facebookAdsSource;
