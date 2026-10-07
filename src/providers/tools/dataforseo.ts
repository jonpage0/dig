import { keptText } from "../http.js";
import { failed, free, metered, outcome, type ToolOutcome } from "../outcome.js";
import { knownSecrets, redactValue, registerSecret } from "../secrets.js";
import type { ToolContext, ToolSpec } from "../types.js";

/**
 * DataForSEO's v3 REST API, called directly with the user's API login and API
 * password (HTTP Basic). Documentation comes from DataForSEO's public docs
 * site: `llms.txt` is the endpoint index and every page has a Markdown twin.
 */
const DOCS_HOST = "docs.dataforseo.com";
const DOCS_ROOT = `https://${DOCS_HOST}/v3`;
const DOCS_INDEX = `${DOCS_ROOT}/llms.txt`;
const API_HOSTS = {
	live: "https://api.dataforseo.com/v3/",
	sandbox: "https://sandbox.dataforseo.com/v3/",
} as const;
/** Envelope codes for a request DataForSEO accepted: 20000 Ok, 20100 Task Created. */
const ACCEPTED = new Set([20000, 20100]);
/**
 * Task codes that are not errors (DataForSEO's Appendix of status codes): 20100 Task Created and
 * 40601/40602 Task Handed/In Queue mean results are not ready yet; 40102 No Search Results is a
 * completed empty search; 40106 is a completed task with partial results.
 */
const NOT_READY = new Set([20100, 40601, 40602]);
const NO_RESULTS = 40102;
const PARTIAL_RESULTS = 40106;
const OUTPUT_LIMIT = 60_000;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

interface DocEntry {
	section: string;
	trail: string[];
	title: string;
	path: string;
	url: string;
	summary: string;
}

interface DfsTask {
	id?: string;
	status_code?: number;
	status_message?: string;
	cost?: number;
	result_count?: number;
	path?: string[];
	data?: unknown;
	result?: unknown[] | null;
}

interface DfsEnvelope {
	status_code?: number;
	status_message?: string;
	time?: string;
	cost?: number;
	tasks_count?: number;
	tasks_error?: number;
	tasks?: DfsTask[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Accepts a bare path, `/v3/...`, or a full docs/API URL; returns the path after `/v3/`, or "" for the docs home. */
function v3Path(value: unknown): string {
	let path = String(value ?? "").trim();
	path = path.replace(/^https:\/\/(?:docs|api|sandbox)\.dataforseo\.com/i, "");
	path = path.replace(/[?#].*$/, "").replace(/^\/+/, "").replace(/^v3(?:\.md)?(?:\/|$)/, "");
	path = path.replace(/\/+$/, "").replace(/\.md$/, "");
	if (path && !path.split("/").every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== ".."))
		throw new Error(`"${String(value)}" is not a DataForSEO v3 path`);
	return path;
}

const docsUrl = (path: string) => (path ? `${DOCS_ROOT}/${path}.md` : `${DOCS_ROOT}.md`);

const plain = (text: string) =>
	text
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();

/** The index is `##`–`######` headings over `- [Title](url) — summary` entries. */
export function parseDocsIndex(text: string): DocEntry[] {
	const trail: string[] = [];
	const entries: DocEntry[] = [];
	for (const line of text.split(/\r?\n/)) {
		const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const depth = heading[1].length - 2;
			trail.length = depth;
			trail[depth] = heading[2];
			continue;
		}
		const entry = /^- \[(.+?)\]\((https:\/\/docs\.dataforseo\.com\/v3[^)\s]*)\)(?:\s+—\s+(.*))?$/.exec(line);
		if (!entry) continue;
		let path: string;
		try { path = v3Path(entry[2]); } catch { continue; }
		const summary = plain(entry[3] ?? "");
		entries.push({
			section: trail[0] ?? "General",
			trail: trail.filter(Boolean),
			title: entry[1],
			path,
			url: docsUrl(path),
			summary: summary.length > 200 ? `${summary.slice(0, 199)}…` : summary,
		});
	}
	return entries;
}

/**
 * The docs site redirects each page to its trailing-slash form. Redirects are followed by hand, at most three,
 * and only within docs.dataforseo.com, so a redirect can never fetch or attribute another host's content.
 */
async function fetchDocs(url: string, label: string, context: ToolContext): Promise<{ status: number; text: string }> {
	let target = new URL(url);
	for (let hop = 0; ; hop++) {
		context.abort.throwIfAborted();
		const response = await fetch(target, {
			headers: { accept: "text/markdown, text/plain;q=0.9" },
			redirect: "manual",
			signal: AbortSignal.any([context.abort, AbortSignal.timeout(60_000)]),
		});
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel();
			const next = new URL(location, target);
			if (next.protocol !== "https:" || next.host !== DOCS_HOST) throw new Error(`the docs site redirected to another host (${next.host})`);
			if (hop >= 2) throw new Error("the docs site redirected more than three times");
			target = next;
			continue;
		}
		const text = await keptText(response, context.keep, label);
		context.abort.throwIfAborted();
		return { status: response.status, text };
	}
}

