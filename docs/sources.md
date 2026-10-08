# Sources and their keys

Turn sources on and off on Dig's **Sources** page. Each source card says whether it is ready, which keys it uses and where to get them; **Setup details** on the card opens the full list.

No source requires that you configure every other source. Hacker News, DeepWiki and Polymarket need no account. GitHub public REST reads and direct Papers searches can run without keys, with provider-specific limits. YouTube's keyless path needs a local `yt-dlp`. Other sources use your own provider accounts; API charges are separate from your ChatGPT plan.

## Keys

Dig reads keys only from `keys.env` in Dig's folder (`~/.local/share/dig/keys.env`), one `NAME=value` per line. **Edit keys.env** on the Sources page creates the file if needed, adds an empty line for each key it is missing, and opens it; fill in the values and save. Dig picks up the change without a restart.

- Never paste a key into the chat. Dig never asks for one there.
- A key already exported in the environment that starts Codex is not used until you copy it in: the source's **Use existing key** button does that.
- If you create the file yourself, keep it private (`chmod 600` on macOS and Linux).
- "Ready" means the keys are present, not that the service accepted them. The first search shows whether a key works.

## What each source needs

| Source | Finds | Keys | Also needs |
| --- | --- | --- | --- |
| Hacker News | Stories and comments | None | |
| DeepWiki | How a public GitHub repository is built | None | |
| Polymarket | Prediction-market odds, volume and movement | None | |
| GitHub | Repositories, their activity and source | Optional: `GH_TOKEN` or `GITHUB_TOKEN` | Or a `gh` login |
| Exa | Web search and page text | `EXA_API_KEY` | |
| Perplexity | Cited answers on current facts | `PERPLEXITY_API_KEY` | |
| Papers | Scholarly papers, citations and full text | Optional: `SEMANTIC_SCHOLAR_API_KEY`, `OPENALEX_API_KEY`, `NCBI_API_KEY` and others | The Papers bridge (`git`, `uv`) for federated search, full text and PDFs |
| YouTube | Videos and their full transcripts | Optional: `OPENCODE_RESEARCH_GOOGLE_API_KEY` | `yt-dlp` |
| X | Posts, threads, accounts, search, counts, X News, Communities | `XAI_API_KEY` (Grok's X search) and `X_BEARER_TOKEN` (X's API); optional sign-in keys and `TIKHUB_API_KEY` | |
| Reddit | Threads and comments | `SCRAPECREATORS_API_KEY` | |
| TikHub Reddit | Full comment trees and subreddit context | `TIKHUB_API_KEY` | |
| TikTok, Instagram, LinkedIn, Telegram | Public posts and profiles | `SCRAPECREATORS_API_KEY` | |
| Facebook | Public profiles, posts, groups, videos and events | `SCRAPECREATORS_API_KEY` | |
| Facebook ads | Meta Ad Library advertisers, ads and transcripts | `SCRAPECREATORS_API_KEY` | |
| China social | Xiaohongshu, Bilibili, Douyin, Weibo, Zhihu, Kuaishou, WeChat | `TIKHUB_API_KEY`; optional `JUSTONE_API_KEY`, used only when the Just One backend is asked for | |
| Commerce | Amazon products, deals, price and rank history, reviews | `SCRAPE_DO_API_KEY` (or `SCRAPEDO_API_TOKEN`); optional `NEXSCOPE_API_KEY` for history and reviews, without which the card reads partly ready | |
| TikTok ads | Top ads and what an advertiser is running | `TIKHUB_API_KEY` and `SCRAPECREATORS_API_KEY` | |
| DataForSEO | Search results, keywords, rankings, backlinks | `DATAFORSEO_USERNAME` and `DATAFORSEO_PASSWORD` | |

One key often covers several sources: a ScrapeCreators key serves eight of them and a TikHub key four.

## GitHub

GitHub's public REST tools work without a login at lower anonymous limits. A token or existing `gh` login raises those limits and makes GraphQL-based review and issue-response samples available. Either is optional:

- Put a GitHub personal access token in `keys.env` as `GH_TOKEN` (or `GITHUB_TOKEN`). A classic token with no scopes is enough, because Dig reads only public data.
- Or log in with the GitHub CLI: `gh auth login`. Dig uses that login when `keys.env` has no GitHub token.

Results say which login they used, or that they ran anonymously.

## YouTube

Install `yt-dlp` for keyless search and transcripts, plus a JavaScript runtime it can use: Deno (its default) or Node 22+. Some videos' captions also need yt-dlp's proof-of-origin token plugin; without it, yt-dlp skips those captions. An optional `OPENCODE_RESEARCH_GOOGLE_API_KEY` adds YouTube Data API metadata. Dig never installs programs or reads browser cookies. Transcripts are saved in your library.

## X

X has two ways in. `XAI_API_KEY` lets Grok search X and interpret what it finds. `X_BEARER_TOKEN` reads X's own API: posts by link with their thread, replies, quotes and reposters; recent and full-archive search (back to March 2006) and post counts; accounts with their posts and mentions; X News; trends, Spaces, Communities and Lists. To get the token:

1. Create a pay-per-use developer account at [console.x.com](https://console.x.com) and add credits.
2. Set a spending limit there, because X does not report what each call costs.
3. Create an app and copy its Bearer Token into `keys.env` as `X_BEARER_TOKEN`.

The X card reads ready with both keys and partly ready with one. Dig records X API costs as unknown and never estimates them. If a single post can't be read through X's API (no token, no credits, a rate limit or an outage) and `TIKHUB_API_KEY` is set, Dig reads it through TikHub instead and says so.

### Optional: sign in as your own X account

People search, Communities search, your bookmarks (`x_bookmarks`) and your likes (`x_likes`) are served by X only to a signed-in account. To use them, copy four values from your app's **Keys and tokens** page at [console.x.com](https://console.x.com) into `keys.env`:

- the app's Consumer Key and Secret as `X_CONSUMER_KEY` and `X_CONSUMER_SECRET`;
- an Access Token and Secret generated for your own account as `X_ACCESS_TOKEN` and `X_ACCESS_TOKEN_SECRET`.

Dig only reads, so the app's **Read** permission is enough, and with it the token cannot post, like or follow as you. An access token keeps the permission it was generated with, so regenerate it after changing the permission. Signed-in calls see what your account can see, including your private bookmarks and likes; every other read keeps using the Bearer Token. Without sign-in, Communities search goes through TikHub when `TIKHUB_API_KEY` is set.

`x_bookmarks` can read one bookmark folder by name or id. Both `x_bookmarks` and `x_likes` take `match` to keep only posts in which every word you give starts a word ("ai" finds "AI" and "#AI" but not "brainstorm"), because X has no search inside them.

`x_community` reads one Community by id or link: its details from X's API and its posts through TikHub, which needs `TIKHUB_API_KEY`.

X has three research methods: **X judge** (`$dig:x-judge`) weighs claims by reach and kind of source and reads every post it relies on; **X breadth** (`$dig:x-breadth`) finds as many distinct posts, accounts and angles as it can without judging them; **X post** (`$dig:x-post`) reads particular posts and reports what surrounds them.

## Facebook and Facebook ads

Both use your existing ScrapeCreators key. Enable **Facebook** for public profiles, posts, groups, videos and events; enable **Facebook ads** separately for Meta's Ad Library. Neither needs a Facebook login.

Facebook research starts from a public URL, video search or event discovery. It is not a general search of every Facebook post. Private and gated content is unavailable, and a public group's accessible page is not a complete archive. Available transcripts describe speech, not everything shown in a video.

Facebook ads searches advertiser and ad records. Keep the country, filters, dates and pages inspected with any conclusion: an empty filtered page does not prove that an advertiser runs no ads, and an ad's run duration does not establish its return on spend.

## Papers bridge

Semantic Scholar and OpenAlex search work without the bridge. Federated search across more databases, full text and PDF downloads need the Papers bridge, which needs `git` and `uv`. Ask Dig for the installed plugin's path (it is in `source_info`), then run:

```sh
node /path/to/installed/plugin/bridges/papers/setup.mjs
```

Setup downloads a pinned copy of [paper-search-mcp](https://github.com/openags/paper-search-mcp) and its Python dependencies into Dig's folder. Unpaywall, one of its databases, needs a contact email: put `PAPER_SEARCH_MCP_UNPAYWALL_EMAIL` in `keys.env` or pass `--email you@example.com` to setup. Re-run setup after an update that changes the bridge.

### Optional Papers credentials and settings

Direct Semantic Scholar/OpenAlex searches work without the bridge. The bridge adds 19 search connectors, including arXiv, PubMed, PMC, Crossref, OpenAlex, Unpaywall and others; availability still depends on each upstream service. Keys are optional and are added outside chat to Dig's `keys.env`.

| Name | What it enables |
| --- | --- |
| `SEMANTIC_SCHOLAR_API_KEY` | A Semantic Scholar rate limit of your own for direct search/recommendations and the bridge's Semantic Scholar connector. |
| `OPENALEX_API_KEY` | Your OpenAlex allowance and rate limit for direct search and the bridge's OpenAlex/SSRN connectors. OpenAlex usage can be metered even with free allowance available. |
| `NCBI_API_KEY` | Higher NCBI request limits for the bridge's PubMed/PMC connectors. Not needed for direct Semantic Scholar or OpenAlex tools. |
| `PAPER_SEARCH_MCP_CORE_API_KEY` | An optional key for the bridge's CORE connector, which also runs without one. |
| `PAPER_SEARCH_MCP_UNPAYWALL_EMAIL` | A contact email, not an API key. Enables Unpaywall's lookup of legal open-access copies; without it, that connector is skipped. |

The direct tools and the bridge also accept `PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY` and `PAPER_SEARCH_MCP_OPENALEX_API_KEY`, and the bridge accepts `PAPER_SEARCH_MCP_NCBI_API_KEY`. When both spellings are set, the `PAPER_SEARCH_MCP_` name wins. Most users can keep one general key per provider. **Edit keys.env** offers every supported name; an empty line does not mean you need that key.

## DataForSEO

DataForSEO charges per request from a prepaid account. Set `DATAFORSEO_USERNAME` (the API login, usually your account email) and `DATAFORSEO_PASSWORD` (the API password from the API Access page of DataForSEO's dashboard, not your dashboard password). Dig records each request's reported cost and never retries a request on its own.
