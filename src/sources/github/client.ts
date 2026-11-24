import { execFile } from "node:child_process";
import { Effect, Result } from "effect";
import type * as Headers from "effect/http/Headers";
import { freeRequest, type FreeHttp, type KeepRaw } from "../../core/http.ts";
import { knownSecrets, redactText, registerSecret } from "../../core/secrets.ts";
import { USER_AGENT } from "../../version.ts";
import { findExecutable } from "../shared/executables.ts";

export interface RequestContext {
  readonly signal: AbortSignal;
  readonly keep: KeepRaw;
}

export const API_BASE = "https://api.github.com";
export const API_VERSION = "2026-03-10";
export const TIMEOUT_MS = 60_000;
export const ACCEPT_JSON = "application/vnd.github+json";
export const ACCEPT_OBJECT = "application/vnd.github.object+json";

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const REF_PATTERN = /^[A-Za-z0-9._/@+-]{1,256}$/;
const REF_LOCK_SUFFIX = ".lock";
const BOT_LOGIN_PATTERN = /\[bot\]$/i;
export const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;
const REDACTED = "[redacted]";

export interface RepoRef {
  readonly owner: string;
  readonly name: string;
  readonly full: string;
}

export type Auth = {
  readonly token: string;
  readonly source: "GH_TOKEN" | "GITHUB_TOKEN" | "gh auth token";
} | null;

export interface RateLimit {
  readonly resource: string | null;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: string | null;
}

export interface GitHubResponse {
  readonly status: number;
  readonly headers: Headers.Headers;
  readonly payload: unknown;
  readonly rateLimit: RateLimit;
}

