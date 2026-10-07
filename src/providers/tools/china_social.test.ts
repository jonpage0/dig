import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import type { SourceToolResult, ToolContext } from "../types.js";
import { search } from "./china_social.js";

const PATHS = {
	xiaohongshu: "/api/v1/xiaohongshu/app_v2/search_notes",
	bilibili: "/api/v1/bilibili/web/fetch_general_search",
	douyin: "/api/v1/douyin/search/fetch_video_search_v2",
	weibo: "/api/v1/weibo/web_v2/fetch_advanced_search",
	zhihu: "/api/v1/zhihu/web/fetch_article_search_v3",
	kuaishou: "/api/v1/kuaishou/app/search_comprehensive",
	wechat: "/api/v1/wechat_search/v2/fetch_search",
	justone: "/api/search/v1",
} as const;

type FetchCall = { url: URL; init: RequestInit | undefined };

function resultText(result: SourceToolResult): string {
	return typeof result === "string" ? result : result.text;
}

function buildFixtures(): Record<string, unknown> {
	return {
		[PATHS.xiaohongshu]: {
			code: 200,
			request_id: "req-xhs",
			data: {
				data: {
					items: [
						{
							note: {
								note_id: "671f0a0000000000000001",
								display_title: "迈阿密夜生活探店合集",
								desc: "含门票优惠码,一次搞定拼盘攻略",
								time: 1751500800,
								user: { nickname: "夜猫子探店" },
								interact_info: {
									liked_count: 2500,
									comment_count: 42,
									share_count: 8,
									collected_count: 150,
								},
								tag_list: [{ name: "夜生活" }, { name: "探店" }],
							},
						},
					],
				},
			},
		},
		[PATHS.bilibili]: {
			code: 200,
			request_id: "req-bili",
			data: {
				result: [
					{
						bvid: "BV1TEST00001",
						title: "B站人工智能观察",
						description: "视频摘要",
						author: "科技观察员",
						arcurl: "https://www.bilibili.com/video/BV1TEST00001",
						play: 1200,
						like: 88,
						video_review: 12,
					},
				],
			},
		},
		[PATHS.douyin]: {
			code: 200,
			request_id: "req-douyin",
			data: {
				data: [
					{
						aweme_info: {
							aweme_id: "7450000000000000001",
							desc: "抖音人工智能趋势",
							author: { nickname: "趋势研究所" },
							statistics: { play_count: 5000, digg_count: 300, comment_count: 20 },
							share_url: "https://www.douyin.com/video/7450000000000000001",
						},
					},
				],
			},
		},
		[PATHS.weibo]: {
			code: 200,
			request_id: "req-weibo",
			data: {
				data: {
					cards: [
						{
							mblog: {
								idstr: "5190000000000001",
								text_raw: "微博人工智能讨论",
								user: { screen_name: "公开讨论者" },
								attitudes_count: 40,
								comments_count: 6,
								reposts_count: 3,
							},
						},
					],
				},
			},
		},
		[PATHS.zhihu]: {
			code: 200,
			request_id: "req-zhihu",
			data: [
				{
					type: "search_result",
					object: {
						type: "answer",
						id: "123456789",
						question: { id: "987654321", title: "如何理解人工智能趋势？" },
						author: { name: "知乎研究员" },
						excerpt: "回答摘要",
						voteup_count: 91,
						comment_count: 7,
					},
				},
			],
		},
		[PATHS.kuaishou]: {
			code: 200,
			request_id: "req-kuaishou",
			data: {
				recoPcursor: "next-kuaishou",
				mixFeeds: [
					{
						feed: {
							share_info: "userId=user-1&photoId=ks-1",
							caption: "快手人工智能观察 #人工智能",
							user_name: "快手观察员",
							timestamp: 1750473958496,
							view_count: 700,
							like_count: 80,
							comment_count: 9,
							share_count: 3,
						},
					},
				],
			},
		},
		[PATHS.wechat]: {
			code: 200,
			request_id: "req-wechat",
			data: {
				cursor: "next-wechat",
				count: 1,
				items: [
					{
						id: "wx-1",
						title: "微信人工智能文章",
						url: "https://mp.weixin.qq.com/s/wx-1",
						author: { name: "微信观察" },
					},
				],
			},
		},
	};
}

function installFetchRouter(fixtures: Record<string, unknown>) {
	const calls: FetchCall[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof URL ? input : new URL(String(input));
		calls.push({ url, init });
		const payload = fixtures[url.pathname];
		if (payload === undefined) {
			return new Response(JSON.stringify({ code: 404, message: "Not Found" }), {
				status: 404,
				statusText: "Not Found",
			});
		}
		return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
			status: 200,
			headers: { "x-request-id": `header-${calls.length}` },
		});
	}) as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