async function docsIndex(context: ToolContext): Promise<DocEntry[]> {
	const { status, text } = await fetchDocs(DOCS_INDEX, "docs index", context);
	if (status < 200 || status >= 300) throw new Error(`the documentation index returned HTTP ${status}`);
	const entries = parseDocsIndex(text);
	if (!entries.length) throw new Error("the documentation index had no endpoint entries");
	return entries;
}

function bounded(value: unknown, fallback: number, max: number): number {
	const number = Number(value ?? fallback);
	return Number.isInteger(number) && number >= 0 ? Math.min(number, max) : fallback;
}

// The documentation site is public and never charges.
export const docs_sections: ToolSpec = free({
	description: "List DataForSEO v3 documentation sections (SERP, Labs, Keywords Data, Backlinks, Business Data, …) with their subsections and page counts.",
	async execute(_args, context) {
		try {
			const sections = new Map<string, { pages: number; parts: Set<string> }>();
			for (const entry of await docsIndex(context)) {
				const section = sections.get(entry.section) ?? { pages: 0, parts: new Set<string>() };
				section.pages += 1;
				if (entry.trail[1]) section.parts.add(entry.trail[1]);
				sections.set(entry.section, section);
			}
			const lines = [...sections].map(([name, { pages, parts }]) =>
				`- ${name} (${pages} pages)${parts.size ? `: ${[...parts].join(", ")}` : ""}`,
			);
			return outcome("success", `DataForSEO documentation sections:\n${lines.join("\n")}\n\nList a section's pages with dataforseo_docs_index.`);
		} catch (error) {
			context.abort.throwIfAborted();
			return failed(`DataForSEO documentation index failed: ${message(error)}`);
		}
	},
});

export const docs_index: ToolSpec = free({
	description: "Find DataForSEO v3 documentation pages by section and words; returns each page's path for dataforseo_docs_read.",
	async execute(args, context) {
		try {
			const section = String(args.section ?? "").trim().toLowerCase();
			const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
			const offset = bounded(args.offset, 0, Number.MAX_SAFE_INTEGER);
			const limit = Math.max(1, bounded(args.limit, 50, 200));
			const matches = (await docsIndex(context)).filter((entry) => {
				if (section && !entry.section.toLowerCase().includes(section)) return false;
				const haystack = `${entry.title}\n${entry.path}\n${entry.trail.join(" ")}\n${entry.summary}`.toLowerCase();
				return words.every((word) => haystack.includes(word));
			});
			if (!matches.length)
				return outcome("empty", `No DataForSEO documentation pages matched${section ? ` section "${args.section}"` : ""}${words.length ? ` and "${args.query}"` : ""}. List sections with dataforseo_docs_sections.`);
			const page = matches.slice(offset, offset + limit);
			const next = offset + limit < matches.length ? offset + limit : null;
			const lines = page.map((entry) =>
				`- ${entry.title} — ${entry.path || entry.url} — ${entry.trail.join(" › ")}${entry.summary ? ` — ${entry.summary}` : ""}`,
			);
			const range = page.length ? `${offset + 1}–${offset + page.length}` : "none";
			return outcome(
				page.length ? "success" : "empty",
				`DataForSEO documentation pages ${range} of ${matches.length}${next === null ? "" : `; continue at offset ${next}`}:\n${lines.join("\n")}\n\nRead a page with dataforseo_docs_read before calling its endpoint.`,
				{ total: matches.length, nextOffset: next },
			);
		} catch (error) {
			context.abort.throwIfAborted();
			return failed(`DataForSEO documentation index failed: ${message(error)}`);
		}
	},
});

