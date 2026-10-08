# Dig

A research plugin for Codex in the ChatGPT desktop app, with source-specific research methods and a local evidence library.

## Install

You need the **ChatGPT desktop app with Codex** and **[Node.js](https://nodejs.org) 22 or newer** (`node --version` to check). Dig has been tested on macOS; other platforms have not been verified. The installed plugin is bundled: no npm install or source build is needed.

Run these two commands in a terminal:

```sh
codex plugin marketplace add jonpage0/dig
codex plugin add dig@dig
```

If your terminal doesn't know `codex`, use the copy inside the macOS ChatGPT app:

```sh
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex plugin marketplace add jonpage0/dig
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex plugin add dig@dig
```

Quit and reopen ChatGPT, then type **`$dig:setup`** in a new Codex conversation. Setup helps you choose sources and tells you which keys or local tools each one needs. **You can start with Hacker News without any API key.**

## What Dig does

Ask a question, choose the sources, and get source reports with links and retained original responses—not just an answer you cannot inspect. Dig currently includes **21 sources, 23 research methods and 56 provider tools**.

- **Research one source or combine several.** The conversation can run a method directly or use ordinary source workers, then read their reports and evidence before answering. Worker model and effort settings are suggestions, not enforced pins.
- **Search the web and code.** Exa and Perplexity provide web search and cited answers; GitHub discovers and inspects repositories; DeepWiki answers questions about a named repository; Hacker News supplies developer discussions.
- **Read papers and spoken content.** Search scholarly literature and related work, retrieve available open-access full text and PDFs, and save YouTube transcripts for claims about what a creator actually said.
- **Investigate X in two complementary ways.** X's API reads exact posts, threads, replies, accounts, search, counts, News and more. Grok adds semantic discovery, discourse analysis and interpretation of images and videos in X posts. Independent X judge, breadth and post methods weigh evidence, find different angles or inspect a particular post. Optional X sign-in adds your bookmarks and likes.
- **Research public social content and advertising.** Reddit, TikTok, Instagram, Facebook, LinkedIn, Telegram and Mainland-China social platforms have their own methods. Facebook includes public groups and events. Separate Facebook ads and TikTok ads methods inspect ad libraries; TikTok Creative Center also supplies selected-ad analytics. Access and coverage differ by platform—this is not private-account access or an exhaustive social archive.
- **Explore commerce and search markets.** Amazon products, deals, Best Sellers, reviews and price/rank history; Polymarket odds and liquidity; DataForSEO search results, keywords, rankings, backlinks, local business and AI visibility. Market odds are beliefs, not facts.
- **Keep the work inspectable.** Browse and search saved Markdown reports in the native library, open original responses, see the research trail beside the conversation, attach saved research with `@`, and inspect provider-reported costs. Retention can be switched off; missing evidence and unknown costs stay explicit.

## Services and API keys

**You do not need every service or key.** Enable only the sources you want. API accounts are separate from your ChatGPT plan: the services below may bill you directly even when Codex's model runs on your plan.

Hacker News, DeepWiki and Polymarket need **no account or API key**. GitHub public REST discovery and reading also work without a login, at lower limits. Direct Papers searches can run without keys; optional keys raise provider limits. YouTube has a keyless path through an installed `yt-dlp`.

| Service / account | Credential in Dig's `keys.env` | What it enables |
| --- | --- | --- |
| [Exa](https://dashboard.exa.ai/api-keys) | `EXA_API_KEY` | Web search, page extraction, similar pages; deep research when explicitly requested. |
| [Perplexity API](https://console.perplexity.ai) | `PERPLEXITY_API_KEY` | Web search and citation-grounded answers at different depths. |
| [GitHub](https://github.com/settings/tokens) — optional | `GH_TOKEN` or `GITHUB_TOKEN`, or an existing `gh` login | Higher public API limits and GraphQL-based review/issue-response evidence. |
| [xAI](https://console.x.ai/team/default/api-keys) | `XAI_API_KEY` | Grok's X search, semantic discovery and interpretation of post images/videos. Separate from the X developer API account. |
| [X API](https://console.x.com) | `X_BEARER_TOKEN` | Direct X reads: posts, threads, replies, quotes, accounts, recent/archive search, counts, News, trends, Spaces and Lists. |
| X sign-in — optional | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | People and Communities search as your account, plus your bookmarks, bookmark folders and liked posts. Use read-only app permissions. |
| [ScrapeCreators](https://app.scrapecreators.com) | `SCRAPECREATORS_API_KEY` | Reddit, TikTok, Instagram, LinkedIn, Telegram, Facebook public content/events, Facebook ads, and TikTok Ad Library. One key covers eight sources. |
| [TikHub](https://user.tikhub.io/dashboard/api) | `TIKHUB_API_KEY` | Advanced Reddit, Mainland-China social platforms, TikTok Creative Center; also X Community posts/search and a single-post fallback. |
| [Just One](https://dashboard.justoneapi.com/en) — optional | `JUSTONE_API_KEY` | An explicitly selected alternative backend for China social—not an automatic fallback. |
| [Scrape.do](https://dashboard.scrape.do/) | `SCRAPE_DO_API_KEY` or `SCRAPEDO_API_TOKEN` | Current Amazon products, searches, deals, Best Sellers and seller catalogs. |
| [Nexscope](https://www.nexscope.ai) — optional | `NEXSCOPE_API_KEY` | Amazon review samples and retrospective price/rank history, separate from Scrape.do's current snapshots. |
| [Semantic Scholar](https://www.semanticscholar.org/product/api#api-key-form) — optional | `SEMANTIC_SCHOLAR_API_KEY` | Higher limits for literature search and related-paper recommendations. |
| [OpenAlex](https://openalex.org/settings/api) — optional | `OPENALEX_API_KEY` | A provider allowance/rate limit of your own for OpenAlex literature searches. Usage can be paid or covered by its free allowance. |
| [Google Cloud / YouTube Data API](https://console.cloud.google.com/apis/credentials) — optional | `OPENCODE_RESEARCH_GOOGLE_API_KEY` | YouTube Data API search metadata. Transcripts still need `yt-dlp`. |
| [DataForSEO](https://app.dataforseo.com/api-access) | `DATAFORSEO_USERNAME` and `DATAFORSEO_PASSWORD` | Paid SEO/search-market queries. Use the API login and API password, not the dashboard password. |

Some capabilities also need local tools or extra provider settings:

- **YouTube:** install `yt-dlp` and a supported JavaScript runtime (Deno or Node 22+). Some captions additionally need yt-dlp's proof-of-origin token plugin. Dig does not install it or read browser cookies.
- **Federated Papers, full text and PDFs:** install the optional Papers bridge, using `git` and `uv`. Optional NCBI and CORE keys improve particular connectors; a contact email enables Unpaywall's legal open-access lookup. The [source setup guide](docs/sources.md#papers-bridge) lists the exact names and setup command.
- **Partial setup is useful:** X's API and Grok are independent; either can be used without the other's key. TikTok Creative Center and its Ad Library use different providers. Amazon current snapshots and history/reviews use different providers. Dig reports the unavailable part rather than silently replacing it.

For source-by-source requirements, optional aliases and access limits, see **[Sources and their keys](docs/sources.md)**. Dig's Sources page also links to each account's key page and shows which sources share a credential.

### Add keys outside the chat

On Dig's **Sources** page, select **Edit keys.env**. Fill in the keys you chose and save. Keys live in `~/.local/share/dig/keys.env`, never in the plugin or conversation; Dig reloads the file when saved. **Use existing key** copies a credential already in Codex's starting environment only when you request it. Never paste a key into chat.

## Use

- **Ask a research question** normally, or say which sources to use.
- **Run a method directly:** `$dig:reddit`, `$dig:x-post`, `$dig:facebook`, `$dig:facebook-ads` or another source method.
- **Open Dig** from the sidebar to browse reports, original evidence and costs.
- **Attach saved research** to a question with `@` in the composer.
- **Change source selection or worker suggestions** on Dig's Sources and Settings pages.

## Update

```sh
codex plugin marketplace upgrade dig
codex plugin add dig@dig
```

The first command refreshes the GitHub marketplace snapshot; the second installs its latest Dig package. Quit and reopen ChatGPT afterward. Settings, keys and saved research stay outside the installed package.

## Privacy and costs

- **Local storage, third-party retrieval:** Dig runs locally and has no research backend or telemetry service of its own. Queries and requested URLs go to the enabled providers; their responses enter your Codex conversation and are handled like the rest of that chat.
- **Your library:** settings and keys live in `~/.local/share/dig`; research lives in its `library` folder unless you select another folder. Original responses are retained only when retention is on and saving succeeds.
- **Your provider accounts:** each service bills you directly. Dig records reported charges in their original units, never merges different credit systems or estimates an unknown charge. Displayed totals exclude Codex model costs and are not a reconciled invoice.
- **Access rules still apply:** use providers and public data in accordance with their terms and applicable law. An available connector does not grant access to private content or permission to redistribute it. Research claims still need checking against the evidence.

## Uninstall

```sh
codex plugin remove dig@dig
codex plugin marketplace remove dig
```

Your research stays in `~/.local/share/dig` until you delete it.

## Development

```sh
npm install
npm run check   # build and offline tests
npm run smoke   # one live, keyless Hacker News search in a throwaway folder
```

To install a local checkout: `codex plugin marketplace add /path/to/dig`. The [architecture contract](docs/architecture.md) explains the boundaries; [CHANGELOG.md](CHANGELOG.md) lists releases. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE). Dig is an independent project, not an OpenAI, X or provider-endorsed plugin.