const ctx: ToolContext = {
	sessionID: "test-session",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

describe("china_social_search providers", () => {
	const originalTikHubKey = process.env.TIKHUB_API_KEY;
	const originalJustOneKey = process.env.JUSTONE_API_KEY;
	let restoreFetch: (() => void) | undefined;

	beforeEach(() => {
		process.env.TIKHUB_API_KEY = "test-tikhub-key";
		process.env.JUSTONE_API_KEY = "test-justone-key";
	});

	afterEach(() => {
		restoreFetch?.();
		restoreFetch = undefined;
		if (originalTikHubKey === undefined) delete process.env.TIKHUB_API_KEY;
		else process.env.TIKHUB_API_KEY = originalTikHubKey;
		if (originalJustOneKey === undefined) delete process.env.JUSTONE_API_KEY;
		else process.env.JUSTONE_API_KEY = originalJustOneKey;
	});

	test("normalizes the Xiaohongshu nested note contract and returns structured run evidence", async () => {
		const mock = installFetchRouter(buildFixtures());
		restoreFetch = mock.restore;
		const result = await search.execute({ query: "夜生活", platforms: ["xiaohongshu"] }, ctx);
		const text = resultText(result);

		expect(text.startsWith("ERROR:")).toBe(false);
		expect(text).toContain("**迈阿密夜生活探店合集**");
		expect(text).toContain("Author: 夜猫子探店");
		expect(text).toContain("Run evidence: HTTP 200 | Attempts 1");
		expect(typeof result).toBe("object");
		if (typeof result !== "string") {
			expect(result.details?.successfulPlatforms).toEqual(["xiaohongshu"]);
			expect(result.details?.totalItems).toBe(1);
		}
	});

	test("uses current endpoints and normalizes every exposed TikHub platform", async () => {
		const mock = installFetchRouter(buildFixtures());
		restoreFetch = mock.restore;
		const cases = [
			["bilibili", "B站人工智能观察"],
			["douyin", "抖音人工智能趋势"],
			["weibo", "微博人工智能讨论"],
			["zhihu", "如何理解人工智能趋势？"],
			["kuaishou", "快手人工智能观察"],
			["wechat", "微信人工智能文章"],
		] as const;

		for (const [platform, expectedTitle] of cases) {
			const result = await search.execute({ query: "人工智能", platforms: [platform] }, ctx);
			expect(resultText(result)).toContain(expectedTitle);
		}

		expect(mock.calls.map((call) => call.url.pathname)).toEqual(cases.map(([platform]) => PATHS[platform]));
		expect(mock.calls.find((call) => call.url.pathname === PATHS.weibo)?.url.searchParams.get("q")).toBe("人工智能");
		expect(mock.calls.find((call) => call.url.pathname === PATHS.weibo)?.url.searchParams.get("search_type")).toBe("all");
		expect(mock.calls.find((call) => call.url.pathname === PATHS.weibo)?.url.searchParams.get("page")).toBe("1");
		const wechatCall = mock.calls.find((call) => call.url.pathname === PATHS.wechat);
		expect(wechatCall?.init?.method).toBe("POST");
		expect(JSON.parse(String(wechatCall?.init?.body))).toMatchObject({
			business_type: "all",
			sort: "default",
			publish_time: "all",
			raw: false,
		});
	});

	test("applies page, cursor, sort, and platform-specific filters", async () => {
		const mock = installFetchRouter(buildFixtures());
		restoreFetch = mock.restore;
		const kuaishou = await search.execute(
			{
				query: "人工智能",
				platforms: ["kuaishou"],
				cursor: "cursor-in",
				sort: "hot",
				time_range: "week",
			},
			ctx,
		);
		expect(resultText(kuaishou)).toContain("Next cursor: next-kuaishou");
		const call = mock.calls[0];
		expect(call.url.searchParams.get("pcursor")).toBe("cursor-in");
		expect(call.url.searchParams.get("sort_type")).toBe("most_likes");
		expect(call.url.searchParams.get("publish_time")).toBe("one_week");
	});

	test("supports the Just One cross-platform backend when credentialed", async () => {
		const fixtures = {
			[PATHS.justone]: {
				code: 0,
				requestId: "req-justone",
				data: JSON.stringify({
					nextCursor: "next-justone",
					items: [
						{
							id: "jo-1",
							title: "Just One 微博结果",
							url: "https://weibo.com/jo-1",
							author: { name: "聚合作者" },
						},
					],
				}),
			},
		};
		const mock = installFetchRouter(fixtures);
		restoreFetch = mock.restore;
		const result = await search.execute(
			{ query: "人工智能", platforms: ["weibo"], provider: "justone", justone_start: "2026-09-01 00:00:00", justone_end: "2026-09-15 00:00:00" },
			ctx,
		);

		expect(resultText(result)).toContain("Just One 微博结果");
		expect(mock.calls[0]?.url.pathname).toBe(PATHS.justone);
		expect(mock.calls[0]?.url.searchParams.get("token")).toBe("test-justone-key");
		expect(mock.calls[0]?.url.searchParams.get("source")).toBe("WEIBO");
		expect(mock.calls[0]?.init?.method).toBe("GET");
		expect(resultText(result)).toContain("next-justone");
		expect(resultText(result)).toContain("req-justone");
		expect(resultText(result)).not.toContain("test-justone-key");
	});

	test("XHS pagination preserves both session IDs and refuses guessed page state", async () => {
		const mock = installFetchRouter({
			[PATHS.xiaohongshu]: { code: 200, data: { data: { items: [], search_id: "search-A", search_session_id: "session-B", has_more: true } } },
		});
		restoreFetch = mock.restore;
		const first = await search.execute({ query: "猫咪", platforms: ["xiaohongshu"] }, ctx);
		if (typeof first === "string") throw new Error(first);
		const runs = first.details?.runs as Array<{ nextCursor: unknown }>;
		expect(runs[0]?.nextCursor).toEqual({ search_id: "search-A", search_session_id: "session-B" });
		await search.execute({ query: "猫咪", platforms: ["xiaohongshu"], page: 2, cursor: runs[0]?.nextCursor }, ctx);
		expect(mock.calls[1]?.url.searchParams.get("search_id")).toBe("search-A");
		expect(mock.calls[1]?.url.searchParams.get("search_session_id")).toBe("session-B");
		const rejected = await search.execute({ query: "猫咪", platforms: ["xiaohongshu"], page: 3 }, ctx);
		expect((resultText(rejected)).startsWith("ERROR:")).toBe(true);
		expect(mock.calls).toHaveLength(2);
	});

	test("Douyin reuses returned offset/backtrace rather than deriving a page offset", async () => {
		const state = { cursor: 37, search_id: "search-D", backtrace: " opaque +/== " };
		const mock = installFetchRouter({ [PATHS.douyin]: { code: 200, data: { ...state, has_more: 1, business_data: [] } } });
		restoreFetch = mock.restore;
		const first = await search.execute({ query: "猫咪", platforms: ["douyin"], sort: "hot", time_range: "week" }, ctx);
		if (typeof first === "string") throw new Error(first);
		const runs = first.details?.runs as Array<{ nextCursor: unknown }>;
		expect(runs[0]?.nextCursor).toEqual(state);
		await search.execute({ query: "猫咪", platforms: ["douyin"], sort: "hot", time_range: "week", cursor: runs[0]?.nextCursor }, ctx);
		expect(JSON.parse(String(mock.calls[1]?.init?.body))).toMatchObject({ ...state, sort_type: "1", publish_time: "7", content_type: "0" });
		expect((resultText(await search.execute({ query: "猫咪", platforms: ["douyin"], page: 2 }, ctx))).startsWith("ERROR:")).toBe(true);
		expect(mock.calls).toHaveLength(2);
	});

	test("WeChat preserves exact large document/video IDs and account availability", async () => {
		const mock = installFetchRouter({
			[PATHS.wechat]: '{"code":200,"data":{"count":1,"continue_flag":1,"cursor":" wx +/== ","categories":[{"type":33554499,"word":"公众号"}],"items":[{"title":"示例公众号","docID":18446744073709551613,"exportId":"video-E","jumpInfo":{"userName":"gh_example","nickName":"示例作者","extInfo":{"feedNonceId":18446744073709551611}}}]}}',
		});
		restoreFetch = mock.restore;
		const result = await search.execute({ query: "示例", platforms: ["wechat"] }, ctx);
		expect(resultText(result)).toContain("18446744073709551613");
		expect(resultText(result)).toContain("18446744073709551611");
		expect(resultText(result)).toContain("gh_example");
		if (typeof result === "string") throw new Error(result);
		expect(result.details?.totalItems).toBe(1);
		const runs = result.details?.runs as Array<{ nextCursor: unknown; availability: unknown }>;
		expect(runs[0]?.nextCursor).toBe(" wx +/== ");
		expect(runs[0]?.availability).toMatchObject({ categories: [{ type: 33554499, word: "公众号" }], continue_flag: 1 });
	});

	test("Douyin live business_config state is reusable and missing backtrace is explicitly unavailable", async () => {
		// Shape captured by the parent on 2026-09-15; no log_pb-derived guesses.
		const business = { has_more: 1, next_page: { cursor: 8, search_id: "captured-search" }, backtrace: "J6+/==" };
		const fixtures = { [PATHS.douyin]: { code: 200, data: { business_config: business, business_data: [] } } };
		const mock = installFetchRouter(fixtures);
		restoreFetch = mock.restore;
		const result = await search.execute({ query: "猫咪", platforms: ["douyin"] }, ctx);
		if (typeof result === "string") throw new Error(result);
		const runs = result.details?.runs as Array<{ nextCursor: unknown }>;
		expect(runs[0]?.nextCursor).toEqual({ cursor: 8, search_id: "captured-search", backtrace: "J6+/==" });
		await search.execute({ query: "猫咪", platforms: ["douyin"], cursor: runs[0]?.nextCursor }, ctx);
		expect(JSON.parse(String(mock.calls[1]?.init?.body))).toMatchObject({ cursor: 8, search_id: "captured-search", backtrace: "J6+/==" });
		Reflect.deleteProperty(business, "backtrace");
		expect(resultText(await search.execute({ query: "猫咪", platforms: ["douyin"] }, ctx))).toContain("pagination unavailable");
	});

	test("Just One fails closed without credentials and without an initial time window", async () => {
		const mock = installFetchRouter({});
		restoreFetch = mock.restore;
		delete process.env.JUSTONE_API_KEY;
		expect(resultText(await search.execute({ query: "猫咪", platforms: ["wechat"], provider: "justone" }, ctx))).toContain("JUSTONE_API_KEY not set");
		process.env.JUSTONE_API_KEY = "test-justone-key";
		expect(resultText(await search.execute({ query: "猫咪", platforms: ["wechat"], provider: "justone" }, ctx))).toContain("require justone_start");
		expect(mock.calls).toHaveLength(0);
	});

	test("Weibo verticals use their own V2 contracts and retire article rather than silently remapping it", async () => {
		const mock = installFetchRouter({
			"/api/v1/weibo/web_v2/fetch_video_search": { code: 200, data: [] },
		});
		restoreFetch = mock.restore;
		const result = await search.execute({ query: "机器人", platforms: ["weibo"], weibo_search_type: "video", sort: "hot", time_range: "week" }, ctx);
		expect(mock.calls[0]?.url.searchParams.get("query")).toBe("机器人");
		expect(mock.calls[0]?.url.searchParams.get("mode")).toBe("hot");
		expect(resultText(result)).toContain("Unsupported time filter");
		expect((resultText(await search.execute({ query: "机器人", platforms: ["weibo"], weibo_search_type: "article" }, ctx))).startsWith("ERROR:")).toBe(true);
		expect(mock.calls).toHaveLength(1);
	});

	test("undocumented month filters are not sent as if they applied", async () => {
		const mock = installFetchRouter(buildFixtures());
		restoreFetch = mock.restore;
		const result = await search.execute({ query: "人工智能", platforms: ["xiaohongshu", "douyin"], time_range: "month" }, ctx);
		expect(resultText(result)).toContain("Unsupported month filter");
		expect(mock.calls[0]?.url.searchParams.get("time_filter")).toBe("不限");
		expect(JSON.parse(String(mock.calls[1]?.init?.body)).publish_time).toBe("0");
	});

	test("provider key echoes are redacted from partial and total failure diagnostics", async () => {
		const fixtures = buildFixtures();
		fixtures[PATHS.weibo] = { code: 403, message: "Rejected Bearer test-tikhub-key" };
		const mock = installFetchRouter(fixtures);
		restoreFetch = mock.restore;
		const partial = resultText(await search.execute({ query: "人工智能", platforms: ["weibo", "xiaohongshu"] }, ctx));
		expect(partial).toContain("Rejected Bearer [redacted]");
		expect(partial).not.toContain("test-tikhub-key");
		const failed = resultText(await search.execute({ query: "人工智能", platforms: ["weibo"] }, ctx));
		expect((failed).startsWith("ERROR:")).toBe(true);
		expect(failed).not.toContain("test-tikhub-key");
	});
});
