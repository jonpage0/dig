import hackernews from "./tools/hackernews.js";
import polymarket from "./tools/polymarket.js";
import reddit from "./tools/reddit.js";
import { reddit as tikhub_reddit } from "./tools/tikhub_reddit.js";
import youtube from "./tools/youtube.js";
import {
	semantic_scholar_search,
	semantic_scholar_recommendations,
	openalex_search,
} from "./tools/papers.js";
import {
	multi_search as papers_multi_search_impl,
	fulltext_read as papers_fulltext_read_impl,
	pdf_download as papers_pdf_download_impl,
} from "./tools/paper_search.js";
import { search as china_social_search } from "./tools/china_social.js";
import { search as commerce_search, product as commerce_product, history as commerce_history, reviews as commerce_reviews, discover as commerce_discover } from "./tools/commerce.js";
import { search as exa_search, contents as exa_contents, similar as exa_similar, research as exa_research } from "./tools/exa.js";
import { ask as perplexity_ask, search as perplexity_search, research as perplexity_research, reason as perplexity_reason } from "./tools/perplexity.js";
import { search as xsearch } from "./tools/xsearch.js";
import { post as x_post, search_posts as x_search_posts, count_posts as x_count_posts, users as x_users, news as x_news, explore as x_explore, bookmarks as x_bookmarks, likes as x_likes, community as x_community } from "./tools/x_api.js";
import { tiktok as scrapecreators_tiktok, instagram as scrapecreators_instagram, linkedin as scrapecreators_linkedin, telegram as scrapecreators_telegram } from "./tools/scrapecreators.js";
import { facebook as scrapecreators_facebook, facebook_events as scrapecreators_facebook_events } from "./tools/facebook.js";
import { library as facebook_ad_library } from "./tools/facebook_ads.js";
import { search as github_search, inspect as github_inspect, read as github_read } from "./tools/github.js";
import { search as tiktok_ads_search, top as tiktok_ads_top, detail as tiktok_ads_detail, library as tiktok_ad_library } from "./tools/tiktok_ads.js";
import { read_wiki_structure as deepwiki_read_wiki_structure, read_wiki_contents as deepwiki_read_wiki_contents, ask_question as deepwiki_ask_question } from "./tools/deepwiki.js";
import { docs_sections as dataforseo_docs_sections, docs_index as dataforseo_docs_index, docs_read as dataforseo_docs_read, request as dataforseo_request } from "./tools/dataforseo.js";
import type { ToolSpec } from "./types.js";

/**
 * Every local provider tool, by its catalog tool name (src/providers/modules.ts).
 * Library tools (research_save, dig_start, dig_finish) belong to the native server.
 */
export const providerTools: Record<string, ToolSpec> = {
	hackernews,
	polymarket,
	reddit,
	tikhub_reddit,
	youtube,
	papers_semantic_scholar_search: semantic_scholar_search,
	papers_semantic_scholar_recommendations: semantic_scholar_recommendations,
	papers_openalex_search: openalex_search,
	papers_multi_search: papers_multi_search_impl,
	papers_fulltext_read: papers_fulltext_read_impl,
	papers_pdf_download: papers_pdf_download_impl,
	china_social_search,
	commerce_search,
	commerce_product,
	commerce_history,
	commerce_reviews,
	commerce_discover,
	exa_search,
	exa_contents,
	exa_similar,
	exa_research,
	perplexity_ask,
	perplexity_search,
	perplexity_research,
	perplexity_reason,
	xsearch,
	x_post,
	x_search_posts,
	x_count_posts,
	x_users,
	x_news,
	x_explore,
	x_bookmarks,
	x_likes,
	x_community,
	scrapecreators_tiktok,
	scrapecreators_instagram,
	scrapecreators_linkedin,
	scrapecreators_telegram,
	scrapecreators_facebook,
	scrapecreators_facebook_events,
	facebook_ad_library,
	github_search,
	github_inspect,
	github_read,
	tiktok_ads_search,
	tiktok_ads_top,
	tiktok_ads_detail,
	tiktok_ad_library,
	deepwiki_read_wiki_structure,
	deepwiki_read_wiki_contents,
	deepwiki_ask_question,
	dataforseo_docs_sections,
	dataforseo_docs_index,
	dataforseo_docs_read,
	dataforseo_request,
};
