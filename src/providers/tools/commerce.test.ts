import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { SourceToolResult, ToolContext, ToolSpec } from "../types.js";
import * as commerce from "./commerce.js";

const { product, search } = commerce;
/** History, reviews and discover can return an outcome with a status beside their text; most assertions read the text. */
function textOnly(spec: ToolSpec) {
	return {
		execute: async (args: unknown, ctx: ToolContext) => text(await spec.execute(args, ctx)),
	};
}
const text = (result: SourceToolResult) => (typeof result === "string" ? result : result.text);
const history = textOnly(commerce.history);
const reviews = textOnly(commerce.reviews);
const discover = textOnly(commerce.discover);

const ENDPOINT =
	"https://api.nexscope.ai/api/skill-api/v1/skills/amazon-product-price-series/run";
const REVIEWS_ENDPOINT =
	"https://api.nexscope.ai/api/skill-api/v1/skills/amazon-reviews-list/run";

type FetchCall = { url: URL; init: RequestInit | undefined };
type MockPayload = Record<string, unknown> | ((url: URL) => Record<string, unknown>);

function providerTime(daysAgo: number, hour = 12): string {
	const date = new Date();
	date.setUTCDate(date.getUTCDate() - daysAgo);
	date.setUTCHours(hour, 0, 0, 0);
	return date.toISOString().slice(0, 16).replace("T", " ");
}

function fixture() {
	return {
		errcode: 200,
		errmsg: "ok",
		asin: "B0DGHMNQ5Z",
		costToken: 1,
		price: [
			{ time: providerTime(120), value: 79 },
			{ time: providerTime(60), value: 99 },
			{ time: providerTime(30), value: 119.95 },
			{ time: providerTime(5), value: 89 },
			{ time: providerTime(1), value: -1 },
		],
		buyboxPrice: [],
		priceList: [],
		priceDeal: [],
		pricePrime: [],
		priceFba: [],
		priceFbm: [],
		priceCoupon: [],
		sellerCount: [],
		rating: [],
		ratingCount: [
			{ time: providerTime(60), value: 30000 },
			{ time: providerTime(5), value: 34000 },
		],
		monthlySold: [],
		bsrMain: [
			{
				categoryName: "Electronics",
				points: [
					{ time: providerTime(60), value: 8 },
					{ time: providerTime(5), value: 4 },
				],
			},
		],
		bsrSub: [],
	};
}

