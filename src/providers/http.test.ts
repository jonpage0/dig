import { afterEach, describe, test } from "node:test";
import { expect } from "expect";
import { keptJson, keptText, requestJson } from "./http.js";

const originalFetch = globalThis.fetch;
const keep = () => {};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("source-research requestJson", () => {
	test("retries transient statuses and returns request telemetry", async () => {
		let calls = 0;
		globalThis.fetch = Object.assign(async () => {
			calls++;
			if (calls === 1) {
				return new Response(JSON.stringify({ message: "slow down" }), {
					status: 429,
					headers: { "retry-after": "0" },
				});
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "x-request-id": "req-http-test" },
			});
		}, { preconnect: originalFetch.preconnect });

		const result = await requestJson({
			url: "https://example.test/data",
			signal: new AbortController().signal,
			provider: "Test provider",
			keep,
		});

		expect(calls).toBe(2);
		expect(result.status).toBe(200);
		expect(result.attempts).toBe(2);
		expect(result.requestId).toBe("req-http-test");
		expect(result.payload).toEqual({ ok: true });
	});

	test("does not retry ordinary client errors", async () => {
		let calls = 0;
		globalThis.fetch = Object.assign(async () => {
			calls++;
			return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
		}, { preconnect: originalFetch.preconnect });

		const result = await requestJson({
			url: "https://example.test/missing",
			signal: new AbortController().signal,
			provider: "Test provider",
			keep,
		});

		expect(calls).toBe(1);
		expect(result.status).toBe(404);
		expect(result.attempts).toBe(1);
	});

	test("honors caller cancellation before issuing a request", async () => {
		let calls = 0;
		globalThis.fetch = Object.assign(async () => {
			calls++;
			return new Response("{}", { status: 200 });
		}, { preconnect: originalFetch.preconnect });
		const controller = new AbortController();
		controller.abort(new Error("caller cancelled"));

		await expect(
			requestJson({
				url: "https://example.test/cancelled",
				signal: controller.signal,
				provider: "Test provider",
				keep,
			}),
		).rejects.toThrow("caller cancelled");
		expect(calls).toBe(0);
	});

	test("preserves caller cancellation while reading either JSON body path", async () => {
		for (const parseJson of [undefined, JSON.parse]) {
			const controller = new AbortController();
			let calls = 0;
			globalThis.fetch = Object.assign(async () => {
				calls++;
				const response = new Response("{}");
				const abortBody = async () => {
					controller.abort(new Error("caller cancelled body"));
					throw new DOMException("Body read aborted", "AbortError");
				};
				response.json = abortBody;
				response.text = abortBody;
				return response;
			}, { preconnect: originalFetch.preconnect });
			await expect(requestJson({
				url: "https://example.test/cancelled-body",
				signal: controller.signal,
				provider: "Test provider",
				keep,
				parseJson,
			})).rejects.toThrow("caller cancelled body");
			expect(calls).toBe(1);
		}
	});

	test("a body that fails to arrive is kept once as interrupted, with its cost header, and propagates without a repeat request", async () => {
		let calls = 0;
		globalThis.fetch = Object.assign(async () => {
			calls++;
			// A retryable status: the request's own timeout fires mid-body, and the charged request must still not repeat.
			const response = new Response("{}", { status: 503, headers: { "retry-after": "0", "scrape.do-request-cost": "3" } });
			response.text = async () => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			};
			return response;
		}, { preconnect: originalFetch.preconnect });
		const kept: unknown[][] = [];
		await expect(requestJson({
			url: "https://example.test/slow-body",
			signal: new AbortController().signal,
			provider: "Test provider",
			label: "search",
			keep: (...entry) => kept.push(entry),
		})).rejects.toThrow("The operation timed out.");
		expect(calls).toBe(1);
		expect(kept).toEqual([["search", 503, "", { "scrape.do-request-cost": "3" }, true]]);
	});

	test("keeps every attempt's response for the raw file, text when it is not JSON", async () => {
		let calls = 0;
		globalThis.fetch = Object.assign(async () => {
			calls++;
			return calls === 1
				? new Response("upstream busy", { status: 503, headers: { "retry-after": "0" } })
				: new Response(JSON.stringify({ ok: true }), { status: 200 });
		}, { preconnect: originalFetch.preconnect });
		const kept: unknown[][] = [];
		await requestJson({
			url: "https://example.test/data",
			signal: new AbortController().signal,
			provider: "Test provider",
			label: "search",
			keep: (...entry) => kept.push(entry),
		});
		expect(kept).toEqual([
			["search", 503, "upstream busy"],
			["search", 200, { ok: true }],
		]);
	});
});

