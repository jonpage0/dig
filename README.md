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

Quit and reopen ChatGPT, then type **`$dig:setup`** in a new conversation. It walks you through choosing sources.

> **Try it with no keys:** Hacker News, DeepWiki and Polymarket work without any account.

## What Dig does

Ask a question in Codex. Dig researches it source by source, writes a report for each source, and keeps the original responses behind every claim.

**21 sources · 23 research methods · 56 provider tools**

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Source | What you get |
| :---: | --- | --- |
| <img src="docs/logos/exa.svg" width="22" height="22" alt=""> | **Exa** | Web search and page text |
| <img src="docs/logos/perplexity.svg" width="22" height="22" alt=""> | **Perplexity** | Cited web answers |
| <img src="docs/logos/github.svg" width="22" height="22" alt=""> | **GitHub** | Repositories, their activity and source code |
| <img src="plugin/assets/skills/book-open-text.svg" width="22" height="22" alt=""> | **DeepWiki** | Questions about a public codebase |
| <img src="docs/logos/ycombinator.svg" width="22" height="22" alt=""> | **Hacker&nbsp;News** | Developer stories and discussion |
| <img src="plugin/assets/skills/graduation-cap.svg" width="22" height="22" alt=""> | **Papers** | Semantic Scholar, OpenAlex and 19 more indexes; full text and PDFs |
| <img src="docs/logos/youtube.svg" width="22" height="22" alt=""> | **YouTube** | Full video transcripts |
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
- **A library** in Codex's sidebar to browse and search past research, plus a research trail beside the conversation.
- **Costs as each provider reports them.** Unknown stays unknown; Dig never guesses.

Good to know:

- **You choose the sources.** Run one directly (`$dig:reddit`) or let Codex combine several.
- **Public data only.** Dig doesn't log in to social accounts or read private content. Coverage varies by platform.
- **X has two ways in.** X's API returns the posts themselves; Grok adds search by meaning and reads images and videos. Three methods use them: X judge weighs claims, X breadth finds as many angles as it can, X post inspects one post.

## Services and API keys

**You only need keys for the sources you turn on.** Each service bills you directly, separately from your ChatGPT plan.

**No key needed:** Hacker News, DeepWiki, Polymarket.
**Works without a key, with limits:** GitHub (lower rate limits), Papers (shared rate limits), YouTube (needs `yt-dlp` installed).

| Service | Used by | Key name in `keys.env` |
| --- | --- | --- |
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
| [DataForSEO](https://app.dataforseo.com/api-access) | **DataForSEO**: search results, keywords, rankings, backlinks | `DATAFORSEO_USERNAME`, `DATAFORSEO_PASSWORD` |

Partial setups work. X's API and Grok are independent, and so are Amazon's current data and its history. Dig names what's unavailable instead of quietly swapping in another source.

**Local tools:** YouTube transcripts need [`yt-dlp`](https://github.com/yt-dlp/yt-dlp). Federated paper search, full text and PDFs need the optional Papers bridge (`git` and `uv`).

[Sources and their keys](docs/sources.md) has every option, alias and setup step.

### Adding keys

Keys never go in the chat. On Dig's **Sources** page, click **Edit keys.env**, paste your keys after the `=` signs and save. Dig picks up the change right away. The file lives at `~/.local/share/dig/keys.env`.

## Use

- **Ask a research question** normally, or name the sources you want.
- **Run one method:** type `$dig:` and pick one, such as `$dig:x-post` or `$dig:facebook`.
- **Open Dig** from the sidebar to read reports, original responses and costs.
- **Reuse past research** by typing `@` in the composer.

## Update

```sh
codex plugin marketplace upgrade dig
codex plugin add dig@dig
```

Then quit and reopen ChatGPT. Your settings, keys and research are kept.

## Privacy and costs

- **Runs on your computer.** Dig has no server of its own and collects nothing.
- **What leaves your computer:** searches go only to the services you turn on, with your keys. Their results enter your Codex conversation.
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