function installFetchMock(payload: MockPayload, status = 200) {
	const calls: FetchCall[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof URL ? input : new URL(String(input));
		calls.push({
			url,
			init,
		});
		const body = typeof payload === "function" ? payload(url) : payload;
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

const context: ToolContext = {
	sessionID: "commerce-history-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

describe("commerce_history Nexscope provider", () => {
	const originalApiKey = process.env.NEXSCOPE_API_KEY;
	const originalScrapeDoApiKey = process.env.SCRAPE_DO_API_KEY;
	let restoreFetch: (() => void) | undefined;

	beforeEach(() => {
		process.env.NEXSCOPE_API_KEY = "nk_test_key";
		process.env.SCRAPE_DO_API_KEY = "scrape-do-test-key";
	});

	afterEach(() => {
		restoreFetch?.();
		restoreFetch = undefined;
		if (originalApiKey === undefined) delete process.env.NEXSCOPE_API_KEY;
		else process.env.NEXSCOPE_API_KEY = originalApiKey;
		if (originalScrapeDoApiKey === undefined)
			delete process.env.SCRAPE_DO_API_KEY;
		else process.env.SCRAPE_DO_API_KEY = originalScrapeDoApiKey;
	});

	test("sends the selected series contract with bearer authentication", async () => {
		const mock = installFetchMock(fixture());
		restoreFetch = mock.restore;

		await history.execute(
			{
				asin: "b0dghmnq5z",
				amazon_domain: "amazon.com",
				days: 90,
				series: ["market_price", "review_count", "sales_rank"],
				max_points: 20,
			},
			context,
		);

		expect(mock.calls).toHaveLength(1);
		const [call] = mock.calls;
		expect(call.url.href).toBe(ENDPOINT);
		expect(call.init?.method).toBe("POST");
		expect(new Headers(call.init?.headers).get("Authorization")).toBe(
			"Bearer nk_test_key",
		);
		expect(call.init?.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(String(call.init?.body))).toEqual({
			asin: "B0DGHMNQ5Z",
			domain: "1",
			days: 90,
			showPrice: 1,
			showPriceList: 0,
			showPriceDeal: 0,
			showPricePrime: 0,
			showPriceFba: 0,
			showPriceFbm: 0,
			showPriceCoupon: 0,
			showBsrMain: 1,
			showSellerCount: 0,
		});
	});

	test("retains one carry-in event while filtering unavailable values", async () => {
		const payload = fixture();
		const mock = installFetchMock(payload);
		restoreFetch = mock.restore;

		const output = await executeSource(
			commerce.history,
			{
				asin: "B0DGHMNQ5Z",
				days: 90,
				series: ["market_price", "review_count", "sales_rank"],
				max_points: 20,
			},
			context,
		);
		// costToken is token consumption, not a documented charge: the call's cost stays unknown.
		expect(output.details?.cost).toBeNull();
		expect(output.details?.knownCost).toBeUndefined();
		const result = output.text;

		expect(result.startsWith("ERROR:")).toBe(false);
		expect(result).toContain("| Lowest new market price | 4 |");
		expect(result).toContain("$89.00");
		expect(result).toContain("$119.95");
		expect(result).toContain(`${providerTime(120)}, carry-in`);
		expect(result).not.toContain("| -1 |");
		expect(result).toContain("Main-category sales rank — Electronics");
		expect(result).toContain("Review count");
	});

	test("bounds displayed points without changing full observation counts", async () => {
		const payload = fixture();
		payload.price = Array.from({ length: 12 }, (_, index) => ({
			time: providerTime(12 - index, index),
			value: 80 + index,
		}));
		const mock = installFetchMock(payload);
		restoreFetch = mock.restore;

		const result = await history.execute(
			{ asin: "B0DGHMNQ5Z", days: 30, series: ["market_price"], max_points: 4 },
			context,
		);

		expect(result).toContain(
			"Full observations: 12. Displayed observations: 4.",
		);
	});

	test("surfaces provider errors and missing credentials honestly", async () => {
		const mock = installFetchMock({
			errcode: 402,
			errmsg: "Insufficient credits",
		});
		restoreFetch = mock.restore;
		const providerError = await history.execute(
			{ asin: "B0DGHMNQ5Z" },
			context,
		);
		expect(providerError).toBe(
			"ERROR: Commerce history lookup failed: Insufficient credits",
		);

		restoreFetch();
		restoreFetch = undefined;
		delete process.env.NEXSCOPE_API_KEY;
		const missingKey = await history.execute({ asin: "B0DGHMNQ5Z" }, context);
		expect(missingKey).toBe(
			"ERROR: Commerce history lookup failed: NEXSCOPE_API_KEY not set",
		);
	});

	test("rejects malformed ASINs before making a request", async () => {
		const mock = installFetchMock(fixture());
		restoreFetch = mock.restore;
		const result = await history.execute({ asin: "not-an-asin" }, context);
		expect(result).toBe(
			"ERROR: Commerce history lookup failed: ASIN must contain exactly 10 letters or digits",
		);
		expect(mock.calls).toHaveLength(0);
	});
	test("falls back to compact review labels when search returns a zero structured count", async () => {
		const mock = installFetchMock({
			status: "success",
			products: [
				{
					position: 1,
					title: "Example product",
					asin: "B0DGHMNQ5Z",
					url: "https://www.amazon.com/dp/B0DGHMNQ5Z",
					price: { amount: 99, currencyCode: "USD" },
					rating: { value: 4.5, count: 0 },
					reviewCount: "(34K)",
					isSponsored: false,
				},
			],
		});
		restoreFetch = mock.restore;

		const result = await search.execute(
			{ query: "example", limit: 1 },
			context,
		);

		expect(result).toContain("Rating: 4.5 | Ratings: 34,000");
		expect(result).toContain("Review count label: (34K)");
	});
});

describe("commerce Scrape.do enrichment", () => {
	const originalScrapeDoApiKey = process.env.SCRAPE_DO_API_KEY;
	let restoreFetch: (() => void) | undefined;

	beforeEach(() => {
		process.env.SCRAPE_DO_API_KEY = "scrape-do-test-key";
	});

	afterEach(() => {
		restoreFetch?.();
		restoreFetch = undefined;
		if (originalScrapeDoApiKey === undefined)
			delete process.env.SCRAPE_DO_API_KEY;
		else process.env.SCRAPE_DO_API_KEY = originalScrapeDoApiKey;
	});

	test("search forwards documented filters and omits ZIP localization for country-level Mexico", async () => {
		const mock = installFetchMock({
			status: "success",
			totalResults: "1-16 of over 10,000 results",
			total_results_extracted: 10000,
			products: [
				{
					position: 1,
					title: "Deal product",
					asin: "B0DGHMNQ5Z",
					price: { amount: 80, currencyCode: "MXN" },
					price_before_deal: { amount: 100, currencyCode: "MXN" },
					rating: { value: 4.2, count: 120 },
					sales_volume: "500+ bought in past month",
					delivery: { isFree: true, date: "Friday" },
				},
			],
			filters: [
				{ name: "Brand", options: [{ name: "Acme", rh: "p_123:456" }] },
			],
			categories: [{ name: "Electronics", node: "172282" }],
			related_searches: ["laptop riser"],
		});
		restoreFetch = mock.restore;

		const result = await search.execute(
			{
				query: "laptop stand",
				amazon_domain: "amazon.com.mx",
				sort: "price-asc-rank",
				refinement: "n:172282",
				node: "172282",
				low_price: 10,
				high_price: 99.5,
				seller: "A2L77EE7U53NWQ",
				language: "es",
			},
			context,
		);

		expect(mock.calls).toHaveLength(1);
		const params = mock.calls[0].url.searchParams;
		expect(mock.calls[0].url.pathname).toBe("/plugin/amazon/search");
		expect(params.get("geocode")).toBe("mx");
		expect(params.has("zipcode")).toBe(false);
		expect(params.has("countryName")).toBe(false);
		expect(params.get("s")).toBe("price-asc-rank");
		expect(params.get("rh")).toBe("n:172282");
		expect(params.get("node")).toBe("172282");
		expect(params.get("low_price")).toBe("10");
		expect(params.get("high_price")).toBe("99.5");
		expect(params.get("seller")).toBe("A2L77EE7U53NWQ");
		expect(params.get("language")).toBe("ES");
		expect(result.startsWith("ERROR:")).toBe(false);
		expect(result).toContain("Country-level marketplace (mx)");
		expect(result).toContain(
			"Savings vs. reference (computed locally): 20.0%",
		);
		expect(result).toContain("Sales volume text: 500+ bought in past month");
		expect(result).toContain("Delivery: Free | Friday");
		expect(result).toContain("Brand: Acme (rh=p_123:456)");
		expect(result).toContain("Electronics (node=172282)");
		expect(result).toContain("laptop riser");
	});

	test("search keeps ZIP localization for ZIP-level marketplaces and requires a query or seller", async () => {
		const mock = installFetchMock({ status: "success", products: [] });
		restoreFetch = mock.restore;

		const missing = await search.execute({}, context);
		expect(missing).toBe(
			"ERROR: Commerce search failed: Provide a query, a seller id, or both",
		);
		expect(mock.calls).toHaveLength(0);

		await search.execute({ seller: "A2L77EE7U53NWQ" }, context);
		expect(mock.calls).toHaveLength(1);
		const params = mock.calls[0].url.searchParams;
		expect(params.get("geocode")).toBe("us");
		expect(params.get("zipcode")).toBe("10001");
		expect(params.has("keyword")).toBe(false);
	});

	test("product reports null stock as unknown and surfaces PDP badges and parent ASIN", async () => {
		const mock = installFetchMock((url) =>
			url.pathname.endsWith("/pdp")
				? {
						status: "success",
						asin: "B0DGHMNQ5Z",
						parent_asin: "B0PARENT01",
						name: "Example product",
						price: 14.99,
						currency: "USD",
						in_stock: null,
						all_badges: ["#1 Best Seller"],
						amazon_choice: false,
						best_seller: true,
						description: "Long-form description.",
					}
				: {
						status: "success",
						offers: [
							{
								merchantName: "Acme",
								sellerId: "A2L77EE7U53NWQ",
								listingPrice: { amount: 14.99, currencyCode: "USD" },
								discount: { percentage: 25, amount: 5, currencyCode: "USD" },
								isBuyBoxWinner: true,
							},
						],
					},
		);
		restoreFetch = mock.restore;

		const result = await product.execute({ asin: "B0DGHMNQ5Z" }, context);

		expect(mock.calls.map((call) => call.url.pathname)).toEqual([
			"/plugin/amazon/pdp",
			"/plugin/amazon/offer-listing",
		]);
		expect(result).toContain("In stock: Unknown (page shows no stock signal)");
		expect(result).toContain(
			"Parent ASIN: B0PARENT01 (variation family; siblings share it)",
		);
		expect(result).toContain("#1 Best Seller badge: Yes");
		expect(result).toContain("Badges shown: #1 Best Seller");
		expect(result).toContain("Long-form description.");
		expect(result).toContain("Provider-reported discount: 25.0%");
		expect(result).toContain("`commerce_reviews`");
	});

	test("discover deals sends scope parameters and computes savings from both prices", async () => {
		const mock = installFetchMock({
			node: "172282",
			page: 2,
			products: [
				{
					asin: "B0B5V2YZPZ",
					title: "Dehumidifier",
					price: { currencyCode: "USD", amount: 15.99 },
					price_before_deal: { currencyCode: "USD", amount: 19.99 },
					rating: { value: 4.5, count: 1284 },
					position: 1,
				},
			],
			pagination: { current_page: 2, has_next: true },
		});
		restoreFetch = mock.restore;

		const result = await discover.execute(
			{
				kind: "deals",
				node: "172282",
				low_price: 10,
				high_price: 50,
				sort_by: "price_low_to_high",
				page: 2,
			},
			context,
		);

		const params = mock.calls[0].url.searchParams;
		expect(mock.calls[0].url.pathname).toBe("/plugin/amazon/deals");
		expect(params.get("node")).toBe("172282");
		expect(params.get("low_price")).toBe("10");
		expect(params.get("high_price")).toBe("50");
		expect(params.get("sort_by")).toBe("price_low_to_high");
		expect(params.get("page")).toBe("2");
		expect(result).toContain("Page: 2 | Next page available: Yes");
		expect(result).toContain(
			"Savings vs. reference (computed locally): 20.0%",
		);
	});

	test("discover rejects out-of-range pages before any request", async () => {
		const mock = installFetchMock({ products: [] });
		restoreFetch = mock.restore;

		const deals = await discover.execute({ kind: "deals", page: 21 }, context);
		expect(deals).toBe(
			"ERROR: Commerce discover failed: Deals page must be an integer from 1 to 20",
		);
		const chart = await discover.execute(
			{ kind: "bestsellers", category: "electronics", page: 3 },
			context,
		);
		expect(chart).toBe(
			"ERROR: Commerce discover failed: Chart page must be an integer from 1 to 2",
		);
		const missingCategory = await discover.execute(
			{ kind: "new_releases" },
			context,
		);
		expect(missingCategory.startsWith("ERROR: Commerce discover failed: category is required")).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});

	test("discover rejects arguments the chosen kind cannot send instead of silently dropping them", async () => {
		const mock = installFetchMock({ ranking: [], products: [] });
		restoreFetch = mock.restore;

		expect(
			await discover.execute({ kind: "bestsellers", category: "electronics", high_price: 25 }, context),
		).toBe(
			"ERROR: Commerce discover failed: high_price does not apply to kind=bestsellers and would not be sent to the provider; kind=bestsellers accepts kind, amazon_domain, provider, category, node, page, limit, language",
		);
		expect((await discover.execute({ kind: "new_releases", category: "electronics", sort_by: "price_low_to_high", refinement: "p_36:1" }, context)).startsWith("ERROR: Commerce discover failed: refinement, sort_by do not apply to kind=new_releases")).toBe(true);
		expect((await discover.execute({ kind: "seller", seller: "A2L77EE7U53NWQ", page: 2 }, context)).startsWith("ERROR: Commerce discover failed: page does not apply to kind=seller")).toBe(true);
		expect((await discover.execute({ kind: "deals", category: "electronics" }, context)).startsWith("ERROR: Commerce discover failed: category does not apply to kind=deals")).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});

	test("discover charts join ranking and product cards and request the new-releases type", async () => {
		const mock = installFetchMock({
			category: "electronics",
			type: "new-releases",
			page: 1,
			ranking: [
				{ rank: 1, asin: "B08JHCVHTY", url: "https://www.amazon.com/dp/B08JHCVHTY" },
				{ rank: 2, asin: "B0GJTFXNRX", url: "https://www.amazon.com/dp/B0GJTFXNRX" },
			],
			products: [
				{
					rank: 1,
					asin: "B08JHCVHTY",
					title: "blink plus plan",
					price: { currencyCode: "USD", amount: 11.99 },
					rating: { value: 4.4, count: 279563 },
					reviewCount: "(279.5K)",
				},
			],
			ranking_count: 2,
			products_count: 1,
			pagination: { current_page: 1, has_next: false },
		});
		restoreFetch = mock.restore;

		const result = await discover.execute(
			{ kind: "new_releases", category: "electronics", amazon_domain: "amazon.co.uk" },
			context,
		);

		const params = mock.calls[0].url.searchParams;
		expect(mock.calls[0].url.pathname).toBe("/plugin/amazon/bestsellers");
		expect(params.get("type")).toBe("new-releases");
		expect(params.get("category")).toBe("electronics");
		expect(params.get("geocode")).toBe("gb");
		expect(result).toContain("# Commerce Discover — New Releases");
		expect(result).toContain("Chart entries returned: 2 | Entries with full product cards: 1");
		expect(result).toContain("- #1 **blink plus plan**");
		expect(result).toContain("- #2 B0GJTFXNRX (https://www.amazon.com/dp/B0GJTFXNRX)");
		expect(result).toContain("Next page available: No");
	});

	test("discover seller keeps absent feedback and business details explicit", async () => {
		const mock = installFetchMock({
			seller_id: "A2L77EE7U53NWQ",
			name: "Acme Direct",
			business_details: {
				business_name: "Acme LLC",
				business_address: ["1 Main St", "10001", "US"],
				fields: { "Business Name": "Acme LLC", "Trading Since": "2019" },
			},
		});
		restoreFetch = mock.restore;

		const result = await discover.execute(
			{ kind: "seller", seller: "A2L77EE7U53NWQ" },
			context,
		);

		expect(mock.calls[0].url.pathname).toBe("/plugin/amazon/seller");
		expect(mock.calls[0].url.searchParams.get("seller")).toBe("A2L77EE7U53NWQ");
		expect(result).toContain("Positive feedback: Not shown on seller page");
		expect(result).toContain("Business name: Acme LLC");
		expect(result).toContain("Address: 1 Main St, 10001, US");
		expect(result).toContain("Trading Since: 2019");
		expect(result).not.toContain("Business Name: Acme LLC");
	});

	test("rejects price bounds with more than two decimals or inverted order before any request", async () => {
		const mock = installFetchMock({ status: "success", products: [] });
		restoreFetch = mock.restore;

		expect(await search.execute({ query: "x", low_price: 10.999 }, context)).toBe(
			"ERROR: Commerce search failed: low_price must be a non-negative number with at most two decimals",
		);
		expect(await search.execute({ query: "x", low_price: 50, high_price: 20 }, context)).toBe(
			"ERROR: Commerce search failed: low_price must not exceed high_price",
		);
		expect(await discover.execute({ kind: "deals", high_price: 1.005 }, context)).toBe(
			"ERROR: Commerce discover failed: high_price must be a non-negative number with at most two decimals",
		);
		expect(await search.execute({ query: "x", page: 1.5 }, context)).toBe(
			"ERROR: Commerce search failed: page must be an integer of at least 1",
		);
		expect(mock.calls).toHaveLength(0);

		// 0.29 * 100 and 19.99 * 100 are inexact in binary; both must pass the decimal guard.
		await search.execute({ query: "x", low_price: 0.29, high_price: 19.99 }, context);
		expect(mock.calls[0].url.searchParams.get("low_price")).toBe("0.29");
		expect(mock.calls[0].url.searchParams.get("high_price")).toBe("19.99");
	});

	test("treats a 200 without the documented arrays or identity fields as malformed", async () => {
		const mock = installFetchMock({});
		restoreFetch = mock.restore;

		expect(await search.execute({ query: "x" }, context)).toBe(
			"ERROR: Commerce search failed: Scrape.do search returned a response without the documented `products` array",
		);
		expect(await discover.execute({ kind: "deals" }, context)).toBe(
			"ERROR: Commerce discover failed: Scrape.do deals returned a response without the documented `products` array",
		);
		expect(await discover.execute({ kind: "bestsellers", category: "electronics" }, context)).toBe(
			"ERROR: Commerce discover failed: Scrape.do bestsellers returned a response without the documented `ranking` array",
		);
		expect(await discover.execute({ kind: "seller", seller: "A2L77EE7U53NWQ" }, context)).toBe(
			"ERROR: Commerce discover failed: Scrape.do returned a seller response without the documented `seller_id`/`name` fields",
		);
		expect(await product.execute({ asin: "B0DGHMNQ5Z" }, context)).toBe(
			"ERROR: Commerce product lookup failed: Scrape.do returned a PDP response without the documented `asin`/`name` fields",
		);

		restoreFetch();
		const empty = installFetchMock({ status: "success", products: [], ranking: [], ranking_count: 0, products_count: 0 });
		restoreFetch = empty.restore;
		const chart = await commerce.discover.execute({ kind: "bestsellers", category: "electronics" }, context);
		expect(typeof chart === "string" ? undefined : chart.status).toBe("empty");
		expect(text(chart)).toContain("The provider returned an empty chart");
	});

	test("redacts the Scrape.do token from provider error echoes", async () => {
		const mock = installFetchMock(
			{ error: "invalid_zipcode", message: "bad request for token scrape-do-test-key" },
			400,
		);
		restoreFetch = mock.restore;

		const result = await search.execute({ query: "x" }, context);
		expect(result).toBe(
			"ERROR: Commerce search failed: 400: bad request for token [redacted]",
		);
	});

	test("redacts the Scrape.do token from the empty-result raw response excerpt", async () => {
		const mock = installFetchMock({
			status: "success",
			products: [],
			debug: "request token scrape-do-test-key",
		});
		restoreFetch = mock.restore;

		const result = await search.execute({ query: "x" }, context);
		expect(result.startsWith("ERROR:")).toBe(false);
		expect(result).toContain("## Raw Response Excerpt");
		expect(result).not.toContain("scrape-do-test-key");
		expect(result).toContain('"debug": "request token [redacted]"');
	});
});

describe("commerce Scrape.do billing", () => {
	const originalScrapeDoApiKey = process.env.SCRAPE_DO_API_KEY;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		process.env.SCRAPE_DO_API_KEY = "scrape-do-test-key";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalScrapeDoApiKey === undefined)
			delete process.env.SCRAPE_DO_API_KEY;
		else process.env.SCRAPE_DO_API_KEY = originalScrapeDoApiKey;
	});

	/** A Scrape.do reply carrying its documented per-request charge header when one is given. */
	function reply(body: Record<string, unknown>, cost?: string): Response {
		return Response.json(body, { headers: cost === undefined ? {} : { "Scrape.do-Request-Cost": cost } });
	}

	function route(replies: Record<string, () => Response>) {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = input instanceof URL ? input : new URL(String(input));
			const next = replies[url.pathname];
			if (!next) throw new Error(`Unexpected request ${url.pathname}`);
			return next();
		}) as typeof fetch;
	}

	const pdp = { status: "success", asin: "B0DGHMNQ5Z", name: "Example product" };

	test("search records the request-cost header in Scrape.do credits, including a reported zero on a failed body", async () => {
		route({ "/plugin/amazon/search": () => reply({ status: "success", products: [{ title: "Example product", asin: "B0DGHMNQ5Z" }] }, "1") });
		const charged = await executeSource(search, { query: "usb c cable" }, context);
		expect(charged.status).toBe("success");
		expect(charged.details?.cost).toEqual([{ amount: 1, unit: "Scrape.do credits" }]);

		route({ "/plugin/amazon/search": () => reply({ status: "failed", errorMessage: "Amazon page could not be read" }, "0") });
		const failed = await executeSource(search, { query: "usb c cable" }, context);
		expect(failed.status).toBe("failed");
		expect(failed.details?.cost).toEqual([]);
	});

	test("product sums both requests' headers; an unparseable header leaves the total unknown with the reported subtotal", async () => {
		route({
			"/plugin/amazon/pdp": () => reply(pdp, "1"),
			"/plugin/amazon/offer-listing": () => reply({ status: "success", offers: [] }, "1"),
		});
		const complete = await executeSource(product, { asin: "B0DGHMNQ5Z" }, context);
		expect(complete.details?.cost).toEqual([{ amount: 2, unit: "Scrape.do credits" }]);

		route({
			"/plugin/amazon/pdp": () => reply(pdp, "1"),
			"/plugin/amazon/offer-listing": () => reply({ status: "success", offers: [] }, "one credit"),
		});
		const partial = await executeSource(product, { asin: "B0DGHMNQ5Z" }, context);
		expect(partial.status).toBe("success");
		expect(partial.details?.cost).toBeNull();
		expect(partial.details?.knownCost).toEqual([{ amount: 1, unit: "Scrape.do credits" }]);
	});

	test("cancellation while reading a header-priced response keeps its charge exactly once", async () => {
		const controller = new AbortController();
		const kept: unknown[][] = [];
		route({
			"/plugin/amazon/search": () => {
				const response = reply({}, "1");
				response.text = async () => {
					controller.abort();
					throw new DOMException("Body read aborted", "AbortError");
				};
				return response;
			},
		});
		const result = await executeSource(search, { query: "usb c cable" }, {
			...context, abort: controller.signal, keep: (...entry) => kept.push(entry),
		});
		expect(result.status).toBe("cancelled");
		expect(result.details?.cost).toBeNull();
		expect(result.details?.knownCost).toEqual([{ amount: 1, unit: "Scrape.do credits" }]);
		expect(kept).toEqual([["search", 200, "", { "scrape.do-request-cost": "1" }]]);
	});

	test("cancellation during the second product request keeps the first request's reported charge as a subtotal", async () => {
		const controller = new AbortController();
		route({
			"/plugin/amazon/pdp": () => reply(pdp, "1"),
			"/plugin/amazon/offer-listing": () => {
				controller.abort();
				throw new DOMException("The operation was aborted.", "AbortError");
			},
		});
		const result = await executeSource(product, { asin: "B0DGHMNQ5Z" }, { ...context, abort: controller.signal });
		expect(result.status).toBe("cancelled");
		expect(result.details?.cost).toBeNull();
		expect(result.details?.knownCost).toEqual([{ amount: 1, unit: "Scrape.do credits" }]);
	});
});

