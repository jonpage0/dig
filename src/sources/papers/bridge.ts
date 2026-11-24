import { spawn } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { stateDirectory } from "../../core/config.ts";
import type { CostAmount, ReceiptCost } from "../../core/cost.ts";
import type { KeepRaw, RetainedResponse } from "../../core/http.ts";
import {
  defineAction,
  failed,
  outcome,
  type ActionContext,
  type ActionOutcome,
  type BillingPolicy,
  type OutcomeStatus,
} from "../../core/plugin.ts";
import { knownSecrets, redactProviderText } from "../../core/secrets.ts";
import {
  findExecutable,
  paperSearchDirectory,
  paperSearchEnvFile,
  paperSearchEnvValues,
  paperSearchInterpreter,
} from "../shared/executables.ts";
import { openAlexAmount, openAlexNoCharge, paperLibraryDir } from "./openalex.ts";

// Bridge to the local clone of openags/paper-search-mcp (MIT). Invokes its `paper-search` CLI
// via `uv run --no-sync` inside the pinned clone so source actions stay behind Dig's service.

const BRIDGE_ASSETS =
  ["../bridges/papers/", "../../../bridges/papers/"]
    .map((p) => new URL(p, import.meta.url))
    .find((url) => existsSync(new URL("setup.mjs", url))) ??
  new URL("../bridges/papers/", import.meta.url);
const BRIDGE_SETUP = fileURLToPath(new URL("setup.mjs", BRIDGE_ASSETS));

const EXISTS = "EEXIST";
const MAX_OUTPUT_CHARS = 120_000;
const BRIDGE_TIMEOUT_MS = 5 * 60_000;

export const DISABLED_SOURCES = new Set(["base", "citeseerx"]);

export const ACTIVE_SOURCES = [
  "arxiv",
  "biorxiv",
  "core",
  "crossref",
  "dblp",
  "doaj",
  "europepmc",
  "google_scholar",
  "hal",
  "iacr",
  "medrxiv",
  "openaire",
  "openalex",
  "pmc",
  "pubmed",
  "semantic",
  "ssrn",
  "unpaywall",
  "zenodo",
  "openreview",
] as const;

/** Connectors that search api.openalex.org, which reports each request's usage cost. */
export const OPENALEX_BACKED_SOURCES = ["openalex", "ssrn"] as const;
const OPENALEX_CREDITS = "OpenAlex credits";
const CONNECTOR_HEALTH = ["ok", "empty", "partial", "failed"] as const;
const CONTACT_NAMES = ["PAPER_SEARCH_MCP_UNPAYWALL_EMAIL", "UNPAYWALL_EMAIL"] as const;

export interface BridgeRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | string;
  readonly timedOut: boolean;
}

