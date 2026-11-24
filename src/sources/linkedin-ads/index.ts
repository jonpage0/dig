/**
 * LinkedIn Ads source plugin (Effect 4.1.5):
 * - linkedin_ad_library: LinkedIn Ad Library search and single-ad detail via ScrapeCreators (`PaidHttp`, zero retries).
 */
import { Effect, Schema } from "effect";
import type { PaidHttp } from "../../core/http.ts";
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
import {
  MISSING_SCRAPECREATORS_KEY,
  SCRAPECREATORS_BILLING,
  SCRAPECREATORS_PROVIDER,
  asArray,
  asNumber,
  asRecord,
  asString,
  continuesAfter,
  expectArray,
  failText,
  fmtNum,
  isoDate,
  knownCharge,
  provenanceLine,
  scrapecreatorsBilling,
  scrapecreatorsHeaders,
  scrapecreatorsRequest,
  validateEnum,
} from "../shared/scrapecreators.ts";

export const LINKEDIN_AD_ACTION_VALUES = ["search", "detail"] as const;
type Action = (typeof LINKEDIN_AD_ACTION_VALUES)[number];
type Fields = Record<string, unknown>;

const LinkedInAdLibrarySchema = Schema.Struct({
  action: Schema.Literals(LINKEDIN_AD_ACTION_VALUES).annotate({
    description:
      "search: ads by company, keyword, company id, countries and dates; detail: one ad by its Ad Library url or ad_id.",
  }),
  company_name: Schema.optionalKey(
    Schema.String.annotate({
      description: "action='search'. Advertiser name, resolved by LinkedIn, such as Microsoft.",
    }),
  ),
  company_id: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "action='search'. LinkedIn's numeric company id, the number in a linkedin.com/company/<id> address.",
    }),
  ),
  query: Schema.optionalKey(
    Schema.String.annotate({ description: "action='search'. Keyword to find in ads." }),
  ),
  countries: Schema.optionalKey(
    Schema.String.annotate({
      description: "action='search'. Comma-separated two-letter country codes, such as US,CA,MX.",
    }),
  ),
  start_date: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "action='search'. Ads shown from this date, YYYY-MM-DD; needs end_date and is no earlier than one year ago.",
    }),
  ),
  end_date: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "action='search'. Ads shown up to this date, YYYY-MM-DD; needs start_date and is at the latest yesterday.",
    }),
  ),
  cursor: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "action='search'. Cursor from the previous page, with the same other arguments; omit for the first page.",
    }),
  ),
  url: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "action='detail'. The ad's Ad Library address, such as https://www.linkedin.com/ad-library/detail/666281156. Use this or ad_id.",
    }),
  ),
  ad_id: Schema.optionalKey(
    Schema.String.annotate({
      description: "action='detail'. The ad's numeric Ad Library id. Use this or url.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description:
        "action='search'. Show at most this many of the returned entries. The request is unchanged and the whole page is paid for; the cursor still continues after every returned entry.",
    }),
  ),
});

type LinkedInAdArgs = Schema.Schema.Type<typeof LinkedInAdLibrarySchema>;
type ArgumentName = Exclude<keyof LinkedInAdArgs, "action">;

const LIBRARY_AD_URL = "https://www.linkedin.com/ad-library/detail/";
const OUTPUT_LIMIT = 60_000;
const TRUNCATION_NOTE =
  "The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file.";
const NUMERIC_ID = /^\d+$/;
const COUNTRY_LIST = /^[A-Z]{2}(,[A-Z]{2})*$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const EVIDENCE_SCOPE =
  "Evidence scope: LinkedIn's Ad Library covers ads shown in roughly the last year and what LinkedIn chooses to publish about each: who ran and paid for it, its creative, dates, and impression ranges and targeting categories where shown. It reports no spend, clicks or results. An ad's presence and how long it ran are not proof that it worked or that its claims are true.";
const MEDIA_NOTE =
  "Media: addresses as returned (signed LinkedIn URLs that may expire); nothing was downloaded, and Dig has not viewed the images or watched the videos.";

