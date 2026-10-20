# Dig

Source-by-source research for Codex in the ChatGPT desktop app, with every report and original response saved where you can check it.

<p align="center">
<img src="docs/logos/exa.svg" width="32" height="32" alt="Exa" title="Exa">
<img src="docs/logos/perplexity.svg" width="32" height="32" alt="Perplexity" title="Perplexity">
<img src="docs/logos/github.svg" width="32" height="32" alt="GitHub" title="GitHub">
<img src="docs/logos/ycombinator.svg" width="32" height="32" alt="Hacker News" title="Hacker News">
<img src="docs/logos/youtube.svg" width="32" height="32" alt="YouTube" title="YouTube">
<img src="docs/logos/x.svg" width="32" height="32" alt="X" title="X">
<img src="docs/logos/reddit.svg" width="32" height="32" alt="Reddit" title="Reddit">
<img src="docs/logos/tiktok.svg" width="32" height="32" alt="TikTok" title="TikTok">
<img src="docs/logos/instagram.svg" width="32" height="32" alt="Instagram" title="Instagram">
<img src="docs/logos/linkedin.svg" width="32" height="32" alt="LinkedIn" title="LinkedIn">
<img src="docs/logos/telegram.svg" width="32" height="32" alt="Telegram" title="Telegram">
<img src="docs/logos/polymarket.svg" width="32" height="32" alt="Polymarket" title="Polymarket">
</p>

## Install

You need:

- the **ChatGPT desktop app with Codex** (tested on macOS);
- **[Node.js](https://nodejs.org) 22 or newer** (`node --version` to check).

Then run:

```sh
codex plugin marketplace add jonpage0/dig
codex plugin add dig@dig
```

If your terminal doesn't know `codex`, use the copy inside the ChatGPT app:

```sh
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex plugin marketplace add jonpage0/dig
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex plugin add dig@dig
```

Refresh the plugin connection, then type **`$dig:setup`** in a new conversation. It walks you through choosing sources. If Dig still does not appear after the refresh, quit and reopen ChatGPT.

> **Try it with no keys:** Hacker News, DeepWiki and Polymarket work without any account.

For a first run, ask: **“Use Dig and Hacker News to research how developers approach local-first software. Save the report and show the original discussions behind the findings.”** Open the saved report, inspect an original response, then ask Dig to find that research again later.

## What Dig does

Ask a question in Codex. Dig researches it source by source, writes a report for each source, and keeps the original responses behind every claim.

**22 sources · 26 research methods · 71 tools, including shared video analysis**

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Source | What you get |
| :---: | --- | --- |
| <img src="docs/logos/exa.svg" width="22" height="22" alt=""> | **Exa** | Web search and page text |
| <img src="docs/logos/perplexity.svg" width="22" height="22" alt=""> | **Perplexity** | Cited web answers |
| <img src="docs/logos/github.svg" width="22" height="22" alt=""> | **GitHub** | Repositories, their activity and source code |
| <img src="plugin/assets/skills/book-open-text.svg" width="22" height="22" alt=""> | **DeepWiki** | Questions about a public codebase |
| <img src="docs/logos/ycombinator.svg" width="22" height="22" alt=""> | **Hacker&nbsp;News** | Developer stories and discussion |
| <img src="plugin/assets/skills/graduation-cap.svg" width="22" height="22" alt=""> | **Papers** | Semantic Scholar, OpenAlex and 18 more indexes; full text and PDFs |
| <img src="docs/logos/youtube.svg" width="22" height="22" alt=""> | **YouTube** | Video discovery, saved transcripts and optional Gemini video understanding |
| <img src="docs/logos/x.svg" width="22" height="22" alt=""> | **X** | Exact posts, threads and accounts; Grok for search by meaning, images and video |
| <img src="docs/logos/reddit.svg" width="22" height="22" alt=""> | **Reddit** | Threads, comments and full comment trees |
| <img src="docs/logos/tiktok.svg" width="22" height="22" alt=""> | **TikTok** | Videos, captions and transcripts |
| <img src="docs/logos/instagram.svg" width="22" height="22" alt=""> | **Instagram** | Reels, accounts and transcripts |
| <img src="plugin/assets/skills/messages-square.svg" width="22" height="22" alt=""> | **Facebook** | Public pages, posts, groups and events |
| <img src="docs/logos/linkedin.svg" width="22" height="22" alt=""> | **LinkedIn** | Profiles, companies and posts |
| <img src="docs/logos/telegram.svg" width="22" height="22" alt=""> | **Telegram** | Public channels and posts |
| <img src="plugin/assets/skills/languages.svg" width="22" height="22" alt=""> | **China&nbsp;social** | Xiaohongshu, Bilibili, Douyin, Weibo, Zhihu, Kuaishou, WeChat |
| <img src="plugin/assets/skills/megaphone.svg" width="22" height="22" alt=""> | **Facebook&nbsp;ads** | Meta Ad Library advertisers and creatives |
| <img src="docs/logos/tiktok.svg" width="22" height="22" alt=""> | **TikTok&nbsp;ads** | Creative Center analytics and the Ad Library |
| <img src="docs/logos/polymarket.svg" width="22" height="22" alt=""> | **Polymarket** | Prediction-market odds |
| <img src="plugin/assets/skills/shopping-cart.svg" width="22" height="22" alt=""> | **Amazon** | Products, reviews and price history |
| <img src="plugin/assets/skills/chart-no-axes-combined.svg" width="22" height="22" alt=""> | **DataForSEO** | Search results, keywords, rankings and backlinks |

What you get back:

- **A report per source**, linking every post, page or paper it relies on.
- **The original responses**, saved so any claim can be checked.
- **A library** in Codex's sidebar to read past research, plus a research trail beside the conversation.
- **Costs as each provider reports them.** Unknown stays unknown; Dig never guesses.

Good to know:

- **You choose the sources.** Run one directly (`$dig:reddit`) or let Codex combine several.
- **Public research by default.** Optional X sign-in reads your own bookmarks and likes. Video analysis can upload a local project clip you select. Coverage varies by platform.
- **X has two ways in.** X's API returns the posts themselves; Grok adds search by meaning and reads images and videos. Three methods use them: X judge weighs claims, X breadth finds as many angles as it can, X post inspects one post.

## Video understanding

Ask **“Use Dig’s YouTube video method to analyze this demo from 35 to 55 seconds. What changes, and does it support the speaker’s claim? Give the video URL and original timestamps for each finding.”**

The optional **YouTube video** method (`$dig:youtube-video`) uses **Gemini 3.8 Flash** for standard deeper analysis. Choose **Gemini 4 Argon** next when the question needs harder reasoning. It can analyze selected intervals, compare up to ten video inputs, follow up on stored context, and return structured findings. Enable YouTube and add `GEMINI_API_KEY` in keys.env; this route needs no local downloader. The key is separate from the optional YouTube Data API key, and transcript research still works without it.

Use the standalone **Video analysis** tool (`$dig:video-analyze`) with [Elorian Glimpse](https://elorian.ai/) for a focused visual need or when you explicitly choose it. It works directly in the conversation, without a dig or report, and alongside appropriate source research. Enable it under **Sources & tools → Shared tools** and add `ELORIAN_API_KEY`. Direct video-file URLs work; local or YouTube clips need `ffmpeg` and `ffprobe`, plus `yt-dlp` for YouTube, and cover at most two minutes per selected interval.

Analysis remains model interpretation. Check exact speech and timestamps against the original; with several videos, require a separate original-video timeline for each. Google’s stored interaction history and Elorian’s uploaded media have their own retention, separate from Dig’s library. Both providers return token usage without a per-call dollar charge, so Dig records cost as unknown. See [YouTube video understanding](docs/youtube-video.md) and [Glimpse video inspection](docs/video-analysis.md) for controls, storage and evidence limits.

## Services and API keys

**You only need keys for the sources you turn on.** Each service bills you directly, separately from your ChatGPT plan.

**No key needed:** Hacker News, DeepWiki, Polymarket.
**Works without a key, with limits:** GitHub (lower rate limits), Papers (shared rate limits), YouTube (needs `yt-dlp` installed).

| Service | Used by | Key name in `keys.env` |
| --- | --- | --- |
| [Elorian](https://platform.elorian.ai/settings/keys) | **Video analysis**: selected clips, visual events and available speech | `ELORIAN_API_KEY` |
| [Exa](https://dashboard.exa.ai/api-keys) | **Exa**: web search, page text, similar pages | `EXA_API_KEY` |
| [Perplexity](https://console.perplexity.ai) | **Perplexity**: cited answers and web search | `PERPLEXITY_API_KEY` |
| [GitHub](https://github.com/settings/tokens) *(optional)* | **GitHub**: higher limits, plus review and issue samples | `GH_TOKEN` or `GITHUB_TOKEN` |
| [xAI](https://console.x.ai/team/default/api-keys) | **X**: Grok's search by meaning, including images and videos | `XAI_API_KEY` |
| [X API](https://console.x.com) | **X**: exact posts, threads, replies, accounts, search, counts, News | `X_BEARER_TOKEN` |
| X sign-in *(optional)* | **X**: your bookmarks and likes; people and Communities search | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` |
| [ScrapeCreators](https://app.scrapecreators.com) | **Reddit**, **TikTok**, **Instagram**, **Facebook**, **LinkedIn**, **Telegram**, **Facebook ads**, **TikTok ads** (Ad Library) | `SCRAPECREATORS_API_KEY` |
| [TikHub](https://user.tikhub.io/dashboard/api) | **Reddit** (advanced), **China social**, **TikTok ads** (Creative Center), **X** (Communities) | `TIKHUB_API_KEY` |
| [Just One](https://dashboard.justoneapi.com/en) *(optional)* | **China social**: an alternative backend, used only when asked for | `JUSTONE_API_KEY` |
| [Scrape.do](https://dashboard.scrape.do/) | **Amazon**: products, search, deals, Best Sellers | `SCRAPE_DO_API_KEY` |
| [Nexscope](https://www.nexscope.ai) *(optional)* | **Amazon**: reviews and price/rank history | `NEXSCOPE_API_KEY` |
| [Semantic Scholar](https://www.semanticscholar.org/product/api#api-key-form) *(optional)* | **Papers**: higher limits for paper search | `SEMANTIC_SCHOLAR_API_KEY` |
| [OpenAlex](https://openalex.org/settings/api) *(optional)* | **Papers**: your own OpenAlex allowance | `OPENALEX_API_KEY` |
| [Google Cloud](https://console.cloud.google.com/apis/credentials) *(optional)* | **YouTube**: Data API search | `OPENCODE_RESEARCH_GOOGLE_API_KEY` |
| [Google Gemini](https://aistudio.google.com/apikey) *(optional)* | **YouTube**: Gemini video understanding and follow-up analysis | `GEMINI_API_KEY` |
| [DataForSEO](https://app.dataforseo.com/api-access) | **DataForSEO**: search results, keywords, rankings, backlinks | `DATAFORSEO_USERNAME`, `DATAFORSEO_PASSWORD` |

Partial setups work. X's API and Grok are independent, and so are Amazon's current data and its history. YouTube discovery, hosted transcripts and Gemini video understanding have separate prerequisites. Dig names what's unavailable instead of quietly swapping in another source.

**Local tools:** YouTube transcripts need [`yt-dlp`](https://github.com/yt-dlp/yt-dlp). Federated paper search, full text and PDFs need the optional Papers bridge (`git` and `uv`).

[Sources and their keys](docs/sources.md) has every option, alias and setup step.

### Adding keys

Keys never go in the chat. On Dig's **Sources & tools** page, click **Edit keys.env**, paste your keys after the `=` signs and save. Dig picks up the change right away. The file lives at `~/.local/share/dig/keys.env`.

## Use

- **Ask a research question** normally, or name the sources you want.
- **Run one method:** type `$dig:` and pick one, such as `$dig:x-post` or `$dig:facebook`.
- **Open Dig** from the sidebar to read reports, original responses and costs.
- **Keep the overview in sight:** activity charts and costs stay visible above recent research. Expand the charts for more detail, and inspect original responses alongside a report.
- **Find saved research through the conversation:** ask Dig to locate earlier reports by project, source or topic. The dashboard focuses on the overview and reading.
- **Reuse past research** by typing `@` in the composer.

## Optional: route Dig from another conversation

The [Dig routing companion](optional/dig-routing/README.md) is a separate, instruction-only plugin that can use the current Dig connection or delegate to an authorized connected computer. Install it only if you want that routing skill:

```sh
codex plugin marketplace upgrade dig
codex plugin add dig-routing@dig
```

Its explicit invocation is `$dig-routing:route`; matching requests may select it automatically. Local installation makes it discoverable locally. Cloud-dot discovery and delegation require host support and separate verification.

## Update

```sh
codex plugin marketplace upgrade dig
codex plugin add dig@dig
```

Refresh Dig’s plugin/MCP connection, then verify the running version in About Dig or through `source_info`. Refresh an already-open Dig view after the server updates. Quit and reopen ChatGPT only if the connection still uses the old version. Your settings, keys and research are kept.

## Privacy and costs

- **Runs on your computer.** Dig has no server of its own and collects nothing.
- **What leaves your computer:** searches go to the services you turn on, with your keys. YouTube understanding sends selected public video references and your question to Google; Glimpse sends selected media or media references to Elorian. Their results enter your Codex conversation.
- **Provider history:** Google interaction storage is enabled by default for follow-ups and background results; a foreground first request can opt out with `store: false`. Elorian uploads expire according to its returned file metadata. These are separate from Dig’s local retention.
- **Where things are kept:** settings, keys and research live in `~/.local/share/dig` (you can choose another research folder).
- **Costs:** each service bills you. Dig shows what each reports; Codex model usage isn't included.
- **Provider terms still apply** to what you search and reuse.

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

Install a local checkout with `codex plugin marketplace add /path/to/dig`. See the [architecture](docs/architecture.md), the [changelog](CHANGELOG.md) and the [security policy](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE); bundled third-party licenses are in [plugin/THIRD_PARTY_NOTICES.md](plugin/THIRD_PARTY_NOTICES.md). Service logos are their owners' trademarks, shown to identify each service. Dig is an independent project, not affiliated with OpenAI, X or any provider.
