import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import TOML from "@iarna/toml";
import { Duration, Effect, Result, Schema, Stream } from "effect";
import * as Headers from "effect/http/Headers";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { configPath, stateDirectory } from "../../core/config.ts";
import { PaidHttp, paidRequest } from "../../core/http.ts";
import {
  defineAction,
  failed,
  meteredBilling,
  outcome,
  setOutsideChat,
} from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import { USER_AGENT } from "../../version.ts";

const OPENALEX_BASE = "https://api.openalex.org";
const MAX_ABSTRACT_POSITIONS = 100_000;
const MAX_CONTENT_BYTES = 50 * 1024 * 1024;
const CONTENT_TIMEOUT_MS = 60_000;

/** Resolve the configured library directory from `<state>/config.toml`, falling back to `<state>/library`. */
export function resolveLibraryDir(): string {
  const state = stateDirectory();
  try {
    const parsed = TOML.parse(readFileSync(configPath(state), "utf8")) as Record<string, unknown>;
    if (typeof parsed.library === "string" && parsed.library.trim()) {
      const expanded = parsed.library.replace(/^~(?=\/|$)/, homedir());
      if (isAbsolute(expanded)) return resolve(expanded);
    }
  } catch {
    // Missing or unreadable config falls back to default state library.
  }
  return join(state, "library");
}

/** Shared papers download directory under `<library>/papers`. */
export function paperLibraryDir(libraryOverride?: string): string {
  return join(libraryOverride ?? resolveLibraryDir(), "papers");
}

/**
 * An amount OpenAlex reports for one request, `meta.cost_usd` in USD or
 * `X-RateLimit-Credits-Used` in OpenAlex credits: finite and nonnegative, else null.
 */
export function openAlexAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** OpenAlex documents every 4xx/5xx response as costing nothing. */
export function openAlexNoCharge(status: unknown): boolean {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599;
}

/** A response's own `meta.cost_usd`; zero for a documented no-charge 4xx/5xx; otherwise unknown, never free. */
export function openAlexCharge(body: unknown, status: number | string): number | null {
  const meta =
    body !== null && typeof body === "object"
      ? (body as { readonly meta?: { readonly cost_usd?: unknown } }).meta
      : undefined;
  const cost = openAlexAmount(meta?.cost_usd);
  if (meta?.cost_usd !== undefined && meta.cost_usd !== null) return cost;
  return openAlexNoCharge(status) ? 0 : null;
}

export function providerKey(name: string): string | undefined {
  return process.env[`PAPER_SEARCH_MCP_${name}`]?.trim() || process.env[name]?.trim() || undefined;
}