const ACTION_ARGUMENTS: Record<Action, readonly ArgumentName[]> = {
  search: ["company_name", "company_id", "query", "countries", "start_date", "end_date", "cursor", "limit"],
  detail: ["url", "ad_id"],
};
const ARGUMENT_NAMES = [...new Set(Object.values(ACTION_ARGUMENTS).flat())];

const present = <T>(value: T | null | undefined | false | ""): value is T =>
  value !== null && value !== undefined && value !== false && value !== "";
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const records = (value: unknown): Fields[] => asArray(value).map(asRecord).filter(present);
const strings = (value: unknown): string[] => asArray(value).map(asString).filter(present);
const day = (time: number) => new Date(time).toISOString().slice(0, 10);

function misplacedArgument(args: LinkedInAdArgs, action: Action): string | null {
  const accepted = ACTION_ARGUMENTS[action];
  const stray = ARGUMENT_NAMES.find((name) => args[name] !== undefined && !accepted.includes(name));
  return stray ? `${stray} does not apply to action='${action}', which takes ${accepted.join(", ")}.` : null;
}

function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function block(label: string, text: string, indent: string): string[] {
  return [`${indent}${label}:`, ...text.split("\n").map((line) => (line.trim() ? `${indent}  ${line}` : ""))];
}

function plain(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return fmtNum(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) {
    const parts = value.map((entry) => plain(entry, depth + 1)).filter(present);
    return parts.length ? parts.join(depth ? ", " : "; ") : null;
  }
  const record = asRecord(value);
  if (!record || depth > 3) return null;
  const parts = Object.entries(record)
    .map(([key, entry]) => {
      const shown = plain(entry, depth + 1);
      return shown === null ? null : `${key} ${shown}`;
    })
    .filter(present);
  return parts.length ? parts.join(", ") : null;
}

