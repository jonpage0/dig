/**
 * X source plugin (all 13 actions: xsearch, x_post, x_search_posts, x_web_search,
 * x_count_posts, x_users, x_follows, x_news, x_explore, x_bookmarks, x_likes,
 * x_community, x_images).
 */
import { defineSource, type SourcePlugin } from "../../core/plugin.ts";
import { SCRAPECREATORS_PROVIDER } from "../shared/scrapecreators.ts";
import { TIKHUB_PROVIDER } from "../shared/tikhub.ts";
import { X_API_DOCS_URL } from "./api-client.ts";
import { xBookmarksAction, xLikesAction } from "./bookmarks.ts";
import { xCommunityAction, xExploreAction, xNewsAction } from "./explore.ts";
import { xImagesAction } from "./images.ts";
import { xPostAction } from "./posts.ts";
import { xCountPostsAction, xSearchPostsAction } from "./search.ts";
import { xFollowsAction, xUsersAction } from "./users.ts";
import { xWebSearchAction } from "./web-search.ts";
import { xsearchAction } from "./xsearch.ts";

export {
  ACCOUNT_READS,
  ARCHIVE_PACING,
  clearSignedInAccountCache,
  POST_READS,
  postId,
  resetArchivePacing,
  X_API_DOCS_URL,
  X_EXPLORE_BILLING,
  X_READS_BILLING,
  xReads,
} from "./api-client.ts";
export { xBookmarksAction, xLikesAction } from "./bookmarks.ts";
export { xCommunityAction, xExploreAction, xNewsAction } from "./explore.ts";
export { xImagesAction } from "./images.ts";
export { oauthHeader, percent, signatureBase, signedQuery, USER_KEY_NAMES, type UserKeys } from "./oauth.ts";
export { xPostAction } from "./posts.ts";
export { xCountPostsAction, xSearchPostsAction } from "./search.ts";
export { xFollowsAction, xUsersAction } from "./users.ts";
export { xWebSearchAction } from "./web-search.ts";
export { loadXDefaults, RECOVERY, reportedTicks, reportedUsd, xsearchAction } from "./xsearch.ts";

export const xSource: SourcePlugin = defineSource({
  id: "x",
  group: "social",
  label: "X",
  description:
    "Posts and discourse: an evidence judge, a breadth finder, a post reader and a tracer, runnable independently",
  skills: ["x-judge", "x-breadth", "x-post", "x-trace"],
  env: [
    "XAI_API_KEY",
    "X_BEARER_TOKEN",
    "X_CONSUMER_KEY",
    "X_CONSUMER_SECRET",
    "X_ACCESS_TOKEN",
    "X_ACCESS_TOKEN_SECRET",
    "TIKHUB_API_KEY",
    "TIKHUB_BASE_URL",
    "SCRAPECREATORS_API_KEY",
  ],
  keys: ["XAI_API_KEY", "X_BEARER_TOKEN"],
  credential:
    "XAI_API_KEY for xsearch; X_BEARER_TOKEN for the X API tools; optional SCRAPECREATORS_API_KEY for x_web_search (Google-indexed post search); optional X sign-in (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET) for people search, Communities search, bookmarks and likes; TIKHUB_API_KEY optional, for x_post's single-post fallback, Communities search without sign-in and a Community's details and posts; x_images needs no key",
  about:
    "Posts and discussion on X, read three ways: X's own API returns the posts, accounts, who an account follows and who follows it, counts, News stories, trends, Spaces, Communities and Lists themselves, and the pictures in the posts can be looked at; ScrapeCreators (x_web_search) searches Google-indexed public posts hydrated live with zero X API post-read fees; xAI's Grok searches X live, by keyword and by meaning (including a fast semantic-only lead mode), watches videos and reads images when requested, and writes up what it finds with links to the posts. Signing in with your own X account adds people and Communities search and reading your bookmarks and likes. Four methods: X judge weighs claims by reach and kind of source; X breadth finds as many distinct posts and angles as it can without judging them; X post reads particular posts exactly, with their thread, reactions, author, spread and origin; X trace starts from a post, an account or a claim and works outward through the people in the conversation, weighing each voice by who it is and what it knows, not by engagement.",
  providers: [
    { name: "X API", url: X_API_DOCS_URL },
    { name: "xAI API", url: "https://x.ai/api" },
    SCRAPECREATORS_PROVIDER,
    TIKHUB_PROVIDER,
  ],
  billing:
    `The X API is pay-per-use from credits in your X developer account (see ${X_API_DOCS_URL}) and reports no per-call charge. For tools that read posts and accounts (x_post, x_search_posts, x_users, x_follows, x_bookmarks, x_likes, and x_explore with kind="list"), Dig records the posts and accounts X returned as X post reads and X account reads: counts, not money, never converted. X deduplicates resource billing per UTC day, so your X bill can be lower than the reads recorded; Dig does not know which reads were repeats. Counts, News, trends, Spaces and Communities show as unknown. xAI is paid per request in US dollars from your xAI account, and Dig records the cost xAI reports. ScrapeCreators (x_web_search) uses ScrapeCreators credits per request, which Dig records. TikHub, used for a single post the X API cannot read, Communities search without sign-in and a Community's details and posts, shows as unknown too. Looking at the pictures in posts (x_images) is free: X's image host makes no charge.`,
  logo: "x",
  actions: [
    xsearchAction,
    xPostAction,
    xSearchPostsAction,
    xWebSearchAction,
    xCountPostsAction,
    xUsersAction,
    xFollowsAction,
    xNewsAction,
    xExploreAction,
    xBookmarksAction,
    xLikesAction,
    xCommunityAction,
    xImagesAction,
  ],
});

export default xSource;