export function boundedOutput(out: string): string {
  return out.length > MAX_OUTPUT_CHARS
    ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n\n[TRUNCATED: output was ${out.length} chars; showing first ${MAX_OUTPUT_CHARS}]`
    : out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Runs a bridge command that saves files into `target`, write-once: the bridge writes into
 * a fresh folder inside `target`, then each file takes its place only if no file of that name
 * is there yet (hard link fails rather than replacing an existing file).
 */
export async function writeOnce(
  target: string,
  run: (folder: string) => Promise<string>,
): Promise<string> {
  const dir = path.resolve(target);
  mkdirSync(dir, { recursive: true });
  const folder = mkdtempSync(path.join(dir, ".incoming-"));
  try {
    const out = await run(folder);
    if (out.startsWith("ERROR:")) return out.replaceAll(folder, dir);
    const kept: string[] = [];
    for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = path.relative(folder, path.join(entry.parentPath, entry.name));
      const destination = path.join(dir, name);
      mkdirSync(path.dirname(destination), { recursive: true });
      try {
        linkSync(path.join(folder, name), destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== EXISTS) throw error;
        kept.push(destination);
      }
    }
    const text = out.replaceAll(folder, dir);
    return kept.length ? `${text}\n\nAlready saved, kept unchanged (not replaced): ${kept.join(", ")}` : text;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function realTarget(target: string): string {
  const missing: string[] = [];
  let existing = path.resolve(target);
  while (!lstatSync(existing, { throwIfNoEntry: false }) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(realpathSync(existing), ...missing);
}

/** Whether `target`, symbolic links resolved, lies inside one of `roots`. An unresolvable link is outside. */
export function confined(target: string, roots: readonly string[]): boolean {
  try {
    const file = realTarget(target);
    return roots.some((root) => {
      const rel = path.relative(realTarget(root), file);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    });
  } catch {
    return false;
  }
}

/** The deduplicated connectors a call requests; none given, or `all`, means every active one. */
export function requestedSources(sources: unknown): string[] {
  const raw = Array.isArray(sources) ? sources.join(",") : String(sources ?? "").trim();
  const requested =
    raw && raw.toLowerCase() !== "all"
      ? raw
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0)
      : [...ACTIVE_SOURCES];
  const unavailable = requested.filter((s) => !(ACTIVE_SOURCES as readonly string[]).includes(s));
  if (unavailable.length) {
    throw new Error(
      `Unsupported or disabled sources: ${unavailable.join(", ")}. Available: ${ACTIVE_SOURCES.join(", ")}`,
    );
  }
  return [...new Set(requested)];
}

function openAlexBackedCharge(output: Record<string, unknown> | undefined, source: string): CostAmount[] | null {
  const billing = asRecord(asRecord(output?.billing)?.[source]);
  const status = billing?.http_status;
  const validBilling =
    billing &&
    (status === null || (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)) &&
    (billing.cost_usd === null || openAlexAmount(billing.cost_usd) !== null);
  const usd = validBilling && status !== null ? openAlexAmount(billing.cost_usd) : null;
  if (usd !== null) return [{ amount: usd, unit: "USD" }];
  const reportedCredits = asRecord(asRecord(output?.rate_limits)?.[source])?.["credits-used"];
  const credits = openAlexAmount(reportedCredits);
  if (credits !== null) return [{ amount: credits, unit: OPENALEX_CREDITS }];
  if (reportedCredits !== undefined && reportedCredits !== null) return null;
  return validBilling && openAlexNoCharge(status) ? [] : null;
}

export function multiSearchBilling(response: RetainedResponse, args: { readonly sources?: unknown }): ReceiptCost {
  const output = asRecord(response.body);
  const charges = requestedSources(args.sources)
    .filter((source) => (OPENALEX_BACKED_SOURCES as readonly string[]).includes(source))
    .flatMap((source) => {
      const observations = asRecord(asRecord(output?.billing)?.[source])?.responses;
      if (!Array.isArray(observations)) return [openAlexBackedCharge(output, source)];
      if (!observations.length) return [null];
      return observations.map((item) => {
        const entry = asRecord(item);
        return openAlexBackedCharge(
          { billing: { [source]: entry }, rate_limits: { [source]: { "credits-used": entry?.credits_used } } },
          source,
        );
      });
    });
  const totals = new Map<string, number>();
  for (const { amount, unit } of charges.flatMap((c) => c ?? [])) {
    totals.set(unit, (totals.get(unit) ?? 0) + amount);
  }
  const known = [...totals].filter(([, amount]) => amount > 0).map(([unit, amount]) => ({ amount, unit }));
  if (!charges.includes(null)) return { cost: known };
  return known.length ? { cost: null, knownCost: known } : { cost: null };
}

export function openAlexUnknownBilling<A extends { readonly source?: string }>(): BillingPolicy<A> {
  return {
    charge: () => ({ cost: null }),
    noCharge: (args) => !(OPENALEX_BACKED_SOURCES as readonly string[]).includes(String(args?.source ?? "").trim().toLowerCase()),
  };
}

function searchStatus(health: readonly string[]): OutcomeStatus {
  if (health.every((h) => h === "failed")) return "failed";
  if (health.every((h) => h === "empty")) return "empty";
  if (health.some((h) => h === "failed" || h === "partial")) return "partial";
  return "success";
}

function searchResult(out: string, requested: readonly string[]): ActionOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(out);
  } catch {
    return failed("paper-search returned invalid JSON, not an empty search");
  }
  const health = asRecord(asRecord(payload)?.source_status);
  if (!health || (payload !== null && typeof payload === "object" && "error" in payload)) {
    return failed(
      `paper-search source health is unavailable. Rerun the Papers bridge setup (node ${BRIDGE_SETUP}) to apply the maintained patch for the pinned clone before using search; this output cannot establish no matches.`,
    );
  }
  const reported = requested.map((source) => health[source]);
  if (
    reported.some(
      (status) => typeof status !== "string" || !(CONNECTOR_HEALTH as readonly string[]).includes(status),
    )
  ) {
    return failed(
      "paper-search omitted a requested source's health; this output cannot establish complete coverage.",
    );
  }
  const status = searchStatus(reported as string[]);
  const text =
    status === "failed"
      ? `ERROR: every requested connector failed (${requested.join(", ")}). The bridge's errors and full output follow.\n\n${out}`
      : out;
  return outcome(status, boundedOutput(text));
}

