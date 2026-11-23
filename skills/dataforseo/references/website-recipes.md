# DataForSEO website and GEO recipe router

These are purpose-oriented routes through the existing generic `dataforseo_request` action of the `dataforseo` tool, not per-endpoint tools or actions. Read the exact current endpoint documentation in this session before executing; the documented request/response contract overrides this guide. Keep full responses for billing and retained evidence. All paths below follow `/v3/`.

| Decision | Endpoint family to inspect | What to preserve / what happens next |
| --- | --- | --- |
| Which owned or competitor pages already match customer intent? | `dataforseo_labs/google/ranked_keywords/live`, `domain_intersection/live`, `relevant_pages/live` | Explicit target/market/language. A page-specific target is an absolute URL; a bare domain requests domain scope. In intersections, competitor target1 + owned target2 and intersections:false discovers competitor-only candidates. Retain keyword/rank timestamps and actual URLs; send those pages to the parent for reading. |
| Is the selected ranking current? | `serp/google/organic/live/advanced` | Exact keyword, market/language/device, collected depth, datetime, result type and URL. Organic rank_group differs from rank_absolute across features. Missing within depth is not absent everywhere. Nov 2026 flags: `resolve_poisoned_results: true` recovers poisoned Google SERPs (+1 page charge; incompatible with `udm=web`/`udm=14`; marks `from_web: true` in `checks`); `resolve_goto_urls: true` resolves Google `goto` redirects (slower turnaround, up to ~260s; Dig waits up to 300s). |
| Does a brand appear in answer prose, or is its site cited? | `ai_optimization/llm_mentions/target_metrics/live`, `multi_target_metrics/live` | Domain target with search_scope:["sources"] measures cited sources; keyword with deliberate answer/brand scope measures a different concept. Match aliases and namesakes explicitly. Multi-target counts can overlap and must not be summed as distinct answers. |
| Which actual AI answers reveal the gap? | `ai_optimization/llm_mentions/search_mentions/live` | Topic query scoped to question for discovery; sources for citations; fan_out_queries for underlying searches. Preserve question, answer, sources, search_results, platform/model, market/language, first_response_at/last_response_at, is_web_search_based and estimated ai_search_volume where returned. search_results need not be cited. Follow continuation with unchanged parameters when inventory completeness is required. |
| Which pages/domains shape the answers? | `ai_optimization/llm_mentions/top_mentioned_pages/live`, `top_mentioned_domains/live` | Use links_scope:sources for citations. Keep page/domain, totals, selection and list bounds. Read decision-critical pages and their actual answer context; an aggregate does not establish why a page was cited. Lite shapes have the same published pricing, not an assumed discount. |
| What does the consumer surface or live LLM response show now? | Google organic AI Overview results; `serp/google/ai_mode/live/advanced`; `ai_optimization/chat_gpt/llm_scraper/task_post` and its documented `task_get`; `ai_optimization/{chat_gpt,claude,gemini,perplexity}/llm_responses/live` | Keep surface identity from the endpoint: AI Mode can use an ai_overview item type too. Review optional asynchronous overview loading and cost. Scraper keyword is the prompt where documented. Preserve task IDs/pending outcomes. LLM Responses (Oct 2026) return `search_results[]` when web search runs; keep retrieved `search_results[]` separate from cited URLs. Other engines need their own exact docs, not inferred support. |
| Does the relevant page have a technical access issue? | `on_page/instant_pages` / current content-parsing docs | One exact URL first. Resource/JavaScript options are explicit scope/cost choices. Use returned checks according to definitions and distinguish them from extraction omissions. A broad crawl is an expansion, not a default. |
| What do competing ads promise, and where do they send people? | `serp/google/ads_advertisers/live/advanced`, `ads_search/live/advanced` | Advertiser, market, dates, creative and destination. Return selected destinations to the parent. Presence, repetition or age does not prove spend, conversions or profitability. |
| Has a same-scope observation changed? | LLM Mentions `historical/live`, `timeseries_delta/live`, `timeseries_new_lost/live`; relevant Labs historical endpoints | Explicit target rules/platform/market/language/dates/grouping. Native history first. Counts and estimated AI volume have different semantics; a delta count does not identify a particular lost citation without answer evidence. |

## GEO interpretation rules

Read current platform/location/language enums. LLM Mentions database coverage is not the same as separate AI Mode, ChatGPT/Gemini consumer scrapers or LLM Responses API models. Never pool them into one visibility rate. A database endpoint named Live serves its current database; preserve actual observation dates and do not call it today's generated answer.

Choose a topic-defined answer set before measuring presence/absence. Searching for the brand selects matches and cannot establish the rate at which the brand is absent. Keep denominators explicit: successfully answered observations under a declared selection. Report failed, pending, partial and no-answer collections separately. A successful SERP without an AI Overview is an observed absence of that feature under those settings, not a provider failure or a rejected brand.

Deduplicate overlapping retrievals only with a disclosed matching rule. Use a provider answer identity where supplied; otherwise retain platform, market/language, exact question, answer text and observation time. Different observations of the same question are not automatically duplicates. Repeated links within an answer do not become several unique cited answers. Preserve exact URLs; do not normalize away meaningful locale/product/query differences.