export interface RepoMetadata {
  readonly fullName: string;
  readonly htmlUrl: string;
  readonly description: string | null;
  readonly homepage: string | null;
  readonly language: string | null;
  readonly license: string | null;
  readonly topics: readonly string[];
  readonly stars: number | null;
  readonly forks: number | null;
  readonly subscribers: number | null;
  readonly openIssuesAndPrs: number | null;
  readonly createdAt: string | null;
  readonly pushedAt: string | null;
  readonly defaultBranch: string;
  readonly archived: boolean;
  readonly disabled: boolean;
  readonly fork: boolean;
  readonly parent: string | null;
  readonly template: boolean;
  readonly ownerType: string | null;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function fmtNum(value: number | null): string {
  return value === null ? "n/a" : value.toLocaleString("en-US");
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "n/a";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
}

export function truncate(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1).trimEnd()}…`;
}

export function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const candidate = value === undefined ? fallback : Math.floor(value);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.min(Math.max(candidate, min), max);
}

export function isBotLogin(login: string | null, typename: unknown): boolean {
  if (typename === "Bot") return true;
  return login !== null && BOT_LOGIN_PATTERN.test(login);
}

export function redactSecrets(text: string): string {
  return redactText(text, knownSecrets()).replace(GITHUB_TOKEN_PATTERN, REDACTED);
}

export function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error ?? "Unknown error"));
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export function parseRepo(input: unknown): RepoRef | { readonly error: string } {
  let value = asString(input);
  if (!value) return { error: "repo is required in owner/repo form" };
  value = value
    .replace(/^git@github\.com:/i, "")
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  value = value.replace(/\.git$/i, "").replace(/\/+$/, "");
  const segments = value.split("/");
  if (segments.length !== 2) {
    return { error: `repo must be owner/repo, got "${truncate(String(input), 80)}"` };
  }
  const [owner, name] = segments as [string, string];
  if (!OWNER_PATTERN.test(owner)) {
    return { error: `repo owner "${truncate(owner, 60)}" is not a valid GitHub login` };
  }
  if (!REPO_NAME_PATTERN.test(name) || name === "." || name === "..") {
    return { error: `repo name "${truncate(name, 60)}" is not a valid GitHub repository name` };
  }
  return { owner, name, full: `${owner}/${name}` };
}

export function parsePath(
  input: unknown,
): { readonly path: string; readonly segments: readonly string[] } | { readonly error: string } {
  const raw = typeof input === "string" ? input.trim() : "";
  if (/[\u0000-\u001f\u007f\\?#]/.test(raw)) {
    return { error: "path may not contain control characters, backslashes, ? or #" };
  }
  const normalized = raw.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return { path: "", segments: [] };
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { error: `path "${truncate(raw, 80)}" contains an empty or dot segment` };
    }
  }
  return { path: segments.join("/"), segments };
}

export function parseRef(
  input: unknown,
): { readonly ref: string | null } | { readonly error: string } {
  const raw = asString(input);
  if (!raw) return { ref: null };
  const wellFormed =
    REF_PATTERN.test(raw) &&
    raw !== "@" &&
    !raw.startsWith("-") &&
    !raw.includes("..") &&
    !raw.endsWith(".") &&
    raw
      .split("/")
      .every((segment) => segment !== "" && !segment.startsWith(".") && !segment.endsWith(REF_LOCK_SUFFIX));
  if (!wellFormed) {
    return { error: `ref "${truncate(raw, 80)}" is not a valid branch, tag, or commit reference` };
  }
  return { ref: raw };
}

// ---------------------------------------------------------------------------
// Credentials & transport
// ---------------------------------------------------------------------------

let ghCliToken: string | null = null;

export function resetGhCliTokenCache(): void {
  ghCliToken = null;
}

function runGhAuthToken(executable: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ["auth", "token"],
      { timeout: 5_000, signal, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout).trim() || null);
      },
    );
  });
}

function probeGhCliToken(signal: AbortSignal): Effect.Effect<string | null> {
  return Effect.promise(async () => {
    const executable = findExecutable("gh");
    if (!executable || signal.aborted) return null;
    return runGhAuthToken(executable, signal);
  });
}

function remember(auth: NonNullable<Auth>): Auth {
  registerSecret(auth.token);
  return auth;
}

export function resolveAuth(signal: AbortSignal): Effect.Effect<Auth> {
  return Effect.gen(function* () {
    const ghToken = process.env.GH_TOKEN?.trim();
    if (ghToken) return remember({ token: ghToken, source: "GH_TOKEN" });
    const githubToken = process.env.GITHUB_TOKEN?.trim();
    if (githubToken) return remember({ token: githubToken, source: "GITHUB_TOKEN" });
    if (ghCliToken === null) {
      ghCliToken = yield* probeGhCliToken(signal);
    }
    return ghCliToken ? remember({ token: ghCliToken, source: "gh auth token" }) : null;
  });
}

export function authLabel(auth: Auth): string {
  return auth
    ? `authenticated via ${auth.source}`
    : "ANONYMOUS — no GH_TOKEN/GITHUB_TOKEN and no logged-in gh found on PATH or in ~/.local/bin, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin; GitHub's lower anonymous limits apply";
}

export function rateLimitFrom(headers: Headers.Headers): RateLimit {
  const reset = asNumber(headers["x-ratelimit-reset"]);
  return {
    resource: asString(headers["x-ratelimit-resource"]),
    limit: asNumber(headers["x-ratelimit-limit"]),
    remaining: asNumber(headers["x-ratelimit-remaining"]),
    resetAt: reset === null ? null : new Date(reset * 1_000).toISOString(),
  };
}

export type GitHubRequestResult =
  | { readonly ok: true; readonly response: GitHubResponse }
  | { readonly ok: false; readonly cancelled: boolean; readonly error: string };

/**
 * Execute one GitHub API request via `FreeHttp` (`freeRequest`).
 * Clears any memoized `gh auth token` on HTTP 401 so subsequent calls re-probe `gh`.
 */
export function githubRequest(
  url: URL,
  auth: Auth,
  ctx: RequestContext,
  options: { readonly accept?: string; readonly method?: "GET" | "POST"; readonly body?: unknown } = {},
): Effect.Effect<GitHubRequestResult, never, FreeHttp> {
  return Effect.gen(function* () {
    if (ctx.signal.aborted) {
      return { ok: false as const, cancelled: true, error: "GitHub request aborted" };
    }
    const headers: Record<string, string> = {
      Accept: options.accept ?? ACCEPT_JSON,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
    };
    if (auth) headers.Authorization = `Bearer ${auth.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const method = options.method ?? "GET";
    const res = yield* Effect.result(
      freeRequest({
        url: url.href,
        method,
        headers,
        body: options.body,
        timeoutMs: TIMEOUT_MS,
        signal: ctx.signal,
        label: `${method} ${url.pathname}`,
        keep: ctx.keep,
      }),
    );

    if (Result.isFailure(res)) {
      if (ctx.signal.aborted) {
        return { ok: false as const, cancelled: true, error: "GitHub request aborted" };
      }
      return { ok: false as const, cancelled: false, error: errorMessage(res.failure) };
    }

    const { status, headers: resHeaders, payload } = res.success;
    if (status === 401 && auth?.source === "gh auth token" && ghCliToken === auth.token) {
      ghCliToken = null;
    }

    return {
      ok: true as const,
      response: {
        status,
        headers: resHeaders,
        payload,
        rateLimit: rateLimitFrom(resHeaders),
      },
    };
  });
}

