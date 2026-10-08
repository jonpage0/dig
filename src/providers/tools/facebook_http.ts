/**
 * One ScrapeCreators request for the Facebook tools: never retried and never redirected.
 *
 * The shared ScrapeCreators helper goes through requestJson, which lets fetch follow redirects (fetch
 * strips Authorization-type headers on a cross-origin redirect, but a custom `x-api-key` travels on) and
 * retries transient statuses. Here a 3xx answer is kept and reported as a failure instead of being
 * followed, so the key can only ever reach api.scrapecreators.com, and each call is exactly one
 * request, so every request the provider may bill leaves its response for the receipt.
 *
 * Results have scrapecreatorsRequest's shape and meaning: a non-200 status or a `success: false`
 * body is an error carrying the provider's own message, a failed response keeps its JSON body as
 * `payload`, an aborted signal is a cancellation, and parameters that are undefined or "" are not
 * sent. The parsed body is redacted before it is returned, because callers may truncate it, and a
 * cut credential would escape the boundary's exact-match redaction.
 */
import { keptText } from "../http.js"
import { knownSecrets, redactText, redactValue } from "../secrets.js"
import { asRecord, asString, type QueryParams, type RequestContext, type ScrapeCreatorsResponse } from "./scrapecreators.js"

const SC_BASE = "https://api.scrapecreators.com"
const FACEBOOK_PATH_PREFIX = "/v1/facebook/"
const TIMEOUT_MS = 60_000

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Unknown error")

/**
 * GET sends the parameters as the query; POST, which ScrapeCreators documents as equivalent for
 * the Ad Library list endpoints, sends the same parameters as a JSON body.
 */
export async function facebookRequest(
  path: string,
  params: QueryParams,
  headers: Record<string, string>,
  ctx: RequestContext,
  label: string,
  method: "GET" | "POST" = "GET",
): Promise<ScrapeCreatorsResponse> {
  const url = new URL(path, SC_BASE)
  if (!path.startsWith(FACEBOOK_PATH_PREFIX) || url.origin !== SC_BASE) {
    throw new Error(`facebookRequest reaches only ScrapeCreators' Facebook endpoints, not ${path}`)
  }
  const signal = ctx.abort
  if (signal.aborted) return { ok: false, cancelled: true, error: `${label} cancelled before the request was sent`, payload: null }
  const sent = Object.entries(params).filter(([, value]) => value !== undefined && value !== "")
  const init: RequestInit =
    method === "GET"
      ? { method, headers }
      : { method, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(sent)) }
  if (method === "GET") for (const [key, value] of sent) url.searchParams.set(key, String(value))
  const secrets = knownSecrets()
  const cancelledInFlight = { ok: false, cancelled: true, error: `${label} cancelled while the request was in flight`, payload: null } as const

  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) })
  } catch (error) {
    ctx.keep(label, "error", errorText(error))
    if (signal.aborted) return cancelledInFlight
    return { ok: false, cancelled: false, error: redactText(`${label} request failed: ${errorText(error)}`, secrets), payload: null }
  }
  let text: string
  try {
    text = await keptText(response, ctx.keep, label)
  } catch (error) {
    if (signal.aborted) return cancelledInFlight
    return { ok: false, cancelled: false, error: redactText(`${label} broke off while answering: ${errorText(error)}`, secrets), payload: null }
  }
  if (signal.aborted) return cancelledInFlight

  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {}
  const record = asRecord(redactValue(parsed, secrets))
  const providerMessage = record ? (asString(record.error) ?? asString(record.message)) : null
  const status = response.status
  if (status >= 300 && status < 400) {
    const location = response.headers.get("location")
    return {
      ok: false,
      cancelled: false,
      error: `${label} answered HTTP ${status}${location ? ` with a redirect to ${redactText(location, secrets)}` : ""}; Dig does not follow redirects for requests that carry the ScrapeCreators key`,
      payload: record,
    }
  }
  if (status !== 200) {
    return { ok: false, cancelled: false, error: `${label} returned HTTP ${status}${providerMessage ? `: ${providerMessage}` : ""}`, payload: record }
  }
  if (!record) return { ok: false, cancelled: false, error: `${label} returned a non-JSON or empty body`, payload: null }
  if (record.success === false) return { ok: false, cancelled: false, error: `${label}: ${providerMessage ?? "request not successful"}`, payload: record }
  return { ok: true, payload: record, status }
}
