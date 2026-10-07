import { afterEach, beforeEach, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { executeSource } from "../outcome.js";
import { loadConfig, paperSearchDirectory, paperSearchInterpreter } from "../runtime-config.js";
import { expect } from "expect";
import type { SourceToolResult, ToolContext } from "../types.js";
import { multi_search, pdf_download } from "./paper_search.js";

const context: ToolContext = { sessionID: "papers-bridge-test", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, keep: () => {} };
const text = (result: SourceToolResult) => (typeof result === "string" ? result : result.text);
const saved = {
	PATH: process.env.PATH,
	DIG_STATE_DIR: process.env.DIG_STATE_DIR,
	PAPER_SEARCH_MCP_ENV_FILE: process.env.PAPER_SEARCH_MCP_ENV_FILE,
	PAPER_SEARCH_MCP_UNPAYWALL_EMAIL: process.env.PAPER_SEARCH_MCP_UNPAYWALL_EMAIL,
};
let root: string;

/**
 * Isolated native state holding an installed-looking bridge, and a stand-in
 * for `uv run … paper-search <command> …` first on PATH. `search` prints
 * FAKE_SEARCH_OUTPUT as the bridge's JSON, or with FAKE_SEARCH_FAIL prints
 * that to stderr and exits 1. `download <source> <id> -o <dir>`
 * writes `<dir>/<id>.pdf` like the bridge's downloaders (which replace an
 * existing file) and prints the saved path. Never the bridge's real checkout.
 */
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dig-papers-bridge-"));
	process.env.DIG_STATE_DIR = join(root, "state");
	mkdirSync(dirname(paperSearchInterpreter()), { recursive: true });
	writeFileSync(paperSearchInterpreter(), "");
	mkdirSync(join(root, "bin"));
	const script = [
		`#!${process.execPath}`,
		'const { writeFileSync } = require("node:fs");',
		"const args = process.argv.slice(2);",
		'const out = args[args.indexOf("-o") + 1];',
		'const id = args[args.indexOf("download") + 2];',
		'if (args[args.indexOf("paper-search") + 1] === "search") { if (process.env.FAKE_SEARCH_FAIL) { console.error(process.env.FAKE_SEARCH_FAIL); process.exit(1); } process.stdout.write(process.env.FAKE_SEARCH_OUTPUT ?? ""); }',
		"else {",
		'writeFileSync(`${out}/${id}.pdf`, process.env.FAKE_PDF_BYTES ?? "");',
		'if (process.env.FAKE_PDF_HANG) { writeFileSync(process.env.FAKE_PDF_HANG, "started"); setTimeout(() => {}, 60_000); }',
		'else if (process.env.FAKE_PDF_FAIL) { console.error("download interrupted"); process.exit(1); }',
		"else console.log(JSON.stringify({ path: `${out}/${id}.pdf` }));",
		"}",
	].join("\n");
	writeFileSync(join(root, "bin", "uv"), script, { mode: 0o755 });
	process.env.PATH = `${join(root, "bin")}:${saved.PATH}`;
});
afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	delete process.env.FAKE_PDF_BYTES;
	delete process.env.FAKE_PDF_FAIL;
	delete process.env.FAKE_PDF_HANG;
	delete process.env.FAKE_SEARCH_OUTPUT;
	delete process.env.FAKE_SEARCH_FAIL;
	rmSync(root, { recursive: true, force: true });
});

test("a repeated PDF download keeps the library's existing file instead of replacing it", async () => {
	const papers = join(loadConfig().library, "papers");
	const path = join(papers, "1234.56789.pdf");
	process.env.FAKE_PDF_BYTES = "original-pdf-bytes";
	const first = text(await pdf_download.execute({ source: "arxiv", paperId: "1234.56789" }, context));
	expect(first).toBe(JSON.stringify({ path }));
	process.env.FAKE_PDF_BYTES = "replacement-pdf-bytes";
	const second = text(await pdf_download.execute({ source: "arxiv", paperId: "1234.56789" }, context));
	expect(second).toContain(JSON.stringify({ path }));
	expect(second).toContain(`Already saved, kept unchanged (not replaced): ${path}`);
	expect(readFileSync(path, "utf8")).toBe("original-pdf-bytes");
	expect(readdirSync(papers)).toEqual(["1234.56789.pdf"]);
});

test("a failed download never publishes its partial file, so a retry saves the complete one", async () => {
	const papers = join(loadConfig().library, "papers");
	const path = join(papers, "2345.67890.pdf");
	process.env.FAKE_PDF_BYTES = "partial-pdf-bytes";
	process.env.FAKE_PDF_FAIL = "1";
	expect((text(await pdf_download.execute({ source: "arxiv", paperId: "2345.67890" }, context))).startsWith("ERROR:")).toBe(true);
	delete process.env.FAKE_PDF_FAIL;
	process.env.FAKE_PDF_BYTES = "complete-pdf-bytes";
	expect(text(await pdf_download.execute({ source: "arxiv", paperId: "2345.67890" }, context))).toBe(JSON.stringify({ path }));
	expect(readFileSync(path, "utf8")).toBe("complete-pdf-bytes");
});