export const docs_read: ToolSpec = free({
	description: "Read one DataForSEO v3 documentation page (method, parameters, limits, response fields) by path or docs URL, in pages of characters.",
	async execute(args, context) {
		try {
			const path = v3Path(args.path);
			const offset = bounded(args.offset, 0, Number.MAX_SAFE_INTEGER);
			const limit = Math.max(1, bounded(args.limit, 40_000, 100_000));
			const { status, text } = await fetchDocs(docsUrl(path), `docs ${path || "home"}`, context);
			if (status === 404)
				return failed(`No DataForSEO documentation page at "${path}". Find the exact path with dataforseo_docs_index.`);
			if (status < 200 || status >= 300) return failed(`DataForSEO documentation returned HTTP ${status} for "${path}"`);
			const slice = text.slice(offset, offset + limit);
			const end = offset + slice.length;
			const next = end < text.length ? end : null;
			return outcome(
				"success",
				`${docsUrl(path)} · characters ${offset}–${end} of ${text.length}${next === null ? ", complete" : `; continue at offset ${next}`}\n\n${slice}`,
				{ path, totalCharacters: text.length, nextOffset: next },
			);
		} catch (error) {
			context.abort.throwIfAborted();
			return failed(`DataForSEO documentation read failed: ${message(error)}`);
		}
	},
});

/** Drops null, empty strings, empty arrays and empty objects, so results read like DataForSEO's trimmed responses. */
export function compact(value: unknown): unknown {
	if (Array.isArray(value)) {
		const items = value.map(compact).filter((item) => item !== undefined);
		return items.length ? items : undefined;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value).map(([key, item]) => [key, compact(item)] as const).filter(([, item]) => item !== undefined);
		return entries.length ? Object.fromEntries(entries) : undefined;
	}
	return value === null || value === "" ? undefined : value;
}

const usd = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? `$${value}` : "not reported");

type TaskClass = "results" | "none" | "partial" | "notReady" | "error";
function classify(task: DfsTask): TaskClass {
	const code = Number(task.status_code);
	if (NOT_READY.has(code)) return "notReady";
	if (code === NO_RESULTS) return "none";
	if (code === PARTIAL_RESULTS) return "partial";
	if (code !== 20000) return "error";
	return Array.isArray(task.result) && task.result.length > 0 ? "results" : "none";
}

function describe(payload: unknown, httpStatus: number, call: { method: string; path: string; sandbox: boolean }): ToolOutcome {
	const where = call.sandbox ? "sandbox: free dummy data, not evidence" : "live API";
	const head = `DataForSEO ${call.method} ${call.path} (${where})`;
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return failed(`${head}: HTTP ${httpStatus} without a DataForSEO response envelope.`);
	// Redact before any serialization or truncation, so an escaped or cut credential can never survive.
	const body = redactValue(payload, knownSecrets()) as DfsEnvelope;
	const tasks = Array.isArray(body.tasks) ? body.tasks : [];
	const lines = [
		head,
		`Status ${body.status_code ?? "missing"} ${body.status_message ?? ""}`.trim() +
			` · returned cost ${usd(body.cost)} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}, ${body.tasks_error ?? 0} with errors · ${body.time ?? "time not reported"}`,
		...tasks.map((task) =>
			`Task ${task.id ?? "(no id)"}: ${task.status_code ?? "missing"} ${task.status_message ?? ""} · cost ${usd(task.cost)} · result_count ${task.result_count ?? 0}`,
		),
	];
	const details = {
		endpoint: call.path,
		method: call.method,
		sandbox: call.sandbox,
		statusCode: body.status_code ?? null,
		tasks: tasks.map((task) => ({
			id: task.id ?? null,
			statusCode: task.status_code ?? null,
			statusMessage: task.status_message ?? null,
			reportedCostUsd: typeof task.cost === "number" ? task.cost : null,
			resultCount: task.result_count ?? 0,
		})),
	};
	if (!ACCEPTED.has(Number(body.status_code)))
		return outcome("failed", `${lines.join("\n")}\nThe request failed; look up the status code in the documentation's Appendix (errors).`, details);
	const classes = tasks.map(classify);
	const status = classes.length && classes.every((c) => c === "error")
		? "failed"
		: classes.some((c) => c === "error" || c === "partial")
			? "partial"
			: classes.some((c) => c === "results" || c === "notReady")
				? "success"
				: "empty";
	const notes = [
		classes.includes("notReady") ? "A task without results yet (20100, 40601, 40602) is retrieved later with its documented task_get path and id." : null,
		classes.includes("partial") ? "40106: DataForSEO returned partial results and did not charge for pages it could not retrieve." : null,
		classes.includes("error") ? "Look up other task codes in the documentation's Appendix (errors)." : null,
	].filter(Boolean);
	const results = JSON.stringify(compact(tasks.map((task) => ({ id: task.id, status_code: task.status_code, data: task.data, result: task.result })))) ?? "[]";
	const truncated = results.length > OUTPUT_LIMIT;
	const shown = truncated
		? `${results.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${results.length} characters. The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file.]`
		: results;
	return outcome(status, `${[...lines, ...notes].join("\n")}\n\nTasks (data echoes the request; null and empty fields omitted):\n${shown}`, { ...details, truncated });
}