function buildResult(status: OutcomeStatus, lines: string[], details: Fields, tail?: string): ActionOutcome {
  const text = lines.join("\n");
  const truncated = text.length > OUTPUT_LIMIT;
  const body = truncated
    ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${text.length} characters. ${TRUNCATION_NOTE}]`
    : text;
  return outcome(truncated && status === "success" ? "partial" : status, tail ? `${body}\n\n${tail}` : body, {
    provider: "scrapecreators",
    ...details,
    truncated,
  });
}

function mediaLines(ad: Fields, indent: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const add = (label: string, url: string | null) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    lines.push(`${indent}${label}: ${url}`);
  };
  for (const url of [
    asString(ad.image),
    ...strings(ad.imageSources),
    ...strings(ad.carouselImages),
    ...records(ad.carouselImages).map((image) => asString(image.url) ?? asString(image.src)),
  ]) {
    add("Image", url);
  }
  for (const source of [...records(ad.videoSources), ...records(ad.preRollVideoSources)]) {
    const bitrate = asNumber(source.bitrate);
    add(`Video${bitrate !== null ? ` (${fmtNum(bitrate)} bits/s)` : ""}`, asString(source.src));
  }
  for (const url of [asString(ad.video), asString(ad.organicVideo), asString(ad.preRollVideo)]) add("Video", url);
  for (const url of strings(ad.thumbnailSources)) add("Video poster", url);
  return lines;
}

function adLines(ad: Fields, id: string, index: number | null, full: boolean): { lines: string[]; media: number } {
  const indent = index === null ? "" : "   ";
  const advertiser = asString(ad.advertiser) ?? asString(ad.poster);
  const lines = [
    `${index === null ? "" : `${index + 1}. `}${advertiser ?? "(advertiser not returned)"} — ad ${id} — ${asString(ad.adType) ?? asString(ad.creativeType) ?? "format not returned"}`,
    `${indent}Ad Library: ${asString(ad.url) ?? `${LIBRARY_AD_URL}${id}`}`,
  ];
  const start = isoDate(ad.startDate);
  const end = isoDate(ad.endDate);
  const availability = asString(ad.adDuration);
  lines.push(
    `${indent}${start || end ? `Ran: ${start ?? "start not published"} → ${end ?? "end not published"}` : availability ? `Ran: ${availability}` : "Ran: dates not published"}`,
  );
  const countries = records(ad.impressionsByCountry)
    .map((entry) => plain(entry))
    .filter(present)
    .concat(strings(ad.impressionsByCountry));
  if (countries.length) lines.push(`${indent}Impressions by country (LinkedIn's ranges): ${countries.join("; ")}`);
  const headline = asString(ad.headline);
  if (headline) lines.push(`${indent}Headline: ${headline}`);
  const body = asString(ad.description);
  lines.push(...(body ? block("Text", body, indent) : [`${indent}Text: none returned for this ad`]));
  const destination = [
    asString(ad.destinationUrl) && `Destination: ${ad.destinationUrl}`,
    asString(ad.landingPage) && asString(ad.landingPage) !== asString(ad.destinationUrl) && `Landing page: ${ad.landingPage}`,
    asString(ad.cta) && `Call to action: ${ad.cta}`,
  ].filter(present);
  if (destination.length) lines.push(`${indent}${destination.join(" | ")}`);
  if (!full) return { lines, media: 0 };

  const page = asString(ad.advertiserLinkedinPage);
  if (page) lines.push(`${indent}Advertiser page: ${page}`);
  const poster = asString(ad.poster);
  const shownAs = [
    poster && poster !== advertiser && `Posted as: ${poster}${asString(ad.posterTitle) ? ` (${ad.posterTitle})` : ""}`,
    asString(ad.promotedBy) && `Promoted by: ${ad.promotedBy}`,
    asString(ad.preRollAdvertiser) && `Pre-roll advertiser: ${ad.preRollAdvertiser}`,
  ].filter(present);
  if (shownAs.length) lines.push(`${indent}${shownAs.join(" | ")}`);
  lines.push(`${indent}Paid for by: ${asString(ad.paidForBy) ?? "not published"}`);
  const total = plain(ad.totalImpressions);
  lines.push(`${indent}Total impressions (LinkedIn's range): ${total ?? "not published"}`);
  const targeting = asRecord(ad.targeting);
  const targeted = targeting
    ? Object.entries(targeting)
        .map(([key, value]) => [key, plain(value)] as const)
        .filter((pair): pair is readonly [string, string] => pair[1] !== null)
    : [];
  if (targeted.length) {
    lines.push(`${indent}Targeting (as LinkedIn publishes it):`, ...targeted.map(([key, value]) => `${indent}  ${key}: ${value}`));
  } else {
    lines.push(`${indent}Targeting: none published in this record`);
  }
  const table = plain(ad.targetingTable);
  if (table) lines.push(`${indent}Targeting categories LinkedIn flags: ${table}`);
  const sender = asString(ad.sponsoredMessageSender);
  if (sender) lines.push(`${indent}Sponsored message sender: ${sender}`);
  const buttons = plain(ad.sponsoredMessageButtons);
  if (buttons) lines.push(`${indent}Sponsored message buttons: ${buttons}`);
  const media = mediaLines(ad, indent);
  lines.push(...media);
  return { lines, media: media.length };
}

