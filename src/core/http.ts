import { Context, Duration, Effect, Layer, Schedule, Stream } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import { knownSecrets, redactProviderText, redactText, type RedactedProviderText } from "./secrets.ts";
import { assertPublicUrl } from "./ssrf.ts";

/**
 * Compile-time HTTP separation for Dig 2.0:
 * - `PaidHttp`: ZERO retries, `redirect: "manual"` (never silently redirects with credentials),
 *   hop-safe SSRF guard inside `HttpClient.transform` (postprocess), redacted auth/token headers & params.
 * - `FreeHttp`: hop-safe SSRF guard checked on EVERY redirect hop (below `followRedirects`),
 *   bounded transient retry (2 retries with exponential backoff), redacted auth headers & params.
 */

export const REDACTED_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-exa-api-key",
] as const;

export const REDACTED_QUERY_PARAMS = [
  "token",
  "api_key",
  "apikey",
  "key",
  "access_token",
] as const;

export interface BillingHeaders {
  readonly "scrape.do-request-cost": string;
}

export interface RetainedResponse {
  readonly label: string;
  readonly status: number | string;
  readonly body: unknown;
  /** Deliberately narrow: never retain arbitrary response headers. */
  readonly headers?: BillingHeaders;
}

export type KeepRaw = (
  label: string,
  status: number | string,
  body: unknown,
  headers?: BillingHeaders,
  interrupted?: boolean,
) => void;

export class PaidHttp extends Context.Service<PaidHttp, HttpClient.HttpClient>()("dig/PaidHttp") {}
export class FreeHttp extends Context.Service<FreeHttp, HttpClient.HttpClient>()("dig/FreeHttp") {}

/**
 * Install the SSRF guard inside `HttpClient.transform` (postprocess) so it executes on
 * EVERY hop when layered below `HttpClient.followRedirects`.
 */
export const FollowRedirectsEnabled = Context.Reference<boolean>("dig/FollowRedirectsEnabled", {
  defaultValue: () => true,
});

const SAFE_CROSS_ORIGIN_HEADERS = new Set(["accept", "accept-language", "user-agent"]);

/**
 * Install the SSRF guard inside `HttpClient.transform` (postprocess) so it executes on
 * EVERY hop. Uses `InvalidUrlError` (not `TransportError`) so `retryTransient` never retries
 * an SSRF-blocked URL.
 */
export function withHopSafeSsrfGuard<E, R>(
  client: HttpClient.HttpClient.With<E, R>,
  options?: { readonly resolveDns?: boolean },
): HttpClient.HttpClient.With<E | HttpClientError.HttpClientError, R> {
  return HttpClient.transform(client, (effect, request) =>
    Effect.gen(function* () {
      const fullUrl = buildFullRequestUrl(request);
      yield* assertPublicUrl(fullUrl, options).pipe(
        Effect.mapError(
          (err) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.InvalidUrlError({
                request,
                description: err.message,
                cause: err,
              }),
            }),
        ),
      );
      return yield* effect;
    }),
  );
}

/**
 * Safe manual redirect follower layered ABOVE `withHopSafeSsrfGuard`:
 * - Honors `FollowRedirectsEnabled` so callers like `x_images`, `dataforseo` docs, or `wayback`
 *   can inspect 3xx directly without following.
 * - Strips all non-allowlisted headers (including `x-api-key`, `authorization`, `cookie`) on
 *   cross-origin hops so credentials never leak across origins.
 */