function openAlexHeaders(): Record<string, string> {
  const apiKey = providerKey("OPENALEX_API_KEY");
  return {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

interface OpenAlexInstitution {
  readonly id?: string;
  readonly display_name?: string;
}

interface OpenAlexAuthorship {
  readonly author?: {
    readonly id?: string;
    readonly display_name?: string;
  };
  readonly institutions?: readonly OpenAlexInstitution[];
}

interface OpenAlexLocation {
  readonly landing_page_url?: string;
  readonly pdf_url?: string;
  readonly source?: {
    readonly display_name?: string;
    readonly id?: string;
  };
}

interface OpenAlexTopic {
  readonly id?: string;
  readonly display_name?: string;
  readonly score?: number;
}

interface OpenAlexWork {
  readonly id?: string;
  readonly display_name?: string;
  readonly publication_year?: number;
  readonly publication_date?: string;
  readonly cited_by_count?: number;
  readonly type?: string;
  readonly doi?: string;
  readonly ids?: Record<string, string | undefined>;
  readonly authorships?: readonly OpenAlexAuthorship[];
  readonly best_oa_location?: OpenAlexLocation | null;
  readonly primary_location?: OpenAlexLocation | null;
  readonly open_access?: {
    readonly is_oa?: boolean;
    readonly oa_url?: string;
    readonly any_repository_has_fulltext?: boolean;
  };
  readonly primary_topic?: OpenAlexTopic | null;
  readonly topics?: readonly OpenAlexTopic[];
  readonly abstract_inverted_index?: Record<string, unknown>;
}

interface OpenAlexSearchResponse {
  readonly meta?: {
    readonly count?: number;
    readonly page?: number;
    readonly per_page?: number;
    readonly cost_usd?: number;
  };
  readonly results?: readonly OpenAlexWork[];
  readonly error?: unknown;
  readonly errors?: unknown;
  readonly message?: unknown;
}

function truncateText(value: string | undefined, maxLength: number): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function toDoiUrl(doi: string | undefined): string | null {
  if (!doi?.trim()) return null;
  const normalized = doi.trim();
  return normalized.startsWith("http://") || normalized.startsWith("https://")
    ? normalized
    : `https://doi.org/${normalized.replace(/^doi:/i, "")}`;
}

function stripOpenAlexIdPrefix(id: string | undefined): string | null {
  if (!id?.trim()) return null;
  return id.trim().replace(/^https?:\/\/openalex\.org\//, "");
}

function formatOpenAlexAuthors(work: OpenAlexWork): string | null {
  const authors = work.authorships
    ?.map((a) => a.author?.display_name?.trim())
    .filter((name): name is string => Boolean(name));
  if (!authors?.length) return null;
  const visible = authors.slice(0, 6);
  return authors.length > 6 ? `${visible.join(", ")} +${authors.length - 6} more` : visible.join(", ");
}

function formatOpenAlexInstitutions(work: OpenAlexWork): string | null {
  const institutions = new Set<string>();
  for (const authorship of work.authorships ?? []) {
    for (const institution of authorship.institutions ?? []) {
      if (institution.display_name?.trim()) {
        institutions.add(institution.display_name.trim());
      }
    }
  }
  const values = [...institutions];
  return values.length > 0 ? values.slice(0, 5).join(", ") : null;
}

function reconstructOpenAlexAbstract(index: Record<string, unknown> | undefined): string | null {
  if (!index || typeof index !== "object") return null;
  let maxPosition = -1;
  for (const positions of Object.values(index)) {
    if (!Array.isArray(positions)) return null;
    for (const position of positions) {
      if (
        typeof position !== "number" ||
        !Number.isInteger(position) ||
        position < 0 ||
        position >= MAX_ABSTRACT_POSITIONS
      ) {
        return null;
      }
      if (position > maxPosition) maxPosition = position;
    }
  }
  if (maxPosition < 0) return null;
  const tokens = new Array<string>(maxPosition + 1);
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions as number[]) {
      tokens[position] = word;
    }
  }
  return truncateText(tokens.filter(Boolean).join(" "), 320);
}

function formatOpenAlexTopics(work: OpenAlexWork): string | null {
  const topics = new Set<string>();
  if (work.primary_topic?.display_name?.trim()) topics.add(work.primary_topic.display_name.trim());
  for (const topic of work.topics ?? []) {
    if (topic.display_name?.trim()) topics.add(topic.display_name.trim());
  }
  const values = [...topics];
  return values.length > 0 ? values.slice(0, 5).join(", ") : null;
}

function formatOpenAlexOaUrl(work: OpenAlexWork): string | null {
  return (
    work.open_access?.oa_url ||
    work.best_oa_location?.pdf_url ||
    work.best_oa_location?.landing_page_url ||
    work.primary_location?.pdf_url ||
    work.primary_location?.landing_page_url ||
    null
  );
}

function formatOpenAlexWorks(works: readonly OpenAlexWork[], header: string): string {
  const formatted = works.map((work) => {
    const lines: string[] = [];
    const title = work.display_name?.trim() || "(untitled work)";
    const openAlexId = stripOpenAlexIdPrefix(work.id) || "unknown";
    const authors = formatOpenAlexAuthors(work);
    const institutions = formatOpenAlexInstitutions(work);
    const topics = formatOpenAlexTopics(work);
    const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);
    const oaUrl = formatOpenAlexOaUrl(work);
    const doiUrl = toDoiUrl(work.doi || work.ids?.doi);

    lines.push(`**${title}**`);
    lines.push(
      [
        `OpenAlex ID: ${openAlexId}`,
        work.publication_date ? `Published: ${work.publication_date}` : null,
        work.publication_year ? `Year: ${work.publication_year}` : null,
        work.cited_by_count !== undefined ? `Citations: ${work.cited_by_count}` : null,
        work.type ? `Type: ${work.type}` : null,
      ]
        .filter(Boolean)
        .join(" | "),
    );
    if (authors) lines.push(`  Authors: ${authors}`);
    if (institutions) lines.push(`  Institutions: ${institutions}`);
    if (topics) lines.push(`  Topics: ${topics}`);
    if (abstract) lines.push(`  Abstract: ${abstract}`);
    if (oaUrl) lines.push(`  Open access: ${oaUrl}`);
    if (doiUrl) lines.push(`  DOI: ${doiUrl}`);
    if (work.id) lines.push(`  OpenAlex: ${work.id}`);
    return lines.join("\n");
  });
  return `${header}\n\n${formatted.join("\n\n")}`;
}

