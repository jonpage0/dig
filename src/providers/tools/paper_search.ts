import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, paperSearchDirectory, paperSearchEnvFile, paperSearchEnvValues, paperSearchInterpreter } from "../runtime-config.js";
import { redactText } from "../secrets.js";
import { findExecutable } from "../executables.js";
import { free, type OutcomeStatus } from "../outcome.js";
import type { CostAmount, ReceiptCost } from "../library/types.js";
import type { KeepRaw, RetainedResponse, SourceToolOutput, ToolContext, ToolSpec } from "../types.js";
import { openAlexAmount, openAlexNoCharge } from "./papers.js";

// Bridge to the local clone of openags/paper-search-mcp (MIT). We invoke its
// `paper-search` CLI (same library as its MCP server, JSON output) via `uv run`
// instead of speaking stdio-MCP: source workers call these provider tools
// directly, so the bridge stays behind them rather than becoming its own server.
// Its OpenAlex-backed search connectors (openalex, ssrn) report OpenAlex's
// per-request usage cost. The other connectors keep their existing no-charge
// policy, which this cost reporting did not re-audit.

// Bundled assets ship in plugin/bridges/papers/; these resolve from the
// bundled server, plugin/dist/server.mjs.
const BRIDGE_ASSETS = new URL("../bridges/papers/", import.meta.url);
const BRIDGE_SETUP = fileURLToPath(new URL("setup.mjs", BRIDGE_ASSETS));

/** Downloaded PDFs are shared across projects in `<library>/papers/` (docs/architecture.md). */
const downloadsDir = () => path.join(loadConfig().library, "papers");
const EXISTS = "EEXIST";

/**
 * Runs a bridge command that saves files into `target`, write-once: the
 * bridge writes into a fresh folder inside `target`, then each file takes its
 * place only if no file of that name is there yet (a hard link fails rather
 * than replace one). An existing file is kept and the new copy discarded; the
 * bridge's output names the kept files, and a note lists the ones that were
 * already there. The bridge names files per source, so a download is only
 * known to be a repeat once it has run.
 */