function redactDiagnostics(value: string): string {
  const secrets = Object.entries(process.env)
    .flatMap(([name, secret]) => (secret && /KEY|TOKEN|SECRET|PASSWORD/i.test(name) ? [secret] : []))
    .sort((a, b) => b.length - a.length);
  return redactProviderText(value, secrets).text.replace(
    /([?&](?:api_key|access_token|token|key)=)[^&\s]+/gi,
    "$1[redacted]",
  );
}

function resolveUv(): string {
  const executable = findExecutable("uv");
  if (!executable) {
    throw new Error(
      "uv is unavailable; the optional Papers bridge runs through uv (https://docs.astral.sh/uv/). Install uv, then run the bridge setup.",
    );
  }
  return executable;
}

function resolveBridge(): string {
  const directory = paperSearchDirectory();
  if (!existsSync(paperSearchInterpreter())) {
    throw new Error(
      `the optional Papers bridge is not installed at ${directory}. Install it with: node ${BRIDGE_SETUP} --email <your contact address> (needs git and uv; --help explains every option).`,
    );
  }
  return directory;
}

function keepOutput(keep: KeepRaw, label: string, exitCode: number | string, out: string): void {
  let body: unknown = out;
  try {
    body = JSON.parse(out);
  } catch {
    // Plain text output kept as string.
  }
  keep(label, exitCode, body);
}

function contactValues(): string[] {
  const values = new Set<string>();
  for (const name of CONTACT_NAMES) {
    for (const value of [process.env[name]?.trim(), ...paperSearchEnvValues(name)]) {
      if (value?.includes("@")) values.add(value);
    }
  }
  return [...values];
}

/**
 * Low-level bridge runner executing `uv run --no-sync --directory <bridge> ...command`.
 * Reusable by add-ons that call the same installed paper-search-mcp environment.
 * Scrubs all known credentials and contact emails from both stdout and stderr before returning.
 */
export function callPaperBridge(
  command: readonly string[],
  signal: AbortSignal,
  options?: { readonly timeoutMs?: number },
): Promise<BridgeRun> {
  const directory = resolveBridge();
  const uv = resolveUv();
  const timeoutMs = options?.timeoutMs ?? BRIDGE_TIMEOUT_MS;

  const BRIDGE_ENV_ALLOW = new Set([
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "UV_CACHE_DIR",
    "UV_PYTHON_PREFERENCE",
    "SEMANTIC_SCHOLAR_API_KEY",
    "OPENALEX_API_KEY",
    "NCBI_API_KEY",
  ]);
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (BRIDGE_ENV_ALLOW.has(k) || k.startsWith("PAPER_SEARCH_MCP_")) {
      childEnv[k] = v;
    }
  }
  childEnv.PAPER_SEARCH_MCP_ENV_FILE = paperSearchEnvFile();
  childEnv.PAPER_SEARCH_MCP_SECTION_PDF_ROOT = paperLibraryDir();

  return new Promise((resolve, reject) => {
    const child = spawn(uv, ["run", "--no-sync", "--directory", directory, ...command], {
      cwd: directory,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: Error | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code, killed) => {
      clearTimeout(timer);
      if (failure && !signal.aborted) return reject(failure);
      const scrubbed = [...knownSecrets(), ...contactValues()].sort((a, b) => b.length - a.length);
      const read = (chunks: Buffer[]) => redactProviderText(Buffer.concat(chunks).toString("utf8"), scrubbed).text;
      resolve({
        stdout: read(stdout),
        stderr: read(stderr),
        exitCode: code ?? killed ?? "unknown",
        timedOut,
      });
    });
  });
}

