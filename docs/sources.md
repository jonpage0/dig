# Sources and their keys

Dig has 25 research sources and 2 shared tools, with 81 actions between them and 30 research methods. Each source and each shared tool is one tool, named by its id with `-` written as `_` (`hackernews`, `tikhub_reddit`, `google_ads`). A call to it names the dig, one of its actions and that action's arguments:

```json
{ "dig": "<the handle dig_start returned>", "action": "x_post", "args": { "posts": ["https://x.com/…/status/…"] } }
```

A source you have not turned on is not listed to the assistant. Turning one on lists its tool; it does not authorise spending. Ask your assistant to set Dig up, or change `<source>_enabled` with the `settings` tool. `source_info` reports each source's readiness, its actions, its methods and what each action has cost in your library over the last 90 days.

No source needs any other. Hacker News, DeepWiki, Polymarket and the Wayback Machine need no account. GitHub and the direct Papers searches run without keys at lower limits. YouTube's keyless search needs a local `yt-dlp`. Other sources use your own provider accounts, which bill you separately from your ChatGPT or Claude plan.

## Keys

Dig reads keys only from `keys.env` in its folder (`~/.local/share/dig/keys.env`), one `NAME=value` per line. A key exported in the environment of the program that started Dig is not used.

- To enter keys, ask the assistant; it calls the `keys` tool, which opens a one-time page that Dig serves on your computer with one field per key. What you type goes into `keys.env` and is used at once, and never passes through the conversation. In the views, **Enter keys** on a source opens the same page.
- You can also edit `keys.env` yourself; Dig picks up a saved change without a restart. Keep the file private (`chmod 600` on macOS and Linux).
- Never paste a key into the chat. Dig never asks for one there.
- **Ready** means the keys are present, not that the provider accepted them. The first call shows whether a key works.

## Every source at a glance

