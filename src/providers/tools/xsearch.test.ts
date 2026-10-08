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

test("a write-up that cites posts by number is flagged; links, references, code and years are not", async () => {
	const reply = (text: string) => (async () => Response.json({ id: "r", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { total_tokens: 1, cost_in_usd_ticks: 1 } })) as typeof fetch;
	globalThis.fetch = reply("According to [post:50]: the skills work. Oren posts the result [120] and [118], as do [3, 5].");
	const numbered = await executeSource(search, { query: "numbered" }, context);
	expect(numbered.status).toBe("success");
	expect(numbered.text).toContain("this write-up has 4 bracketed markers that look like citations by number (such as [post:50]) but no link for them");
	globalThis.fetch = reply(
		"Alex shows the skills [1](https://x.com/The_Alex/status/1). Ethan edits raw footage [[3]](https://x.com/Ethan_Ng_13/status/3 \"post\"). " +
			"Oren posts the result [2] and [4][oren]; the fix is `items[0]`, shipped in [2026].\n\n[2]: https://x.com/orenmeetsworld/status/2\n[oren]: https://x.com/orenmeetsworld/status/4",
	);
	const linked = await executeSource(search, { query: "linked" }, context);
	expect(linked.text).not.toContain("Citations by number");
});
