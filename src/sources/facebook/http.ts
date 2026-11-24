/**
 * One ScrapeCreators request for the Facebook source: never retried and never redirected.
 * Runs over `PaidHttp` (`paidRequest`), keeping every response for receipt metering and redacting secrets.
 */
import { Effect, Result } from "effect";
import { paidRequest, type PaidHttp } from "../../core/http.ts";
import type { ActionContext } from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import {
  SCRAPECREATORS_BASE,
  SCRAPECREATORS_TIMEOUT_MS,
  UNANSWERED_SCRAPECREATORS_COST,
  asRecord,
  asString,
  type QueryParams,
  type ScrapeCreatorsResponse,
} from "../shared/scrapecreators.ts";

const FACEBOOK_PATH_PREFIX = "/v1/facebook/";

export function facebookRequest(
  path: string,
  params: QueryParams,
  headers: Record<string, string>,
  ctx: Pick<ActionContext, "signal" | "keep">,
  label: string,
  method: "GET" | "POST" = "GET",
): Effect.Effect<ScrapeCreatorsResponse, never, PaidHttp> {
  return Effect.gen(function* () {
    const url = new URL(path, SCRAPECREATORS_BASE);
    if (!path.startsWith(FACEBOOK_PATH_PREFIX) || url.origin !== SCRAPECREATORS_BASE) {
      return {
        ok: false as const,
        cancelled: false,
        error: `facebookRequest reaches only ScrapeCreators' Facebook endpoints, not ${path}`,
        payload: null,
      };
    }
    if (ctx.signal.aborted) {
      return {
        ok: false as const,
        cancelled: true,
        error: `${label} cancelled before the request was sent`,
        payload: null,
      };
    }

    const sent = Object.entries(params).filter(([, value]) => value !== undefined && value !== "");
    if (method === "GET") {
      for (const [key, value] of sent) url.searchParams.set(key, String(value));
    }

    const secrets = knownSecrets();
    const cancelledInFlight = {
      ok: false as const,
      cancelled: true,
      error: `${label} cancelled while the request was in flight`,
      payload: null,
    };

    const res = yield* Effect.result(
      paidRequest({
        url: url.href,
        method,
        headers,
        body: method === "POST" ? Object.fromEntries(sent) : undefined,
        timeoutMs: SCRAPECREATORS_TIMEOUT_MS,
        signal: ctx.signal,
        label,
        keep: ctx.keep,
      }),
    );

    if (Result.isFailure(res)) {
      if (ctx.signal.aborted) return cancelledInFlight;
      const msg = res.failure instanceof Error ? res.failure.message : "Unknown error";
      return {
        ok: false as const,
        cancelled: false,
        error: `${redactText(`${label} request failed: ${msg}`, secrets)}. ${UNANSWERED_SCRAPECREATORS_COST}`,
        payload: null,
      };
    }

    if (ctx.signal.aborted) return cancelledInFlight;

    const { status, payload, headers: respHeaders } = res.success;
    const record = asRecord(payload);
    const rawMessage = record ? (asString(record.error) ?? asString(record.message)) : null;
    const providerMessage = rawMessage ? redactText(rawMessage, secrets) : null;

    if (status >= 300 && status < 400) {
      const location = respHeaders.location;
      return {
        ok: false as const,
        cancelled: false,
        status,
        error: `${label} answered HTTP ${status}${location ? ` with a redirect to ${redactText(location, secrets)}` : ""}; Dig does not follow redirects for requests that carry the ScrapeCreators key`,
        payload: record,
      };
    }
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