function withSafeRedirects<E, R>(
  client: HttpClient.HttpClient.With<E, R>,
  maxRedirects: number,
): HttpClient.HttpClient.With<E, R> {
  return HttpClient.transform(client, (firstEffect, firstReq) =>
    Effect.gen(function* () {
      const follow = yield* FollowRedirectsEnabled;
      let res = yield* firstEffect;
      let req = firstReq;
      let hops = 0;
      while (follow && res.status >= 300 && res.status < 400) {
        const location = res.headers["location"];
        if (!location || hops >= maxRedirects) return res;
        hops += 1;
        const prevUrl = new URL(buildFullRequestUrl(req));
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, prevUrl);
        } catch {
          return res;
        }
        const crossOrigin = nextUrl.origin !== prevUrl.origin;
        const nextMethod = (
          res.status === 303 || ((res.status === 301 || res.status === 302) && req.method === "POST")
            ? "GET"
            : req.method
        ) as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
        let nextReq = HttpClientRequest.make(nextMethod)(nextUrl.href);
        const nextHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v !== "string") continue;
          const lower = k.toLowerCase();
          // Redirected requests carry no body here (including 307/308), so never forward stale body headers.
          if (lower === "content-length" || lower === "content-type" || lower === "transfer-encoding") continue;
          if (crossOrigin && !SAFE_CROSS_ORIGIN_HEADERS.has(lower)) continue;
          nextHeaders[k] = v;
        }
        nextReq = HttpClientRequest.setHeaders(nextReq, nextHeaders);
        req = nextReq;
        res = yield* client.execute(req);
      }
      return res;
    }),
  );
}

function buildFullRequestUrl(request: HttpClientRequest.HttpClientRequest): string {
  const qs = UrlParams.toString(request.urlParams);
  if (!qs) return request.url;
  const sep = request.url.includes("?") ? "&" : "?";
  return `${request.url}${sep}${qs}`;
}

const withRedaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.provideService(Headers.CurrentRedactedNames, REDACTED_HEADERS),
    Effect.provideService(UrlParams.CurrentRedactedNames, REDACTED_QUERY_PARAMS),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
  );

/**
 * Build a `PaidHttp` client over any base `HttpClient` (real `FetchHttpClient` or mock in tests).
 * Never retries, never follows redirects automatically, never emits trace headers.
 */
export function makePaidClient(
  base: HttpClient.HttpClient,
  options?: { readonly defaultTimeout?: Duration.Input; readonly resolveDns?: boolean },
): HttpClient.HttpClient {
  const guarded = withHopSafeSsrfGuard(base, { resolveDns: options?.resolveDns });
  return HttpClient.transform(guarded, (effect, request) => {
    const redacted = withRedaction(effect);
    if (options?.defaultTimeout === undefined) return redacted;
    return redacted.pipe(
      Effect.timeoutOrElse({
        duration: options.defaultTimeout,
        orElse: () =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: "HTTP request timed out",
              }),
            }),
          ),
      }),
    );
  });
}

/**
 * Build a `FreeHttp` client over any base `HttpClient`.
 * Enforces hop-safe SSRF BEFORE `withSafeRedirects` (stripping credentials cross-origin & honoring
 * `FollowRedirectsEnabled`), then wraps with bounded transient retries (never retrying SSRF blocks).
 */
export function makeFreeClient(
  base: HttpClient.HttpClient,
  options?: {
    readonly resolveDns?: boolean;
    readonly maxRedirects?: number;
    readonly retries?: number;
  },
): HttpClient.HttpClient {
  const guarded = withHopSafeSsrfGuard(base, { resolveDns: options?.resolveDns });
  const redirected = withSafeRedirects(guarded, options?.maxRedirects ?? 5);
  const retried = HttpClient.retryTransient(redirected, {
    times: options?.retries ?? 2,
    schedule: Schedule.exponential(Duration.millis(500)),
  });
  return HttpClient.transform(retried, (effect) => withRedaction(effect));
}
const ManualRedirectFetchLayer = Layer.succeed(FetchHttpClient.RequestInit, {
  redirect: "manual",
});

export const PaidHttpLive: Layer.Layer<PaidHttp> = Layer.effect(
  PaidHttp,
  Effect.map(HttpClient.HttpClient, (base) => makePaidClient(base)),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(ManualRedirectFetchLayer));

export const FreeHttpLive: Layer.Layer<FreeHttp> = Layer.effect(
  FreeHttp,
  Effect.map(HttpClient.HttpClient, (base) => makeFreeClient(base)),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(ManualRedirectFetchLayer));

export const HttpLive: Layer.Layer<PaidHttp | FreeHttp> = Layer.mergeAll(PaidHttpLive, FreeHttpLive);

export function billingHeadersFrom(headers: Headers.Headers): BillingHeaders | undefined {
  const cost = headers["scrape.do-request-cost"];
  return typeof cost === "string" ? { "scrape.do-request-cost": cost } : undefined;
}