function searchAds(
  args: LinkedInAdArgs,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const company = args.company_name?.trim() || undefined;
    const companyId = args.company_id?.trim() || undefined;
    const keyword = args.query?.trim() || undefined;
    if (!company && !companyId && !keyword) {
      return failed("action='search' needs company_name, company_id or query.");
    }
    if (companyId && !NUMERIC_ID.test(companyId)) {
      return failed(
        "company_id must be LinkedIn's numeric company id, the number in a linkedin.com/company/<id> address.",
      );
    }
    const countries = args.countries?.replace(/\s+/g, "").toUpperCase() || undefined;
    if (countries && !COUNTRY_LIST.test(countries)) {
      return failed("countries must be two-letter country codes separated by commas, such as US,CA,MX.");
    }
    const start = args.start_date?.trim() || undefined;
    const end = args.end_date?.trim() || undefined;
    if (!start !== !end) {
      return failed("start_date and end_date go together; LinkedIn filters by dates only when both are given.");
    }
    if (start && !isCalendarDay(start)) return failed("start_date must be a date in YYYY-MM-DD form.");
    if (end && !isCalendarDay(end)) return failed("end_date must be a date in YYYY-MM-DD form.");
    if (start && end) {
      if (start > end) return failed("start_date must not be after end_date.");
      const today = Date.now();
      const yearAgo = new Date(today);
      yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
      if (start < day(yearAgo.getTime())) {
        return failed(
          `start_date must be no earlier than one year ago (${day(yearAgo.getTime())}); LinkedIn's library goes back no further.`,
        );
      }
      if (end >= day(today)) {
        return failed(`end_date must be yesterday (${day(today - DAY_MS)}) or earlier.`);
      }
    }

    const cursor = args.cursor?.trim() || undefined;
    const label = "ScrapeCreators LinkedIn Ad Library search";
    const response = yield* scrapecreatorsRequest(
      "/v1/linkedin/ads/search",
      { company, keyword, companyId, countries, startDate: start, endDate: end, paginationToken: cursor },
      headers,
      ctx,
      label,
    );
    if (!response.ok) return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
    const payload = response.payload;
    const listed = expectArray(payload, "ads", label);
    if (!listed.ok) return failed(listed.error);

    const ads: Array<{ ad: Fields; id: string }> = [];
    let unreadable = 0;
    for (const entry of listed.items) {
      const ad = asRecord(entry);
      const id = ad ? idOf(ad.id) : null;
      if (ad && id) ads.push({ ad, id });
      else unreadable += 1;
    }
    if (!ads.length && unreadable) {
      return failed(
        `${label} returned an unexpected payload: none of the ${plural(unreadable, "entry", "entries")} carried an ad id`,
      );
    }

    const shown = args.limit === undefined ? ads : ads.slice(0, args.limit);
    const next = payload.isLastPage === true ? null : asString(payload.paginationToken);
    const total = asNumber(payload.totalAds);
    const subject = [
      company && `company "${company}"`,
      companyId && `company id ${companyId}`,
      keyword && `keyword "${keyword}"`,
    ]
      .filter(present)
      .join(", ");
    const filters = [
      `countries=${countries ?? "all (none sent)"}`,
      start && end ? `dates=${start} → ${end}` : "dates=LinkedIn's full window (about the last year)",
    ];
    const lines = [
      `LinkedIn Ad Library search: ${subject}`,
      `Filters: ${filters.join(" | ")} | ${cursor ? "continuation page" : "first page"}`,
      provenanceLine(payload, response.charges),
      `Ads returned: ${ads.length}${shown.length < ads.length ? ` | ${shown.length} shown of ${ads.length} returned (limit=${args.limit})` : ""}${total !== null ? ` | LinkedIn's result count: ${fmtNum(total)}` : ""}`,
    ];
    if (unreadable) {
      lines.push(
        `Unreadable entries: ${plural(unreadable, "returned entry", "returned entries")} carried no ad id and ${unreadable === 1 ? "was" : "were"} skipped; see the retained original.`,
      );
    }
    lines.push(EVIDENCE_SCOPE);
    const details: Fields = {
      action: "search",
      company_name: company ?? null,
      company_id: companyId ?? null,
      query: keyword ?? null,
      filters,
      returned: ads.length,
      shown: shown.length,
      unreadable,
      result_count: total,
      cursor: next,
      ad_ids: shown.map(({ id }) => id),
      credits_charged: knownCharge(response.charges),
    };
    if (!ads.length) {
      lines.push("", "LinkedIn's Ad Library returned no ads for this search and filter set.");
      return buildResult("empty", lines, details);
    }
    lines.push("Search entries leave out payer, targeting and media; read action='detail' for the ads the answer rests on.");
    for (const [index, { ad, id }] of shown.entries()) lines.push("", ...adLines(ad, id, index, false).lines);
    const tail = next
      ? `Next page: pass cursor="${next}" with the same other arguments${continuesAfter(shown.length, ads.length, "ads")}.`
      : "Next page: none; LinkedIn reports this as the last page.";
    return buildResult(unreadable ? "partial" : "success", lines, details, tail);
  });
}

