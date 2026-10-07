import { afterEach, describe, test } from "node:test";
import { expect } from "expect";
import { requestJson } from "./http.js";

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
