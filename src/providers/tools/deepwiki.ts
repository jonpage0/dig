import { outcome, failed, free, type ToolOutcome } from "../outcome.js";
import { knownSecrets, redactText, redactValue } from "../secrets.js";
import type { KeepRaw, ToolSpec } from "../types.js";

const DEEPWIKI_MCP_URL = "https://mcp.deepwiki.com/mcp";
/**
 * The most of a wiki one read returns: github_read's bound for one text, so the result stays well under the ~1 MiB
 * of JSON a host passes to the model (even at 4 UTF-8 bytes a character). The retained original keeps the whole wiki.
 */
const CONTENTS_MAX_CHARS = 200_000;
/** A page or heading boundary this close before the bound is where the cut falls; otherwise the last line break. */
const BOUNDARY_WINDOW = 20_000;

type DeepWikiToolName = "read_wiki_structure" | "read_wiki_contents" | "ask_question";

function normalizeRepoName(value: unknown): string {
	const repo = String(value ?? "").trim();
	if (!repo) throw new Error("repoName is required in owner/repo format");
	return repo;
}

/**
 * DeepWiki answers over streamable HTTP. A slow `ask_question` streams progress
 * notifications (and `: ping` comments) before the JSON-RPC response, so parse
 * each SSE event on its own and return the one carrying `result` or `error`.
 */
function extractSseJson(text: string): unknown {
	const messages: unknown[] = [];
	for (const event of text.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.join("\n")
			.trim();
		if (data) messages.push(JSON.parse(data));
	}
	if (!messages.length) {
		if (!text.trim()) throw new Error("DeepWiki returned an empty response");
		return JSON.parse(text);
	}
	const response = messages.find(
		(m) => typeof m === "object" && m !== null && ("result" in m || "error" in m),
	);
	if (!response) throw new Error("DeepWiki stream ended without a response");
	return response;
}

function textFromMcpResult(payload: unknown): ToolOutcome {
	const envelope = payload as {
		error?: { message?: string };
		result?: { content?: Array<{ type?: string; text?: string }>; result?: string; isError?: boolean };
	};
	if (envelope.error) throw new Error(envelope.error.message || "DeepWiki MCP error");
	const result = envelope.result;
	if (!result) throw new Error("DeepWiki MCP response did not include a result");
	if (typeof result.result === "string") return outcome(result.isError ? "failed" : "success", result.result);
	const content = result.content ?? [];
	const text = content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
	if (!text) throw new Error("DeepWiki MCP response did not include text content");
	return outcome(result.isError ? "failed" : "success", text);
}

async function callDeepWiki(
	name: DeepWikiToolName,
	args: Record<string, unknown>,
	signal: AbortSignal,
	keep: KeepRaw,
	timeoutMs = 60_000,
): Promise<ToolOutcome> {
	signal.throwIfAborted();
	const response = await fetch(DEEPWIKI_MCP_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: `${name}-${Date.now()}`,
			method: "tools/call",
			params: { name, arguments: args },
		}),
		signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
	});
	const text = await response.text();
	signal.throwIfAborted();
	// DeepWiki sends no credential, but an answer can echo one from a question. The decoded response is redacted, and
	// text that does not decode is redacted as text, before any of it is kept or cut into an excerpt.
	const secrets = knownSecrets();
	let payload: unknown;
	try {
		payload = redactValue(extractSseJson(text), secrets);
	} catch (error) {
		const clean = redactText(text, secrets);
		keep(name, response.status, clean);
		if (!response.ok) return failed(`DeepWiki HTTP ${response.status}: ${clean.slice(0, 300)}`);
		// The JSON parser's own message quotes part of the response, which could cut a credential in two.
		const reason = error instanceof SyntaxError ? "a response event is not JSON" : error instanceof Error ? error.message : "Unknown error";
		return failed(`Failed to parse DeepWiki response: ${reason}`);
	}
	keep(name, response.status, payload);
	if (!response.ok) {
		return failed(`DeepWiki HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
	}
	try {
		return textFromMcpResult(payload);
	} catch (error) {
		return failed(`Failed to parse DeepWiki response: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

// DeepWiki's public MCP endpoint needs no account and never charges.
export const read_wiki_structure: ToolSpec = free({
	description: "Get a list of documentation topics for a GitHub repository via DeepWiki's public no-auth endpoint.",
	async execute(args, context) {
		try {
			return await callDeepWiki("read_wiki_structure", { repoName: normalizeRepoName(args.repoName) }, context.abort, context.keep);
		} catch (error) {
			context.abort.throwIfAborted();
			return failed(`DeepWiki read_wiki_structure failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	},
});

/** The wiki's first part, cut at a page or heading boundary near the bound when there is one; partial, saying so. */
function boundedContents(result: ToolOutcome): ToolOutcome {
	const text = result.text;
	if (result.status !== "success" || text.length <= CONTENTS_MAX_CHARS) return result;
	const window = text.slice(0, CONTENTS_MAX_CHARS + 1);
	const headings = [...window.matchAll(/\n(?=#{1,6} )/g)].map((match) => match.index + 1);
	const heading = headings.at(-1);
	const line = window.lastIndexOf("\n");
	let cut = heading !== undefined && heading >= CONTENTS_MAX_CHARS - BOUNDARY_WINDOW ? heading : line >= CONTENTS_MAX_CHARS - BOUNDARY_WINDOW ? line + 1 : CONTENTS_MAX_CHARS;
	if (/[\uD800-\uDBFF]/.test(text[cut - 1] ?? "")) cut -= 1;
	const shown = text.slice(0, cut);
	const count = (n: number) => n.toLocaleString("en-US");
	return outcome(
		"partial",
		`Showing the first ${count(shown.length)} of ${count(text.length)} characters of this wiki (Dig returns at most ${count(CONTENTS_MAX_CHARS)} per call); the retained original holds the whole wiki, and deepwiki_ask_question or the page list from deepwiki_read_wiki_structure reaches a specific page.\n\n${shown}`,
		result.details,
	);
}

export const read_wiki_contents: ToolSpec = free({
	description: "View DeepWiki documentation contents for a GitHub repository via DeepWiki's public no-auth endpoint. Returns at most 200,000 characters: a longer wiki comes back cut at a page boundary, as partial, with the full size stated; the retained original keeps the whole wiki.",
	async execute(args, context) {
		try {
			return boundedContents(await callDeepWiki("read_wiki_contents", { repoName: normalizeRepoName(args.repoName) }, context.abort, context.keep));
		} catch (error) {
			context.abort.throwIfAborted();
			return failed(`DeepWiki read_wiki_contents failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	},
});

export const ask_question: ToolSpec = free({
	description: "Ask DeepWiki an AI-powered, context-grounded question about one GitHub repository.",
	async execute(args, context) {
		try {
			const question = String(args.question ?? "").trim();
			if (!question) return failed("question is required");
			return await callDeepWiki(
				"ask_question",
				{ repoName: normalizeRepoName(args.repoName), question },
				context.abort,
				context.keep,
				180_000,
			);
		} catch (error) {
			context.abort.throwIfAborted();
			return failed(`DeepWiki ask_question failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	},
});
