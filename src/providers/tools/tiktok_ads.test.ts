import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import type { SourceToolResult, ToolContext } from "../types.js";
import { detail, library, search, top } from "./tiktok_ads.js";

type FetchCall = { url: URL; body: unknown };

const context: ToolContext = {
	sessionID: "tiktok-ads-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

function text(result: SourceToolResult): string {
	return typeof result === "string" ? result : result.text;
}

function details(result: SourceToolResult): Record<string, unknown> {
	return typeof result === "string" ? {} : (result.details ?? {});
}

// Shapes below follow live responses captured 2026-09-10, not TikHub's doc
// examples (which describe a different payload for search_ads).
const creativeAd = {
	ad_title: "Spring Break? Color Factory Has You Covered - Book Now!",
	brand_name: "",
	cost: 2,
	ctr: 0.21,
	id: "7560480306832457735",
	industry_key: "label_17105000000",
	like: 4624,
	objective_key: "campaign_objective_conversion",
	video_info: { duration: 7.04, cover: "https://cdn.example/cover.jpg", video_url: {} },
};

function tikhub(data: unknown) {
	return { code: 200, data: { code: 0, msg: "OK", data } };
}

function installFetchMock(routes: Record<string, unknown | ((call: FetchCall) => unknown)>) {
	const calls: FetchCall[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof URL ? input : new URL(String(input));
		const call = { url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
		calls.push(call);
		const route = routes[url.pathname];
		if (route === undefined) return new Response("not found", { status: 404 });
		const payload = typeof route === "function" ? (route as (call: FetchCall) => unknown)(call) : route;
		return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

describe("tiktok ads tools", () => {
	const env = { tikhub: process.env.TIKHUB_API_KEY, sc: process.env.SCRAPECREATORS_API_KEY };
	let restore: (() => void) | undefined;

	beforeEach(() => {
		process.env.TIKHUB_API_KEY = "tikhub-test-key";
		process.env.SCRAPECREATORS_API_KEY = "sc-test-key";
	});

	afterEach(() => {
		restore?.();
		restore = undefined;
		if (env.tikhub === undefined) delete process.env.TIKHUB_API_KEY;
		else process.env.TIKHUB_API_KEY = env.tikhub;
		if (env.sc === undefined) delete process.env.SCRAPECREATORS_API_KEY;
		else process.env.SCRAPECREATORS_API_KEY = env.sc;
	});

	test("search resolves industry names to ids, maps enum filters to codes, and names the industry in output", async () => {
		const mock = installFetchMock({
			"/api/v1/tiktok/ads/search_ads": tikhub({ materials: [creativeAd], pagination: { page: 1, size: 20, total_count: 36, has_more: true } }),
		});
		restore = mock.restore;

		const result = await search.execute(
			{ keyword: "spring break", industry: "Travel, 23110000000", objective: "conversion", performance: "top_20", ad_format: "spark" },
			context,
		);

		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]!.body).toEqual({
			period: 180, page: 1, limit: 20, order_by: "for_you", country_code: "US",
			keyword: "spring break", industry: "17000000000,23110000000", objective: 3, like: 1, ad_format: 1,
		});
		const out = text(result);
		expect(out).toContain("Industry: Travel > Tours & Attractions");
		expect(out).toContain("Objective: conversion");
		expect(out).toContain("CTR: 21%");
		expect(out).toContain("Showing 1 of 36 ads; more pages available");
		expect(details(result)).toMatchObject({ provider: "tikhub", ads: 1, total: 36, hasMore: true, ad_ids: ["7560480306832457735"] });
	});

	test("search rejects an unknown industry name before spending a request", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;
		const result = await search.execute({ industry: "Spring Break Parties" }, context);
		expect((text(result)).startsWith('ERROR: Unknown TikTok ad industry "Spring Break Parties"')).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});

	test("search surfaces a Creative Center error code instead of an empty result", async () => {
		const mock = installFetchMock({ "/api/v1/tiktok/ads/search_ads": { code: 200, data: { code: 40001, msg: "invalid period" } } });
		restore = mock.restore;
		expect(text(await search.execute({ keyword: "x" }, context))).toBe("ERROR: TikTok Creative Center returned code 40001: invalid period");
	});

	test("detail merges percentile and retention, and asks for similar ads with the top-level industry", async () => {
		const mock = installFetchMock({
			"/api/v1/tiktok/ads/get_ads_detail": tikhub({
				...creativeAd,
				comment: 150, share: 128, country_code: ["US"], landing_page: "https://www.colorfactory.co/",
				objectives: [{ label: "campaign_objective_conversion", value: 3 }, { label: "campaign_objective_traffic", value: 1 }],
				source: "TikTok Ads Manager", voice_over: false, pattern_label: [],
			}),
			"/api/v1/tiktok/ads/get_ad_percentile": tikhub({ ctr_percentile: 0.99 }),
			"/api/v1/tiktok/ads/get_ad_keyframe_analysis": tikhub({
				analysis: [{ second: 0, value: 0.069 }, { second: 1, value: 1 }, { second: 2, value: 0.42 }, { second: 3, value: 0.26 }],
				duration: 4, highlight: [1],
			}),
			"/api/v1/tiktok/ads/get_recommended_ads": tikhub({ materials: [{ ...creativeAd, id: "7000000000000000001", ad_title: "Rooftop pool getaway" }] }),
		});
		restore = mock.restore;

		const result = await detail.execute({ ad_id: "7560480306832457735", similar: true }, context);
		const out = text(result);
		expect(out).toContain("CTR percentile within industry (180d): 99%");
		expect(out).toContain("Largest drop: 58% at second 2");
		expect(out).toContain("TikTok-flagged key frames: second 1");
		expect(out).toContain("All objectives: conversion, traffic");
		expect(out).toContain("Similar ads (TikTok recommended, 1):");
		expect(out).toContain("Rooftop pool getaway");

		const similarCall = mock.calls.find((call) => call.url.pathname.endsWith("get_recommended_ads"));
		expect(similarCall?.body).toEqual({ material_id: "7560480306832457735", country_code: "US", industry: "17000000000" });
		expect(details(result)).toMatchObject({ ctr_percentile: 0.99, similar: ["7000000000000000001"], requests: 4 });
	});

	test("detail reports a failed analytics call as a note, not as a failed tool", async () => {
		const mock = installFetchMock({
			"/api/v1/tiktok/ads/get_ads_detail": tikhub({ ...creativeAd, country_code: ["US"] }),
			"/api/v1/tiktok/ads/get_ad_percentile": tikhub({ ctr_percentile: 0.5 }),
			// keyframe route missing → 404 → tikhubPost error
		});
		restore = mock.restore;
		const result = await detail.execute({ ad_id: "7560480306832457735" }, context);
		const out = text(result);
		expect((out).startsWith("ERROR:")).toBe(false);
		expect(out).toContain("CTR percentile within industry (180d): 50%");
		expect(out).toContain("Retention curve: unavailable");
		expect(out).toContain("Note: Retention curve unavailable:");
	});

	test("top explains an empty industry spotlight and points at search", async () => {
		const mock = installFetchMock({ "/api/v1/tiktok/ads/get_top_ads_spotlight": tikhub({ materials: [], pagination: { page: 1, size: 20, total: 0, has_more: false } }) });
		restore = mock.restore;
		const out = text(await top.execute({ industry: "Travel" }, context));
		expect(mock.calls[0]!.body).toEqual({ page: 1, limit: 20, industry: "17000000000" });
		expect(out).toContain("(Travel; page 1)");
		expect(out).toContain("omit industry for the cross-industry list");
	});

	test("library says plainly when no advertiser entity matched and results are a name-search fallback", async () => {
		const mock = installFetchMock({
			"/v1/tiktok/ad-library/search": {
				success: true, credits_charged: 1, source: "tiktok_public_ads_library",
				advertiser_name: "Example Spring Tours", resolved_advertiser_name: "Example Spring Tours", advertiser_matches: [],
				ads: [{ id: "1000000000000001", name: "example.creator", first_shown_date: 1786924800000, last_shown_date: 1786924800000, videos: [{ video_url: "v", cover_img: "c" }], estimated_audience: "1K-10K", spent: "", impression: 0, image_urls: [] }],
				total: 5000, has_more: true, cursor: "abc",
			},
		});
		restore = mock.restore;
		const result = await library.execute({ advertiser_name: "Example Spring Tours" }, context);
		expect(mock.calls[0]!.url.searchParams.get("advertiser_name")).toBe("Example Spring Tours");
		const out = text(result);
		expect(out).toContain('No advertiser entity matched "Example Spring Tours"');
		expect(out).toContain("example.creator — ad 1000000000000001");
		expect(out).toContain("Shown: 2026-08-17 | Audience: 1K-10K | Media: 1 video, 0 images");
		expect(out).not.toContain("Impressions:");
		expect(details(result)).toMatchObject({ entityMatched: false, hasMore: true, cursor: "abc", credits_charged: 1 });
	});

	test("library requires exactly one of advertiser_name or query", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;
		expect(text(await library.execute({}, context))).toBe("ERROR: Provide advertiser_name or query.");
		expect(text(await library.execute({ advertiser_name: "a", query: "b" }, context))).toBe("ERROR: Provide either advertiser_name or query, not both.");
		expect(mock.calls).toHaveLength(0);
	});

	test("library pins an advertiser by exact business ID and retains returned identity evidence", async () => {
		const id = "7078923208527618049";
		const mock = installFetchMock({
			"/v1/tiktok/ad-library/search": {
				success: true,
				advertiser_matches: [],
				ads: [{ id: "1871655924410641", name: "GYMSHARK LTD", adv_biz_ids: id }],
				has_more: false,
			},
		});
		restore = mock.restore;
		const result = await library.execute({ advertiser_name: "Gymshark", adv_biz_ids: id }, context);
		expect(mock.calls[0]?.url.searchParams.get("adv_biz_ids")).toBe(id);
		expect(mock.calls[0]?.url.searchParams.get("advertiser_name")).toBe("Gymshark");
		expect(text(result)).toContain(`Advertiser business IDs: ${id}`);
		expect(text(result)).not.toContain("fell back to a name search");
		expect(details(result)).toMatchObject({ requested_adv_biz_ids: id, advertiser_ids: [id], entityMatched: false });
		expect((text(await library.execute({ query: "Gymshark", adv_biz_ids: id }, context))).startsWith("ERROR:")).toBe(true);
		expect(mock.calls).toHaveLength(1);
	});

	test("an unreadable ads payload is unavailable rather than evidence of no matching ads", async () => {
		const mock = installFetchMock({
			"/v1/tiktok/ad-library/search": { success: true, unexpected: [] },
			"/api/v1/tiktok/ads/search_ads": tikhub({ unexpected: [] }),
		});
		restore = mock.restore;
		expect((text(await library.execute({ query: "x" }, context))).startsWith("ERROR:")).toBe(true);
		expect((text(await search.execute({ keyword: "x" }, context))).startsWith("ERROR:")).toBe(true);
	});

	test("provider errors redact both credentials before returning diagnostics", async () => {
		const mock = installFetchMock({
			"/v1/tiktok/ad-library/search": { success: false, error: "Rejected sc-test-key" },
			"/api/v1/tiktok/ads/search_ads": { code: 403, message: "Rejected tikhub-test-key" },
		});
		restore = mock.restore;
		const adLibrary = text(await library.execute({ query: "x" }, context));
		const creative = text(await search.execute({ keyword: "x" }, context));
		expect((adLibrary).startsWith("ERROR:")).toBe(true);
		expect((creative).startsWith("ERROR:")).toBe(true);
		expect(adLibrary).toContain("[redacted]");
		expect(creative).toContain("[redacted]");
		expect(adLibrary).not.toContain("sc-test-key");
		expect(creative).not.toContain("tikhub-test-key");
	});

	test("missing keys fail closed per provider", async () => {
		delete process.env.TIKHUB_API_KEY;
		delete process.env.SCRAPECREATORS_API_KEY;
		expect((text(await search.execute({ keyword: "x" }, context))).startsWith("ERROR: TIKHUB_API_KEY not set")).toBe(true);
		expect((text(await library.execute({ query: "x" }, context))).startsWith("ERROR: SCRAPECREATORS_API_KEY not set")).toBe(true);
	});
});
