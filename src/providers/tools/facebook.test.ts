import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { executeSource } from "../outcome.js";
import type { SourceToolResult, ToolContext } from "../types.js";
import { facebook, facebook_events } from "./facebook.js";

type Envelope = { status: number; body: unknown; headers?: Record<string, string> };
type Route = unknown | ((url: URL) => unknown);

function isEnvelope(value: unknown): value is Envelope {
	return typeof value === "object" && value !== null && "status" in value && "body" in value && typeof (value as Envelope).status === "number";
}

const context: ToolContext = {
	sessionID: "facebook-test",
	directory: "/tmp",
	worktree: "/tmp",
	abort: new AbortController().signal,
	keep: () => {},
};

function text(result: SourceToolResult): string {
	return typeof result === "string" ? result : result.text;
}

function status(result: SourceToolResult): string | undefined {
	return typeof result === "string" ? undefined : result.status;
}

function details(result: SourceToolResult): Record<string, unknown> {
	return typeof result === "string" ? {} : (result.details ?? {});
}

/** Route values (or what a route function returns) are the JSON body for a 200, or `{ status, body, headers }` for another answer. */
function installFetchMock(routes: Record<string, Route>) {
	const calls: URL[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = input instanceof URL ? input : new URL(String(input));
		calls.push(url);
		const route = routes[url.pathname];
		if (route === undefined) return new Response(JSON.stringify({ success: false, error: "no route" }), { status: 404 });
		const resolved = typeof route === "function" ? (route as (url: URL) => unknown)(url) : route;
		const { status, body, headers } = isEnvelope(resolved) ? resolved : { status: 200, body: resolved, headers: undefined };
		return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

// Shapes follow the ScrapeCreators docs examples read 2026-10-08 (https://docs.scrapecreators.com/v1/facebook/<endpoint>.md), shortened.
const PAGE_URL = "https://www.facebook.com/pacemorby";
const HD_URL = "https://video-atl3-2.xx.fbcdn.net/o1/v/t2/f2/m69/AQO8YLki.mp4?strext=1&_nc_cat=111&oh=00_AYHk&oe=67DBDF5B";
const feedPost = {
	id: "1177973017668337",
	text: "Getting into real estate isn't easy.\n\nJoin the NOLB Challenge - Nov 17th-19th",
	url: "https://www.facebook.com/reel/1548769829113168/",
	permalink: "https://www.facebook.com/reel/1548769829113168/",
	author: { __typename: "User", name: "Pace Morby", short_name: "Pace Morby", id: "100063669491743" },
	reactionCount: 138,
	commentCount: 26,
	videoViewCount: null,
	publishTime: 1731616669,
	videoDetails: { sdUrl: "https://video-atl3-2.xx.fbcdn.net/sd.mp4", hdUrl: HD_URL, thumbnailUrl: "https://scontent-atl3-2.xx.fbcdn.net/thumb.jpg" },
	topComments: [
		{ id: "Y29tbWVudDox", text: "I'm in", publishTime: 1732158216, author: { id: "pfbid0Vv", name: "Ray Bales", gender: "MALE", url: "https://www.facebook.com/people/Ray-Bales/pfbid0Vv/" } },
	],
};

describe("facebook tools", () => {
	const originalKey = process.env.SCRAPECREATORS_API_KEY;
	let restore: (() => void) | undefined;

	beforeEach(() => {
		process.env.SCRAPECREATORS_API_KEY = "sc-test-key";
	});

	afterEach(() => {
		restore?.();
		restore = undefined;
		if (originalKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
		else process.env.SCRAPECREATORS_API_KEY = originalKey;
	});

	test("profile_posts sends url or pageId with the cursor and keeps full text, video links, top comments and the next cursor", async () => {
		const mock = installFetchMock({
			"/v1/facebook/profile/posts": { success: true, credits_charged: 1, posts: [feedPost], cursor: "Cg8Ob3Jn-next" },
		});
		restore = mock.restore;

		const result = await facebook.execute({ kind: "profile_posts", url: PAGE_URL, cursor: "Cg8-prev" }, context);
		const output = text(result);
		expect(mock.calls[0].searchParams.get("url")).toBe(PAGE_URL);
		expect(mock.calls[0].searchParams.get("cursor")).toBe("Cg8-prev");
		expect(mock.calls[0].searchParams.get("pageId")).toBeNull();
		expect(status(result)).toBe("success");
		expect(output).toContain("at most 3 posts per page");
		expect(output).toContain("1. Pace Morby (id 100063669491743) — 2024-11-14T20:37:49.000Z");
		expect(output).toContain("   Getting into real estate isn't easy.\n\n   Join the NOLB Challenge - Nov 17th-19th");
		expect(output).toContain("Reactions: 138 | Comments: 26 | Video views: not reported");
		expect(output).toContain(`Video (HD): ${HD_URL}`);
		expect(output).toContain("- Ray Bales (https://www.facebook.com/people/Ray-Bales/pfbid0Vv/), 2024-11-21T03:03:36.000Z:\n     I'm in");
		expect(output).toContain('Next page: pass cursor="Cg8Ob3Jn-next" with the same url or page_id.');
		expect(output).toContain("Dig does not watch videos");
		expect(output).not.toContain("Permalink:");
		expect(details(result)).toMatchObject({ kind: "profile_posts", cursor: "Cg8Ob3Jn-next", returned: 1, ids: ["1177973017668337"], truncated: false });

		await facebook.execute({ kind: "profile_posts", page_id: "100063669491743" }, context);
		expect(mock.calls[1].searchParams.get("pageId")).toBe("100063669491743");
		expect(mock.calls[1].searchParams.get("url")).toBeNull();
	});

	test("profile reports a gated page as unavailable or limited, a missing page as not found, and never prints an absent count as 0", async () => {
		const mock = installFetchMock({
			"/v1/facebook/profile": (url: URL) => {
				switch (url.searchParams.get("url")) {
					case "https://www.facebook.com/mantraindianfolsom":
						return {
							success: true,
							credits_charged: 1,
							id: "100088017857524",
							isPrivate: false,
							name: "Mantraindian",
							category: "Restaurant",
							email: "contact@mantraindian.com",
							likeCount: 3224,
							talkingAboutCount: null,
							followerCount: 3200,
							adLibrary: { adStatus: "This Page is currently running ads.", pageId: "104359362513119" },
							businessHours: [{ monday: { open: null, close: null, intervals: [], fullText: "CLOSED" } }],
						};
					case "https://www.facebook.com/adultsonly":
						return { success: true, credits_charged: 1, isPrivate: true, account_status: "age-restricted" };
					case "https://www.facebook.com/closedpage":
						return { success: true, credits_charged: 1, isPrivate: true, account_status: "private", id: "42", name: "Closed Page", likeCount: 10 };
					default:
						return { status: 404, body: { success: false, credits_charged: 0, accountDoesNotExist: true, isPrivate: false, error: "Profile not found" } };
				}
			},
		});
		restore = mock.restore;

		const open = await facebook.execute({ kind: "profile", url: "https://www.facebook.com/mantraindianfolsom", business_hours: true, cache_max_age: "7d" }, context);
		expect(mock.calls[0].searchParams.get("get_business_hours")).toBe("true");
		expect(mock.calls[0].searchParams.get("cache_max_age")).toBe("7d");
		expect(mock.calls[0].searchParams.get("include_gated_profile")).toBeNull();
		expect(status(open)).toBe("success");
		expect(text(open)).toContain("Access: public; no login used.");
		expect(text(open)).toContain("Likes: 3.2K | Followers: 3.2K | Talking about: not reported");
		expect(text(open)).toContain("Ad Library: This Page is currently running ads. (Ad Library page id 104359362513119)");
		expect(text(open)).toContain("- monday: CLOSED");

		const gated = await facebook.execute({ kind: "profile", url: "https://www.facebook.com/adultsonly" }, context);
		expect(status(gated)).toBe("failed");
		expect(text(gated)).toContain("Access: gated (account_status: age-restricted; isPrivate: true). Facebook shows an 18+ content gate");
		expect(text(gated)).toContain("include_gated_profile=true asks for the limited public fields");
		expect(text(gated)).not.toContain("Likes:");
		expect(details(gated)).toMatchObject({ available: false, gate: { account_status: "age-restricted", is_private: true, limited_fields: false } });

		const limited = await facebook.execute({ kind: "profile", url: "https://www.facebook.com/closedpage", include_gated_profile: true }, context);
		expect(mock.calls[2].searchParams.get("include_gated_profile")).toBe("true");
		expect(status(limited)).toBe("partial");
		expect(text(limited)).toContain("Only the limited public fields below came back.");
		expect(text(limited)).toContain("Likes: 10 | Followers: not reported");

		const missing = await facebook.execute({ kind: "profile", url: "https://www.facebook.com/nobodyhere" }, context);
		expect(status(missing)).toBe("empty");
		expect(text(missing)).toContain("Not found: the provider reports that this page does not exist (accountDoesNotExist).");
		expect(details(missing)).toMatchObject({ not_found: true, available: false });
	});

	test("arguments that are missing, misplaced, malformed or off Facebook are refused before any request", async () => {
		const mock = installFetchMock({});
		restore = mock.restore;
		const reel = "https://www.facebook.com/reel/1535656380759655";

		expect(await facebook.execute({ kind: "post" }, context)).toBe("ERROR: url is required for kind='post'.");
		expect(await facebook.execute({ kind: "post", url: "https://example.com/reel/1" }, context)).toBe("ERROR: url must be a facebook.com URL.");
		expect(await facebook.execute({ kind: "post", url: reel, cursor: "x" }, context)).toBe("ERROR: cursor does not apply to kind='post'; it takes url, cache_max_age.");
		expect(await facebook.execute({ kind: "comments", url: reel, cache_max_age: "7d" }, context)).toContain("cache_max_age does not apply to kind='comments'");
		expect(await facebook.execute({ kind: "profile_reels", url: PAGE_URL, cursor: "AQH" }, context)).toContain("cursor and next_page_id go together");
		expect(await facebook.execute({ kind: "profile_posts", url: PAGE_URL, page_id: "1" }, context)).toBe("ERROR: pass url or page_id for kind='profile_posts', not both.");
		expect(await facebook.execute({ kind: "group", group_id: "python" }, context)).toBe("ERROR: group_id must be the numeric Facebook id.");
		expect(await facebook.execute({ kind: "group", url: PAGE_URL }, context)).toContain("url must be a Facebook group URL");
		expect(await facebook.execute({ kind: "profile", url: "https://www.facebook.com/groups/366190054572553" }, context)).toContain("url is a Facebook group");
		expect(await facebook.execute({ kind: "replies", feedback_id: "ZmVl" }, context)).toContain("needs both feedback_id and expansion_token");
		expect(await facebook.execute({ kind: "search_videos" }, context)).toBe("ERROR: query is required for kind='search_videos'.");
		expect(await facebook.execute({ kind: "group_posts", group_id: "1", sort_by: "NEWEST" }, context)).toContain("sort_by must be one of TOP_POSTS");
		expect(await facebook_events.execute({ kind: "search", query: "dogs", time: "today" }, context)).toBe("ERROR: time does not apply to kind='search'; it takes query, cursor.");
		expect(await facebook_events.execute({ kind: "city", url: "https://www.facebook.com/events/2255360061870188/" }, context)).toContain("url must be a city's Facebook Events page");
		expect(await facebook_events.execute({ kind: "details" }, context)).toBe("ERROR: url or event_id is required for kind='details'.");
		expect(mock.calls).toHaveLength(0);
	});

	test("reels and photos page only with both tokens, and say so when the provider returns one", async () => {
		const mock = installFetchMock({
			"/v1/facebook/profile/reels": {
				success: true,
				credits_charged: 1,
				reels: [
					{
						id: "UzpfSTEw",
						post_id: "1203161005161463",
						creation_time: "2025-09-13T20:51:28.000Z",
						url: "https://www.facebook.com/reel/1114235920664408",
						view_count: 900,
						feedback_id: "ZmVlZGJhY2s6MTIw",
						description: "#globetheatreregina #yqrfood",
						video_id: "1114235920664408",
						thumbnail: "https://scontent.fsjc1-3.fna.fbcdn.net/reel-thumb.jpg",
						play_time_in_ms: 22035,
						video_url: "https://video.fsjc1-3.fna.fbcdn.net/reel.mp4?tag=sve_sd",
						music: { id: "1491450028648565", track_title: "The Copper Kettle Restaurant · Original audio" },
						author: { id: "100064027242849", name: "The Copper Kettle Restaurant", is_verified: false, url: "https://www.facebook.com/copperkettleyqr" },
					},
				],
				cursor: "AQH-next",
				next_page_id: "YXB-next",
			},
			"/v1/facebook/profile/photos": {
				success: true,
				credits_charged: 1,
				photos: [
					{
						id: "YXBwX2l0ZW06",
						photo_id: "1428106402020495",
						accessibility_caption: "May be an image of basketball and text",
						viewer_image: { uri: "https://scontent-sea5-1.xx.fbcdn.net/photo.jpg", height: 1800, width: 1440 },
						thumbnail: "https://scontent-sea5-1.xx.fbcdn.net/photo-thumb.jpg",
						url: "https://www.facebook.com/photo.php?fbid=1428106402020495&set=pb.100044634450208.-2207520000&type=3",
					},
				],
				cursor: "AQHSRM68",
			},
		});
		restore = mock.restore;

		const reels = await facebook.execute({ kind: "profile_reels", url: "https://www.facebook.com/copperkettleyqr", cursor: "AQH-prev", next_page_id: "YXB-prev" }, context);
		expect(mock.calls[0].searchParams.get("cursor")).toBe("AQH-prev");
		expect(mock.calls[0].searchParams.get("next_page_id")).toBe("YXB-prev");
		expect(text(reels)).toContain('Next page: pass cursor="AQH-next" and next_page_id="YXB-next" with the same url.');
		expect(text(reels)).toContain("Views: 900 | Duration: 22.0s");
		expect(text(reels)).toContain("Music: The Copper Kettle Restaurant · Original audio");
		expect(text(reels)).toContain("Feedback id: ZmVlZGJhY2s6MTIw (pass as feedback_id to kind='comments')");
		expect(details(reels)).toMatchObject({ cursor: "AQH-next", next_page_id: "YXB-next", continuation: true });

		const photos = await facebook.execute({ kind: "profile_photos", url: "https://www.facebook.com/Spurs" }, context);
		expect(text(photos)).toContain("Next page: the provider returned only cursor; this endpoint needs both, so continuation is unavailable.");
		expect(text(photos)).toContain("Image: https://scontent-sea5-1.xx.fbcdn.net/photo.jpg (1440×1800)");
		expect(text(photos)).toContain("Alt text (Facebook's automatic description): May be an image of basketball and text");
		expect(details(photos)).toMatchObject({ continuation: false, returned: 1 });
	});

	test("search_videos is labelled as native video search, keeps Facebook's display text apart from times, and separates a last page from an unreadable one", async () => {
		const mock = installFetchMock({
			"/v1/facebook/search/videos": (url: URL) => {
				switch (url.searchParams.get("query")) {
					case "dogs":
						return {
							success: true,
							credits_charged: 1,
							query: "dogs",
							videos: [
								{ id: "1972139093484105", url: "https://www.facebook.com/reel/1972139093484105/", title: "Extremely strong dogs", description: "Large dogs #dog", author: { id: "100071029295578", name: "Jozo Dogs", url: "https://www.facebook.com/jozodogs" }, creation_time: null, publish_time: null, relative_time_text: "Sep 5 · 89K views", duration_ms: null, duration_text: "0:17", thumbnail_url: "https://scontent-lax3-2.xx.fbcdn.net/a.jpg" },
								{ id: "1218486163512401", url: "https://www.facebook.com/reel/1218486163512401/", title: null, description: null, author: { id: "61584767065991", name: "Funny dogs", url: null }, creation_time: 1765836166, publish_time: 1765836166, relative_time_text: null, duration_ms: 10100, duration_text: null, thumbnail_url: "https://scontent-lax3-2.xx.fbcdn.net/b.jpg" },
							],
							cursor: "eyJ-next",
							has_more: true,
						};
					case "nothing":
						return { success: true, credits_charged: 1, query: "nothing", videos: [], cursor: null, has_more: false };
					default:
						return { success: true, credits_charged: 1 };
				}
			},
		});
		restore = mock.restore;

		const found = await facebook.execute({ kind: "search_videos", query: "dogs" }, context);
		expect(mock.calls[0].searchParams.get("query")).toBe("dogs");
		expect(status(found)).toBe("success");
		expect(text(found)).toContain("not general post, text or photo search");
		expect(text(found)).toContain("Published: not reported");
		expect(text(found)).toContain("Facebook's display text (not a normalized time): Sep 5 · 89K views");
		expect(text(found)).toContain("Duration: 0:17");
		expect(text(found)).toContain("Published: 2025-12-15T22:02:46.000Z");
		expect(text(found)).toContain("Duration: 10.1s");
		expect(text(found)).toContain('Next page: pass cursor="eyJ-next" with the same query.');
		expect(details(found)).toMatchObject({ cursor: "eyJ-next", has_more: true, returned: 2 });

		const none = await facebook.execute({ kind: "search_videos", query: "nothing" }, context);
		expect(status(none)).toBe("empty");
		expect(text(none)).toContain("Next page: none; the provider reports has_more false.");
		expect(text(none)).toContain("The provider returned an empty videos list for this page.");

		expect(await facebook.execute({ kind: "search_videos", query: "drift" }, context)).toBe(
			"ERROR: ScrapeCreators Facebook video search returned an unexpected payload: `videos` is missing",
		);
	});

	test("post keeps the whole text, counts, feedback id and media links; transcript separates text, null and a missing field", async () => {
		const description = "Air Fryer Chocolate Cake \n\n100% simple.\n🔥 Method:\n 1. Mix banana";
		const mock = installFetchMock({
			"/v1/facebook/post": {
				success: true,
				credits_charged: 1,
				post_id: "25118307061088489",
				like_count: 2095,
				comment_count: 48,
				share_count: 133,
				view_count: 133000,
				description,
				creation_time: "2025-09-18T06:30:18.000Z",
				feedback_id: "ZmVlZGJhY2s6MjUx",
				url: "https://www.facebook.com/reel/1535656380759655",
				image_url: null,
				video: { id: "1535656380759655", sd_url: "https://video-fml1-1.xx.fbcdn.net/sd.mp4", hd_url: "https://video-fml1-1.xx.fbcdn.net/hd.mp4", height: 1920, width: 1080, length_in_second: 23.36, thumbnail: "https://scontent-fml1-1.xx.fbcdn.net/t.jpg", captions_url: "https://scontent-fml1-1.xx.fbcdn.net/c.srt" },
				author: { id: "100000076236457", name: "Matt West", handle: "matt.west.184", is_verified: true, url: "https://www.facebook.com/matt.west.184" },
				music: { id: "1506592770696336", type: "CUSTOM_AUDIO", track_title: "Matt West · Original audio" },
			},
			"/v1/facebook/post/transcript": (url: URL) => {
				if (url.searchParams.get("url")?.endsWith("/1")) return { success: true, credits_charged: 1, transcript: "We're fishing\nbite x2\nBest bait" };
				if (url.searchParams.get("url")?.endsWith("/2")) return { success: true, credits_charged: 1, transcript: null };
				return { success: true, credits_charged: 1 };
			},
		});
		restore = mock.restore;

		const post = await facebook.execute({ kind: "post", url: "https://www.facebook.com/reel/1535656380759655", cache_max_age: "3d" }, context);
		const params = mock.calls[0].searchParams;
		expect(params.get("cache_max_age")).toBe("3d");
		expect(params.get("get_comments")).toBeNull();
		expect(params.get("get_transcript")).toBeNull();
		expect(status(post)).toBe("success");
		expect(text(post)).toContain("Author: Matt West (@matt.west.184) (verified) — https://www.facebook.com/matt.west.184 (id 100000076236457)");
		expect(text(post)).toContain("Likes: 2.1K | Comments: 48 | Shares: 133 | Views: 133.0K");
		expect(text(post)).toContain("Views note:");
		expect(text(post)).toContain("Feedback id: ZmVlZGJhY2s6MjUx (pass as feedback_id to kind='comments'");
		expect(text(post)).toContain("Text:\n   Air Fryer Chocolate Cake \n\n   100% simple.\n   🔥 Method:\n    1. Mix banana");
		expect(text(post)).toContain("Length: 23.36s");
		expect(text(post)).toContain("Captions file (not fetched): https://scontent-fml1-1.xx.fbcdn.net/c.srt");
		expect(details(post)).toMatchObject({ post_id: "25118307061088489", feedback_id: "ZmVlZGJhY2s6MjUx", is_video: true });

		const spoken = await facebook.execute({ kind: "transcript", url: "https://www.facebook.com/reel/1" }, context);
		expect(status(spoken)).toBe("success");
		expect(text(spoken)).toContain("We're fishing\nbite x2\nBest bait");
		expect(text(spoken)).toContain("videos under 2 minutes");

		const silent = await facebook.execute({ kind: "transcript", url: "https://www.facebook.com/reel/2" }, context);
		expect(status(silent)).toBe("empty");
		expect(text(silent)).toContain("No transcript came back (transcript: null).");

		expect(await facebook.execute({ kind: "transcript", url: "https://www.facebook.com/reel/3" }, context)).toBe(
			"ERROR: ScrapeCreators Facebook transcript returned an unexpected payload: `transcript` is missing",
		);
	});

	test("comments page by feedback_id and hand each comment's reply tokens to kind='replies'", async () => {
		const mock = installFetchMock({
			"/v1/facebook/post/comments": {
				success: true,
				credits_charged: 1,
				comments: [
					{ id: "Y29tbWVudDox", text: "Do 1/2 mini Oreos", created_at: "2025-09-01T01:10:40.000Z", reply_count: 1, reaction_count: 95, reactions: { thankful: 0, like: 79, love: 4, haha: 1, wow: 11, sad: 0 }, author: { id: "pfbid02Sd", name: "Robin Bergsagel" }, feedback_id: "ZmVl-c1", expansion_token: "MjoxNzc-c1" },
					{ id: "Y29tbWVudDoy", text: "Do these bits have cheese?", created_at: "2025-09-01T00:52:22.000Z", reply_count: 30, reaction_count: 51, author: { id: "1527964450", name: "Jill Carney Strother" } },
				],
				cursor: "MToxNzc2-next",
				has_next_page: true,
			},
			"/v1/facebook/post/comment/replies": {
				success: true,
				credits_charged: 1,
				replies: [{ id: "Y29tbWVudDoz", text: "Terry Quillan weird", created_at: "2026-05-11T04:20:42.000Z", reply_count: 0, reaction_count: 0, author: { id: "1073504073", name: "Paul Goecke" } }],
				cursor: "MToxNzc4-end",
				has_next_page: false,
			},
		});
		restore = mock.restore;

		const comments = await facebook.execute({ kind: "comments", feedback_id: "ZmVlZGJhY2s6MTQ0", cursor: "MToxNzU3-prev" }, context);
		expect(mock.calls[0].searchParams.get("feedback_id")).toBe("ZmVlZGJhY2s6MTQ0");
		expect(mock.calls[0].searchParams.get("cursor")).toBe("MToxNzU3-prev");
		expect(mock.calls[0].searchParams.get("url")).toBeNull();
		expect(text(comments)).toContain("Reactions: 95 (like 79, love 4, haha 1, wow 11) | Replies: 1");
		expect(text(comments)).toContain(`Read replies with kind='replies', feedback_id="ZmVl-c1", expansion_token="MjoxNzc-c1"`);
		expect(text(comments)).toContain("Reactions: 51 | Replies: 30");
		expect(text(comments)).toContain("Replies cannot be read from here: this comment came back without the feedback_id and expansion_token they need.");
		expect(text(comments)).toContain('Next page: pass cursor="MToxNzc2-next" with the same url or feedback_id.');
		expect(details(comments)).toMatchObject({ cursor: "MToxNzc2-next", has_next_page: true, returned: 2 });

		const replies = await facebook.execute({ kind: "replies", feedback_id: "ZmVl-c1", expansion_token: "MjoxNzc-c1" }, context);
		expect(mock.calls[1].searchParams.get("feedback_id")).toBe("ZmVl-c1");
		expect(mock.calls[1].searchParams.get("expansion_token")).toBe("MjoxNzc-c1");
		expect(text(replies)).toContain("1. Paul Goecke — 2026-05-11T04:20:42.000Z\n   Terry Quillan weird");
		expect(text(replies)).toContain("Next page: none; the provider reports has_next_page false.");
		expect(details(replies)).toMatchObject({ cursor: null, has_next_page: false });
	});

	test("group reads the About page with its privacy, and group_posts forwards group_id and sort_by", async () => {
		const mock = installFetchMock({
			"/v1/facebook/group": {
				success: true,
				credits_charged: 1,
				id: "366190054572553",
				url: "https://www.facebook.com/groups/366190054572553",
				name: "Python Programming",
				description: "Let's share our knowledge on Python Programming",
				privacy: { label: "Private", description: "Only members can see who's in the group and what they post." },
				visibility: { label: "Visible", description: "Anyone can find this group." },
				categories: [{ id: "242504017103922", name: "Software & tech" }],
				member_count: 710386,
				member_count_text: "710,386 total members",
				administrator_count: 3,
				moderator_count: 0,
				administrators: [{ id: "pfbid029b", name: "Nusrat Jahan", url: "https://www.facebook.com/people/Nusrat-Jahan/pfbid029b/" }],
				activity: { posts_last_day: 16, posts_last_month: 512, new_members_text: "No new members in the last week" },
				rules: [{ id: "366191957905696", title: "Be Kind and Courteous", description: "Treat everyone with respect." }],
			},
			"/v1/facebook/group/posts": {
				success: true,
				credits_charged: 1,
				posts: [{ ...feedPost, id: "1286289372828481", text: null, url: "https://www.facebook.com/groups/742354120555345/permalink/1286289372828481/", permalink: "https://www.facebook.com/sofiyati.942655/videos/996458202287759/?idorvanity=742354120555345" }],
				cursor: "AQHRBjJC-next",
			},
		});
		restore = mock.restore;

		const group = await facebook.execute({ kind: "group", url: "https://www.facebook.com/groups/366190054572553/about" }, context);
		expect(status(group)).toBe("success");
		expect(text(group)).toContain("Facebook group: Python Programming (id 366190054572553)");
		expect(text(group)).toContain("Privacy: Private — Only members can see who's in the group and what they post.");
		expect(text(group)).toContain("ScrapeCreators documents group posts for public groups only");
		expect(text(group)).toContain("Members: 710.4K (710,386 total members)");
		expect(text(group)).toContain("Activity: 16 posts in the last day | 512 posts in the last month | No new members in the last week");
		expect(text(group)).toContain("1. Be Kind and Courteous\n   Treat everyone with respect.");

		const posts = await facebook.execute({ kind: "group_posts", group_id: "742354120555345", sort_by: "TOP_POSTS" }, context);
		expect(mock.calls[1].searchParams.get("group_id")).toBe("742354120555345");
		expect(mock.calls[1].searchParams.get("sort_by")).toBe("TOP_POSTS");
		expect(text(posts)).toContain("Facebook group posts: group_id 742354120555345 (first page)");
		expect(text(posts)).toContain("Sort: TOP_POSTS");
		expect(text(posts)).toContain("   (no text)");
		expect(text(posts)).toContain("Permalink: https://www.facebook.com/sofiyati.942655/videos/996458202287759/?idorvanity=742354120555345");
		expect(text(posts)).toContain('Next page: pass cursor="AQHRBjJC-next" with the same group and sort_by.');
	});

	test("events read a page's events, a city's events with time, event search and one event's details", async () => {
		const mock = installFetchMock({
			"/v1/facebook/profile/events": {
				success: true,
				credits_charged: 1,
				events: [
					{ id: "1596643298218453", name: "Harrison Steele at Brickyard", is_canceled: false, event_creator: { name: "Brickyard", url: "https://www.facebook.com/brickyardoldtown", id: "100066639371774" }, event_place: { contextual_name: "Brickyard", location: { reverse_geocode: { city: "Wichita" } }, id: "1594193222711146" }, day_time_sentence: "Thu, May 7 at 6:00 PM CDT", url: "https://www.facebook.com/events/1596643298218453/", event_kind: "PUBLIC_TYPE", is_past: false, start_timestamp: 1778194800 },
				],
				cursor: "eyJpZCI6-next",
				has_next_page: true,
				total_count: 22,
			},
			"/v1/facebook/events": {
				success: true,
				credits_charged: 1,
				events: [
					{ id: "2255360061870188", cover_photo: { photo: { accessibility_caption: "May be an image of crowd", image: { uri: "https://scontent-bos5-1.xx.fbcdn.net/flea.jpg" }, id: "950305717713028" } }, day_time_sentence: "Sun, May 3 at 12:00 PM EDT", name: "May St. Pete Flea ", event_place: { contextual_name: "Mirror Lake Park, Downtown St Pete" }, eventUrl: "https://www.facebook.com/events/2255360061870188/", is_past: false, start_timestamp: 1777824000, social_context: { text: "7.3K interested · 195 going", interested_count: 7300, going_count: 195, went_count: null } },
				],
				cursor: "eyJzdGFydF-next",
			},
			"/v1/facebook/events/search": {
				success: true,
				credits_charged: 1,
				events: [
					{ id: "24659081027102562", name: "DockDogs® at Frankenmuth Dog Bowl", url: "https://www.facebook.com/events/24659081027102562/", day_time_sentence: "Fri, May 22 - May 24", ticketing_context_row: { price_range_text: "$10" }, cover_photo: { accessibility_caption: "No photo description available.", eventImage: { uri: "https://scontent-bos5-1.xx.fbcdn.net/dock.jpg" } } },
				],
			},
			"/v1/facebook/event/details": {
				success: true,
				credits_charged: 1,
				id: "2255360061870188",
				url: "https://www.facebook.com/events/2255360061870188/",
				name: "May St. Pete Flea ",
				description: "SPRING IS HERE!\n\nSunday, May 3rd, 2026",
				is_online: false,
				is_past: true,
				privacy: "public",
				duration: "4 hr",
				location_name: "Mirror Lake Park, Downtown St Pete",
				address: "Saint Petersburg, FL",
				city: "Saint Petersburg, Florida",
				latitude: 27.776053761243,
				longitude: -82.639546684316,
				attendance_count: 7654,
				hosts: [{ id: "100082008263628", name: "The Indie Flea", url: "https://www.facebook.com/theindieflea", is_verified: false }],
				day_time_sentence: "Sunday, May 3, 2026 at 12:00 PM – 4:00 PM EDT",
				start_timestamp: 1777824000,
				interested_count: 7448,
				going_count: 207,
			},
		});
		restore = mock.restore;

		const page = await facebook_events.execute({ kind: "profile", url: "https://www.facebook.com/brickyardoldtown" }, context);
		expect(text(page)).toContain("The provider reports 22 events in total.");
		expect(text(page)).toContain("When: Thu, May 7 at 6:00 PM CDT (starts 2026-05-07T23:00:00.000Z)");
		expect(text(page)).toContain("Where: Brickyard, Wichita");
		expect(text(page)).toContain("Created by: Brickyard — https://www.facebook.com/brickyardoldtown");
		expect(details(page)).toMatchObject({ cursor: "eyJpZCI6-next", has_next_page: true, total_count: 22 });

		const city = await facebook_events.execute({ kind: "city", url: "https://www.facebook.com/events/explore/saint-petersburg-florida/111326725552547", time: "this_week" }, context);
		expect(mock.calls[1].searchParams.get("time")).toBe("this_week");
		expect(text(city)).toContain("1. May St. Pete Flea\n");
		expect(text(city)).toContain('Interested: 7.3K | Going: 195 (Facebook shows "7.3K interested · 195 going")');
		expect(text(city)).toContain("URL: https://www.facebook.com/events/2255360061870188/");
		expect(text(city)).toContain("Cover alt text (Facebook's automatic description): May be an image of crowd");
		expect(text(city)).toContain('Next page: pass cursor="eyJzdGFydF-next" with the same url and time.');

		const search = await facebook_events.execute({ kind: "search", query: "dogs" }, context);
		expect(mock.calls[2].searchParams.get("query")).toBe("dogs");
		expect(text(search)).toContain("Price: $10");
		expect(text(search)).toContain("Cover: https://scontent-bos5-1.xx.fbcdn.net/dock.jpg");
		expect(text(search)).toContain("Next page: no cursor returned");

		const event = await facebook_events.execute({ kind: "details", event_id: "2255360061870188" }, context);
		expect(mock.calls[3].searchParams.get("id")).toBe("2255360061870188");
		expect(status(event)).toBe("success");
		expect(text(event)).toContain("Facebook event: May St. Pete Flea [past]");
		expect(text(event)).toContain("Where: Mirror Lake Park, Downtown St Pete | Saint Petersburg, FL | Saint Petersburg, Florida");
		expect(text(event)).toContain("- The Indie Flea — https://www.facebook.com/theindieflea");
		expect(text(event)).toContain("Interested: 7.4K | Going: 207 | Attendance count (as the provider reports it): 7.7K");
		expect(text(event)).toContain("Description:\n   SPRING IS HERE!\n\n   Sunday, May 3rd, 2026");
	});

	test("provider failures, a redirect and a missing key are errors, and each response's reported credits price the call", async () => {
		const mock = installFetchMock({
			"/v1/facebook/search/videos": { status: 402, body: { success: false, error: "Insufficient credits" } },
			"/v1/facebook/post": { success: false, credits_charged: 0, error: "Post not found or private" },
			"/v1/facebook/group": { status: 302, body: null, headers: { Location: "https://elsewhere.example/group" } },
			"/v1/facebook/profile/posts": (url: URL) =>
				url.searchParams.get("cursor") === "unpriced" ? { success: true, posts: [feedPost] } : { success: true, credits_charged: 1, posts: [feedPost] },
		});
		restore = mock.restore;

		expect(await facebook.execute({ kind: "search_videos", query: "dogs" }, context)).toBe("ERROR: ScrapeCreators Facebook video search returned HTTP 402: Insufficient credits");
		expect(await facebook.execute({ kind: "post", url: "https://www.facebook.com/reel/9" }, context)).toBe("ERROR: ScrapeCreators Facebook post: Post not found or private");
		const redirected = await facebook.execute({ kind: "group", group_id: "1" }, context);
		expect(text(redirected)).toMatch(/^ERROR: ScrapeCreators Facebook group answered HTTP 302/);
		expect(mock.calls.filter((call) => call.pathname === "/v1/facebook/group")).toHaveLength(1);
		expect(mock.calls.some((call) => call.hostname === "elsewhere.example")).toBe(false);

		const priced = await executeSource(facebook, { kind: "profile_posts", url: PAGE_URL }, context);
		expect(priced.details?.cost).toEqual([{ amount: 1, unit: "credits" }]);
		const unpriced = await executeSource(facebook, { kind: "profile_posts", url: PAGE_URL, cursor: "unpriced" }, context);
		expect(unpriced.details?.cost).toBeNull();

		mock.restore();
		restore = undefined;
		delete process.env.SCRAPECREATORS_API_KEY;
		expect(await facebook_events.execute({ kind: "search", query: "dogs" }, context)).toBe("ERROR: SCRAPECREATORS_API_KEY not set. Get a key at https://scrapecreators.com");
	});

	test("mixed readable and malformed results preserve evidence and report partial coverage", async () => {
		const mock = installFetchMock({
			"/v1/facebook/profile/posts": { success: true, credits_charged: 1, posts: [feedPost, { text: "missing identity" }] },
		});
		restore = mock.restore;
		const result = await executeSource(facebook, { kind: "profile_posts", url: PAGE_URL }, context);
		expect(result.status).toBe("partial");
		expect(result.details).toMatchObject({ returned: 1, unreadable: 1, ids: [feedPost.id] });
		expect(result.text).toContain(feedPost.text.split("\n")[0]);
	});

	test("a page past the output limit is cut with a pointer to the original, after its continuation line", async () => {
		const mock = installFetchMock({
			"/v1/facebook/profile/posts": { success: true, credits_charged: 1, posts: [{ ...feedPost, text: "x".repeat(70_000) }], cursor: "Cg8-after-long" },
		});
		restore = mock.restore;

		const result = await facebook.execute({ kind: "profile_posts", url: PAGE_URL }, context);
		const output = text(result);
		expect(output).toContain('Next page: pass cursor="Cg8-after-long"');
		expect(output).toMatch(/\[Truncated at 60000 of \d+ characters\. The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file\.\]$/);
		expect(details(result)).toMatchObject({ truncated: true, cursor: "Cg8-after-long" });
	});
});
