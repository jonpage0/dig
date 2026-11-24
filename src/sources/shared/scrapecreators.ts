import { Effect, Result } from "effect";
import { paidRequest, type KeepRaw, type PaidHttp } from "../../core/http.ts";
import { meteredBilling, outcome, setOutsideChat, type ActionContext, type ActionOutcome } from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import { USER_AGENT } from "../../version.ts";

export const SCRAPECREATORS_BASE = "https://api.scrapecreators.com";
export const SCRAPECREATORS_TIMEOUT_MS = 60_000;
export const SCRAPECREATORS_PROVIDER = { name: "ScrapeCreators", url: "https://scrapecreators.com" } as const;
export const SCRAPECREATORS_BILLING =
  "ScrapeCreators credits per request, from your ScrapeCreators account. Dig records the credits each response reports.";

export const CACHE_MAX_AGE_VALUES = ["1d", "3d", "7d", "14d", "30d"] as const;
export type CacheMaxAge = (typeof CACHE_MAX_AGE_VALUES)[number];

export const MISSING_SCRAPECREATORS_KEY = `SCRAPECREATORS_API_KEY is not set in Dig's keys.env. Get a key at https://scrapecreators.com. ${setOutsideChat()}`;
export const UNANSWERED_SCRAPECREATORS_COST =
  "ScrapeCreators may have received and charged this request, but no complete response arrived; its cost is unknown.";

export function scrapecreatorsHeaders(): Record<string, string> | null {
  const key = process.env.SCRAPECREATORS_API_KEY?.trim();
  if (!key) return null;
  return { "x-api-key": key, Accept: "application/json", "User-Agent": USER_AGENT };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

export function truncate(value: string | null, maxLength: number): string {
  if (!value) return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

export function isoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    return value.length >= 10 ? value.slice(0, 10) : null;
  }
  return null;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function displayLimit(value: unknown, max: number): number {
  return value === undefined ? Number.POSITIVE_INFINITY : clampInt(value, max, 1, max);
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function fmtMetric(n: number | null): string {
  return n === null ? "n/a" : fmtNum(n);
}

export function validateEnum<T extends string>(name: string, value: unknown, values: readonly T[]): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    return `${name} must be one of ${values.join(", ")}`;
  }
  return null;
}

export function continuesAfter(shown: number, returned: number, noun: string): string {
  return shown < returned
    ? ` (it continues after all ${returned} returned ${noun}, including the ${returned - shown} not shown)`
    : "";
}

export const creditsOf = (body: unknown): number | null => asNumber(asRecord(body)?.credits_charged);

export const scrapecreatorsBilling = meteredBilling("credits", creditsOf);

export type QueryParams = Record<string, string | number | boolean | undefined>;

export type ScrapeCreatorsResponse =
  | { readonly ok: true; readonly payload: Record<string, unknown>; readonly status: number }
  | {
      readonly ok: false;
      readonly cancelled: boolean;
      readonly error: string;
      readonly status?: number;
      readonly payload: Record<string, unknown> | null;
    };

export type ScrapeCreatorsResult = ScrapeCreatorsResponse & { readonly charges: Array<number | null> };

export function chargeRecorder(keep: KeepRaw): { keep: KeepRaw; charges: Array<number | null> } {
  const charges: Array<number | null> = [];
  return {
    charges,
    keep: (label, status, body, headers, interrupted) => {
      charges.push(interrupted ? null : creditsOf(body));
      keep(label, status, body, headers, interrupted);
    },
  };
}

export function knownCharge(charges: readonly (number | null)[]): number | null {
  return charges.length && charges.every((c) => c !== null)
    ? charges.reduce<number>((sum, c) => sum + (c ?? 0), 0)
    : null;
}

export function failText(response: { readonly cancelled: boolean; readonly error: string }): string {
  return response.cancelled ? `ERROR: Cancelled: ${response.error}` : `ERROR: ${response.error}`;
}

export function expectArray(
  payload: Record<string, unknown>,
  key: string,
  label: string,
): { readonly ok: true; readonly items: unknown[] } | { readonly ok: false; readonly error: string } {
  const value = payload[key];
  if (Array.isArray(value)) return { ok: true, items: value };
  return {
    ok: false,
    error: `${label} returned an unexpected payload: \`${key}\` is ${value === undefined ? "missing" : `not an array (${typeof value})`}`,
  };
}

export class CreditTally {
  charged = 0;
  unreported = 0;
  add(payload: Record<string, unknown> | null): void {
    this.addAttempts([payload ? asNumber(payload.credits_charged) : null]);
  }
  addAttempts(charges: readonly (number | null)[]): void {
    for (const credits of charges) {
      if (credits === null) this.unreported += 1;
      else this.charged += credits;
    }
  }
  describe(): string {
    if (this.unreported === 0) return `Credits charged: ${this.charged}`;
    return `Credits charged: ${this.charged} reported, plus ${this.unreported} request${this.unreported === 1 ? "" : "s"} that did not report a charge (total unknown)`;
  }
  details(): { readonly charged: number; readonly unreported: number } {
    return { charged: this.charged, unreported: this.unreported };
  }
}

export function provenanceLine(payload: Record<string, unknown>, charges?: readonly (number | null)[]): string {
  const credits = asNumber(payload.credits_charged);
  let charged = credits === null ? "Credits charged: not reported" : `Credits charged: ${credits}`;
  if (charges && charges.length > 1) {
    const tally = new CreditTally();
    tally.addAttempts(charges);
    charged = `${tally.describe()} over ${charges.length} attempts`;
  }
  if (payload.cached === true) {
    const cachedAt = asString(payload.cached_at);
    return `Served from ScrapeCreators cache${cachedAt ? ` (scraped ${cachedAt})` : ""}; ${charged.charAt(0).toLowerCase()}${charged.slice(1)}`;
  }
  return charged;
}