describe("provider bodies enter Dig redacted", () => {
	/** Runs `check` with `name` set to `value` in the environment, as keys.env would set it. */
	async function withCredential(name: string, value: string, check: () => Promise<void>) {
		const original = process.env[name];
		process.env[name] = value;
		try {
			await check();
		} finally {
			if (original === undefined) delete process.env[name];
			else process.env[name] = original;
		}
	}
	const respond = (body: string) => {
		globalThis.fetch = Object.assign(async () => new Response(body), { preconnect: originalFetch.preconnect });
	};
	const request = () => requestJson({ url: "https://example.test/echo", signal: new AbortController().signal, provider: "Test provider", keep });

	test("requestJson, keptJson and keptText return a known credential's echoes redacted, encoded or JSON-escaped, before any caller can cut them", async () => {
		const key = "Entry/key+PRIVATE value";
		await withCredential("SCRAPE_DO_API_KEY", key, async () => {
			const encoded = encodeURIComponent(key).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
			// A JSON string may escape `/` as `\/`, which only parsing turns back into the credential.
			const body = `{"echo":"${encoded}","escaped":"Entry\\/key+PRIVATE value"}`;
			respond(body);
			expect((await request()).payload).toEqual({ echo: "[redacted]", escaped: "[redacted]" });
			expect(await keptJson(new Response(body), keep, "echo")).toEqual({ echo: "[redacted]", escaped: "[redacted]" });
			expect(await keptText(new Response(`not json: ${encoded}`), keep, "echo")).toBe("not json: [redacted]");
		});
	});

	test("keptText returns JSON text with a JSON-escaped, mixed-spelling echo redacted, still valid JSON", async () => {
		await withCredential("SCRAPE_DO_API_KEY", "Review/key+PRIVATE sample", async () => {
			const kept: unknown[][] = [];
			const text = await keptText(new Response('{"error":{"message":"Review\\/key%2bPRIVATE+sample"}}'), (...entry) => kept.push(entry), "echo");
			expect(text).not.toContain("PRIVATE");
			expect(JSON.parse(text)).toEqual({ error: { message: "[redacted]" } });
			expect(kept).toEqual([["echo", 200, { error: { message: "[redacted]" } }]]);
		});
	});

	test("JSON is decoded before it is redacted, so redaction never breaks valid JSON or its billing evidence, and unchanged text stays byte-for-byte", async () => {
		// A credential that is also the tail of a JSON escape (`\u0061lpha` decodes to "alpha").
		await withCredential("DATAFORSEO_PASSWORD", "u0061lpha", async () => {
			const wire = '{"ordinary":"\\u0061lpha","cost":0.125}';
			respond(wire);
			expect((await request()).payload).toEqual({ ordinary: "alpha", cost: 0.125 });
			expect(await keptJson(new Response(wire), keep, "escape")).toEqual({ ordinary: "alpha", cost: 0.125 });
			expect(await keptText(new Response(wire), keep, "escape")).toBe(wire);
		});
		// A credential equal to a JSON number token.
		await withCredential("SCRAPE_DO_API_KEY", "12345678", async () => {
			const wire = '{"id":12345678,"meta":{"cost_usd":0.001}}';
			respond(wire);
			expect((await request()).payload).toEqual({ id: 12345678, meta: { cost_usd: 0.001 } });
			expect(await keptJson(new Response(wire), keep, "number")).toEqual({ id: 12345678, meta: { cost_usd: 0.001 } });
		});
	});
});
