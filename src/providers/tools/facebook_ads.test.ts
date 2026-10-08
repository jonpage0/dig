import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { SourceToolResult, ToolContext } from "../types.js";
import { library } from "./facebook_ads.js";

type FetchCall = { url: URL; method: string; headers: Record<string, string>; body: unknown; redirect: RequestRedirect | undefined };
type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type Route = unknown | ((call: FetchCall) => unknown);

const KEY = "sc-test-key-0231";

const context: ToolContext = {
	sessionID: "facebook-ads-test",
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

function status(result: SourceToolResult): string | undefined {
	return typeof result === "string" ? undefined : result.status;
}

function isReply(value: unknown): value is Reply {
	return typeof value === "object" && value !== null && "status" in value && "body" in value && typeof (value as Reply).status === "number";
}

/** Route values (or what a route function returns) are the JSON body of a 200, or `{ status, body, headers }`. */
function installFetchMock(routes: Record<string, Route>) {
	const calls: FetchCall[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof URL ? input : new URL(String(input));
		const call: FetchCall = {
			url,
			method: init?.method ?? "GET",
			headers: { ...(init?.headers as Record<string, string>) },
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			redirect: init?.redirect,
		};
		calls.push(call);
		const route = routes[url.pathname];
		if (route === undefined) return new Response(JSON.stringify({ success: false, error: "no route" }), { status: 404 });
		const resolved = typeof route === "function" ? (route as (call: FetchCall) => unknown)(call) : route;
		const reply = isReply(resolved) ? resolved : { status: 200, body: resolved };
		const body = reply.body === null ? null : JSON.stringify(reply.body);
		return new Response(body, { status: reply.status, headers: { "Content-Type": "application/json", ...reply.headers } });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

// Shapes follow the ScrapeCreators docs examples read 2026-10-08 (media URLs shortened).
const LONG_TEXT =
	"Discover the unmatched joy of having Cedar in your life—a playful and intelligent labradoodle who’s eager to please and full of enthusiasm! Cedar boasts a confident demeanor and a moderate energy level, making him the perfect companion for any active household.\n\nIdeal for an experienced dog family ready to embrace an active lifestyle, Cedar is more than just a pet. Make Cedar a cherished member of your family today!";

const searchAd = {
	ad_archive_id: "615470338018648",
	ad_id: null,
	categories: ["UNKNOWN"],
	collation_count: 1,
	collation_id: "888075953335279",
	currency: "",
	end_date: 1740729600,
	impressions_with_index: { impressions_text: null, impressions_index: -1 },
	is_active: true,
	page_id: "115531458627129",
	page_name: "JNB Stables Labradoodles",
	publisher_platform: ["FACEBOOK", "INSTAGRAM"],
	reach_estimate: null,
	snapshot: {
		body: { text: LONG_TEXT },
		cards: [],
		cta_text: "No button",
		display_format: "MULTI_IMAGES",
		images: [{ original_image_url: "https://scontent.example/original-1.jpg", resized_image_url: "https://scontent.example/resized-1.jpg", watermarked_resized_image_url: "" }],
		link_url: null,
		page_categories: ["Pet Service"],
		page_id: "115531458627129",
		page_like_count: 3823,
		page_name: "JNB Stables Labradoodles",
		page_profile_uri: "https://www.facebook.com/JNBStables/",
		title: null,
		videos: [],
		extra_texts: [],
		extra_links: [],
	},
	spend: null,
	start_date: 1740729600,
	targeted_or_reached_countries: [],
};

const companyAd = {
	...searchAd,
	ad_archive_id: "1162496978867592",
	collation_count: 3,
	collation_id: "596215693307098",
	page_id: "367152833370567",
	page_name: "Instagram",
	publisher_platform: ["INSTAGRAM"],
	snapshot: {
		body: { text: "{{product.brand}}" },
		branded_content: { page_name: "Instagram", page_profile_uri: "https://www.facebook.com/instagram/" },
		cards: [
			{ body: "Card one text", title: "{{product.name}}", link_url: "https://shop.example/1", cta_text: "Shop now", original_image_url: "https://scontent.example/card1.jpg" },
			{ body: "Card two text", video_hd_url: "https://video.example/card2.mp4", video_preview_image_url: "https://scontent.example/card2.jpg" },
		],
		display_format: "DCO",
		images: [],
		page_id: "378515988682204",
		page_name: "Lalobri",
		page_profile_uri: "https://www.facebook.com/61564084618363/",
		videos: [],
	},
};

const adDetail = {
	success: true,
	credits_charged: 1,
	adArchiveID: 702369045530963,
	categories: [0],
	collationCount: null,
	collationID: null,
	currency: "",
	endDate: 1747983600,
	impressionsWithIndex: { impressionsText: null, impressionsIndex: -1 },
	isActive: false,
	pageID: 166258896830103,
	pageName: "Porto Montenegro",
	publisherPlatform: ["facebook", "instagram", "audience_network"],
	reachEstimate: null,
	snapshot: {
		body: "Reflections ripple, light gathers,<br /> and tomorrow brings a new rhythm to the square. <br /> <br /> One day until the Grand Opening of Boka Place.",
		branded_content: { page_name: "Porto Montenegro", page_profile_uri: "https://www.facebook.com/portomontenegrotivat/" },
		caption: "www.portomontenegro.com",
		cards: [],
		cta_text: "Learn more",
		display_format: "video",
		images: [],
		link_url: "https://www.portomontenegro.com/attractions-events/boka-place-grand-opening/",
		page_categories: { "197251360301109": "Marina" },
		page_id: 598631456674530,
		page_like_count: 1,
		page_name: "Porto Montenegro Experience",
		page_profile_uri: "https://www.facebook.com/61575286107814/",
		videos: [{ video_hd_url: "https://video.example/hd.mp4", video_sd_url: "https://video.example/sd.mp4", watermarked_video_hd_url: "", video_preview_image_url: "https://scontent.example/preview.jpg" }],
	},
	spend: null,
	startDate: 1747897200,
	url: "https://www.facebook.com/ads/library?id=702369045530963",
	aaa_info: {
		targets_eu: true,
		location_audience: [{ name: "Dubrovnik, Croatia", num_obfuscated: 0, type: "CITY", excluded: false }],
		gender_audience: "All",
		age_audience: { min: 18, max: 65 },
		eu_total_reach: 1657,
		age_country_gender_reach_breakdown: [
			{ country: "HR", age_gender_breakdowns: [{ age_range: "65+", male: 37, female: 29, unknown: null }, { age_range: "18-24", male: 161, female: 152, unknown: 7 }] },
		],
		payer_beneficiary_data: [{ payer: "Porto Montenegro", beneficiary: "Porto Montenegro" }],
		has_violating_payer_beneficiary: false,
		is_ad_taken_down: false,
	},
};

const SEARCH_PATH = "/v1/facebook/adLibrary/search/ads";
const COMPANY_PATH = "/v1/facebook/adLibrary/company/ads";
const AD_PATH = "/v1/facebook/adLibrary/ad";
const TRANSCRIPT_PATH = "/v1/facebook/adLibrary/ad/transcript";
const COMPANIES_PATH = "/v1/facebook/adLibrary/search/companies";

describe("facebook_ad_library", () => {
	const originalKey = process.env.SCRAPECREATORS_API_KEY;
	let restore: (() => void) | undefined;

	beforeEach(() => {
		process.env.SCRAPECREATORS_API_KEY = KEY;
	});

	afterEach(() => {
		restore?.();
		restore = undefined;
		if (originalKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
		else process.env.SCRAPECREATORS_API_KEY = originalKey;
	});

	test("search sends the documented filters by GET, keeps the creative text whole, and exposes the next cursor", async () => {
		const mock = installFetchMock({
			[SEARCH_PATH]: { success: true, credits_charged: 1, searchResults: [searchAd], searchResultsCount: 50001, cursor: "AQH-next" },
		});
		restore = mock.restore;

		const result = await executeSource(
			library,
			{ kind: "search", query: "running", country: "us", language: "en", search_type: "keyword_exact_phrase", start_date: "2025-01-05", end_date: "2025-02-16" },
			context,
		);
		const out = text(result);
		const call = mock.calls[0]!;

		expect(mock.calls).toHaveLength(1);
		expect(call.method).toBe("GET");
		expect(call.redirect).toBe("manual");
		expect(call.headers["x-api-key"]).toBe(KEY);
		expect(Object.fromEntries(call.url.searchParams)).toEqual({
			query: "running",
			search_type: "keyword_exact_phrase",
			country: "US",
			language: "EN",
			start_date: "2025-01-05",
			end_date: "2025-02-16",
		});
		expect(status(result)).toBe("success");
		for (const paragraph of LONG_TEXT.split("\n").filter(Boolean)) expect(out).toContain(paragraph);
		expect(out).toContain("JNB Stables Labradoodles — ad 615470338018648 — active");
		expect(out).toContain("Ad Library: https://www.facebook.com/ads/library?id=615470338018648");
		expect(out).toContain("Ran: 2025-02-28 → 2025-02-28 | Platforms: FACEBOOK, INSTAGRAM | Format: MULTI_IMAGES");
		expect(out).toContain("Profile: https://www.facebook.com/JNBStables/ | 3.8K page likes | Pet Service");
		expect(out).toContain("Image 1: https://scontent.example/original-1.jpg");
		expect(out).toContain("Delivery: no impressions, spend or reach disclosed in this record");
		expect(out).toContain("It reports no clicks, conversions, sales or other performance");
		expect(out).toContain("Dig has not viewed the images or watched the videos");
		expect(out).toContain("status=ACTIVE (provider default)");
		expect(out).toContain("Ad Library result count reported: 50001");
		expect(out).toContain('Next page: pass cursor="AQH-next" with the same other arguments');
		expect(details(result)).toMatchObject({ kind: "search", transport: "GET", returned: 1, cursor: "AQH-next", result_count: 50001, ad_ids: ["615470338018648"], truncated: false });
		expect(details(result).cost).toEqual([{ amount: 1, unit: "credits" }]);
	});

	test("a continuation page sends the same parameters and cursor as a JSON POST body", async () => {
		const mock = installFetchMock({ [SEARCH_PATH]: { success: true, credits_charged: 1, searchResults: [searchAd] } });
		restore = mock.restore;

		const result = await library.execute({ kind: "search", query: "running", country: "gb", status: "ALL", cursor: " AQH-long " }, context);
		const call = mock.calls[0]!;

		expect(call.method).toBe("POST");
		expect(call.redirect).toBe("manual");
		expect(call.url.search).toBe("");
		expect(call.headers["Content-Type"]).toBe("application/json");
		expect(call.body).toEqual({ query: "running", country: "GB", status: "ALL", cursor: "AQH-long" });
		expect(text(result)).toContain("Page: continuation page (cursor sent by POST");
		expect(text(result)).toContain("Next page: no cursor returned; the provider gave no further page.");
		expect(details(result)).toMatchObject({ transport: "POST", cursor: null });
	});

	test("company ads by name keep the advertiser page, the shown-as page and every card's text and media", async () => {
		const mock = installFetchMock({ [COMPANY_PATH]: { success: true, credits_charged: 1, results: [companyAd], cursor: "AQH-company" } });
		restore = mock.restore;

		const result = await library.execute({ kind: "company", company_name: "Lululemon", media_type: "VIDEO" }, context);
		const out = text(result);

		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ companyName: "Lululemon", media_type: "VIDEO" });
		expect(out).toContain('company name "Lululemon" (resolved by the provider');
		expect(out).toContain("Advertiser pages in these results: Instagram (367152833370567)");
		expect(out).toContain("Page: Instagram (page id 367152833370567); shown as Lalobri (page id 378515988682204)");
		expect(out).toContain("Shown-as page profile: https://www.facebook.com/61564084618363/");
		expect(out).toContain("Branded content with: Instagram (https://www.facebook.com/instagram/)");
		expect(out).toContain("Related ads: 3 in Meta's group 596215693307098");
		expect(out).toContain("Card 1:");
		expect(out).toContain("Card one text");
		expect(out).toContain("Headline: {{product.name}}");
		expect(out).toContain("Link: https://shop.example/1 | Call to action: Shop now");
		expect(out).toContain("Image 1: https://scontent.example/card1.jpg");
		expect(out).toContain("Card two text");
		expect(out).toContain("Video 1: https://video.example/card2.mp4 (preview image https://scontent.example/card2.jpg)");
		expect(out).toContain("Dynamic template: Meta fills the {{…}} placeholders per viewer");
		expect(details(result)).toMatchObject({ kind: "company", company_name: "Lululemon", page_id: null, page_ids: ["367152833370567"], cursor: "AQH-company" });
	});

	test("ad details render line breaks, both pages, video links and Meta's transparency data as reported", async () => {
		const mock = installFetchMock({ [AD_PATH]: adDetail });
		restore = mock.restore;

		const result = await library.execute({ kind: "ad", ad_id: "702369045530963", cache_max_age: "7d" }, context);
		const out = text(result);

		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ id: "702369045530963", cache_max_age: "7d" });
		expect(out).toContain("Porto Montenegro — ad 702369045530963 — inactive");
		expect(out).toContain("Ran: 2025-05-22 → 2025-05-23 | Platforms: facebook, instagram, audience_network | Format: video");
		expect(out).toContain("Page: Porto Montenegro (page id 166258896830103); shown as Porto Montenegro Experience (page id 598631456674530)");
		expect(out).toContain("Shown-as page profile: https://www.facebook.com/61575286107814/ | 1 page likes | Marina");
		expect(out).toContain("Reflections ripple, light gathers,\n   and tomorrow brings a new rhythm to the square.");
		expect(out).toContain("One day until the Grand Opening of Boka Place.");
		expect(out).not.toContain("<br");
		expect(out).toContain("Link: https://www.portomontenegro.com/attractions-events/boka-place-grand-opening/ | Caption: www.portomontenegro.com | Call to action: Learn more");
		expect(out).toContain("Video 1: https://video.example/hd.mp4 (preview image https://scontent.example/preview.jpg)");
		expect(out).toContain("political and issue ad delivery values are fractional shares (0.08 = 8%)");
		expect(out).toContain("Targets EU: yes | EU total reach: 1657");
		expect(out).toContain("Audience: gender All, ages 18–65");
		expect(out).toContain("Locations: Dubrovnik, Croatia (CITY)");
		expect(out).toContain("Reach by age and gender, HR: 65+: male 37, female 29; 18-24: male 161, female 152, unknown 7");
		expect(out).toContain("Payer and beneficiary: payer Porto Montenegro, beneficiary Porto Montenegro");
		expect(out).not.toContain("taken down");
		expect(details(result)).toMatchObject({ kind: "ad", ad_id: "702369045530963", page_id: "166258896830103", active: false, transparency: true, credits_charged: 1 });
	});

	test("a transcript is returned in full by url, and a null transcript is an empty result, not a failure", async () => {
		const adUrl = "https://www.facebook.com/ads/library?id=1020359190509080";
		const mock = installFetchMock({
			[TRANSCRIPT_PATH]: (call: FetchCall) =>
				call.url.searchParams.get("id") === "999"
					? { success: true, credits_charged: 0, data: { ad_id: "999", url: "https://www.facebook.com/ads/library?id=999", transcript: null, transcript_available: false } }
					: { success: true, credits_charged: 1, data: { ad_id: "1020359190509080", url: adUrl, transcript: "First sentence of the ad.\nSecond sentence, unabridged.", transcript_available: true } },
		});
		restore = mock.restore;

		const found = await library.execute({ kind: "transcript", url: adUrl, cache_max_age: "3d" }, context);
		expect(Object.fromEntries(mock.calls[0]!.url.searchParams)).toEqual({ url: adUrl, cache_max_age: "3d" });
		expect(status(found)).toBe("success");
		expect(text(found)).toContain("Transcript:\n  First sentence of the ad.\n  Second sentence, unabridged.");
		expect(text(found)).toContain("Dig has not watched the video");
		expect(details(found)).toMatchObject({ ad_id: "1020359190509080", transcript_available: true, credits_charged: 1 });

		const none = await library.execute({ kind: "transcript", ad_id: "999" }, context);
		expect(status(none)).toBe("empty");
		expect(text(none)).toContain("No transcript: the provider returned none (transcript: null, transcript_available: false)");
		expect(text(none)).toContain("Credits charged: 0");
		expect(text(none)).toContain("This does not show that the ad has no spoken words.");
	});

	test("advertiser lookup lists page ids with the metrics returned and never invents a missing one", async () => {
		const mock = installFetchMock({
			[COMPANIES_PATH]: (call: FetchCall) =>
				call.url.searchParams.get("query") === "nobody"
					? { success: true, credits_charged: 1, searchResults: [] }
					: {
							success: true,
							credits_charged: 1,
							searchResults: [
								{ page_id: "15087023444", category: "Sportswear Store", likes: 39558683, verification: "BLUE_VERIFIED", name: "Nike", ig_username: "nike", ig_followers: 302060936, ig_verification: true, page_alias: "nike", page_is_deleted: false },
								{ page_id: "51212153078", name: "Nike Football", category: "Product/service" },
							],
						},
		});
		restore = mock.restore;

		const result = await library.execute({ kind: "companies", query: "nike" }, context);
		const out = text(result);
		expect(out).toContain("1. Nike — page id 15087023444");
		expect(out).toContain("Sportswear Store | 39.6M Facebook likes | verification BLUE_VERIFIED");
		expect(out).toContain("Instagram: @nike (302.1M followers), verified");
		expect(out).toContain("Facebook: https://www.facebook.com/nike");
		expect(out).toContain("2. Nike Football — page id 51212153078\n   Product/service");
		expect(out).not.toContain("0 Facebook likes");
		expect(details(result)).toMatchObject({ kind: "companies", page_ids: ["15087023444", "51212153078"] });

		const empty = await library.execute({ kind: "companies", query: "nobody" }, context);
		expect(status(empty)).toBe("empty");
		expect(text(empty)).toContain("The Ad Library returned no advertiser pages for this name.");
	});

	test("an empty ads list is empty and names the ACTIVE default; an unreadable payload is an error, never empty", async () => {
		const mock = installFetchMock({
			[SEARCH_PATH]: (call: FetchCall) => {
				const query = call.url.searchParams.get("query");
				if (query === "none") return { success: true, credits_charged: 1, searchResults: [], searchResultsCount: 0, cursor: null };
				if (query === "drift") return { success: true, credits_charged: 1, results: [searchAd] };
				if (query === "mixed") return { success: true, credits_charged: 1, searchResults: [searchAd, { snapshot: {} }] };
				return { success: true, credits_charged: 1, searchResults: [{ snapshot: { body: { text: "no id" } } }] };
			},
			[AD_PATH]: { success: true, credits_charged: 1 },
			[TRANSCRIPT_PATH]: { success: true, credits_charged: 1, data: { ad_id: "1" } },
		});
		restore = mock.restore;

		const empty = await library.execute({ kind: "search", query: "none" }, context);
		expect(status(empty)).toBe("empty");
		expect(text(empty)).toContain("The Ad Library returned no ads for this query and filter set. status defaults to ACTIVE");

		expect(await library.execute({ kind: "search", query: "drift" }, context)).toBe(
			"ERROR: ScrapeCreators Facebook Ad Library search returned an unexpected payload: `searchResults` is missing",
		);
		expect(await library.execute({ kind: "search", query: "idless" }, context)).toBe(
			"ERROR: ScrapeCreators Facebook Ad Library search returned an unexpected payload: none of the 1 entry carried an ad id (ad_archive_id)",
		);
		const mixed = await library.execute({ kind: "search", query: "mixed" }, context);
		expect(status(mixed)).toBe("partial");
		expect(text(mixed)).toContain("Unreadable entries: 1 returned entry carried no ad id and was skipped");
		expect(details(mixed)).toMatchObject({ returned: 1, unreadable: 1 });
		for (const body of [
			{ success: true, credits_charged: 1 },
			{ success: true, credits_charged: 1, snapshot: {} },
			{ ...adDetail, adArchiveID: 2, url: undefined },
		]) {
			const bad = installFetchMock({ [AD_PATH]: body });
			try {
				const result = await executeSource(library, { kind: "ad", ad_id: "1" }, context);
				expect(result.status).toBe("failed");
			} finally { bad.restore(); }
		}
		expect(await library.execute({ kind: "transcript", ad_id: "1" }, context)).toBe(
			"ERROR: ScrapeCreators Facebook Ad Library transcript returned an unexpected payload: `data.transcript` is missing",
		);
	});

	test("provider failures are errors with the key redacted, a redirect is never followed, and unreported cost stays unknown", async () => {
		const mock = installFetchMock({
			[SEARCH_PATH]: { status: 402, body: { success: false, error: "Insufficient credits" } },
			[COMPANY_PATH]: { success: false, message: `Rejected key ${KEY}` },
			[AD_PATH]: { status: 302, body: null, headers: { location: "https://elsewhere.example/collect" } },
		});
		restore = mock.restore;

		const refused = await executeSource(library, { kind: "search", query: "x" }, context);
		expect(refused.status).toBe("failed");
		expect(refused.text).toBe("ERROR: ScrapeCreators Facebook Ad Library search returned HTTP 402: Insufficient credits");
		expect(refused.details?.cost).toBeNull();

		const rejected = text(await library.execute({ kind: "company", page_id: "367152833370567" }, context));
		expect(rejected).toBe("ERROR: ScrapeCreators Facebook Ad Library company ads: Rejected key [redacted]");

		const redirected = text(await library.execute({ kind: "ad", ad_id: "702369045530963" }, context));
		expect(redirected).toContain("answered HTTP 302 with a redirect to https://elsewhere.example/collect");
		expect(redirected).toContain("Dig does not follow redirects");
		expect(mock.calls.filter((call) => call.url.pathname === AD_PATH)).toHaveLength(1);
		expect(mock.calls.every((call) => call.redirect === "manual" && call.url.origin === "https://api.scrapecreators.com")).toBe(true);
	});

	test("arguments are validated per kind before any request, and a missing key or cancellation sends nothing", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;

		const refusals: Array<[Record<string, unknown>, string]> = [
			[{ kind: "bogus" }, "ERROR: kind must be one of search, company, ad, companies, transcript"],
			[{ kind: "ad", ad_id: "1", cursor: "x" }, "ERROR: cursor does not apply to kind='ad'"],
			[{ kind: "search", query: "x", cache_max_age: "7d" }, "ERROR: cache_max_age does not apply to kind='search'"],
			[{ kind: "company", company_name: "x", search_type: "keyword_exact_phrase" }, "ERROR: search_type does not apply to kind='company'"],
			[{ kind: "companies", query: "x", country: "US" }, "ERROR: country does not apply to kind='companies'"],
			[{ kind: "search" }, "ERROR: query is required for kind='search'."],
			[{ kind: "company" }, "ERROR: kind='company' needs page_id (exact) or company_name."],
			[{ kind: "company", page_id: "1", company_name: "x" }, "ERROR: Provide page_id or company_name for kind='company', not both."],
			[{ kind: "company", page_id: "lululemon" }, "ERROR: page_id must be the numeric Ad Library page id"],
			[{ kind: "ad", ad_id: "1", url: "https://www.facebook.com/ads/library?id=1" }, "ERROR: Provide ad_id or url, not both."],
			[{ kind: "ad", ad_id: "abc" }, "ERROR: ad_id must be the numeric Ad Library id"],
			[{ kind: "transcript", url: "https://elsewhere.example/ads/library?id=1" }, "ERROR: url must be an Ad Library URL naming one ad"],
			[{ kind: "transcript", url: "https://www.facebook.com/ads/library/?q=shoes" }, "ERROR: url must be an Ad Library URL naming one ad"],
			[{ kind: "search", query: "x", country: "USA" }, "ERROR: country must be one two-letter country code"],
			[{ kind: "search", query: "x", language: "english" }, "ERROR: language must be a two-letter language code"],
			[{ kind: "search", query: "x", start_date: "2025-02-30" }, "ERROR: start_date must be a date in YYYY-MM-DD form."],
			[{ kind: "search", query: "x", start_date: "2025-03-01", end_date: "2025-02-01" }, "ERROR: start_date must not be after end_date."],
			[{ kind: "search", query: "x", status: "active" }, "ERROR: status must be one of ALL, ACTIVE, INACTIVE"],
		];
		for (const [args, expected] of refusals) expect(text(await library.execute(args, context))).toContain(expected);

		const controller = new AbortController();
		controller.abort();
		expect(text(await library.execute({ kind: "search", query: "x" }, { ...context, abort: controller.signal }))).toBe(
			"ERROR: Cancelled: ScrapeCreators Facebook Ad Library search cancelled before the request was sent",
		);

		delete process.env.SCRAPECREATORS_API_KEY;
		expect(await library.execute({ kind: "search", query: "x" }, context)).toBe("ERROR: SCRAPECREATORS_API_KEY not set. Get a key at https://scrapecreators.com");
		expect(mock.calls).toHaveLength(0);
	});

	test("output past the limit is cut with a pointer to the retained original, after the paging line", async () => {
		const huge = { ...searchAd, snapshot: { ...searchAd.snapshot, body: { text: "word ".repeat(15_000) } } };
		const mock = installFetchMock({ [SEARCH_PATH]: { success: true, credits_charged: 1, searchResults: [huge, { ...huge, ad_archive_id: "2" }], cursor: "AQH-after" } });
		restore = mock.restore;

		const result = await library.execute({ kind: "search", query: "x" }, context);
		const out = text(result);
		expect(out).toContain('Next page: pass cursor="AQH-after"');
		expect(out).toMatch(/\[Truncated at 60000 of \d+ characters\. The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file\.\]$/);
		expect(details(result)).toMatchObject({ truncated: true, ad_ids: ["615470338018648", "2"] });
	});
});