describe("commerce_reviews Nexscope provider", () => {
	const originalApiKey = process.env.NEXSCOPE_API_KEY;
	let restoreFetch: (() => void) | undefined;

	beforeEach(() => {
		process.env.NEXSCOPE_API_KEY = "nk_test_key";
	});

	afterEach(() => {
		restoreFetch?.();
		restoreFetch = undefined;
		if (originalApiKey === undefined) delete process.env.NEXSCOPE_API_KEY;
		else process.env.NEXSCOPE_API_KEY = originalApiKey;
	});

	test("sends the documented review request and renders reviews from either payload array", async () => {
		const mock = installFetchMock({
			errcode: 200,
			total: 2,
			costToken: 3,
			data: [
				{
					reviewId: "R1",
					rating: "5",
					title: "Great",
					text: "Works well.",
					date: "2026-01-01",
					userName: "Ann",
					verified: true,
					vine: false,
					numberOfHelpful: 4,
					imageUrlList: ["https://example.invalid/a.jpg"],
					videoUrlList: [],
					productTitle: "Example product",
					productRating: "4.6",
					countRatings: 2712,
					countReviews: 900,
				},
			],
			columns: [
				{ reviewId: "R1", rating: "5", title: "Great", text: "Works well." },
				{ reviewId: "R2", rating: "1", title: "Broke", text: "Failed fast.", verified: false },
			],
		});
		restoreFetch = mock.restore;

		const result = await reviews.execute(
			{
				asin: "b0dghmnq5z",
				amazon_domain: "amazon.co.uk",
				stars: [1, 5],
				per_star_limit: 3,
				keyword: "battery",
				sort: "helpful",
				verified_only: true,
			},
			context,
		);

		expect(mock.calls).toHaveLength(1);
		const [call] = mock.calls;
		expect(call.url.href).toBe(REVIEWS_ENDPOINT);
		expect(new Headers(call.init?.headers).get("Authorization")).toBe(
			"Bearer nk_test_key",
		);
		expect(JSON.parse(String(call.init?.body))).toEqual({
			asin: "B0DGHMNQ5Z",
			domainCode: "co.uk",
			star1Num: 3,
			star2Num: 0,
			star3Num: 0,
			star4Num: 0,
			star5Num: 3,
			filterByKeyword: "battery",
			sortBy: "helpful",
			reviewerType: "avp_only_reviews",
			mediaType: "all_contents",
			formatType: "all_formats",
		});
		expect(result.startsWith("ERROR:")).toBe(false);
		expect(result).toContain("Provider-reported total: 2");
		expect(result).toContain("Returned reviews: 2");
		expect(result).toContain("Title: Example product");
		expect(result).toContain("Ratings count: 2,712 | Reviews count: 900");
		expect(result).toContain("- 5 star: 1");
		expect(result).toContain("- 3 star: 0 (not requested)");
		expect(result).toContain("**Great** — 5 star");
		expect(result).toContain("Verified purchase: Yes | Vine: No | Helpful votes: 4");
		expect(result).toContain("Media: 1 image(s), 0 video(s)");
		expect(result).toContain("**Broke** — 1 star");
		expect(result).toContain("Verified purchase: No | Vine: Unknown | Helpful votes: Unavailable");
	});

	test("rejects invalid stars and malformed ASINs before making a request", async () => {
		const mock = installFetchMock({ errcode: 200, data: [] });
		restoreFetch = mock.restore;

		expect(await reviews.execute({ asin: "B0DGHMNQ5Z", stars: [6] }, context)).toBe(
			"ERROR: Commerce reviews lookup failed: stars must be an integer from 1 to 5",
		);
		expect(
			await reviews.execute({ asin: "B0DGHMNQ5Z", per_star_limit: 1.5 }, context),
		).toBe(
			"ERROR: Commerce reviews lookup failed: per_star_limit must be an integer from 1 to 100",
		);
		expect(
			await reviews.execute({ asin: "B0DGHMNQ5Z", amazon_domain: "amazon.ie" }, context),
		).toContain("amazon_domain must be one of the Nexscope reviews marketplaces");
		expect(await reviews.execute({ asin: "nope" }, context)).toBe(
			"ERROR: Commerce reviews lookup failed: ASIN must contain exactly 10 letters or digits",
		);
		expect(mock.calls).toHaveLength(0);
	});

	test("treats a 200 without the documented review arrays as malformed, not empty", async () => {
		const mock = installFetchMock({ errcode: 200 });
		restoreFetch = mock.restore;

		const result = await reviews.execute({ asin: "B0DGHMNQ5Z" }, context);
		expect(result).toBe(
			"ERROR: Commerce reviews lookup failed: Nexscope returned a response without the documented `data`/`columns` review arrays",
		);

		restoreFetch();
		const empty = installFetchMock({ errcode: 200, total: 0, data: [], columns: [] });
		restoreFetch = empty.restore;
		const none = await reviews.execute({ asin: "B0DGHMNQ5Z" }, context);
		expect(none.startsWith("ERROR:")).toBe(false);
		expect(none).toContain("Returned reviews: 0");
		expect(none).toContain("No reviews were returned for the requested filters.");
	});

	test("redacts the Nexscope key from the empty-result raw response excerpt", async () => {
		const mock = installFetchMock({
			errcode: 200,
			data: [],
			columns: [],
			debug: "request credential nk_test_key",
		});
		restoreFetch = mock.restore;

		const result = await reviews.execute({ asin: "B0DGHMNQ5Z" }, context);
		expect(result.startsWith("ERROR:")).toBe(false);
		expect(result).toContain("## Raw Response Excerpt");
		expect(result).not.toContain("nk_test_key");
		expect(result).toContain('"debug": "request credential [redacted]"');
	});

	test("reports the live-observed HTTP 200 gateway credit error as a provider failure", async () => {
		// Exact envelope captured by the parent's live smoke on 2026-09-15
		// (/tmp/dig-live-receipts/commerce-reviews-1789505508436.json).
		const envelope = {
			code: 13011,
			msg: "Not enough credits. Add credits or subscribe to continue",
			data: null,
			ts: "1789505508602",
			time: "2026-09-15 20:51:48",
			cost: "-1",
			traceId: "8ab1786d425b41e6a2f83cb8e162ff61",
		};
		const mock = installFetchMock(envelope);
		restoreFetch = mock.restore;

		const expected =
			"Not enough credits. Add credits or subscribe to continue (Nexscope code 13011, traceId 8ab1786d425b41e6a2f83cb8e162ff61)";
		expect(await reviews.execute({ asin: "B0DGHMNQ5Z" }, context)).toBe(
			`ERROR: Commerce reviews lookup failed: ${expected}`,
		);
		expect(await history.execute({ asin: "B0DGHMNQ5Z" }, context)).toBe(
			`ERROR: Commerce history lookup failed: ${expected}`,
		);
		expect(mock.calls).toHaveLength(2);
	});
});