Actions marked † are slow and run as jobs (see [the architecture](architecture.md#jobs)). Actions marked $ are metered: each call records a cost, or an unknown cost, and may be asked about before it is sent (see [permissions](permissions.md#spending)). Unmarked actions are free.

| Source (tool) | What it reads | Keys | Actions | Methods | Cost |
| --- | --- | --- | --- | --- | --- |
| Hacker News (`hackernews`) | Stories and comment threads, through Algolia | None | `hackernews`, `hackernews_read` | `hackernews` | Free |
| DeepWiki (`deepwiki`) | How a public GitHub repository is built | None | `deepwiki_read_wiki_structure`, `deepwiki_read_wiki_contents`, `deepwiki_ask_question` † | `deepwiki` | Free |
| Polymarket (`polymarket`) | Prediction-market odds, volume, price history and resolutions | None | `polymarket`, `polymarket_history`, `polymarket_resolution` | `polymarket` | Free |
| Wayback Machine (`wayback`) | What a web page said on a given date | None | `wayback_snapshots`, `wayback_read` | `wayback` | Free |
| GitHub (`github`) | Repositories, their activity and source | Optional `GH_TOKEN` or `GITHUB_TOKEN`, or a `gh` login | `github_search`, `github_inspect`, `github_read` | `github` | Free |
| Exa (`exa`) | Web search, page text, similar pages, deep research | `EXA_API_KEY` | `exa_search` $, `exa_contents` $, `exa_similar` $, `exa_research` $ † | `exa` | US dollars, as Exa reports |
| Perplexity (`perplexity`) | Cited answers and web search | `PERPLEXITY_API_KEY` | `perplexity_ask` $, `perplexity_search` $, `perplexity_research` $ †, `perplexity_reason` $ † | `perplexity` | US dollars for ask, reason and research; search reports none, so unknown |
| Papers (`papers`) | Scholarly papers, citations, snippets, full text, PDFs and sections | Optional; see [Papers](#papers) | `papers_semantic_scholar_search`, `papers_semantic_scholar_recommendations`, `papers_semantic_scholar_snippets`, `papers_semantic_scholar_relations`, `papers_openalex_search` $, `papers_openalex_content` $, `papers_multi_search` $ †, `papers_sections` †, `papers_fulltext_read` $ †, `papers_pdf_download` $ † | `papers` | Mostly free; OpenAlex reports a US-dollar usage cost its free daily allowance can cover |
| YouTube (`youtube`) | Video discovery, transcripts, comments and Gemini video understanding | Optional by route; see [YouTube](#youtube) | `youtube` †, `youtube_transcript` $, `youtube_comments` $, `youtube_analyze` $ †, `youtube_analysis_status` $ † | `youtube`, `youtube-video` (with the helper `youtube-summarizer`) | yt-dlp and Data API free; ScrapeCreators credits; Gemini unknown |
| X (`x`) | Posts, threads, accounts, followers, search, counts, X News, Communities and the pictures in posts; Grok's search by meaning | `XAI_API_KEY`, `X_BEARER_TOKEN`; optional sign-in keys and `TIKHUB_API_KEY` | `xsearch` $ †, `x_post` $, `x_search_posts` $, `x_count_posts` $, `x_users` $, `x_follows` $, `x_news` $, `x_explore` $, `x_bookmarks` $, `x_likes` $, `x_community` $, `x_images` | `x-judge`, `x-breadth`, `x-post`, `x-trace` | xAI in US dollars; X reads as post and account reads; see [X](#x) |
| Reddit (`reddit`) | Threads, comments and collapsed replies | `SCRAPECREATORS_API_KEY` | `reddit` $ | `reddit` | ScrapeCreators credits |
| TikHub Reddit (`tikhub_reddit`) | A thread's comments with collapsed-reply continuations, and subreddit context | `TIKHUB_API_KEY` | `tikhub_reddit` $ | `tikhub-reddit` | Unknown (TikHub reports no amount) |
| TikTok (`tiktok`) | Public videos, photo posts, creator feeds, comments and transcripts | `SCRAPECREATORS_API_KEY` | `scrapecreators_tiktok` $, `tiktok_top` $, `tiktok_comments` $, `tiktok_read` $ | `tiktok` | ScrapeCreators credits |
| Instagram (`instagram`) | Public posts, reels, creator feeds, comments and transcripts | `SCRAPECREATORS_API_KEY` | `scrapecreators_instagram` $, `instagram_comments` $, `instagram_read` $ | `instagram` | ScrapeCreators credits |
| Facebook (`facebook`) | Public profiles, posts, groups, videos and events | `SCRAPECREATORS_API_KEY` | `scrapecreators_facebook` $, `scrapecreators_facebook_events` $ | `facebook` | ScrapeCreators credits |
| Threads (`threads`) | Public posts, replies and account posts | `SCRAPECREATORS_API_KEY` | `threads` $ | `threads` | ScrapeCreators credits |
| LinkedIn (`linkedin`) | Public profiles, companies and posts | `SCRAPECREATORS_API_KEY` | `scrapecreators_linkedin` $ | `linkedin` | ScrapeCreators credits |
| Telegram (`telegram`) | Public channel previews and posts | `SCRAPECREATORS_API_KEY` | `scrapecreators_telegram` $ | `telegram` | ScrapeCreators credits |
| China social (`china_social`) | Xiaohongshu, Bilibili, Douyin, Weibo, Zhihu, Kuaishou, WeChat | `TIKHUB_API_KEY`; optional `JUSTONE_API_KEY` | `china_social_search` $ | `china-social` | Unknown |
| Commerce (`commerce`) | Amazon products, deals, Best Sellers, price and rank history, reviews | `SCRAPE_DO_API_KEY` (or `SCRAPEDO_API_TOKEN`); optional `NEXSCOPE_API_KEY` | `commerce_search` $, `commerce_product` $, `commerce_history` $, `commerce_reviews` $, `commerce_discover` $ | `commerce` | Scrape.do credits; Nexscope unknown |
| TikTok ads (`tiktok_ads`) | Creative Center top ads and the public Ad Library | `TIKHUB_API_KEY`, `SCRAPECREATORS_API_KEY` | `tiktok_ads_search` $, `tiktok_ads_top` $, `tiktok_ads_detail` $, `tiktok_ad_library` $ | `tiktok-ads` | Creative Center unknown; Ad Library ScrapeCreators credits |
| Facebook ads (`facebook_ads`) | Meta Ad Library advertisers, ads and transcripts | `SCRAPECREATORS_API_KEY` | `facebook_ad_library` $ | `facebook-ads` | ScrapeCreators credits |
| Google ads (`google_ads`) | Ads Transparency Center advertisers, their ads and ad details | `SCRAPECREATORS_API_KEY` | `google_ad_library` $ | `google-ads` | ScrapeCreators credits |
| LinkedIn ads (`linkedin_ads`) | Ad Library ads with their payer and published targeting and impressions | `SCRAPECREATORS_API_KEY` | `linkedin_ad_library` $ | `linkedin-ads` | ScrapeCreators credits |
| DataForSEO (`dataforseo`) | Search results, keywords, rankings, backlinks, Google Trends, Google ads, app-store and Trustpilot reviews, AI visibility | `DATAFORSEO_USERNAME`, `DATAFORSEO_PASSWORD` | `dataforseo_docs_sections`, `dataforseo_docs_index`, `dataforseo_docs_read`, `dataforseo_request` $ † | `dataforseo`, `dataforseo-ai-visibility` | US dollars per request, as DataForSEO reports; the sandbox is free |
| Video analysis (`video`, shared tool) | A supplied video or clip, through Elorian Glimpse | `ELORIAN_API_KEY` | `video_analyze` $ † | helper `video-analyze` | Unknown (tokens shown) |
| Evidence ranking (`evidence`, shared tool) | A reading order for supplied excerpts, through TypeSafe Jev | `TYPESAFE_API_KEY` | `evidence_rank` $ | helper `evidence-rank` | Unknown (tokens shown) |

Counted from the catalog in `src/providers/modules.ts`: 27 entries (25 sources, 2 shared tools), 81 actions of which 23 are free and 14 slow, and 31 methods for the sources (30 research methods and the `youtube-summarizer` helper). With `dig`, `library`, `setup` and the two shared-tool helpers, Dig serves 36 methods.

A method is a set of instructions for researching one source: what to search, how to weigh it and how to write the report. Your assistant reads one with the `method` tool, or receives it from the host as a prompt or skill. One key can cover several sources: ScrapeCreators serves several social sources, the ad libraries and hosted YouTube transcripts; TikHub serves advanced Reddit, China social, TikTok ads and some X reads.

## GitHub

GitHub's public REST reads work without a login at lower anonymous limits. A token or an existing `gh` login raises the limits and adds review and issue-reply samples, which need GraphQL. Either is optional:

- Put a GitHub personal access token in `keys.env` as `GH_TOKEN` (or `GITHUB_TOKEN`). A classic token with no scopes is enough, since Dig reads only public data.
- Or log in with the GitHub CLI: `gh auth login`. Dig uses that login when `keys.env` has no GitHub token.

Results say which login they used, or that they ran anonymously.

## YouTube

Choose the route that answers your question; none needs every YouTube option:

| Route | Setup | What it does |
| --- | --- | --- |
| Discovery and local captions | Install `yt-dlp`; Dig gives it its own Node as the JavaScript runtime | The `youtube` action searches without a key and saves each video's English captions in the library: the uploaded captions, or automatic ones when there are none. |
| YouTube Data API metadata | Optional `OPENCODE_RESEARCH_GOOGLE_API_KEY` from [Google Cloud](https://console.cloud.google.com/apis/credentials) | Adds keyed metadata search; it does not enable Gemini analysis. |
| Hosted transcripts and comments | Optional `SCRAPECREATORS_API_KEY` | `youtube_transcript` keeps the returned timing and language; it is called explicitly, never as an automatic paid fallback. `youtube_comments` reads one page of a video's comments, top or newest, with a cursor for the next. |
| Gemini video understanding | Optional `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey) | `youtube_analyze` analyzes supplied public YouTube videos with Flash or Argon, without local download tools. |

The `youtube` method researches discovery and transcripts; the `youtube-video` method analyzes selected videos in depth, starting with Gemini 3.8 Flash and preferring Gemini 4 Argon for harder reasoning. A focused visual need, or your explicit choice, can go to the Video analysis tool instead.

`GEMINI_API_KEY` is Dig's only Gemini credential name. Keep it separate from `OPENCODE_RESEARCH_GOOGLE_API_KEY`; having one does not set up the other route. Some videos' captions need yt-dlp's proof-of-origin token plugin; without it, yt-dlp skips those captions. Dig never installs programs or reads browser cookies. See [YouTube video understanding](youtube-video.md).

## X

X has two ways in. `XAI_API_KEY` lets Grok search X (`xsearch`) and interpret what it finds. Grok image and video understanding are off by default on `xsearch` to control cost (pass `media: true` when a pass needs Grok to watch video or inspect images; `x_images` stays the free path for images), and completed passes report `Posts fetched` and `Users fetched` when xAI returns them. `X_BEARER_TOKEN` reads X's own API: posts by link with their thread, replies, quotes and reposters (`x_post`); recent and full-archive search back to March 2006 (`x_search_posts`) and post counts (`x_count_posts`, a full-archive count needs a start time); accounts with their posts and mentions (`x_users`); who an account follows and who follows it (`x_follows`, one page per call); X News (`x_news`); trends, Spaces, Communities and Lists (`x_explore`, `x_community`). To get the token:

1. Create a pay-per-use developer account at [console.x.com](https://console.x.com) and add credits.
2. Set a spending limit there, because X does not report what each call costs.
3. Create an app and copy its Bearer Token into `keys.env` as `X_BEARER_TOKEN`.

X is ready with both keys and partly ready with one. X bills reads per post or account returned but reports no charge, so for the actions that read posts and accounts Dig records what X returned, as X post reads and X account reads: counts, not money. X's bill can be lower, since X charges a resource once per UTC day. Counts, X News, trends, Spaces, Lists and Communities record an unknown cost. `x_follows` returns every account it is asked for, and X bills each one, so ask for no more than you need. If a single post cannot be read through X's API (no token, no credits, a rate limit or an outage) and `TIKHUB_API_KEY` is set, Dig reads it through TikHub instead and says so.

### Optional: sign in as your own X account

People search, Communities search, your bookmarks (`x_bookmarks`) and your likes (`x_likes`) are served by X only to a signed-in account. To use them, copy four values from your app's **Keys and tokens** page at [console.x.com](https://console.x.com) into `keys.env`:

- the app's Consumer Key and Secret as `X_CONSUMER_KEY` and `X_CONSUMER_SECRET`;
- an Access Token and Secret generated for your own account as `X_ACCESS_TOKEN` and `X_ACCESS_TOKEN_SECRET`.

Dig only reads, so the app's **Read** permission is enough, and with it the token cannot post, like or follow as you. An access token keeps the permission it was generated with, so regenerate it after changing the permission. Signed-in calls see what your account can see, including your private bookmarks and likes; every other read uses the Bearer Token. Without sign-in, Communities search goes through TikHub when `TIKHUB_API_KEY` is set.

`x_bookmarks` can read one bookmark folder by name or id. Both `x_bookmarks` and `x_likes` take `match` to keep only posts in which every word you give starts a word ("ai" finds "AI" and "#AI" but not "brainstorm"), because X has no search inside them.

`x_community` reads one Community by id or link: its details from X's API and its posts through TikHub, which needs `TIKHUB_API_KEY`.

`x_images` shows your assistant the pictures in posts, from the image links the other X actions print. It needs no key and costs nothing: it fetches only from X's public image host. The pictures go to the assistant in the call's result and are not kept; a note of each one's link, type and size is.

X has four research methods: **x-judge** weighs claims by reach and kind of source and reads every post it relies on; **x-breadth** finds as many distinct posts, accounts and angles as it can without judging them; **x-post** reads particular posts and reports what surrounds them; **x-trace** starts from a post, an account or a claim and works outward through X's own API (the thread, the people replying, their profiles and recent posts, and what they point to), weighs each voice by who it is and what it knows rather than by likes, works to a budget of post reads and account reads, and uses Grok for at most one pass.

## Facebook and Facebook ads

Both use your ScrapeCreators key. Turn on **Facebook** for public profiles, posts, groups, videos and events, and **Facebook ads** separately for Meta's Ad Library. Neither needs a Facebook login.

Facebook research starts from a public URL, a video search or event discovery. It is not a general search of every Facebook post. Private and gated content is unavailable, and a public group's accessible page is not a complete archive. Available transcripts describe speech, not everything shown in a video.

Facebook ads searches advertiser and ad records. Keep the country, filters, dates and pages inspected with any conclusion: an empty filtered page does not prove that an advertiser runs no ads, and an ad's run duration does not establish its return on spend.

## Google ads and LinkedIn ads

Both use your ScrapeCreators key, and each is turned on separately; neither needs a Google or LinkedIn login.

Google ads finds an advertiser in Google's Ads Transparency Center, lists its ads by region, date and format, and reads one ad's text, destination, media addresses, regions and dates. Several advertiser accounts can share a name, so confirm the advertiser before reading its ads. Google shows ads from verified advertisers only, and gives no spend, reach or results outside political ads; ads that need a Google login to view are unavailable.

LinkedIn ads searches LinkedIn's Ad Library by company, keyword, country and date, and reads one ad's text, payer, and the targeting and impression ranges LinkedIn publishes. The library covers ads shown in roughly the last year, and gives no spend or results.

The ad library's own `action` (`advertisers`, `ads` and so on) is an argument inside `args`, not the tool's `action`, which is always `google_ad_library` or `linkedin_ad_library`. As with Facebook ads, keep the filters, dates and pages inspected with any conclusion.

## Papers

Semantic Scholar and OpenAlex search work without any setup. Federated search across more databases (`papers_multi_search`), full text (`papers_fulltext_read`), PDF downloads (`papers_pdf_download`) and section extraction (`papers_sections`) need the Papers bridge, which needs `git` and `uv`. From your Dig checkout, run:

```sh
node bridges/papers/setup.mjs --email you@example.com
```

`source_info` gives the exact command with its full path. Setup downloads a pinned copy of [paper-search-mcp](https://github.com/openags/paper-search-mcp) and its Python dependencies into Dig's folder (`tools/paper-search-mcp`). Unpaywall, one of its databases, needs a contact email: pass `--email` to setup, or put `PAPER_SEARCH_MCP_UNPAYWALL_EMAIL` in `keys.env`. Run setup again when `source_info` says the bridge is out of date.

The bridge adds 20 search connectors, including OpenReview, arXiv, PubMed, PMC, Crossref, OpenAlex and Unpaywall; each still depends on its upstream service. Keys are optional:

| Name | What it enables |
| --- | --- |
| `SEMANTIC_SCHOLAR_API_KEY` | A Semantic Scholar rate limit of your own, for the direct actions and the bridge's Semantic Scholar connector. |
| `OPENALEX_API_KEY` | Your OpenAlex allowance and rate limit, for the direct actions and the bridge's OpenAlex and SSRN connectors. OpenAlex usage can be metered even with free allowance left. |
| `NCBI_API_KEY` | Higher NCBI limits for the bridge's PubMed and PMC connectors. |
| `PAPER_SEARCH_MCP_CORE_API_KEY` | A key for the bridge's CORE connector, which also runs without one. |
| `PAPER_SEARCH_MCP_UNPAYWALL_EMAIL` | A contact email, not a key. Enables Unpaywall's lookup of legal open-access copies; without it, that connector is skipped. |

The direct actions and the bridge also accept `PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY` and `PAPER_SEARCH_MCP_OPENALEX_API_KEY`, and the bridge accepts `PAPER_SEARCH_MCP_NCBI_API_KEY`. When both spellings are set, the `PAPER_SEARCH_MCP_` name wins. One key per provider is enough for most people. The key page covers credentials only; put the Unpaywall email in `keys.env` yourself or pass it to setup.

## DataForSEO

DataForSEO charges per request from a prepaid account. Set `DATAFORSEO_USERNAME` (the API login, usually your account email) and `DATAFORSEO_PASSWORD` (the API password from the API Access page of DataForSEO's dashboard, not your dashboard password). Dig records each request's reported cost and never repeats a request on its own. `dataforseo_request` with `sandbox: true` checks a request's shape against DataForSEO's free sandbox, with dummy data. The `dataforseo` method has routes for how interest in a term has changed (Google Trends, whose values are relative to the peak inside one request, not search volume), the ads a company runs on Google (when Google showed each ad, not what it spent or achieved), and reviews of an app or a company (App Store, Google Play and Trustpilot, posted as tasks and retrieved afterwards). The `dataforseo-ai-visibility` method compares how often a brand or page is mentioned or cited in AI answers.

## Video analysis

The shared `video` tool's one action, `video_analyze`, inspects a video with Elorian Glimpse. It runs under a dig like any call, directly in the conversation or alongside a source method; it saves no report of its own. Turn on **Video analysis** and put `ELORIAN_API_KEY` in `keys.env`, from [Elorian's key page](https://platform.elorian.ai/settings/keys).

For broader YouTube analysis, use Gemini through the `youtube-video` method first. Choose Glimpse for a focused visual need or an explicit provider preference. Direct video-file URLs work without local programs; local and YouTube clips need `ffmpeg` and `ffprobe`, plus `yt-dlp` for YouTube. The result shows token and media coverage; the dollar cost stays unknown, since Elorian reports none. See [Glimpse video inspection](video-analysis.md).

## Evidence ranking

The shared `evidence` tool's one action, `evidence_rank`, uses TypeSafe Jev to suggest a reading order for excerpts the assistant supplies. Turn on **Evidence ranking** and add `TYPESAFE_API_KEY` from the [TypeSafe console](https://console.typesafe.ai/keys) to `keys.env`. It needs no local program. It is off by default and runs only when the assistant chooses to call it.

It sends the question, the excerpts and an optional claim to TypeSafe. It does not retrieve the references, drop candidates or establish truth. Returned usage is shown when available; the dollar cost stays unknown. See [evidence ranking](evidence-ranking.md).
