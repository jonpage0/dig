import { outcome, failed, free, type ToolOutcome } from "../outcome.js";
import type { KeepRaw, ToolSpec } from "../types.js";

const DEEPWIKI_MCP_URL = "https://mcp.deepwiki.com/mcp";

type DeepWikiToolName = "read_wiki_structure" | "read_wiki_contents" | "ask_question";

function normalizeRepoName(value: unknown): string | string[] {
	if (Array.isArray(value)) {
		const repos = value.map((item) => String(item).trim()).filter(Boolean);
		if (repos.length === 0) throw new Error("repoName must include at least one owner/repo value");
		return repos;
	}
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
		signal,
	});
	const text = await response.text();
	signal.throwIfAborted();
	let payload: unknown;
	try {
		payload = extractSseJson(text);
	} catch (error) {
		keep(name, response.status, text);
		if (!response.ok) return failed(`DeepWiki HTTP ${response.status}: ${text.slice(0, 300)}`);
		return failed(`Failed to parse DeepWiki response: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
	keep(name, response.status, payload);
	if (!response.ok) {
		return failed(`DeepWiki HTTP ${response.status}: ${text.slice(0, 300)}`);
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

export const read_wiki_contents: ToolSpec = free({
	description: "View DeepWiki documentation contents for a GitHub repository via DeepWiki's public no-auth endpoint.",
	async execute(args, context) {
		try {
			return await callDeepWiki("read_wiki_contents", { repoName: normalizeRepoName(args.repoName) }, context.abort, context.keep);
		} catch (error) {
			context.abort.throwIfAborted();
			return failed(`DeepWiki read_wiki_contents failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	},
});

export const ask_question: ToolSpec = free({
	description: "Ask DeepWiki an AI-powered, context-grounded question about one or more GitHub repositories.",
	async execute(args, context) {
		try {
			const question = String(args.question ?? "").trim();
			if (!question) return failed("question is required");
			return await callDeepWiki(
				"ask_question",
				{ repoName: normalizeRepoName(args.repoName), question },
				context.abort,
				context.keep,
			);
		} catch (error) {
			context.abort.throwIfAborted();
			return failed(`DeepWiki ask_question failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	},
});