A citation label is not automatically a prose mention or recommendation. Inspect the answer and the cited page. Negative/disqualifying mentions, namesake collisions, stale answers and truncated source lists stay explicit. Provider estimated demand/volume/traffic is not clicks, conversion or revenue.

## Return a page-reading queue when needed

A source worker stays within DataForSEO. For every promising finding that needs page evidence, return the exact competing/cited URL, candidate owned URL (or missing), customer query/answer, what the parent must inspect, and the retained answer/call reference. Do not pretend the content diagnosis is complete without those reads. When the assignment already supplies inspected page reports, read them completely and preserve their provenance.

For actionable reports, include `## Opportunities` with Query/customer need | Observed answer/result | Cited/competing URL | Owned URL or missing | Diagnosis or unresolved question | Proposed change | Confidence/limits | Verification. Mark a proposal pending page verification when that evidence is absent. Preserve `## Metrics Table`, cost/method and mandatory audit sections. Recommendations are hypotheses unless a concrete defect is demonstrated.

## Local & Review Sources

Exact `/v3/` paths and minimal `tasks` POST bodies for local discovery, consumer reviews, and search interest. Read each endpoint's current docs via `dataforseo_docs_read` before calling to verify required fields, sort enums, and pricing. Standard `task_post` calls return status `20100` and a task id; retrieve results later with GET on the paired `task_get` path instead of reposting. See [trends-ads-reviews.md](trends-ads-reviews.md) for extended interpretation rules on Trends, Ads Transparency, and reviews.

- **Google Maps & Google Business Profile reviews**
  - Maps discovery (Live): POST `serp/google/maps/live/advanced`
    - Body: `[{"keyword": "coffee shop", "location_code": 2840, "language_code": "en", "depth": 20}]`
  - Business Profile info & `google_business_info.services` (Live): POST `business_data/google/my_business_info/live`
    - Body: `[{"cid": "1234567890123456789", "location_code": 2840, "language_code": "en"}]` (accepts keyword, cid, or place_id)
  - Business Profile reviews (Standard): POST `business_data/google/reviews/task_post` → GET `business_data/google/reviews/task_get/{task_id}`
    - Body: `[{"cid": "1234567890123456789", "location_code": 2840, "language_code": "en", "depth": 20, "sort_by": "newest"}]`
- **Yelp** (Standard)
  - Search: POST `business_data/yelp/search/task_post` → GET `business_data/yelp/search/task_get/{task_id}`
    - Body: `[{"keyword": "plumber", "location_code": 2840, "depth": 20}]`
  - Reviews: POST `business_data/yelp/reviews/task_post` → GET `business_data/yelp/reviews/task_get/{task_id}`
    - Body: `[{"alias": "business-alias-city", "language_code": "en", "depth": 20, "sort_by": "newest"}]`
- **Tripadvisor** (Standard)
  - Search: POST `business_data/tripadvisor/search/task_post` → GET `business_data/tripadvisor/search/task_get/{task_id}`
    - Body: `[{"keyword": "example hotel", "location_code": 2840, "depth": 20}]`
  - Reviews: POST `business_data/tripadvisor/reviews/task_post` → GET `business_data/tripadvisor/reviews/task_get/{task_id}`
    - Body: `[{"url_path": "Hotel_Review-g60763-d123456-Reviews-Example_Hotel.html", "language_code": "en", "depth": 20, "sort_by": "most_recent"}]`
- **Trustpilot** (Standard)
  - Search: POST `business_data/trustpilot/search/task_post` → GET `business_data/trustpilot/search/task_get/{task_id}`
    - Body: `[{"keyword": "Acme Corp", "depth": 10}]`
  - Reviews (billed per 20): POST `business_data/trustpilot/reviews/task_post` → GET `business_data/trustpilot/reviews/task_get/{task_id}`
    - Body: `[{"domain": "example.com", "depth": 20, "sort_by": "recency"}]`
- **Apple App Store & Google Play reviews** (Standard)
  - Apple App Store: POST `app_data/apple/app_reviews/task_post` → GET `app_data/apple/app_reviews/task_get/advanced/{task_id}`
    - Body: `[{"app_id": "389801252", "location_code": 2840, "language_code": "en", "depth": 25, "sort_by": "most_recent"}]`
  - Google Play: POST `app_data/google/app_reviews/task_post` → GET `app_data/google/app_reviews/task_get/advanced/{task_id}`
    - Body: `[{"app_id": "com.example.app", "location_code": 2840, "language_code": "en", "depth": 25, "sort_by": "newest"}]`
- **Google Trends** (Live)
  - Explore (up to 5 keywords, 1 item type per call; relative 0–100 index, never search volume): POST `keywords_data/google_trends/explore/live`
    - Body: `[{"keywords": ["term a", "term b"], "location_code": 2840, "language_code": "en", "type": "web", "time_range": "past_12_months", "item_types": ["google_trends_graph"]}]`