function numericHeader(headers: Headers.Headers, name: string): number | undefined {
  const raw = headers[name.toLowerCase()];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function openAlexBudget(headers: Headers.Headers, cost?: number): string {
  const fields = (
    [
      ["daily credits", "x-ratelimit-limit"],
      ["daily USD", "x-ratelimit-limit-usd"],
      ["remaining credits", "x-ratelimit-remaining"],
      ["request credits", "x-ratelimit-credits-used"],
      ["reset seconds", "x-ratelimit-reset"],
    ] as const
  ).flatMap(([label, header]) => {
    const value = numericHeader(headers, header);
    return value === undefined ? [] : [`${label}: ${value}`];
  });
  const usd = openAlexAmount(cost);
  if (usd !== null) fields.push(`request USD: ${usd}`);
  return `OpenAlex access: ${
    providerKey("OPENALEX_API_KEY")
      ? "API key configured"
      : "keyless (limited daily budget; a free OPENALEX_API_KEY raises it 10×)"
  }. Provider budget: ${fields.length ? fields.join(" | ") : "not reported"}.`;
}

const OpenAlexSearchSchema = Schema.Struct({
  mode: Schema.optionalKey(
    Schema.Literals(["keyword", "semantic"]).annotate({
      description: "Keyword or semantic search; semantic queries max 2000 characters, relevance ordering.",
    }),
  ),
  query: Schema.String.annotate({ description: "Paper/literature query." }),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })).annotate({
      description: "Max works (default: 10, max: 25).",
    }),
  ),
  page: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Pagination page." }),
  ),
  yearFrom: Schema.optionalKey(Schema.Finite.annotate({ description: "Only works in or after this year." })),
  yearTo: Schema.optionalKey(Schema.Finite.annotate({ description: "Only works in or before this year." })),
  openAccessOnly: Schema.optionalKey(Schema.Boolean.annotate({ description: "Only include open-access works." })),
  sort: Schema.optionalKey(
    Schema.Literals(["relevance", "cited_by_count", "publication_date"]).annotate({ description: "Sort mode." }),
  ),
});