/**
 * High-level helper executing `paper-search <cliArgs...>` through the bridge, retaining raw output,
 * emitting live progress updates, and returning trimmed output or an `ERROR: ...` line.
 */
export async function runPaperBridgeTool(
  cliArgs: readonly string[],
  ctx: Pick<ActionContext, "signal" | "keep" | "progress">,
  options?: { readonly label?: string; readonly progressMessage?: string; readonly timeoutMs?: number },
): Promise<string> {
  const label = options?.label ?? `paper-search ${cliArgs[0] ?? "run"}`;
  const timeoutMs = options?.timeoutMs ?? BRIDGE_TIMEOUT_MS;
  ctx.progress({
    progress: 1,
    total: 2,
    message: options?.progressMessage ?? `Running ${label}...`,
  });
  const { stdout, stderr, exitCode, timedOut } = await callPaperBridge(["paper-search", ...cliArgs], ctx.signal, {
    timeoutMs,
  });
  const out = stdout.trim();
  if (timedOut && !ctx.signal.aborted) {
    keepOutput(ctx.keep, label, exitCode, redactDiagnostics(out || stderr.trim().split("\n").slice(-5).join("\n")));
    return `ERROR: paper-search ${cliArgs[0] ?? "run"} produced no result within ${timeoutMs / 60_000} minutes and was stopped; this is not evidence of no papers.`;
  }
  if (exitCode !== 0) {
    const detail = redactDiagnostics(out || stderr.trim().split("\n").slice(-5).join("\n"));
    keepOutput(ctx.keep, label, exitCode, detail);
    return `ERROR: paper-search exited with code ${exitCode}: ${detail.slice(0, 2000)}`;
  }
  keepOutput(ctx.keep, label, exitCode, out);
  ctx.progress({ progress: 2, total: 2, message: `Completed ${label}` });
  return out || "ERROR: paper-search produced no output";
}

const PapersMultiSearchSchema = Schema.Struct({
  query: Schema.String.annotate({ description: "Paper/literature query for federated multi-source search." }),
  sources: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Array(Schema.String)]).annotate({
      description:
        "Comma-separated string or array of sources (arxiv, pubmed, biorxiv, medrxiv, pmc, europepmc, crossref, openalex, semantic, dblp, doaj, zenodo, hal, iacr, core, openaire, ssrn, unpaywall, google_scholar, openreview). Default: all 20 enabled connectors (slower), not a guarantee of availability. base/citeseerx are disabled; unknown/disabled requests fail explicitly. Inspect per-source health before treating zero counts as no matches.",
    }),
  ),
  maxResults: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
      description: "Bounded results per source (default: 5, max: 20), not provider totals.",
    }),
  ),
  year: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Year filter applied only to Semantic Scholar, e.g. '2020' or '2018-2022'. Other sources' omission is reported in coverage.year_not_applied_to.",
    }),
  ),
});

export const papersMultiSearchAction = defineAction({
  name: "papers_multi_search",
  description: `Federated academic paper search across ${ACTIVE_SOURCES.length} enabled connectors (${ACTIVE_SOURCES.join(", ")}) via the local paper-search-mcp CLI. Enabled does not guarantee current availability: inspect source_status, errors, warnings and bounded counts. Only 'empty' is completed zero-result evidence. Prefer targeted sources; 'all' is slower. SSRN uses OpenAlex's SSRN venue filter (metadata-only). PubMed/PMC share a host-local NCBI rate limiter.`,
  schema: PapersMultiSearchSchema,
  slow: true,
  billing: {
    charge: multiSearchBilling,
    noCharge(args) {
      const sources = requestedSources(args.sources);
      return (
        sources.length > 0 &&
        sources.every((source) => !(OPENALEX_BACKED_SOURCES as readonly string[]).includes(source))
      );
    },
  },
  execute: (args, ctx) =>
    Effect.tryPromise({
      try: async (): Promise<ActionOutcome> => {
        const query = String(args.query ?? "").trim();
        if (!query) return failed("query is required");
        const maxResults = Number(args.maxResults ?? 5);
        if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
          return failed("maxResults must be an integer from 1 to 20");
        }
        const sources = requestedSources(args.sources);
        if (!sources.length) {
          return failed(
            `no sources selected. Disabled: ${[...DISABLED_SOURCES].join(", ")}. Available: ${ACTIVE_SOURCES.join(", ")}`,
          );
        }
        const cliArgs = ["search", "-n", String(maxResults), "-s", sources.join(",")];
        const year = String(args.year ?? "").trim();
        if (year) cliArgs.push("-y", year);
        cliArgs.push("--", query);
        const out = await runPaperBridgeTool(cliArgs, ctx, {
          progressMessage: `Searching ${sources.length} paper connector${sources.length === 1 ? "" : "s"} (${sources.slice(0, 4).join(", ")}${sources.length > 4 ? ", …" : ""})...`,
        });
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        return out.startsWith("ERROR:") ? failed(out) : searchResult(out, sources);
      },
      catch: (error) => (error instanceof Error ? error : new Error("Unknown error")),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          ctx.signal.aborted
            ? outcome("cancelled", "Research call cancelled")
            : failed(`papers_multi_search failed: ${error.message}`),
        ),
      ),
    ),
});