export function extractRequestId(headers: Headers.Headers): string | undefined {
  for (const name of ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"]) {
    const value = headers[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export interface KeptHttpResult {
  readonly status: number;
  readonly headers: Headers.Headers;
  readonly text: string;
  readonly payload: unknown;
  readonly isJson: boolean;
  readonly durationMs: number;
  readonly requestId?: string;
}

export interface KeptRequestOptions {
  readonly url: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly rawBody?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly followRedirects?: boolean;
  readonly label: string;
  readonly keep: KeepRaw;
  readonly parseJson?: (text: string) => unknown;
}

function capture(
  keep: KeepRaw,
  label: string,
  status: number | string,
  body: unknown,
  headers?: BillingHeaders,
  interrupted = false,
): void {
  if (interrupted) keep(label, status, body, headers, true);
  else if (headers) keep(label, status, body, headers);
  else keep(label, status, body);
}

/**
 * Execute one HTTP request through an explicit `HttpClient` (`PaidHttp` or `FreeHttp`),
 * reading and redacting the response body immediately, capturing it via `keep`, and
 * recording interrupted body reads so paid cost accounting stays strictly honest.
 */
export function executeKeptRequest(
  client: HttpClient.HttpClient,
  options: KeptRequestOptions,
): Effect.Effect<KeptHttpResult, HttpClientError.HttpClientError> {
  return Effect.gen(function* () {
    const startedAt = performance.now();
    let req = HttpClientRequest.make(options.method ?? "GET")(options.url);
    if (options.headers) req = HttpClientRequest.setHeaders(req, options.headers);
    if (options.rawBody !== undefined) {
      req =
        typeof options.rawBody === "string"
          ? HttpClientRequest.bodyText(req, options.rawBody)
          : HttpClientRequest.bodyUint8Array(req, options.rawBody);
    } else if (options.body !== undefined) {
      req = HttpClientRequest.bodyJsonUnsafe(req, options.body);
    }

    const timeoutMs = options.timeoutMs ?? 60_000;
    const withSignal = <A>(eff: Effect.Effect<A, HttpClientError.HttpClientError>) => {
      const sig = options.signal;
      if (!sig) return eff;
      if (sig.aborted) {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: req,
              description: `${options.label} cancelled`,
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
                  description: `${options.label} cancelled`,
                }),
              }),
            ),
          );
        sig.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => sig.removeEventListener("abort", onAbort));
      });
      return Effect.raceFirst(eff, abortWait);
    };

    const withDeadline = <A>(
      eff: Effect.Effect<A, HttpClientError.HttpClientError>,
      remainingMs: number,
    ) =>
      withSignal(eff).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(Math.max(1, remainingMs)),
          orElse: () =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request: req,
                  description: `${options.label} timed out after ${timeoutMs}ms`,
                }),
              }),
            ),
        }),
      );

    const response = yield* withDeadline(client.execute(req), timeoutMs).pipe(
      Effect.tapError((err) =>
        Effect.sync(() => {
          capture(options.keep, options.label, "error", redactText(err.message, knownSecrets()));
        }),
      ),
    );
    const bHeaders = billingHeadersFrom(response.headers);
    const remainingForBody = timeoutMs - (performance.now() - startedAt);
    const rawText = yield* withDeadline(response.text, remainingForBody).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          capture(options.keep, options.label, response.status, "", bHeaders, true);
        }),
      ),
    );

    const redacted: RedactedProviderText = redactProviderText(rawText, knownSecrets(), options.parseJson);
    const payload = redacted.json ? redacted.value : null;
    capture(options.keep, options.label, response.status, redacted.json ? redacted.value : redacted.text, bHeaders);

    return {
      status: response.status,
      headers: response.headers,
      text: redacted.text,
      payload,
      isJson: redacted.json,
      durationMs: Math.round(performance.now() - startedAt),
      requestId: extractRequestId(response.headers),
    };
  }).pipe(
    Effect.scoped,
    withRedaction,
    Effect.provideService(FollowRedirectsEnabled, options.followRedirects ?? true),
  );
}