export const papersOpenAlexSearchAction = defineAction({
  name: "papers_openalex_search",
  description:
    "Search scholarly works via OpenAlex. " +
    "Best for broad literature coverage, open-access links, topic/institution metadata, and ecosystem mapping beyond one provider's index. " +
    "Supports year and open-access filtering plus cited_by_count/publication_date sorting.",
  schema: OpenAlexSearchSchema,
  billing: meteredBilling("USD", openAlexCharge),
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const limit = Math.min(args.limit ?? 10, 25);
      const page = Math.max(args.page ?? 1, 1);

      if (args.mode !== undefined && args.mode !== "keyword" && args.mode !== "semantic") {
        return failed("mode must be keyword or semantic");
      }
      if (args.mode === "semantic" && args.query.length > 2000) {
        return failed("semantic query must be at most 2000 characters");
      }
      if (args.mode === "semantic" && args.sort && args.sort !== "relevance") {
        return failed("semantic search uses relevance ordering");
      }

      const url = new URL(`${OPENALEX_BASE}/works`);
      url.searchParams.set(args.mode === "semantic" ? "search.semantic" : "search", args.query);
      url.searchParams.set("per_page", String(limit));
      url.searchParams.set("page", String(page));

      const filters: string[] = [];
      if (args.yearFrom) filters.push(`from_publication_date:${args.yearFrom}-01-01`);
      if (args.yearTo) filters.push(`to_publication_date:${args.yearTo}-12-31`);
      if (args.openAccessOnly) filters.push("is_oa:true");
      if (filters.length > 0) url.searchParams.set("filter", filters.join(","));

      const sort = args.sort ?? "relevance";
      if (sort !== "relevance") url.searchParams.set("sort", `${sort}:desc`);

      const res = yield* Effect.result(
        paidRequest({
          url: url.href,
          method: "GET",
          headers: openAlexHeaders(),
          timeoutMs: 60_000,
          signal: ctx.signal,
          label: "works",
          keep: ctx.keep,
        }),
      );

      if (Result.isFailure(res)) {
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        return failed(
          "OpenAlex search failed during transport or response decoding; not evidence of no matches.",
        );
      }

      const { status, headers, isJson, payload } = res.success;
      if (status < 200 || status >= 300) {
        return failed(
          `OpenAlex search failed with HTTP ${status}.${
            status === 429 ? " Daily budget exhausted or request-rate limit exceeded; not evidence of no matches." : ""
          }\n${openAlexBudget(headers)}`,
        );
      }

      const data = isJson && payload !== null && typeof payload === "object" ? (payload as OpenAlexSearchResponse) : null;
      if (
        !data ||
        !Array.isArray(data.results) ||
        "error" in data ||
        "errors" in data ||
        "message" in data
      ) {
        return failed(
          `OpenAlex returned an invalid search payload; not evidence of no matches.\n${openAlexBudget(headers)}`,
        );
      }

      const works = data.results;
      const budget = openAlexBudget(headers, data.meta?.cost_usd);
      if (works.length === 0) {
        return outcome("empty", `No OpenAlex works found for "${args.query}".\n${budget}`);
      }

      const header = [
        `OpenAlex works for "${args.query}" (${works.length} shown${data.meta?.count ? `, ${data.meta.count} total matches` : ""}):`,
        `Page ${data.meta?.page ?? page} | Sorted by ${sort}.`,
        budget,
      ].join("\n");

      return outcome("success", formatOpenAlexWorks(works, header));
    }),
});

const OpenAlexContentSchema = Schema.Struct({
  workId: Schema.String.annotate({ description: "OpenAlex W-prefixed work ID (e.g. W1234567890)." }),
  format: Schema.optionalKey(
    Schema.Literals(["pdf", "xml"]).annotate({ description: "Cached content format; xml by default." }),
  ),
});