export function apiUrl(
  path: string,
  query: Record<string, string | number | undefined> = {},
): URL {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

export function repoPath(repo: RepoRef, suffix = ""): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

export function hasNextPage(headers: Headers.Headers): boolean {
  const link = headers.link;
  return typeof link === "string" && /<[^>]+>;\s*rel="next"/.test(link);
}

export function isRateLimited(response: GitHubResponse): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  if (response.rateLimit.remaining === 0) return true;
  if (response.headers["retry-after"]) return true;
  const message = asString(asRecord(response.payload)?.message) ?? "";
  return /rate limit/i.test(message);
}

export function describeFailure(response: GitHubResponse, what: string): string {
  if (isRateLimited(response)) {
    const resource = response.rateLimit.resource ?? "API";
    const reset = response.rateLimit.resetAt ? ` (resets ${response.rateLimit.resetAt})` : "";
    const retryAfter = response.headers["retry-after"];
    const wait = retryAfter ? ` retry-after ${retryAfter}s;` : "";
    return `GitHub ${resource} rate limit reached while fetching ${what};${wait} remaining ${fmtNum(response.rateLimit.remaining)}${reset}`;
  }
  const record = asRecord(response.payload);
  const message = asString(record?.message);
  const errors = asArray(record?.errors)
    .map((entry) => asString(asRecord(entry)?.message))
    .filter((entry): entry is string => entry !== null);
  const detail = redactSecrets([message, ...errors].filter(Boolean).join("; "));
  return `GitHub returned HTTP ${response.status} for ${what}${detail ? `: ${truncate(detail, 240)}` : ""}`;
}

// ---------------------------------------------------------------------------
// Public-only gate & metadata normalization
// ---------------------------------------------------------------------------

/** Explicit public marking: `private` must be literally false and `visibility` literally "public". */
export function isMarkedPublic(record: Record<string, unknown>): boolean {
  return record.private === false && record.visibility === "public";
}

export function normalizeRepoMetadata(
  raw: Record<string, unknown>,
): RepoMetadata | { readonly error: string } {
  const fullName = asString(raw.full_name);
  const htmlUrl = asString(raw.html_url);
  const defaultBranch = asString(raw.default_branch);
  if (!fullName || !htmlUrl || !defaultBranch) {
    return {
      error: "GitHub repository metadata is malformed (missing full_name, html_url, or default_branch)",
    };
  }
  if (!isMarkedPublic(raw)) {
    return {
      error: `GitHub repository ${fullName} is not public; github tools read public repositories only`,
    };
  }
  const license = asRecord(raw.license);
  const parent = asRecord(raw.parent);
  return {
    fullName,
    htmlUrl,
    description: asString(raw.description),
    homepage: asString(raw.homepage),
    language: asString(raw.language),
    license: asString(license?.spdx_id) ?? asString(license?.name),
    topics: asArray(raw.topics)
      .map(asString)
      .filter((topic): topic is string => topic !== null),
    stars: asNumber(raw.stargazers_count),
    forks: asNumber(raw.forks_count),
    subscribers: asNumber(raw.subscribers_count),
    openIssuesAndPrs: asNumber(raw.open_issues_count),
    createdAt: asString(raw.created_at),
    pushedAt: asString(raw.pushed_at),
    defaultBranch,
    archived: raw.archived === true,
    disabled: raw.disabled === true,
    fork: raw.fork === true,
    parent: asString(parent?.full_name),
    template: raw.is_template === true,
    ownerType: asString(asRecord(raw.owner)?.type),
  };
}

export type PublicRepoGate =
  | { readonly ok: true; readonly auth: Auth; readonly metadata: RepoMetadata; readonly rateLimit: RateLimit }
  | { readonly ok: false; readonly cancelled: boolean; readonly error: string };

export function loadPublicRepo(
  repo: RepoRef,
  ctx: RequestContext,
): Effect.Effect<PublicRepoGate, never, FreeHttp> {
  return Effect.gen(function* () {
    const auth = yield* resolveAuth(ctx.signal);
    const req = yield* githubRequest(apiUrl(repoPath(repo)), auth, ctx);
    if (!req.ok) return req;
    const { response } = req;
    if (response.status === 404) {
      return {
        ok: false as const,
        cancelled: false,
        error: `GitHub repository ${repo.full} was not found or is not public`,
      };
    }
    if (response.status === 451) {
      return {
        ok: false as const,
        cancelled: false,
        error: `GitHub repository ${repo.full} is unavailable for legal reasons (HTTP 451)`,
      };
    }
    const record = asRecord(response.payload);
    if (response.status !== 200 || !record) {
      return {
        ok: false as const,
        cancelled: false,
        error: describeFailure(response, `repository ${repo.full}`),
      };
    }
    const metadata = normalizeRepoMetadata(record);
    if ("error" in metadata) {
      return { ok: false as const, cancelled: false, error: metadata.error };
    }
    return { ok: true as const, auth, metadata, rateLimit: response.rateLimit };
  });
}
