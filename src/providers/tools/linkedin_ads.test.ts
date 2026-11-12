// The fixtures are ScrapeCreators' documented response examples for /v1/linkedin/ads/search and /v1/linkedin/ad
// (read 2026-11-10), trimmed; they have not been checked against a live response.
import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { SourceToolResult, ToolContext } from "../types.js";
import { library } from "./linkedin_ads.js";

type FetchCall = { url: URL; headers: Record<string, string> };
type Reply = { status: number; body: unknown };
type Route = unknown | ((call: FetchCall) => unknown);

const KEY = "sc-test-key-0231";
const SEARCH_PATH = "/v1/linkedin/ads/search";
const AD_PATH = "/v1/linkedin/ad";

const context: ToolContext = {
	sessionID: "linkedin-ads-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

const text = (result: SourceToolResult): string => (typeof result === "string" ? result : result.text);
const details = (result: SourceToolResult): Record<string, unknown> => (typeof result === "string" ? {} : (result.details ?? {}));
const isReply = (value: unknown): value is Reply => typeof value === "object" && value !== null && "status" in value && "body" in value;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

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

const DESCRIPTION = "Offensive security for Insurance Brokers, TPAs, MGAs and Carriers.\n\nGet a full audit-grade NYDFS or SOC2 PDF report within 48 hours.";
const VIDEO_360 = "https://dms.licdn.com/playlist/vid/v2/D5610AQHhFKchr0EgUA/mp4-360p-30fp-crf28/B56aDdqz26GoCE-/0/1790425384702?e=2147483647&v=beta&t=JDvJ4pLmerMVdDjbUZskRZIeuno7_YD4b-t_y2aY_f0";
const POSTER = "https://media.licdn.com/dms/image/v2/D5610AQHhFKchr0EgUA/videocover-high/B56aDdqz26GoBM-/0/1790425384196?e=2147483647&v=beta&t=f4890gDBvRXts6rJzik-j7iF8aDV6XOLTyaT10Bdkyg";
const videoAd = {
	id: "1629532086",
	description: DESCRIPTION,
	headline: "Meet us at Booth 3240",
	poster: "CodeAnt AI",
	posterTitle: null,
	promotedBy: null,
	targeting: {},
	image: null,
	video: VIDEO_360,
	preRollVideo: null,
	organicVideo: VIDEO_360,
	preRollAdvertiser: null,
	carouselImages: [],
	url: "https://www.linkedin.com/ad-library/detail/1629532086",
	adType: "Video Ad",
	creativeType: "SPONSORED_VIDEO",
	advertiser: "CodeAnt AI",
	advertiserLinkedinPage: "https://www.linkedin.com/company/96582348",
	cta: "Join",
	sponsoredMessageSender: null,
	sponsoredMessageButtons: [],
	destinationUrl: null,
	landingPage: null,
	adDuration: "",
	startDate: null,
	endDate: null,
	totalImpressions: null,
	impressionsByCountry: [],
	imageSources: [],
	videoSources: [{ src: VIDEO_360, type: "video/mp4", bitrate: 124294 }],
	thumbnailSources: [POSTER],
	preRollVideoSources: [],
};
const imageAd = {
	...videoAd,
	id: "1637580796",
	description: "Your code, cloud and team changed since your last pentest. Your auditor needs a report on today's environment.",
	headline: "Renewing PCI? Get a pentest report in 3 weeks",
	video: null,
	organicVideo: null,
	image: "https://media.licdn.com/dms/image/v2/D5610AQFFRKthq08ivA/image-shrink_1280/B56aEaDZDNJcAc-/0/1791438459516/PCI-02png",
	url: "https://www.linkedin.com/ad-library/detail/1637580796",
	adType: "Single Image Ad",
	cta: "Learn more",
	videoSources: [],
	thumbnailSources: [],
};
const searchPage = { success: true, credits_remaining: 100, credits_charged: 1, ads: [videoAd, imageAd], paginationToken: "1587449116-1788316404963", isLastPage: false, totalAds: 258 };
// The detail example, with the payer, dates and impression fields LinkedIn publishes for some ads filled in.
const published = {
	success: true,
	credits_remaining: 100,
	credits_charged: 1,
	...videoAd,
	paidForBy: "CodeAnt AI Inc.",
	startDate: "2026-03-01",
	endDate: "2026-04-15",
	adDuration: "Mar 1, 2026 - Apr 15, 2026",
	destinationUrl: "https://codeant.example/pentest",
	totalImpressions: "1k-5k",
	impressionsByCountry: [{ country: "United States", impressions: "60%" }],
	targeting: { language: "English", location: "United States" },
};

describe("linkedin_ad_library", () => {
	const originalKey = process.env.SCRAPECREATORS_API_KEY;
	let restore: (() => void) | undefined;
	beforeEach(() => { process.env.SCRAPECREATORS_API_KEY = KEY; });
	afterEach(() => {
		restore?.();
		restore = undefined;
		if (originalKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
		else process.env.SCRAPECREATORS_API_KEY = originalKey;
	});

	test("search sends the documented parameters and shows each ad's advertiser, format, text, dates and address, then the cursor", async () => {
		const mock = installFetchMock({ [SEARCH_PATH]: searchPage });
		restore = mock.restore;
		const start = daysAgo(60);
		const end = daysAgo(2);
		const result = await executeSource(
			library,
			{ action: "search", company_name: "CodeAnt AI", query: "pentest", countries: "us, ca", start_date: start, end_date: end, cursor: "640547184-1743616612000" },
			context,
		);
		const out = text(result);
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]!.headers["x-api-key"]).toBe(KEY);
		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ company: "CodeAnt AI", keyword: "pentest", countries: "US,CA", startDate: start, endDate: end, paginationToken: "640547184-1743616612000" });
		expect(result.status).toBe("success");
		expect(out).toContain('LinkedIn Ad Library search: company "CodeAnt AI", keyword "pentest"');
		expect(out).toContain(`Filters: countries=US,CA | dates=${start} → ${end} | continuation page`);
		expect(out).toContain("Ads returned: 2 | LinkedIn's result count: 258");
		expect(out).toContain("1. CodeAnt AI — ad 1629532086 — Video Ad\n   Ad Library: https://www.linkedin.com/ad-library/detail/1629532086\n   Ran: dates not published");
		expect(out).toContain("   Headline: Meet us at Booth 3240\n   Text:\n     Offensive security for Insurance Brokers, TPAs, MGAs and Carriers.\n\n     Get a full audit-grade NYDFS or SOC2 PDF report within 48 hours.\n   Call to action: Join");
		expect(out).toContain("2. CodeAnt AI — ad 1637580796 — Single Image Ad");
		expect(out).toContain("It reports no spend, clicks or results");
		expect(out).not.toContain(VIDEO_360);
		expect(out).toMatch(/Next page: pass cursor="1587449116-1788316404963" with the same other arguments\.$/);
		expect(details(result)).toMatchObject({ action: "search", returned: 2, shown: 2, result_count: 258, cursor: "1587449116-1788316404963", ad_ids: ["1629532086", "1637580796"], truncated: false });
		expect(details(result).cost).toEqual([{ amount: 1, unit: "credits" }]);
	});

	test("limit narrows the ads shown, never the request; the last page gives no cursor", async () => {
		let body: unknown = searchPage;
		const mock = installFetchMock({ [SEARCH_PATH]: () => body });
		restore = mock.restore;
		const result = await executeSource(library, { action: "search", company_id: "96582348", limit: 1 }, context);
		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ companyId: "96582348" });
		expect(result.text).toContain("Filters: countries=all (none sent) | dates=LinkedIn's full window (about the last year) | first page");
		expect(result.text).toContain("Ads returned: 2 | 1 shown of 2 returned (limit=1)");
		expect(result.text).not.toContain("1637580796");
		expect(result.text).toContain("with the same other arguments (it continues after all 2 returned ads, including the 1 not shown).");
		expect(result.status).toBe("success");

		body = { ...searchPage, isLastPage: true };
		const last = await executeSource(library, { action: "search", query: "pentest" }, context);
		expect(last.text).toMatch(/Next page: none; LinkedIn reports this as the last page\.$/);
		expect(details(last).cursor).toBeNull();
	});

	test("detail sends the address and gives everything returned: payer, targeting, impressions, dates, destination and media addresses", async () => {
		const mock = installFetchMock({ [AD_PATH]: published });
		restore = mock.restore;
		const result = await executeSource(library, { action: "detail", ad_id: "1629532086" }, context);
		const out = text(result);
		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ url: "https://www.linkedin.com/ad-library/detail/1629532086" });
		expect(result.status).toBe("success");
		expect(out).toContain("LinkedIn Ad Library ad 1629532086");
		expect(out).toContain("Ran: 2026-03-01 → 2026-04-15");
		expect(out).toContain("Impressions by country (LinkedIn's ranges): country United States, impressions 60%");
		expect(out).toContain("Destination: https://codeant.example/pentest | Call to action: Join");
		expect(out).toContain("Advertiser page: https://www.linkedin.com/company/96582348");
		expect(out).toContain("Paid for by: CodeAnt AI Inc.");
		expect(out).toContain("Total impressions (LinkedIn's range): 1k-5k");
		expect(out).toContain("Targeting (as LinkedIn publishes it):\n  language: English\n  location: United States");
		expect(out).toContain(`Video (124.3K bits/s): ${VIDEO_360}`);
		expect(out).toContain(`Video poster: ${POSTER}`);
		expect(out.split(VIDEO_360)).toHaveLength(2);
		expect(out).toContain("nothing was downloaded");
		expect(details(result)).toMatchObject({ action: "detail", ad_id: "1629532086", paid_for_by: "CodeAnt AI Inc.", media: 2 });
		expect(details(result).cost).toEqual([{ amount: 1, unit: "credits" }]);

		const bare = installFetchMock({ [AD_PATH]: { success: true, credits_charged: 1, ...videoAd } });
		restore = () => { bare.restore(); mock.restore(); };
		const unpublished = text(await library.execute({ action: "detail", url: "https://www.linkedin.com/ad-library/detail/1629532086" }, context));
		expect(unpublished).toContain("Paid for by: not published");
		expect(unpublished).toContain("Targeting: none published in this record");
		expect(await library.execute({ action: "detail", ad_id: "1" }, context)).toBe("ERROR: ScrapeCreators LinkedIn Ad Library ad returned ad 1629532086 instead of requested ad 1");
	});

	test("an empty search is empty; an unreadable payload is an error, never empty", async () => {
		let body: unknown = { success: true, credits_charged: 1, ads: [], isLastPage: true, totalAds: 0 };
		const mock = installFetchMock({ [SEARCH_PATH]: () => body });
		restore = mock.restore;
		const empty = await executeSource(library, { action: "search", query: "nothing" }, context);
		expect(empty.status).toBe("empty");
		expect(empty.text).toContain("returned no ads for this search and filter set");
		expect(details(empty).cost).toEqual([{ amount: 1, unit: "credits" }]);

		body = { ...searchPage, ads: [videoAd, { headline: "no id" }] };
		const mixed = await executeSource(library, { action: "search", query: "x" }, context);
		expect(mixed.status).toBe("partial");
		expect(mixed.text).toContain("Unreadable entries: 1 returned entry carried no ad id and was skipped");

		body = { success: true, credits_charged: 1 };
		expect(await library.execute({ action: "search", query: "x" }, context)).toBe("ERROR: ScrapeCreators LinkedIn Ad Library search returned an unexpected payload: `ads` is missing");
	});

	test("a provider error status fails with the provider's message and the key redacted", async () => {
		const mock = installFetchMock({ [SEARCH_PATH]: { status: 402, body: { success: false, error: `Insufficient credits for ${KEY}` } } });
		restore = mock.restore;
		const result = await executeSource(library, { action: "search", query: "x" }, context);
		expect(result.status).toBe("failed");
		expect(result.text).toBe("ERROR: ScrapeCreators LinkedIn Ad Library search returned HTTP 402: Insufficient credits for [redacted]");
		expect(details(result).cost).toBeNull();
		expect(mock.calls).toHaveLength(1);
	});

	test("a request that got no response is sent once, says its cost is unknown once, and the receipt leaves it unknown", async () => {
		const mock = installFetchMock({ [SEARCH_PATH]: () => { throw new DOMException("The operation timed out.", "TimeoutError"); } });
		restore = mock.restore;
		const result = await executeSource(library, { action: "search", query: "x" }, context);
		expect(mock.calls).toHaveLength(1);
		expect(result.status).toBe("failed");
		expect(result.text.match(/its cost is unknown/g)).toHaveLength(1);
		expect(details(result).cost).toBeNull();
	});

	test("arguments are validated per action, and a missing key sends nothing", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;
		const refusals: Array<[Record<string, unknown>, string]> = [
			[{ action: "ads" }, "ERROR: action must be one of search, detail"],
			[{ action: "detail", ad_id: "1", cursor: "c" }, "ERROR: cursor does not apply to action='detail'"],
			[{ action: "search", query: "x", url: "https://www.linkedin.com/ad-library/detail/1" }, "ERROR: url does not apply to action='search'"],
			[{ action: "search" }, "ERROR: action='search' needs company_name, company_id or query."],
			[{ action: "search", company_id: "microsoft" }, "ERROR: company_id must be LinkedIn's numeric company id"],
			[{ action: "search", query: "x", countries: "USA" }, "ERROR: countries must be two-letter country codes separated by commas"],
			[{ action: "search", query: "x", start_date: daysAgo(10) }, "ERROR: start_date and end_date go together"],
			[{ action: "search", query: "x", start_date: "2026-02-30", end_date: daysAgo(1) }, "ERROR: start_date must be a date in YYYY-MM-DD form."],
			[{ action: "search", query: "x", start_date: daysAgo(5), end_date: daysAgo(10) }, "ERROR: start_date must not be after end_date."],
			[{ action: "search", query: "x", start_date: daysAgo(400), end_date: daysAgo(10) }, "ERROR: start_date must be no earlier than one year ago"],
			[{ action: "search", query: "x", start_date: daysAgo(10), end_date: daysAgo(0) }, "ERROR: end_date must be yesterday"],
			[{ action: "search", query: "x", limit: 0 }, "ERROR: limit must be a positive whole number."],
			[{ action: "detail" }, "ERROR: action='detail' needs an Ad Library url or ad_id."],
			[{ action: "detail", ad_id: "1", url: "https://www.linkedin.com/ad-library/detail/1" }, "ERROR: Provide url or ad_id, not both."],
			[{ action: "detail", ad_id: "abc" }, "ERROR: ad_id must be the numeric Ad Library id."],
			[{ action: "detail", url: "https://www.linkedin.com/company/96582348" }, "ERROR: url must be a LinkedIn Ad Library address naming one ad"],
			[{ action: "detail", url: "https://elsewhere.example/ad-library/detail/1" }, "ERROR: url must be a LinkedIn Ad Library address naming one ad"],
		];
		for (const [args, expected] of refusals) expect(text(await library.execute(args, context))).toContain(expected);
		delete process.env.SCRAPECREATORS_API_KEY;
		expect(await library.execute({ action: "search", query: "x" }, context)).toBe("ERROR: SCRAPECREATORS_API_KEY not set. Get a key at https://scrapecreators.com");
		expect(mock.calls).toHaveLength(0);
	});

	test("output past the limit is cut with a pointer to the retained original, and the next-page line is kept", async () => {
		const huge = { ...videoAd, description: "word ".repeat(15_000) };
		const mock = installFetchMock({ [SEARCH_PATH]: { ...searchPage, ads: [huge, { ...huge, id: "2" }], paginationToken: "after" } });
		restore = mock.restore;
		const result = await library.execute({ action: "search", query: "x" }, context);
		const out = text(result);
		expect(out).toContain("[Truncated at 60000 of ");
		expect(out).toMatch(/Next page: pass cursor="after" with the same other arguments\.$/);
		expect(typeof result === "string" ? undefined : result.status).toBe("partial");
	});
});
