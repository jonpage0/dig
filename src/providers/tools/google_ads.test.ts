// The fixtures are ScrapeCreators' documented response examples for /v1/google/adLibrary/advertisers/search,
// /v1/google/company/ads and /v1/google/ad (read 2026-11-10), trimmed; they have not been checked against a live response.
import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { SourceToolResult, ToolContext } from "../types.js";
import { library } from "./google_ads.js";

type FetchCall = { url: URL; headers: Record<string, string> };
type Reply = { status: number; body: unknown };
type Route = unknown | ((call: FetchCall) => unknown);

const KEY = "sc-test-key-0231";
const ADVERTISERS_PATH = "/v1/google/adLibrary/advertisers/search";
const ADS_PATH = "/v1/google/company/ads";
const AD_PATH = "/v1/google/ad";

const context: ToolContext = {
	sessionID: "google-ads-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

const text = (result: SourceToolResult): string => (typeof result === "string" ? result : result.text);
const details = (result: SourceToolResult): Record<string, unknown> => (typeof result === "string" ? {} : (result.details ?? {}));
const isReply = (value: unknown): value is Reply => typeof value === "object" && value !== null && "status" in value && "body" in value;

function installFetchMock(routes: Record<string, Route>) {
	const calls: FetchCall[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof URL ? input : new URL(String(input));
		const call = { url, headers: { ...(init?.headers as Record<string, string>) } };
		calls.push(call);
		const route = routes[url.pathname];
		if (route === undefined) return new Response(JSON.stringify({ success: false, error: "no route" }), { status: 404 });
		const resolved = typeof route === "function" ? (route as (call: FetchCall) => unknown)(call) : route;
		const reply = isReply(resolved) ? resolved : { status: 200, body: resolved };
		return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

const advertiserPage = {
	success: true,
	credits_remaining: 49998226090,
	credits_charged: 1,
	advertisers: [
		{ name: "lululemon HK Limited", advertiser_id: "AR01382517811867287553", region: "HK", number_of_ads_estimate: 5 },
		{ name: "lululemon athletica canada inc.", advertiser_id: "AR01614014350098432001", region: "CA", number_of_ads_estimate: 7000 },
	],
	websites: [{ domain: "lululemon.de" }, { domain: "lululemon.com" }],
};

const listedAd = (creativeId: string, format: string, imageUrl: string | null, firstShown: string) => ({
	advertiserId: "AR01614014350098432001",
	creativeId,
	format,
	adUrl: `https://adstransparency.google.com/advertiser/AR01614014350098432001/creative/${creativeId}`,
	advertiserName: "lululemon athletica canada inc.",
	imageUrl,
	firstShown,
	lastShown: "2026-05-04T17:59:12.000Z",
});
const adsPage = {
	success: true,
	credits_remaining: 49998226428,
	credits_charged: 1,
	ads: [
		listedAd("CR08567627846124568577", "image", null, "2026-03-11T17:08:22.000Z"),
		listedAd("CR02637147045441306625", "text", "https://tpc.googlesyndication.com/archive/simgad/7468813441689462696", "2024-11-01T01:34:54.000Z"),
	],
	cursor: "CgoAP7zmu%2FzKj6ijEhBBAgiPtk1y16J9lpkAAAAAGgn8%2BHbW%2BJylE6g%3D",
	number_of_ads_estimate: 20000,
};

const AD_URL = "https://adstransparency.google.com/advertiser/AR07541154843046445057/creative/CR17778900238552006657";
const adDetail = {
	success: true,
	credits_remaining: 1000000,
	credits_charged: 1,
	advertiserId: "AR07541154843046445057",
	creativeId: "CR17778900238552006657",
	firstShown: "2026-06-05T21:52:15.000Z",
	url: AD_URL,
	lastShown: "2026-06-24T19:04:54.000Z",
	format: "image",
	overallImpressions: { min: "500000", max: "600000" },
	spend: { currency: "USD", lower: "5000", upper: "6000" },
	targeting: {
		age: { included: ["25-34", "35-44"], excluded: ["18-24"] },
		gender: { included: ["female", "male", "unknown"], excluded: [] },
		location: {
			included: [{ criterionId: "2840", name: "United States", fullName: "United States", countryCodes: ["US"] }],
			excluded: [{ criterionId: "2578", name: "Norway", fullName: "Norway", countryCodes: ["NO"] }],
		},
	},
	creativeRegions: [{ regionCode: "US", regionName: "United States" }],
	regionStats: [{ regionCode: "US", regionName: "United States", firstShown: "2026-06-05T00:00:00.000Z", lastShown: "2026-06-24T00:00:00.000Z", impressions: { lower: "500000", upper: "600000" }, platformImpressions: [] }],
	variations: [
		{
			destinationUrl: "shop.gop.com",
			headline: "Classic GOP Quarter - Zip Pullover | Shop American ...",
			description: "FORE MORE Official Party Quarter - Zip Pullover XL / US FLAG",
			allText: "Official GOP Shop shop.gop.com Classic GOP Quarter - Zip Pullover | Shop American ...",
			imageUrl: "https://tpc.googlesyndication.com/archive/simgad/18242167605449878359",
		},
	],
};

describe("google_ad_library", () => {
	const originalKey = process.env.SCRAPECREATORS_API_KEY;
	let restore: (() => void) | undefined;
	beforeEach(() => { process.env.SCRAPECREATORS_API_KEY = KEY; });
	afterEach(() => {
		restore?.();
		restore = undefined;
		if (originalKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
		else process.env.SCRAPECREATORS_API_KEY = originalKey;
	});

	test("advertisers sends the name and region, and lists each advertiser's id, region and estimate with the websites", async () => {
		const mock = installFetchMock({ [ADVERTISERS_PATH]: advertiserPage });
		restore = mock.restore;
		const result = await executeSource(library, { action: "advertisers", query: "lululemon", country: "ca" }, context);
		const out = text(result);
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]!.headers["x-api-key"]).toBe(KEY);
		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ query: "lululemon", region: "CA" });
		expect(result.status).toBe("success");
		expect(out).toContain('Google Ad Library advertiser search: "lululemon"');
		expect(out).toContain("Region: CA.");
		expect(out).toContain("Advertisers returned: 2");
		expect(out).toContain("Websites Google associates with this search: lululemon.de, lululemon.com");
		expect(out).toContain("2. lululemon athletica canada inc. — advertiser id AR01614014350098432001\n   region CA | about 7.0K ads (Google's estimate)\n   Ads Transparency: https://adstransparency.google.com/advertiser/AR01614014350098432001");
		expect(details(result)).toMatchObject({ action: "advertisers", returned: 2, advertiser_ids: ["AR01382517811867287553", "AR01614014350098432001"] });
		expect(details(result).cost).toEqual([{ amount: 1, unit: "credits" }]);

		const narrowed = await executeSource(library, { action: "advertisers", query: "lululemon", limit: 1 }, context);
		expect(Object.fromEntries(mock.calls[1]!.url.searchParams)).toEqual({ query: "lululemon" });
		expect(narrowed.text).toContain("Region: US (provider default).");
		expect(narrowed.text).toContain("Advertisers returned: 2 | 1 shown of 2 returned (limit=1)");
		expect(narrowed.text).not.toContain("lululemon athletica canada inc.");
	});

	test("ads sends the documented filters and shows each ad with its dates, format and address, then the cursor", async () => {
		const mock = installFetchMock({ [ADS_PATH]: adsPage });
		restore = mock.restore;
		const result = await executeSource(
			library,
			{ action: "ads", advertiser_id: "AR01614014350098432001", country: "us", start_date: "2025-08-01", end_date: "2025-08-11", format: "text", cursor: "prev" },
			context,
		);
		const out = text(result);
		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ advertiser_id: "AR01614014350098432001", region: "US", start_date: "2025-08-01", end_date: "2025-08-11", format: "text", cursor: "prev" });
		expect(result.status).toBe("success");
		expect(out).toContain("Google Ad Library ads for advertiser id AR01614014350098432001");
		expect(out).toContain("Filters: region=US | start_date=2025-08-01 | end_date=2025-08-11 | format=text | continuation page");
		expect(out).toContain("Ads returned: 2 | Google's estimate of this advertiser's ads: 20.0K");
		expect(out).toContain("1. lululemon athletica canada inc. — creative CR08567627846124568577 — image\n   Shown: 2026-03-11 → 2026-05-04\n   Ads Transparency: https://adstransparency.google.com/advertiser/AR01614014350098432001/creative/CR08567627846124568577");
		expect(out).toContain("   Preview image: https://tpc.googlesyndication.com/archive/simgad/7468813441689462696");
		expect(out).toContain("It reports no clicks, conversions or other results");
		expect(out).toMatch(/Next page: pass cursor="CgoAP7zmu%2FzKj6ijEhBBAgiPtk1y16J9lpkAAAAAGgn8%2BHbW%2BJylE6g%3D" with the same other arguments\.$/);
		expect(details(result)).toMatchObject({ action: "ads", returned: 2, shown: 2, cursor: adsPage.cursor, creative_ids: ["CR08567627846124568577", "CR02637147045441306625"], truncated: false });
		expect(details(result).cost).toEqual([{ amount: 1, unit: "credits" }]);
	});

	test("limit narrows the ads shown, never the request, and the cursor continues after every returned ad", async () => {
		const mock = installFetchMock({ [ADS_PATH]: adsPage });
		restore = mock.restore;
		const result = await executeSource(library, { action: "ads", domain: "Lululemon.com", limit: 1 }, context);
		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ domain: "lululemon.com" });
		expect(result.text).toContain("Filters: region=anywhere (provider default) | first page");
		expect(result.text).toContain("Ads returned: 2 | 1 shown of 2 returned (limit=1)");
		expect(result.text).not.toContain("CR02637147045441306625");
		expect(result.text).toContain("with the same other arguments (it continues after all 2 returned ads, including the 1 not shown).");
		expect(result.status).toBe("success");
	});

	test("detail sends the address and gives everything returned: variations, destination, media, regions, dates, impressions, spend and targeting", async () => {
		const mock = installFetchMock({ [AD_PATH]: adDetail });
		restore = mock.restore;
		const result = await executeSource(library, { action: "detail", url: AD_URL }, context);
		const out = text(result);
		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ url: AD_URL });
		expect(result.status).toBe("success");
		expect(out).toContain(`Google Ad Library ad CR17778900238552006657\nAds Transparency: ${AD_URL}`);
		expect(out).toContain("Advertiser id: AR07541154843046445057 | Format: image");
		expect(out).toContain("Shown: 2026-06-05 → 2026-06-24");
		expect(out).toContain("Impressions (Google's range): 500.0K–600.0K");
		expect(out).toContain("Spend (Google's range): 5.0K–6.0K USD");
		expect(out).toContain("  age: included 25-34; 35-44; excluded 18-24");
		expect(out).toContain("  location: included United States (US); excluded Norway (NO)");
		expect(out).toContain("Regions: United States (US)");
		expect(out).toContain("Region United States: 2026-06-05 → 2026-06-24 | impressions 500.0K–600.0K");
		expect(out).toContain("  Headline: Classic GOP Quarter - Zip Pullover | Shop American ...");
		expect(out).toContain("  Destination: shop.gop.com");
		expect(out).toContain("  Image 1: https://tpc.googlesyndication.com/archive/simgad/18242167605449878359");
		expect(out).toContain("by OCR and may contain errors");
		expect(details(result)).toMatchObject({ action: "detail", creative_id: "CR17778900238552006657", variations: 1, political_data: true });
		expect(details(result).cost).toEqual([{ amount: 1, unit: "credits" }]);

		const other = installFetchMock({ [AD_PATH]: { ...adDetail, creativeId: "CR1" } });
		restore = () => { other.restore(); mock.restore(); };
		expect(await library.execute({ action: "detail", url: AD_URL }, context)).toBe("ERROR: ScrapeCreators Google Ad Library ad returned creative CR1 instead of requested creative CR17778900238552006657");
	});

	test("an empty list is empty; an unreadable payload is an error, never empty", async () => {
		let body: unknown = { success: true, credits_charged: 1, ads: [] };
		const mock = installFetchMock({ [ADS_PATH]: () => body, [ADVERTISERS_PATH]: { success: true, credits_charged: 1, advertisers: [], websites: [] } });
		restore = mock.restore;
		const empty = await executeSource(library, { action: "ads", domain: "example.com" }, context);
		expect(empty.status).toBe("empty");
		expect(empty.text).toContain("returned no ads for this advertiser and filter set");
		expect(details(empty).cost).toEqual([{ amount: 1, unit: "credits" }]);
		expect((await executeSource(library, { action: "advertisers", query: "nobody" }, context)).status).toBe("empty");

		body = { success: true, credits_charged: 1, ads: [adsPage.ads[0], { format: "text" }] };
		const mixed = await executeSource(library, { action: "ads", domain: "example.com" }, context);
		expect(mixed.status).toBe("partial");
		expect(mixed.text).toContain("Unreadable entries: 1 returned entry carried no creativeId and was skipped");

		body = { success: true, credits_charged: 1 };
		expect(await library.execute({ action: "ads", domain: "example.com" }, context)).toBe("ERROR: ScrapeCreators Google Ad Library company ads returned an unexpected payload: `ads` is missing");
	});

	test("a provider error status fails with the provider's message, and its cost stays unknown when unreported", async () => {
		const mock = installFetchMock({ [ADS_PATH]: { status: 402, body: { success: false, error: "Insufficient credits" } } });
		restore = mock.restore;
		const result = await executeSource(library, { action: "ads", domain: "example.com" }, context);
		expect(result.status).toBe("failed");
		expect(result.text).toBe("ERROR: ScrapeCreators Google Ad Library company ads returned HTTP 402: Insufficient credits");
		expect(details(result).cost).toBeNull();
		expect(mock.calls).toHaveLength(1);
	});

	test("a request that got no response is sent once, says its cost is unknown once, and the receipt leaves it unknown", async () => {
		const mock = installFetchMock({ [AD_PATH]: () => { throw new TypeError("fetch failed"); } });
		restore = mock.restore;
		const result = await executeSource(library, { action: "detail", url: AD_URL }, context);
		expect(mock.calls).toHaveLength(1);
		expect(result.status).toBe("failed");
		expect(result.text.match(/its cost is unknown/g)).toHaveLength(1);
		expect(details(result).cost).toBeNull();
	});

	test("arguments are validated per action, and a missing key sends nothing", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;
		const refusals: Array<[Record<string, unknown>, string]> = [
			[{ action: "search" }, "ERROR: action must be one of advertisers, ads, detail"],
			[{ action: "advertisers", query: "x", cursor: "c" }, "ERROR: cursor does not apply to action='advertisers'"],
			[{ action: "detail", url: AD_URL, limit: 2 }, "ERROR: limit does not apply to action='detail'"],
			[{ action: "advertisers" }, "ERROR: query is required for action='advertisers'."],
			[{ action: "ads" }, "ERROR: action='ads' needs domain or advertiser_id."],
			[{ action: "ads", domain: "a.com", advertiser_id: "AR1" }, "ERROR: Provide domain or advertiser_id for action='ads', not both."],
			[{ action: "ads", domain: "https://a.com/x" }, "ERROR: domain must be a website domain"],
			[{ action: "ads", advertiser_id: "lululemon" }, "ERROR: advertiser_id must be Google's advertiser id"],
			[{ action: "ads", domain: "a.com", country: "USA" }, "ERROR: country must be one two-letter region code"],
			[{ action: "ads", domain: "a.com", format: "audio" }, "ERROR: format must be one of text, image, video"],
			[{ action: "ads", domain: "a.com", start_date: "2025-02-30" }, "ERROR: start_date must be a date in YYYY-MM-DD form."],
			[{ action: "ads", domain: "a.com", start_date: "2025-03-01", end_date: "2025-02-01" }, "ERROR: start_date must not be after end_date."],
			[{ action: "ads", domain: "a.com", limit: 0 }, "ERROR: limit must be a positive whole number."],
			[{ action: "detail" }, "ERROR: url is required for action='detail'."],
			[{ action: "detail", url: "https://elsewhere.example/advertiser/AR1/creative/CR1" }, "ERROR: url must be an Ads Transparency Center address naming one ad"],
			[{ action: "detail", url: "https://adstransparency.google.com/advertiser/AR1" }, "ERROR: url must be an Ads Transparency Center address naming one ad"],
		];
		for (const [args, expected] of refusals) expect(text(await library.execute(args, context))).toContain(expected);
		delete process.env.SCRAPECREATORS_API_KEY;
		expect(await library.execute({ action: "advertisers", query: "x" }, context)).toBe("ERROR: SCRAPECREATORS_API_KEY not set. Get a key at https://scrapecreators.com");
		expect(mock.calls).toHaveLength(0);
	});

	test("output past the limit is cut with a pointer to the retained original, and the next-page line is kept", async () => {
		const ads = Array.from({ length: 400 }, (_, index) => listedAd(`CR${index}`, "text", `https://tpc.googlesyndication.com/archive/simgad/${"9".repeat(120)}${index}`, "2024-01-01T00:00:00.000Z"));
		const mock = installFetchMock({ [ADS_PATH]: { success: true, credits_charged: 1, ads, cursor: "after" } });
		restore = mock.restore;
		const result = await library.execute({ action: "ads", domain: "example.com" }, context);
		const out = text(result);
		expect(out).toContain("[Truncated at 60000 of ");
		expect(out).toMatch(/Next page: pass cursor="after" with the same other arguments\.$/);
		expect(typeof result === "string" ? undefined : result.status).toBe("partial");
	});
});