const PapersSectionsSchema = Schema.Struct({
  file: Schema.String.annotate({ description: "Relative PDF filename inside the Dig paper library." }),
  maxPages: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description: "Maximum pages to extract (1–100, default 30).",
    }),
  ),
  maxCharacters: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200_000 })).annotate({
      description: "Maximum characters to extract (1–200000, default 60000).",
    }),
  ),
});

export const papersSectionsAction = defineAction({
  name: "papers_sections",
  description:
    "Extract bounded sections from a PDF already saved under the Dig paper library. Takes a relative filename, not an arbitrary path. Headings are recognized heuristically; page and character limits stay explicit.",
  schema: PapersSectionsSchema,
  slow: true,
  billing: "free",
  execute: (args, ctx) =>
    Effect.tryPromise({
      try: async (): Promise<ActionOutcome> => {
        const file = String(args.file ?? "");
        if (
          !file ||
          path.isAbsolute(file) ||
          file.split(/[\\/]/).some((part) => !part || part === "." || part === "..") ||
          !file.toLowerCase().endsWith(".pdf")
        ) {
          return failed("file must be a relative PDF filename inside the paper library");
        }
        const maxPages = args.maxPages ?? 30;
        const maxCharacters = args.maxCharacters ?? 60_000;
        if (
          !Number.isInteger(maxPages) ||
          maxPages < 1 ||
          maxPages > 100 ||
          !Number.isInteger(maxCharacters) ||
          maxCharacters < 1 ||
          maxCharacters > 200_000
        ) {
          return failed("maxPages must be 1–100 and maxCharacters 1–200000");
        }
        const out = await runPaperBridgeTool(
          ["tool", "extract_sections", file, "--max-pages", String(maxPages), "--max-chars", String(maxCharacters)],
          ctx,
          { progressMessage: `Extracting sections from ${file}...` },
        );
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        if (out.startsWith("ERROR:") && /invalid choice: '?(?:tool|extract_sections)\b/.test(out)) {
          return failed(
            `the Papers bridge is out of date: the installed clone has no section extraction. Rerun the Papers bridge setup (node ${BRIDGE_SETUP}) to update the pinned clone and apply the maintained patch, then retry. ${out.slice("ERROR: ".length)}`,
          );
        }
        if (out.startsWith("ERROR:")) return failed(out);
        const value = JSON.parse(out) as { sections?: unknown; truncated?: unknown };
        if (!value || !Array.isArray(value.sections) || typeof value.truncated !== "boolean") {
          return failed("paper sections returned a malformed result");
        }
        return outcome(value.truncated ? "partial" : "success", boundedOutput(out));
      },
      catch: (error) => (error instanceof Error ? error : new Error("Unknown error")),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          ctx.signal.aborted
            ? outcome("cancelled", "Research call cancelled")
            : failed(`papers_sections failed: ${error.message}`),
        ),
      ),
    ),
});

const PapersFulltextReadSchema = Schema.Struct({
  source: Schema.String.annotate({
    description:
      "Source platform the paper_id belongs to (e.g. arxiv, biorxiv, medrxiv, pmc, europepmc, semantic, zenodo, hal, core). IACR read is Cloudflare-blocked; SSRN is metadata-only.",
  }),
  paperId: Schema.String.annotate({
    description: "Paper identifier exactly as reported by search results for that source.",
  }),
});