export const papersOpenAlexContentAction = defineAction({
  name: "papers_openalex_content",
  description:
    "Retrieve an OpenAlex cached open-access PDF or Grobid TEI XML by W-prefixed work ID. Requires an existing OpenAlex API key. Saves a bounded file in the paper library; no overwrite. XML includes a bounded text preview. Per-request cost remains unknown unless reported by the provider.",
  schema: OpenAlexContentSchema,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const workId = String(args.workId ?? "").replace(/^https:\/\/openalex\.org\//, "");
      if (!/^W\d+$/.test(workId)) return failed("workId must be an OpenAlex W-prefixed ID");
      const format = args.format ?? "xml";
      if (format !== "pdf" && format !== "xml") return failed("format must be pdf or xml");

      const key = providerKey("OPENALEX_API_KEY");
      if (!key) {
        return failed(
          `OPENALEX_API_KEY is not set in Dig's keys.env, and cached full text needs it. ${setOutsideChat()}`,
        );
      }

      const folder = paperLibraryDir(ctx.library);
      mkdirSync(folder, { recursive: true });
      const file = join(folder, `openalex-${workId}.${format}`);
      if (existsSync(file) && !lstatSync(file).isFile()) {
        return failed("The destination is not a regular paper file");
      }

      const url = `https://content.openalex.org/works/${workId}.${format === "pdf" ? "pdf" : "grobid-xml"}`;
      const client = yield* PaidHttp;
      const req = HttpClientRequest.setHeaders(HttpClientRequest.get(url), {
        Authorization: `Bearer ${key}`,
        "User-Agent": USER_AGENT,
      });

      const withSignal = <A, E>(eff: Effect.Effect<A, E>) => {
        if (ctx.signal.aborted) {
          return Effect.fail(new Error("OpenAlex content cancelled") as E | Error);
        }
        const abortWait = Effect.callback<never, Error>((resume) => {
          const onAbort = () => resume(Effect.fail(new Error("OpenAlex content cancelled")));
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() => ctx.signal.removeEventListener("abort", onAbort));
        });
        return Effect.raceFirst(eff, abortWait);
      };

      const fetchRes = yield* Effect.result(
        Effect.gen(function* () {
          const startedAt = performance.now();
          const response = yield* withSignal(client.execute(req)).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(CONTENT_TIMEOUT_MS),
              orElse: () => Effect.fail(new Error("OpenAlex content timed out")),
            }),
            Effect.tapError((err) =>
              Effect.sync(() => {
                ctx.keep(
                  `OpenAlex content ${workId}`,
                  "error",
                  err instanceof Error ? err.message : String(err),
                );
              }),
            ),
          );

          if (response.status < 200 || response.status >= 300) {
            const errText = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
            ctx.keep(`OpenAlex content ${workId}`, response.status, redactText(errText, knownSecrets()));
            return yield* Effect.fail(new Error(`OpenAlex content returned HTTP ${response.status}`));
          }

          const remaining = Math.max(1, CONTENT_TIMEOUT_MS - (performance.now() - startedAt));
          const collected = yield* withSignal(
            Stream.runFoldEffect(
              response.stream,
              () => ({ chunks: [] as Uint8Array[], size: 0 }),
              (acc, chunk) => {
                const nextSize = acc.size + chunk.byteLength;
                if (nextSize > MAX_CONTENT_BYTES) {
                  return Effect.fail(new Error("OpenAlex content exceeds 50 MiB"));
                }
                acc.chunks.push(chunk);
                return Effect.succeed({ chunks: acc.chunks, size: nextSize });
              },
            ),
          ).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(remaining),
              orElse: () => Effect.fail(new Error("OpenAlex content body timed out")),
            }),
            Effect.tapError(() =>
              Effect.sync(() => {
                ctx.keep(`OpenAlex content ${workId}`, response.status, "", undefined, true);
              }),
            ),
          );

          return { status: response.status, chunks: collected.chunks, size: collected.size };
        }).pipe(Effect.scoped),
      );

      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      if (Result.isFailure(fetchRes)) {
        const err = fetchRes.failure;
        const msg =
          err instanceof HttpClientError.HttpClientError || err instanceof Error
            ? err.message
            : "OpenAlex content failed";
        return failed(redactText(msg, knownSecrets()));
      }

      const { status, chunks, size } = fetchRes.success;
      const rawBuffer = Buffer.concat(chunks);
      const bytes =
        format === "xml"
          ? Buffer.from(redactText(rawBuffer.toString("utf8"), knownSecrets()), "utf8")
          : rawBuffer;
      const beginning = bytes.subarray(0, 1000).toString("utf8").trimStart();
      if (
        format === "pdf"
          ? !beginning.startsWith("%PDF-")
          : !/<(?:\?xml|TEI\b|tei:TEI\b)/.test(beginning)
      ) {
        return failed("OpenAlex returned content in an unexpected format");
      }

      const scratch = mkdtempSync(join(folder, ".openalex-"));
      let existing = false;
      try {
        const temp = join(scratch, "content");
        writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
        try {
          linkSync(temp, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          existing = true;
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }

      ctx.keep(`OpenAlex cached content ${workId}`, status, {
        workId,
        format,
        bytes: size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        file,
        existingFileKept: existing,
      });

      const xml = format === "xml" && !existing ? bytes.toString("utf8") : "";
      return outcome(
        xml.length > 60_000 ? "partial" : "success",
        `OpenAlex cached ${format}: ${file}\n${
          existing ? "Existing file preserved; newly fetched content was not substituted." : "File saved."
        }\nFetched ${size} bytes. Provider cost unknown. ${
          format === "xml"
            ? "Grobid XML is machine extraction, not a verified transcription."
            : "PDF bytes validated by file signature; page contents not inspected."
        }${xml ? `\n\n${xml.slice(0, 60_000)}${xml.length > 60_000 ? "\n[Preview truncated; complete file saved.]" : ""}` : ""}`,
        { file },
      );
    }),
});