/**
 * One request, never retried and never redirected: a 3xx response is kept and reported, so the call cannot
 * reach another host and every attempted request leaves its response (or transport error) for billing.
 */
async function sendOnce(url: string, init: RequestInit, label: string, context: ToolContext): Promise<{ status: number; payload: unknown; location: string | null }> {
	context.abort.throwIfAborted();
	let response: Response;
	try {
		response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.any([context.abort, AbortSignal.timeout(180_000)]) });
	} catch (error) {
		context.keep(label, "error", message(error));
		throw error;
	}
	const text = await keptText(response, context.keep, label);
	context.abort.throwIfAborted();
	let payload: unknown = null;
	try { payload = JSON.parse(text); } catch {}
	return { status: response.status, payload, location: response.headers.get("location") };
}

/** DataForSEO reports each request's charge in USD as the envelope's top-level `cost`. */
export const request: ToolSpec = metered(
	{
		description: "Call any DataForSEO v3 endpoint with the documented method and task array. Paid per request: the returned USD cost is recorded. sandbox: true returns free dummy data for checking a request shape.",
		async execute(args, context) {
			let path: string;
			try { path = v3Path(args.path); } catch (error) { return failed(message(error)); }
			if (!path) return failed("path is required: the endpoint path after /v3/, as documented");
			if (/\.ai$/.test(path))
				return failed("Request the full response without the .ai suffix: only the full response reports the call's cost, and Dig trims the output itself.");
			const tasks = args.tasks;
			const method: "GET" | "POST" = args.method ?? (tasks === undefined ? "GET" : "POST");
			if (method === "POST" && (!Array.isArray(tasks) || !tasks.length))
				return failed("POST needs tasks: the documented array of task objects");
			if (method === "GET" && tasks !== undefined) return failed("GET takes no tasks; its parameters are part of the documented path");
			const login = process.env.DATAFORSEO_USERNAME?.trim();
			const password = process.env.DATAFORSEO_PASSWORD?.trim();
			if (!login || !password)
				return failed("DATAFORSEO_USERNAME and DATAFORSEO_PASSWORD must both be set (DataForSEO's API login and API password). The user adds them outside the chat in Dig's keys.env (Dig Settings → Edit keys.env); Dig reloads that file when it is saved.");
			const basic = Buffer.from(`${login}:${password}`).toString("base64");
			// The encoded pair is as sensitive as the password; redact it everywhere if a response ever echoes it.
			registerSecret(basic);
			const sandbox = args.sandbox === true;
			try {
				const response = await sendOnce(
					`${sandbox ? API_HOSTS.sandbox : API_HOSTS.live}${path}`,
					{
						method,
						headers: { authorization: `Basic ${basic}`, "content-type": "application/json" },
						body: method === "POST" ? JSON.stringify(tasks) : undefined,
					},
					`${method} ${path}`,
					context,
				);
				if (response.status >= 300 && response.status < 400)
					return failed(`DataForSEO answered HTTP ${response.status}${response.location ? ` with a redirect to ${response.location}` : ""}. Dig does not follow redirects for API requests; check the documented path.`);
				return describe(response.payload, response.status, { method, path, sandbox });
			} catch (error) {
				context.abort.throwIfAborted();
				return failed(`DataForSEO request failed: ${message(error)}`);
			}
		},
	},
	"USD",
	(body) => {
		const cost = (body as DfsEnvelope | null)?.cost;
		return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
	},
);
