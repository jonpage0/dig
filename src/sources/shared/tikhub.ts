import { Effect, Result } from "effect";
import { paidRequest, type PaidHttp } from "../../core/http.ts";
import { setOutsideChat, type ActionContext } from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import { USER_AGENT } from "../../version.ts";

export const TIKHUB_DEFAULT_BASE = "https://api.tikhub.io";
export const TIKHUB_TIMEOUT_MS = 60_000;
export const TIKHUB_PROVIDER = { name: "TikHub", url: "https://tikhub.io" } as const;
export const TIKHUB_BILLING =
  "Paid from your TikHub account. TikHub does not report a per-request amount, so Dig shows these calls' cost as unknown.";

export const MISSING_TIKHUB_KEY = `TIKHUB_API_KEY is not set in Dig's keys.env. Get a key at https://tikhub.io. ${setOutsideChat()}`;

export function tikhubBaseUrl(): string {
  const raw = process.env.TIKHUB_BASE_URL?.trim();
  if (!raw) return TIKHUB_DEFAULT_BASE;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return TIKHUB_DEFAULT_BASE;
    return raw.replace(/\/+$/, "");
  } catch {
    return TIKHUB_DEFAULT_BASE;
  }
}

export function tikhubHeaders(): Record<string, string> | null {
  const key = process.env.TIKHUB_API_KEY?.trim();
  if (!key) return null;
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}

export type TikHubResponse =
  | { readonly ok: true; readonly status: number; readonly payload: unknown; readonly text: string }
  | { readonly ok: false; readonly cancelled: boolean; readonly status?: number; readonly error: string; readonly payload: unknown };

/**
 * Execute one TikHub request over `PaidHttp` (compile-time zero retries).
 */
export function tikhubRequest(options: {
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly params?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  readonly headers: Record<string, string>;
  readonly ctx: Pick<ActionContext, "signal" | "keep">;
  readonly label: string;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}): Effect.Effect<TikHubResponse, never, PaidHttp> {
  return Effect.gen(function* () {
    if (options.ctx.signal.aborted) {
      return { ok: false as const, cancelled: true, error: `${options.label} cancelled`, payload: null };
    }
    const base = options.baseUrl ?? tikhubBaseUrl();
    const url = new URL(options.path, `${base.replace(/\/+$/, "")}/`);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (v === undefined || v === "") continue;
        url.searchParams.set(k, String(v));
      }
    }
    const res = yield* Effect.result(
      paidRequest({
        url: url.href,
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        timeoutMs: options.timeoutMs ?? TIKHUB_TIMEOUT_MS,
        signal: options.ctx.signal,
        label: options.label,
        keep: options.ctx.keep,
      }),
    );
    if (Result.isFailure(res)) {
      if (options.ctx.signal.aborted) {
        return { ok: false as const, cancelled: true, error: `${options.label} cancelled`, payload: null };
      }
      const msg = res.failure instanceof Error ? res.failure.message : String(res.failure);
      return {
        ok: false as const,
        cancelled: false,
        error: redactText(`${options.label} failed: ${msg}`, knownSecrets()),
        payload: null,
      };
    }
    const { status, payload, text } = res.success;
    if (status < 200 || status >= 300) {
      const rec = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
      const detail =
        (typeof rec?.message === "string" && rec.message) ||
        (typeof rec?.detail === "string" && rec.detail) ||
        (typeof rec?.error === "string" && rec.error) ||
        text.slice(0, 200);
      return {
        ok: false as const,
        cancelled: false,
        status,
        error: redactText(`${options.label} HTTP ${status}${detail ? `: ${detail}` : ""}`, knownSecrets()),
        payload,
      };
    }
    return { ok: true as const, status, payload, text };
  });
}