function adTarget(args: LinkedInAdArgs): { url: string; id: string } | { error: string } {
  const id = args.ad_id?.trim();
  const url = args.url?.trim();
  if (id && url) return { error: "Provide url or ad_id, not both." };
  if (!id && !url) return { error: "action='detail' needs an Ad Library url or ad_id." };
  if (id) {
    return NUMERIC_ID.test(id)
      ? { url: `${LIBRARY_AD_URL}${id}`, id }
      : { error: "ad_id must be the numeric Ad Library id." };
  }
  const error = `url must be a LinkedIn Ad Library address naming one ad, such as ${LIBRARY_AD_URL}666281156.`;
  let parsed: URL;
  try {
    parsed = new URL(url!);
  } catch {
    return { error };
  }
  const match = /^\/ad-library\/detail\/(\d+)\/?$/.exec(parsed.pathname);
  if (
    parsed.protocol !== "https:" ||
    !/^(www\.)?linkedin\.com$/i.test(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !match
  ) {
    return { error };
  }
  return { url: url!, id: match[1]! };
}

function adDetail(
  args: LinkedInAdArgs,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const target = adTarget(args);
    if ("error" in target) return failed(target.error);
    const label = "ScrapeCreators LinkedIn Ad Library ad";
    const response = yield* scrapecreatorsRequest("/v1/linkedin/ad", { url: target.url }, headers, ctx, label);
    if (!response.ok) return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
    const ad = response.payload;
    const id = idOf(ad.id);
    if (!id) return failed(`${label} returned an unexpected payload: an ad with an id is required`);
    if (id !== target.id) return failed(`${label} returned ad ${id} instead of requested ad ${target.id}`);
    const formatted = adLines(ad, id, null, true);
    const lines = [
      `LinkedIn Ad Library ad ${id}`,
      `Requested: ${target.url}`,
      provenanceLine(ad, response.charges),
      EVIDENCE_SCOPE,
    ];
    if (formatted.media) lines.push(MEDIA_NOTE);
    lines.push("", ...formatted.lines);
    return buildResult("success", lines, {
      action: "detail",
      ad_id: id,
      advertiser: asString(ad.advertiser),
      paid_for_by: asString(ad.paidForBy),
      media: formatted.media,
      credits_charged: knownCharge(response.charges),
    });
  });
}

export const linkedinAdLibraryAction = defineAction({
  name: "linkedin_ad_library",
  description:
    "Read LinkedIn's public Ad Library via ScrapeCreators, one request per call. " +
    "action='search': ads by company_name, company_id or keyword query, with countries and a start_date/end_date pair (LinkedIn's window is the last year, through yesterday); one page and a cursor for the next. " +
    "action='detail': one ad by its Ad Library url or ad_id, with who paid for it, its targeting and impression ranges where LinkedIn publishes them, and its media as addresses (nothing is downloaded). " +
    "Ad text is shown in full. The whole returned page is shown unless limit narrows the display. The library reports no spend or results. " +
    "Requires SCRAPECREATORS_API_KEY; 1 credit per request.",
  schema: LinkedInAdLibrarySchema,
  billing: scrapecreatorsBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const headers = scrapecreatorsHeaders();
      if (!headers) return failed(MISSING_SCRAPECREATORS_KEY);
      const invalid = validateEnum("action", args.action ?? "", LINKEDIN_AD_ACTION_VALUES);
      if (invalid) return failed(invalid);
      const action = args.action as Action;
      const misplaced = misplacedArgument(args, action);
      if (misplaced) return failed(misplaced);
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
        return failed("limit must be a positive whole number.");
      }
      return action === "search" ? yield* searchAds(args, headers, ctx) : yield* adDetail(args, headers, ctx);
    }),
});

export const linkedinAdsSource: SourcePlugin = defineSource({
  id: "linkedin-ads",
  group: "markets",
  label: "LinkedIn ads",
  description: "LinkedIn Ad Library ads and their published details",
  about:
    "LinkedIn's public Ad Library through ScrapeCreators: search ads from roughly the last year by company, keyword, country and date, and read one ad's text, destination, payer, and the targeting and impression ranges LinkedIn publishes. An ad's presence and how long it ran do not show how it performed or that a claim in it is true.",
  providers: [SCRAPECREATORS_PROVIDER],
  billing: SCRAPECREATORS_BILLING,
  logo: "linkedin",
  env: ["SCRAPECREATORS_API_KEY"],
  keys: ["SCRAPECREATORS_API_KEY"],
  credential: "SCRAPECREATORS_API_KEY",
  actions: [linkedinAdLibraryAction],
});

export default linkedinAdsSource;
