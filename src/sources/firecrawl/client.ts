import { Effect, Result } from "effect";
import { paidRequest, type KeepRaw, type PaidHttp } from "../../core/http.ts";
import { setOutsideChat } from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import { validatePublicUrlSyntax } from "../../core/ssrf.ts";
import { USER_AGENT } from "../../version.ts";

export const FIRECRAWL_BASE = "https://api.firecrawl.dev";
export const FIRECRAWL_COST_UNIT = "Firecrawl credits";
export const MISSING_FIRECRAWL_KEY = `FIRECRAWL_API_KEY is not set in Dig's keys.env. Get a key at https://www.firecrawl.dev/app/api-keys. ${setOutsideChat()}`;
export const UNANSWERED_FIRECRAWL_COST =
  "Firecrawl may have received and charged this request, but no complete response arrived; its cost is unknown.";

export const CLIENT_TIMEOUT_MS = 70_000;
export const PROVIDER_TIMEOUT_MS = 60_000;
export const MAX_WAIT_FOR_MS = 10_000;
export const DEFAULT_MAX_CHARACTERS = 40_000;
export const MIN_MAX_CHARACTERS = 500;
export const MAX_MAX_CHARACTERS = 100_000;
export const DEFAULT_MAP_LIMIT = 50;
export const MAX_MAP_LIMIT = 200;

export const SCRAPE_FORMATS = ["markdown", "html", "links"] as const;
export type ScrapeFormat = (typeof SCRAPE_FORMATS)[number];

export const SITEMAP_MODES = ["include", "skip", "only"] as const;
export type SitemapMode = (typeof SITEMAP_MODES)[number];

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Firecrawl credits reported on a response body (`creditsUsed` or `data.metadata.creditsUsed`); null when omitted. */
export function reportedFirecrawlCredits(body: unknown): number | null {
  const record = asRecord(body);
  if (!record) return null;
  const top = optionalNumber(record.creditsUsed);
  if (top !== undefined && top >= 0) return top;
  const meta = asRecord(asRecord(record.data)?.metadata);
  const nested = optionalNumber(meta?.creditsUsed);
  if (nested !== undefined && nested >= 0) return nested;
  return null;
}

export function apiKey(): string | null {
  return process.env.FIRECRAWL_API_KEY?.trim() || null;
}

export function formatCreditsNote(credits: number | null): string {
  if (credits === null) return "credits not reported (cost unknown)";
  return `${credits} Firecrawl ${credits === 1 ? "credit" : "credits"}`;
}

function isBlockedIpv4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT RFC 6598
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function parseIpv6Hextets(raw: string): number[] | null {
  const ip = raw.toLowerCase().split("%")[0];
  if (!ip) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const tokens = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes(".")) {
        if (i !== tokens.length - 1) return null;
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tok);
        if (!m) return null;
        const octets = m.slice(1).map(Number);
        if (octets.some((n) => n > 255)) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        out.push(parseInt(tok, 16));
      }
    }
    return out;
  };

  const left = parsePart(halves[0]);
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = parsePart(halves[1]);
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isBlockedIpv6(host: string): boolean {
  const h = parseIpv6Hextets(host);
  if (!h) return true;
  if ((h[0] & 0xe000) !== 0x2000) return true;
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (h[0] === 0x2001 && h[1] === 0x0000) return true; // 2001::/32 Teredo
  if (h[0] === 0x2002) return true; // 2002::/16 6to4
  return false;
}

/**
 * Validate a public http(s) URL before sending any paid request to Firecrawl.
 * Refuses non-http(s) schemes, embedded credentials, single-label hosts, localhost/internal domains,
 * and private, loopback, link-local, CGNAT, or reserved IPv4/IPv6 addresses.
 */
export function validatePublicHttpUrl(value: unknown): URL | { readonly error: string } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { error: "url is required." };
  if (!/^https?:\/\//i.test(raw)) {
    return { error: "url must begin with http:// or https://." };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "url is not a valid http(s) URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "url must use http:// or https://." };
  }
  if (url.username || url.password) {
    return { error: "url must not contain embedded credentials." };
  }

  const ssrfCheck = validatePublicUrlSyntax(url);
  if (ssrfCheck instanceof Error) {
    return { error: `Refused private, loopback, or local target "${url.hostname}": ${ssrfCheck.message}` };
  }

  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return { error: "url must include a hostname." };

  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    if (isBlockedIpv6(inner)) {
      return { error: `Refused private, loopback, or link-local target "${host}".` };
    }
    return url;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return { error: `Invalid IPv4 address "${host}".` };
    if (isBlockedIpv4(octets[0], octets[1], octets[2])) {
      return { error: `Refused private, loopback, or link-local target "${host}".` };
    }
    return url;
  }

  const labels = host.split(".");
  if (
    labels.length < 2 ||
    labels.some((l) => l.length === 0) ||
    host === "localhost" ||
    host === "metadata.goog" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".localdomain") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    host.endsWith(".metadata.goog")
  ) {
    return { error: `Refused private, loopback, or local target "${host}".` };
  }

  return url;
}

export type FirecrawlPostResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly cancelled: boolean; readonly error: string };

/**
 * Execute one paid Firecrawl v2 POST through `PaidHttp` (compile-time zero retries).
 */
export function firecrawlPost(
  path: "/v2/scrape" | "/v2/map",
  body: Record<string, unknown>,
  options: {
    readonly operation: string;
    readonly key: string;
    readonly signal: AbortSignal;
    readonly keep: KeepRaw;
  },
): Effect.Effect<FirecrawlPostResult, never, PaidHttp> {
  return Effect.gen(function* () {
    if (options.signal.aborted) {
      return {
        ok: false as const,
        cancelled: true,
        error: `Firecrawl ${options.operation} canceled before completion; not a provider failure.`,
      };
    }

    const res = yield* Effect.result(
      paidRequest({
        url: `${FIRECRAWL_BASE}${path}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body,
        timeoutMs: CLIENT_TIMEOUT_MS,
        signal: options.signal,
        label: path,
        keep: options.keep,
      }),
    );

    if (Result.isFailure(res)) {
      if (options.signal.aborted) {
        return {
          ok: false as const,
          cancelled: true,
          error: `Firecrawl ${options.operation} canceled before completion; not a provider failure.`,
        };
      }
      const message = res.failure instanceof Error ? res.failure.message : String(res.failure);
      return {
        ok: false as const,
        cancelled: false,
        error: `Firecrawl ${options.operation} failed: ${redactText(message, knownSecrets())}. ${UNANSWERED_FIRECRAWL_COST}`,
      };
    }

    const { status, payload: rawPayload, text, requestId } = res.success;
    const payload = asRecord(rawPayload);
    const envelopeError = optionalString(payload?.error);
    if (status < 200 || status >= 300 || payload?.success === false || envelopeError !== undefined) {
      const detail =
        envelopeError ??
        (text.trim() ? text.trim().slice(0, 240) : `HTTP ${status}`);
      const reqId = requestId ? ` [request ${requestId}]` : "";
      return {
        ok: false as const,
        cancelled: false,
        error: `Firecrawl ${options.operation} failed: ${redactText(`Firecrawl ${path} returned HTTP ${status}: ${detail}${reqId}`, knownSecrets())}`,
      };
    }
    if (!payload) {
      return {
        ok: false as const,
        cancelled: false,
        error: `Firecrawl ${options.operation} failed: Firecrawl ${path} returned an unexpected non-object JSON body`,
      };
    }
    return { ok: true as const, payload };
  });
}