/**
 * Execute one GET against ScrapeCreators through `PaidHttp` (compile-time zero retries).
 */
export function scrapecreatorsRequest(
  path: string,
  params: QueryParams,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
  label: string,
  timeoutMs = SCRAPECREATORS_TIMEOUT_MS,
): Effect.Effect<ScrapeCreatorsResult, never, PaidHttp> {
  return Effect.gen(function* () {
    const { keep, charges } = chargeRecorder(ctx.keep);
    if (ctx.signal.aborted) {
      return {
        ok: false as const,
        cancelled: true,
        error: `${label} cancelled before the request was sent`,
        payload: null,
        charges,
      };
    }
    const url = new URL(path, SCRAPECREATORS_BASE);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const res = yield* Effect.result(
      paidRequest({
        url: url.href,
        method: "GET",
        headers,
        timeoutMs,
        signal: ctx.signal,
        label,
        keep,
      }),
    );

    if (Result.isFailure(res)) {
      if (ctx.signal.aborted) {
        return {
          ok: false as const,
          cancelled: true,
          error: `${label} cancelled while the request was in flight`,
          payload: null,
          charges,
        };
      }
      const msg = res.failure instanceof Error ? res.failure.message : String(res.failure);
      return {
        ok: false as const,
        cancelled: false,
        error: redactText(`${label} request failed: ${msg}. ${UNANSWERED_SCRAPECREATORS_COST}`, knownSecrets()),
        payload: null,
        charges,
      };
    }

    const { payload, status } = res.success;
    const record = asRecord(payload);
    const rawMessage = record ? (asString(record.error) ?? asString(record.message)) : null;
    const providerMessage = rawMessage ? redactText(rawMessage, knownSecrets()) : null;
    if (status !== 200) {
      return {
        ok: false as const,
        cancelled: false,
        status,
        error: `${label} returned HTTP ${status}${providerMessage ? `: ${providerMessage}` : ""}`,
        payload: record,
        charges,
      };
    }
    if (!record) {
      return {
        ok: false as const,
        cancelled: false,
        status,
        error: `${label} returned a non-JSON or empty body`,
        payload: null,
        charges,
      };
    }
    if (record.success === false) {
      return {
        ok: false as const,
        cancelled: false,
        status,
        error: `${label}: ${providerMessage ?? "request not successful"}`,
        payload: record,
        charges,
      };
    }
    return { ok: true as const, payload: record, status, charges };
  });
}

/**
 * Shared paginated JSON page reader for ScrapeCreators evidence endpoints
 * (`tiktok_top`, `tiktok_comments`, `instagram_comments`, `threads`).
 */
export function scrapecreatorsReadPage(
  path: string,
  params: QueryParams,
  arrayKey: string | null,
  label: string,
  ctx: Pick<ActionContext, "signal" | "keep">,
  note = "",
): Effect.Effect<ActionOutcome, never, PaidHttp> {
  return Effect.gen(function* () {
    const headers = scrapecreatorsHeaders();
    if (!headers) return outcome("failed", `ERROR: ${MISSING_SCRAPECREATORS_KEY}`);
    const response = yield* scrapecreatorsRequest(path, params, headers, ctx, label);
    if (!response.ok) {
      return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
    }
    const body = response.payload;
    if (arrayKey && !Array.isArray(body[arrayKey])) {
      return outcome("failed", `ERROR: ${label} did not return its ${arrayKey} array`);
    }
    if (!arrayKey) {
      const post = asRecord(body.post);
      if (!post || !(post.id || post.pk)) {
        return outcome("failed", "ERROR: Threads returned no identifiable post");
      }
    }

    let malformed = false;
    const view: Record<string, unknown> = { ...body };
    delete view.credits_remaining;
    if (arrayKey) {
      const seen = new Set<string>();
      view[arrayKey] = (body[arrayKey] as unknown[]).filter((item) => {
        const rec = asRecord(item);
        if (!rec) {
          malformed = true;
          return false;
        }
        const id = rec.id ?? rec.cid ?? rec.pk;
        if (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id))) {
          malformed = true;
          return false;
        }
        const key = String(id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    const json = JSON.stringify(view, null, 2);
    const truncated = json.length > 60_000;
    const hasMore =
      body.end_of_pagination !== true &&
      (body.has_more === true ||
        body.has_more === 1 ||
        body.hasMore === true ||
        ([body.has_more, body.hasMore].every((flag) => flag !== false && flag !== 0) &&
          body.cursor !== undefined &&
          body.cursor !== null &&
          body.cursor !== "" &&
          body.cursor !== 0 &&
          body.cursor !== "0"));
    const count = arrayKey ? (view[arrayKey] as unknown[]).length : 1;
    const status = malformed || truncated ? "partial" : count ? "success" : "empty";
    return outcome(
      status,
      `${label}\n${provenanceLine(body)}\n${note}\nOne provider page; not a complete platform archive.${hasMore ? " More data may exist; use the returned continuation on the same operation." : ""}${malformed ? " Malformed records were omitted." : ""}${truncated ? " Output shortened; read the retained original for the rest." : ""}\n\n${json.slice(0, 60_000)}`,
    );
  });
}
