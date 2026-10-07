import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { ToolContext } from "../types.js";
import { search } from "./xsearch.js";

const originalFetch = globalThis.fetch;
const saved = { XAI_API_KEY: process.env.XAI_API_KEY, DIG_STATE_DIR: process.env.DIG_STATE_DIR };
let root: string;

beforeEach(() => {
	// Default [x] settings come from an isolated, empty native state directory.
	root = mkdtempSync(join(tmpdir(), "dig-xsearch-test-"));
	process.env.DIG_STATE_DIR = root;
	process.env.XAI_API_KEY = "xai-test-key";
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const context: ToolContext = {
	sessionID: "xsearch-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

test("a transport failure after a charged storage-limit response leaves the total unknown and keeps the reported USD subtotal", async () => {
	let calls = 0;
	globalThis.fetch = (async () => {
		if (++calls === 1) {
			return Response.json(
				{ error: { message: "Response is too large to store" }, usage: { total_tokens: 12, cost_in_usd_ticks: 123400000 } },
				{ status: 400 },
			);
		}
		throw new TypeError("fetch failed");
	}) as typeof fetch;

	const result = await executeSource(search, { query: "storage limit" }, context);
	expect(calls).toBe(2);
	expect(result.status).toBe("failed");
	expect(result.details?.cost).toBeNull();
	expect(result.details?.knownCost).toEqual([{ amount: 0.01234, unit: "USD" }]);
});

test("the default model receives the requested depth as reasoning effort", async () => {
	const bodies: Array<{ model: string; reasoning?: { effort: string } }> = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return Response.json({ error: { message: "stop after the request" } });
	}) as typeof fetch;
	await executeSource(search, { query: "depth" }, context);
	await executeSource(search, { query: "depth", depth: "max" }, context);
	expect(bodies.map((body) => [body.model, body.reasoning?.effort])).toEqual([["grok-4.7", "medium"], ["grok-4.7", "high"]]);
});