test("cancelling a download stops the bridge process, publishes nothing and reports cancelled", async () => {
	const papers = join(loadConfig().library, "papers");
	const started = join(root, "bridge-started");
	process.env.FAKE_PDF_BYTES = "partial-pdf-bytes";
	process.env.FAKE_PDF_HANG = started;
	const controller = new AbortController();
	const pending = executeSource(pdf_download, { source: "arxiv", paperId: "3456.78901" }, { ...context, abort: controller.signal });
	for (let i = 0; i < 400 && !existsSync(started); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(existsSync(started)).toBe(true);
	controller.abort();
	const result = await pending;
	expect(result.status).toBe("cancelled");
	expect(readdirSync(papers)).toEqual([]);
});

test("a missing bridge is an actionable failure naming its setup, not an empty result", async () => {
	rmSync(paperSearchInterpreter());
	const result = text(await pdf_download.execute({ source: "arxiv", paperId: "4567.89012" }, context));
	expect((result).startsWith("ERROR: papers_pdf_download failed: the optional Papers bridge is not installed")).toBe(true);
	expect(result).toContain("setup.mjs --email");
});

test("the bridge's echoes of the Unpaywall contact email reach neither results nor kept responses, wherever it is set", async () => {
	const address = "reader+dig@example.org";
	const encoded = "reader%2Bdig%40example.org";
	const httpError = `503 Server Error: Service Unavailable for url: https://api.unpaywall.org/v2/10.1000/x?email=${encoded}`;
	const rejected = `Unpaywall rejected the configured email (${address}) with HTTP 422.`;
	delete process.env.PAPER_SEARCH_MCP_ENV_FILE;
	const origins = [
		() => { process.env.PAPER_SEARCH_MCP_UNPAYWALL_EMAIL = address; },
		() => {
			delete process.env.PAPER_SEARCH_MCP_UNPAYWALL_EMAIL;
			writeFileSync(join(paperSearchDirectory(), ".env"), `export PAPER_SEARCH_MCP_UNPAYWALL_EMAIL="${address}"\n`);
		},
	];
	for (const configure of origins) {
		configure();
		const kept: unknown[] = [];
		const keeping = { ...context, keep: (_label: string, _status: number | string, body: unknown) => { kept.push(body); } };
		process.env.FAKE_SEARCH_OUTPUT = JSON.stringify({ source_status: { unpaywall: "failed" }, papers: [], errors: { unpaywall: httpError }, warnings: { unpaywall: [rejected] } });
		const found = text(await multi_search.execute({ query: "10.1000/x", sources: ["unpaywall"] }, keeping));
		process.env.FAKE_SEARCH_FAIL = `${rejected}\n${httpError}`;
		const failed = text(await multi_search.execute({ query: "10.1000/x", sources: ["unpaywall"] }, keeping));
		delete process.env.FAKE_SEARCH_FAIL;
		expect(found).toContain("rejected the configured email ([redacted])");
		expect(failed).toContain("email=[redacted]");
		for (const value of [found, failed, JSON.stringify(kept)]) {
			expect(value).not.toContain(address);
			expect(value).not.toContain(encoded);
		}
	}
});

test("a federated search's outcome follows its requested connectors' health, so one whose every connector failed is recorded as failed", async () => {
	const outcomeOf = (health: Record<string, unknown>) => {
		process.env.FAKE_SEARCH_OUTPUT = JSON.stringify({ source_status: health, papers: [], errors: {} });
		return executeSource(multi_search, { query: "governance", sources: Object.keys(health) }, context);
	};
	const failed = await outcomeOf({ crossref: "failed", arxiv: "failed" });
	expect(failed.status).toBe("failed");
	// The receipt keeps a failed call's first line as its error; the bridge's errors stay in the text after it.
	expect(failed.text.split("\n", 1)[0]).toBe("ERROR: every requested connector failed (crossref, arxiv). The bridge's errors and full output follow.");
	expect(failed.text).toContain('"source_status"');
	expect((await outcomeOf({ crossref: "failed", arxiv: "ok" })).status).toBe("partial");
	expect((await outcomeOf({ crossref: "failed", arxiv: "empty" })).status).toBe("partial");
	expect((await outcomeOf({ crossref: "partial" })).status).toBe("partial");
	expect((await outcomeOf({ crossref: "empty", arxiv: "empty" })).status).toBe("empty");
	expect((await outcomeOf({ crossref: "ok", arxiv: "empty" })).status).toBe("success");
	// Health that is not one of the bridge's words is unusable, even when it would stringify to one.
	for (const malformed of [["empty"], ["ok"], [["empty"]]]) {
		const result = await outcomeOf({ crossref: malformed });
		expect(result.status).toBe("failed");
		expect(result.text).toBe("ERROR: paper-search omitted a requested source's health; this output cannot establish complete coverage.");
	}
});

/** The finalized cost of one federated search whose bridge prints `output` (every requested source reported healthy). */
async function searchCost(sources: string[], output: Record<string, unknown>) {
	process.env.FAKE_SEARCH_OUTPUT = JSON.stringify({ source_status: Object.fromEntries(sources.map(source => [source, "empty"])), papers: [], ...output });
	const { details } = await executeSource(multi_search, { query: "governance", sources }, context);
	return { cost: details?.cost, knownCost: details?.knownCost };
}

test("a federated search records OpenAlex's reported USD for its OpenAlex-backed sources, never also its credits", async () => {
	expect(await searchCost(["openalex", "ssrn"], {
		billing: { openalex: { http_status: 200, cost_usd: 0.001 }, ssrn: { http_status: 200, cost_usd: 0.001 } },
		rate_limits: { openalex: { "credits-used": 10 }, ssrn: { "credits-used": 10 } },
	})).toEqual({ cost: [{ amount: 0.002, unit: "USD" }], knownCost: undefined });
	// A bridge that did not report USD may still report the request's credits, in OpenAlex's own unit.
	expect(await searchCost(["openalex"], { rate_limits: { openalex: { "credits-used": 10 } } }))
		.toEqual({ cost: [{ amount: 10, unit: "OpenAlex credits" }], knownCost: undefined });
});

test("a missing OpenAlex cost is unknown, not free, including from a bridge that predates billing", async () => {
	expect(await searchCost(["openalex"], { billing: { openalex: { http_status: 200, cost_usd: null } } }))
		.toEqual({ cost: null, knownCost: undefined });
	expect(await searchCost(["ssrn"], { billing: { ssrn: { http_status: null, cost_usd: null } } }))
		.toEqual({ cost: null, knownCost: undefined });
	expect(await searchCost(["openalex", "crossref"], { rate_limits: {} })).toEqual({ cost: null, knownCost: undefined });
	expect(await searchCost(["openalex"], { billing: { openalex: { cost_usd: 0 } } }))
		.toEqual({ cost: null, knownCost: undefined });
});

test("a mixed federated search keeps its known OpenAlex subtotal when another OpenAlex-backed charge is unknown", async () => {
	expect(await searchCost(["openalex", "ssrn", "crossref"], {
		billing: { openalex: { http_status: 200, cost_usd: 0.001 }, ssrn: { http_status: 200, cost_usd: null } },
	})).toEqual({ cost: null, knownCost: [{ amount: 0.001, unit: "USD" }] });
});

test("an OpenAlex error response costs nothing, and other connectors keep their no-charge policy", async () => {
	expect(await searchCost(["openalex", "crossref"], { billing: { openalex: { http_status: 429, cost_usd: null } } }))
		.toEqual({ cost: [], knownCost: undefined });
	expect(await searchCost(["crossref", "arxiv"], {})).toEqual({ cost: [], knownCost: undefined });
});

test("public-only Papers calls stay no-charge through cancellation and setup failure, while OpenAlex selections stay metered", async () => {
	for (const { sources, cost, knownCost } of [
		{ sources: ["crossref", "arxiv"], cost: [], knownCost: undefined },
		{ sources: ["crossref", "openalex"], cost: null, knownCost: [{ amount: 0.125, unit: "USD" }] },
	]) {
		process.env.FAKE_SEARCH_OUTPUT = JSON.stringify({
			source_status: Object.fromEntries(sources.map(source => [source, "empty"])), papers: [],
			billing: { openalex: { http_status: 200, cost_usd: 0.125 } },
		});
		const controller = new AbortController();
		const result = await executeSource(multi_search, { query: "governance", sources }, {
			...context, abort: controller.signal, keep: () => controller.abort(),
		});
		expect(result.status).toBe("cancelled");
		expect(result.details?.cost).toEqual(cost);
		expect(result.details?.knownCost).toEqual(knownCost);
	}
	rmSync(paperSearchInterpreter());
	for (const { sources, cost } of [
		{ sources: ["crossref", "arxiv"], cost: [] },
		{ sources: ["crossref", "openalex"], cost: null },
		{ sources: undefined, cost: null },
	]) {
		const result = await executeSource(multi_search, { query: "governance", sources }, context);
		expect(result.status).toBe("failed");
		expect(result.details?.cost).toEqual(cost);
		expect(result.details?.knownCost).toBeUndefined();
	}
});