async function writeOnce(target: string, run: (folder: string) => Promise<string>): Promise<string> {
	// Absolute, because the bridge runs in its own directory.
	const dir = path.resolve(target);
	mkdirSync(dir, { recursive: true });
	const folder = mkdtempSync(path.join(dir, ".incoming-"));
	try {
		const out = await run(folder);
		// A failed run may leave a partial file; publishing it would block every retry.
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

// Disabled after live testing (2026-07-21): CiteSeerX service is dead (2024 datacenter
// shutdown, 2025 archive migration; JabRef removed its fetcher 2026-07); BASE's OAI-PMH
// endpoint requires institutional IP registration (official keyed API would need an
// approval process — revisit if ever needed).
const DISABLED_SOURCES = new Set(["base", "citeseerx"]);

const ACTIVE_SOURCES = [
	"arxiv", "biorxiv", "core", "crossref", "dblp", "doaj", "europepmc", "google_scholar",
	"hal", "iacr", "medrxiv", "openaire", "openalex", "pmc", "pubmed", "semantic", "ssrn",
	"unpaywall", "zenodo",
];

/** Connectors that search api.openalex.org, which reports each request's usage cost. */
const OPENALEX_BACKED_SOURCES = ["openalex", "ssrn"];
/** OpenAlex's `X-RateLimit-Credits-Used` unit, distinct from other providers' credits. */
const OPENALEX_CREDITS = "OpenAlex credits";

/** The deduplicated connectors a call requests; none given, or `all`, means every active one. */
function requestedSources(sources: unknown): string[] {
	const raw = Array.isArray(sources) ? sources.join(",") : String(sources ?? "").trim();
	const requested = raw && raw.toLowerCase() !== "all"
		? raw.split(",").map(s => s.trim().toLowerCase()).filter(s => s.length > 0)
		: ACTIVE_SOURCES;
	const unavailable = requested.filter(s => !ACTIVE_SOURCES.includes(s));
	if (unavailable.length) throw new Error(`Unsupported or disabled sources: ${unavailable.join(", ")}. Available: ${ACTIVE_SOURCES.join(", ")}`);
	return [...new Set(requested)];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * One requested OpenAlex-backed connector's charge in the bridge's search
 * output: its reported USD cost; else its per-request credits header (one
 * unit, never both, never converted); else nothing for a documented no-charge
 * 4xx/5xx; else unknown (null). A stale bridge without `billing` proves no zero.
 */
function openAlexBackedCharge(output: Record<string, unknown> | undefined, source: string): CostAmount[] | null {
	const billing = record(record(output?.billing)?.[source]);
	const status = billing?.http_status;
	const validBilling = billing && (status === null || (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599))
		&& (billing.cost_usd === null || openAlexAmount(billing.cost_usd) !== null);
	const usd = validBilling && status !== null ? openAlexAmount(billing.cost_usd) : null;
	if (usd !== null) return [{ amount: usd, unit: "USD" }];
	const reportedCredits = record(record(output?.rate_limits)?.[source])?.["credits-used"];
	const credits = openAlexAmount(reportedCredits);
	if (credits !== null) return [{ amount: credits, unit: OPENALEX_CREDITS }];
	if (reportedCredits !== undefined && reportedCredits !== null) return null;
	return validBilling && openAlexNoCharge(status) ? [] : null;
}

/**
 * The federated search's charge from its bridge output. Each requested
 * OpenAlex-backed connector adds its reported amount; one whose charge is
 * unknown leaves the total unknown and keeps the known subtotal. The other
 * connectors keep their no-charge policy.
 */
function multiSearchBilling(response: RetainedResponse, args: { sources?: unknown }): ReceiptCost {
	const output = record(response.body);
	const charges = requestedSources(args.sources)
		.filter(source => OPENALEX_BACKED_SOURCES.includes(source))
		.map(source => openAlexBackedCharge(output, source));
	const totals = new Map<string, number>();
	for (const { amount, unit } of charges.flatMap(charge => charge ?? [])) totals.set(unit, (totals.get(unit) ?? 0) + amount);
	const known = [...totals].filter(([, amount]) => amount > 0).map(([unit, amount]) => ({ amount, unit }));
	if (!charges.includes(null)) return { cost: known };
	return known.length ? { cost: null, knownCost: known } : { cost: null };
}

const MAX_OUTPUT_CHARS = 120_000;
const bounded = (out: string) =>
	out.length > MAX_OUTPUT_CHARS ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n\n[TRUNCATED: output was ${out.length} chars; showing first ${MAX_OUTPUT_CHARS}]` : out;

const CONNECTOR_HEALTH = ["ok", "empty", "partial", "failed"];

/**
 * The federated search's outcome from its requested connectors' health, by the rule DataForSEO's tasks follow: every
 * connector failed is `failed`, every one empty is `empty`, any failed or partial connector makes the search
 * `partial`, and the rest returned papers. The bridge marks a connector `partial` when it returned papers with errors
 * or warnings, or no papers with only warnings (an empty response it could not validate), so a search with no papers
 * can be `partial`, never `empty`.
 */
function searchStatus(health: string[]): OutcomeStatus {
	if (health.every(h => h === "failed")) return "failed";
	if (health.every(h => h === "empty")) return "empty";
	if (health.some(h => h === "failed" || h === "partial")) return "partial";
	return "success";
}

/**
 * The bridge's search JSON as the tool's result, with an outcome decided before any truncation. Output without
 * per-connector health cannot establish coverage or no matches, so it is an error. A failed search keeps the
 * bridge's output after a first line naming the connectors, which the receipt keeps as its error.
 */
function searchResult(out: string, requested: string[]): SourceToolOutput | string {
	let payload: unknown;
	try { payload = JSON.parse(out); }
	catch { return "ERROR: paper-search returned invalid JSON, not an empty search"; }
	const health = record(record(payload)?.source_status);
	if (!health || "error" in (payload as object)) {
		return `ERROR: paper-search source health is unavailable. Rerun the Papers bridge setup (node ${BRIDGE_SETUP}) to apply the maintained patch for the pinned clone before using search; this output cannot establish no matches.`;
	}
	// Only the bridge's own words count: a non-string (`["empty"]` would stringify to "empty") is unusable health.
	const reported = requested.map(source => health[source]);
	if (reported.some(status => typeof status !== "string" || !CONNECTOR_HEALTH.includes(status))) {
		return "ERROR: paper-search omitted a requested source's health; this output cannot establish complete coverage.";
	}
	const status = searchStatus(reported as string[]);
	const text = status === "failed" ? `ERROR: every requested connector failed (${requested.join(", ")}). The bridge's errors and full output follow.\n\n${out}` : out;
	return { status, text: bounded(text) };
}

function redactDiagnostics(value: string): string {
	let text = value.replace(/([?&](?:api_key|access_token|token|key)=)[^&\s]+/gi, "$1[redacted]");
	for (const [name, secret] of Object.entries(process.env)) {
		if (secret && /KEY|TOKEN|SECRET|PASSWORD/i.test(name)) text = text.replaceAll(secret, "[redacted]");
	}
	return text;
}

function resolveUv(): string {
	const executable = findExecutable("uv");
	if (!executable) throw new Error("uv is unavailable; the optional Papers bridge runs through uv (https://docs.astral.sh/uv/). Install uv, then run the bridge setup.");
	return executable;
}

/** The installed bridge clone; absent until its setup has run. */
function resolveBridge(): string {
	const directory = paperSearchDirectory();
	if (!existsSync(paperSearchInterpreter()))
		throw new Error(`the optional Papers bridge is not installed at ${directory}. Install it with: node ${BRIDGE_SETUP} --email <your contact address> (needs git and uv; --help explains every option).`);
	return directory;
}

/** The bridge's stdout for the raw file: parsed JSON when it is JSON, else text. */
function keepOutput(keep: KeepRaw, label: string, exitCode: number | string, out: string): void {
	let body: unknown = out;
	try {
		body = JSON.parse(out);
	} catch {}
	keep(label, exitCode, body);
}

type BridgeContext = Pick<ToolContext, "abort" | "keep">;

interface BridgeRun {
	stdout: string;
	stderr: string;
	/** The exit code, or the signal name when the process was killed. */
	exitCode: number | string;
}

/**
 * The bridge reads the Unpaywall contact email as `PAPER_SEARCH_MCP_UNPAYWALL_EMAIL` or plain `UNPAYWALL_EMAIL`, from
 * Dig's environment (keys.env) or its own settings file.
 */
const CONTACT_NAMES = ["PAPER_SEARCH_MCP_UNPAYWALL_EMAIL", "UNPAYWALL_EMAIL"];
/** A value as Python's `requests` writes it into a query string (`@` → `%40`, `+` → `%2B`). */
const queryEncoded = (value: string) =>
	encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replaceAll("%20", "+");
/**
 * Every contact email the bridge could be using, as written and as encoded in a request URL, longest first. The
 * address is personal rather than a credential, and Dig keeps it out of conversations and saved evidence, but the
 * bridge echoes it: Unpaywall's rejected-email warning names it, and an HTTP error quotes the request URL. Only a
 * value with an `@` counts, so a stray placeholder such as `none` never blanks ordinary words in the evidence.
 */
function contactValues(): string[] {
	const values = new Set<string>();
	for (const name of CONTACT_NAMES) {
		for (const value of [process.env[name]?.trim(), ...paperSearchEnvValues(name)]) {
			if (value?.includes("@")) values.add(value).add(queryEncoded(value));
		}
	}
	return [...values].sort((a, b) => b.length - a.length);
}

/**
 * `uv run --no-sync` inside the bridge clone. Settles only once the process
 * has exited, so a cancelled download never races the removal of its scratch
 * folder. Cancellation kills it (SIGTERM) and reports its exit as it was;
 * failing to start rejects. The contact email is scrubbed from both streams
 * before anything reads them, so no truncation can leave part of it.
 */
function runBridge(command: string[], signal: AbortSignal): Promise<BridgeRun> {
	const directory = resolveBridge();
	const uv = resolveUv();
	return new Promise((resolve, reject) => {
		const child = spawn(uv, ["run", "--no-sync", "--directory", directory, ...command], {
			cwd: directory,
			// Exported variables reach the bridge as they are; without an explicit
			// PAPER_SEARCH_MCP_ENV_FILE the upstream config reads only this clone's
			// own `.env`, never a user-global file another installation wrote.
			env: { ...process.env, PAPER_SEARCH_MCP_ENV_FILE: paperSearchEnvFile() },
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let failure: Error | undefined;
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => {
			failure ??= error;
		});
		child.on("close", (code, killed) => {
			if (failure && !signal.aborted) return reject(failure);
			const contact = contactValues();
			const read = (chunks: Buffer[]) => redactText(Buffer.concat(chunks).toString("utf8"), contact);
			resolve({ stdout: read(stdout), stderr: read(stderr), exitCode: code ?? killed ?? "unknown" });
		});
	});
}

/** `paper-search <command>`'s trimmed output, or an ERROR line when it exited abnormally or printed nothing. */
async function runPaperSearch(cliArgs: string[], ctx: BridgeContext): Promise<string> {
	const { stdout, stderr, exitCode } = await runBridge(["paper-search", ...cliArgs], ctx.abort);
	const out = stdout.trim();
	if (exitCode !== 0) {
		const detail = redactDiagnostics(out || stderr.trim().split("\n").slice(-5).join("\n"));
		keepOutput(ctx.keep, `paper-search ${cliArgs[0]}`, exitCode, detail);
		return `ERROR: paper-search exited with code ${exitCode}: ${detail.slice(0, 2000)}`;
	}
	keepOutput(ctx.keep, `paper-search ${cliArgs[0]}`, exitCode, out);
	return out || "ERROR: paper-search produced no output";
}

export const multi_search: ToolSpec = {
	description:
		`Federated academic paper search across ${ACTIVE_SOURCES.length} enabled connectors (${ACTIVE_SOURCES.join(", ")}) via the local paper-search-mcp CLI. Enabled does not guarantee current availability: inspect source_status, errors, warnings and bounded counts. Only 'empty' is completed zero-result evidence. Prefer targeted sources; 'all' is slower. SSRN uses OpenAlex's SSRN venue filter (metadata-only). PubMed/PMC share a host-local NCBI rate limiter.`,
	billing: {
		charge: multiSearchBilling,
		noCharge(args) {
			const sources = requestedSources(args.sources);
			return sources.length > 0 && sources.every(source => !OPENALEX_BACKED_SOURCES.includes(source));
		},
	},
	async execute(args, context) {
		try {
			const query = String(args.query ?? "").trim();
			if (!query) return "ERROR: query is required";
			const cliArgs = ["search", query];
			const maxResults = Number(args.maxResults ?? 5);
			if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) return "ERROR: maxResults must be an integer from 1 to 20";
			cliArgs.push("-n", String(maxResults));
			const sources = requestedSources(args.sources);
			if (!sources.length) return `ERROR: no sources selected. Disabled: ${[...DISABLED_SOURCES].join(", ")}. Available: ${ACTIVE_SOURCES.join(", ")}`;
			cliArgs.push("-s", sources.join(","));
			const year = String(args.year ?? "").trim();
			if (year) cliArgs.push("-y", year);
			const out = await runPaperSearch(cliArgs, context);
			return out.startsWith("ERROR:") ? out : searchResult(out, sources);
		} catch (error) {
			if (context.abort.aborted) throw error;
			return `ERROR: papers_multi_search failed: ${error instanceof Error ? error.message : "Unknown error"}`;
		}
	},
};

export const fulltext_read: ToolSpec = free({
	description:
		"Download a paper's PDF from an open source (e.g. arxiv, biorxiv, medrxiv, pmc, europepmc, semantic, zenodo, hal, core) and extract its full text via the local paper-search-mcp CLI. Returns plain text (truncated if very long). Use the paper_id exactly as reported by search results for that source. Note: IACR PDFs are Cloudflare-blocked (search works, read does not); SSRN is metadata-only.",
	async execute(args, context) {
		try {
			const source = String(args.source ?? "").trim().toLowerCase();
			const paperId = String(args.paperId ?? "").trim();
			if (!source || !paperId) return "ERROR: source and paperId are required";
			return await writeOnce(downloadsDir(), (folder) => runPaperSearch(["read", source, paperId, "-o", folder], context).then(bounded));
		} catch (error) {
			if (context.abort.aborted) throw error;
			return `ERROR: papers_fulltext_read failed: ${error instanceof Error ? error.message : "Unknown error"}`;
		}
	},
});

export const pdf_download: ToolSpec = free({
	description:
		"Download a paper's PDF to local disk via the local paper-search-mcp CLI and return the saved file path as JSON. Use when the parent orchestrator needs the PDF artifact itself rather than extracted text.",
	async execute(args, context) {
		try {
			const source = String(args.source ?? "").trim().toLowerCase();
			const paperId = String(args.paperId ?? "").trim();
			if (!source || !paperId) return "ERROR: source and paperId are required";
			const savePath = String(args.savePath ?? "").trim() || downloadsDir();
			return await writeOnce(savePath, (folder) => runPaperSearch(["download", source, paperId, "-o", folder], context).then(bounded));
		} catch (error) {
			if (context.abort.aborted) throw error;
			return `ERROR: papers_pdf_download failed: ${error instanceof Error ? error.message : "Unknown error"}`;
		}
	},
});