/** Execute a paid HTTP call via the `PaidHttp` service (compile-time zero-retry guarantee). */
export const paidRequest = (
  options: KeptRequestOptions,
): Effect.Effect<KeptHttpResult, HttpClientError.HttpClientError, PaidHttp> =>
  Effect.gen(function* () {
    const client = yield* PaidHttp;
    return yield* executeKeptRequest(client, { ...options, followRedirects: false });
  });

/** Execute a free HTTP call via the `FreeHttp` service (hop-safe redirects + bounded retries). */
export const freeRequest = (
  options: KeptRequestOptions,
): Effect.Effect<KeptHttpResult, HttpClientError.HttpClientError, FreeHttp> =>
  Effect.gen(function* () {
    const client = yield* FreeHttp;
    return yield* executeKeptRequest(client, options);
  });

/**
 * Fetch binary bytes via `FreeHttp` with streaming `maxBytes` cap, body timeout,
 * optional `followRedirects: false`, and AbortSignal cancellation.
 */
export const freeBytes = (
  url: string,
  options?: {
    readonly headers?: Record<string, string>;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    readonly followRedirects?: boolean;
    readonly signal?: AbortSignal;
  },
): Effect.Effect<
  {
    readonly status: number;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly exceededMaxBytes?: boolean;
    readonly location?: string;
  },
  HttpClientError.HttpClientError,
  FreeHttp
> =>
  Effect.gen(function* () {
    const client = yield* FreeHttp;
    const startedAt = performance.now();
    const timeoutMs = options?.timeoutMs ?? 30_000;
    let req = HttpClientRequest.get(url);
    if (options?.headers) req = HttpClientRequest.setHeaders(req, options.headers);

    const withDeadline = <A>(eff: Effect.Effect<A, HttpClientError.HttpClientError>, ms: number) => {
      const sig = options?.signal;
      const raced = sig
        ? sig.aborted
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request: req, description: "Fetch cancelled" }),
              }),
            )
          : Effect.raceFirst(
              eff,
              Effect.callback<never, HttpClientError.HttpClientError>((resume) => {
                const onAbort = () =>
                  resume(
                    Effect.fail(
                      new HttpClientError.HttpClientError({
                        reason: new HttpClientError.TransportError({ request: req, description: "Fetch cancelled" }),
                      }),
                    ),
                  );
                sig.addEventListener("abort", onAbort, { once: true });
                return Effect.sync(() => sig.removeEventListener("abort", onAbort));
              }),
            )
        : eff;
      return raced.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(Math.max(1, ms)),
          orElse: () =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request: req,
                  description: `Image fetch timed out after ${timeoutMs}ms`,
                }),
              }),
            ),
        }),
      );
    };

    const response = yield* withDeadline(client.execute(req), timeoutMs);
    const contentType = response.headers["content-type"] ?? "application/octet-stream";
    const location = response.headers["location"];
    if (response.status >= 300 && response.status < 400) {
      return { status: response.status, contentType, bytes: new Uint8Array(0), ...(location ? { location } : {}) };
    }

    const remaining = timeoutMs - (performance.now() - startedAt);
    const maxBytes = options?.maxBytes;
    const contentLen = Number(response.headers["content-length"]);
    if (maxBytes !== undefined && Number.isFinite(contentLen) && contentLen > maxBytes) {
      return { status: response.status, contentType, bytes: new Uint8Array(0), exceededMaxBytes: true };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    let exceeded = false;
    const MAX_BYTES_EXCEEDED = Symbol("MAX_BYTES_EXCEEDED");
    const readBody = Stream.runForEach(response.stream, (chunk) => {
      total += chunk.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        exceeded = true;
        return Effect.fail(MAX_BYTES_EXCEEDED);
      }
      chunks.push(chunk);
      return Effect.void;
    }).pipe(
      Effect.catch((err) =>
        err === MAX_BYTES_EXCEEDED
          ? Effect.void
          : Effect.fail(err as HttpClientError.HttpClientError),
      ),
    );
    yield* withDeadline(readBody, remaining);
    if (exceeded) {
      return { status: response.status, contentType, bytes: new Uint8Array(0), exceededMaxBytes: true };
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return { status: response.status, contentType, bytes: merged };
  }).pipe(
    Effect.scoped,
    withRedaction,
    Effect.provideService(FollowRedirectsEnabled, options?.followRedirects ?? true),
  );

export type { HttpClientResponse };