export const papersFulltextReadAction = defineAction({
  name: "papers_fulltext_read",
  description:
    "Download a paper's PDF from an open source (e.g. arxiv, biorxiv, medrxiv, pmc, europepmc, semantic, zenodo, hal, core) and extract its full text via the local paper-search-mcp CLI. Returns plain text (truncated if very long). Use the paper_id exactly as reported by search results for that source. Note: IACR PDFs are Cloudflare-blocked (search works, read does not); SSRN is metadata-only.",
  schema: PapersFulltextReadSchema,
  slow: true,
  billing: openAlexUnknownBilling(),
  execute: (args, ctx) =>
    Effect.tryPromise({
      try: async (): Promise<ActionOutcome> => {
        const source = String(args.source ?? "").trim().toLowerCase();
        const paperId = String(args.paperId ?? "").trim();
        if (!source || !paperId) return failed("source and paperId are required");
        const text = await writeOnce(paperLibraryDir(), (folder) =>
          runPaperBridgeTool(["read", source, paperId, "-o", folder], ctx, {
            progressMessage: `Downloading and extracting full text for ${source}:${paperId}...`,
          }).then(boundedOutput),
        );
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        return text.startsWith("ERROR:") ? failed(text) : outcome("success", text);
      },
      catch: (error) => (error instanceof Error ? error : new Error("Unknown error")),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          ctx.signal.aborted
            ? outcome("cancelled", "Research call cancelled")
            : failed(`papers_fulltext_read failed: ${error.message}`),
        ),
      ),
    ),
});

const PapersPdfDownloadSchema = Schema.Struct({
  source: Schema.String.annotate({
    description:
      "Source platform the paper_id belongs to (e.g. arxiv, biorxiv, medrxiv, pmc, europepmc, iacr, semantic, zenodo, hal).",
  }),
  paperId: Schema.String.annotate({
    description: "Paper identifier exactly as reported by search results for that source.",
  }),
  savePath: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Directory to save the PDF (default: the library's papers/ folder). A relative path resolves against the project directory; the directory must lie inside the project or Dig's state directory, symbolic links resolved.",
    }),
  ),
});

export const papersPdfDownloadAction = defineAction({
  name: "papers_pdf_download",
  description:
    "Download a paper's PDF to local disk via the local paper-search-mcp CLI and return the saved file path as JSON. Use when the parent orchestrator needs the PDF artifact itself rather than extracted text.",
  schema: PapersPdfDownloadSchema,
  slow: true,
  billing: openAlexUnknownBilling(),
  execute: (args, ctx) =>
    Effect.tryPromise({
      try: async (): Promise<ActionOutcome> => {
        const source = String(args.source ?? "").trim().toLowerCase();
        const paperId = String(args.paperId ?? "").trim();
        if (!source || !paperId) return failed("source and paperId are required");
        const savePath = String(args.savePath ?? "").trim();
        if (savePath && !path.isAbsolute(savePath) && !path.isAbsolute(ctx.project)) {
          return failed(
            "a relative savePath needs the call's project directory; give an absolute savePath or omit it to use the library",
          );
        }
        const target = !savePath ? paperLibraryDir() : path.resolve(ctx.project, savePath);
        const roots = [...(path.isAbsolute(ctx.project) ? [ctx.project] : []), stateDirectory()];
        if (savePath && !confined(target, roots)) {
          return failed(
            `savePath must lie inside the project directory (${ctx.project}) or Dig's state directory (${stateDirectory()}), symbolic links resolved; omit it to save in the library's papers folder`,
          );
        }
        const text = await writeOnce(target, (folder) =>
          runPaperBridgeTool(["download", source, paperId, "-o", folder], ctx, {
            progressMessage: `Downloading PDF for ${source}:${paperId}...`,
          }).then(boundedOutput),
        );
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        return text.startsWith("ERROR:") ? failed(text) : outcome("success", text);
      },
      catch: (error) => (error instanceof Error ? error : new Error("Unknown error")),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          ctx.signal.aborted
            ? outcome("cancelled", "Research call cancelled")
            : failed(`papers_pdf_download failed: ${error.message}`),
        ),
      ),
    ),
});
