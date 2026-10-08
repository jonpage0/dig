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

| Area | Sources | What you get |
| --- | --- | --- |
| **Web** | <img src="docs/logos/exa.svg" width="18" height="18" alt=""> Exa · <img src="docs/logos/perplexity.svg" width="18" height="18" alt=""> Perplexity | Web search, page text, cited answers |
| **Code** | <img src="docs/logos/github.svg" width="18" height="18" alt=""> GitHub · <img src="plugin/assets/skills/book-open-text.svg" width="18" height="18" alt=""> DeepWiki · <img src="docs/logos/ycombinator.svg" width="18" height="18" alt=""> Hacker News | Repositories and their activity, questions about a codebase, developer discussion |
| **Papers** | <img src="plugin/assets/skills/graduation-cap.svg" width="18" height="18" alt=""> Semantic Scholar, OpenAlex, optional 19-connector bridge | Literature search, related work, open-access full text and PDFs |
| **Video** | <img src="docs/logos/youtube.svg" width="18" height="18" alt=""> YouTube | Full transcripts, so a claim can be checked against what was said |
| **X** | <img src="docs/logos/x.svg" width="18" height="18" alt=""> X API and xAI's Grok | Exact posts, threads, accounts, search and counts; search by meaning; descriptions of images and videos |
| **Social** | <img src="docs/logos/reddit.svg" width="18" height="18" alt=""> Reddit · <img src="docs/logos/tiktok.svg" width="18" height="18" alt=""> TikTok · <img src="docs/logos/instagram.svg" width="18" height="18" alt=""> Instagram · <img src="plugin/assets/skills/messages-square.svg" width="18" height="18" alt=""> Facebook · <img src="docs/logos/linkedin.svg" width="18" height="18" alt=""> LinkedIn · <img src="docs/logos/telegram.svg" width="18" height="18" alt=""> Telegram · <img src="plugin/assets/skills/languages.svg" width="18" height="18" alt=""> China social | Public posts, comments, profiles, groups and events |
| **Ads** | <img src="plugin/assets/skills/megaphone.svg" width="18" height="18" alt=""> Facebook ads · <img src="docs/logos/tiktok.svg" width="18" height="18" alt=""> TikTok ads | Ad libraries; TikTok Creative Center analytics |
| **Markets** | <img src="docs/logos/polymarket.svg" width="18" height="18" alt=""> Polymarket · <img src="plugin/assets/skills/shopping-cart.svg" width="18" height="18" alt=""> Amazon · <img src="plugin/assets/skills/chart-no-axes-combined.svg" width="18" height="18" alt=""> DataForSEO | Prediction-market odds; products, reviews and price history; search and SEO data |

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

| Service | Key name in `keys.env` | What it unlocks |
| --- | --- | --- |
| [Exa](https://dashboard.exa.ai/api-keys) | `EXA_API_KEY` | Web search, page text, similar pages |
| [Perplexity](https://console.perplexity.ai) | `PERPLEXITY_API_KEY` | Cited answers and web search |
| [GitHub](https://github.com/settings/tokens) *(optional)* | `GH_TOKEN` or `GITHUB_TOKEN` | Higher limits, plus review and issue samples |
| [xAI](https://console.x.ai/team/default/api-keys) | `XAI_API_KEY` | Grok's X search, including images and videos |
| [X API](https://console.x.com) | `X_BEARER_TOKEN` | Exact posts, threads, replies, accounts, search, counts, News |
| X sign-in *(optional)* | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | Your bookmarks and likes; people and Communities search |
| [ScrapeCreators](https://app.scrapecreators.com) | `SCRAPECREATORS_API_KEY` | Reddit, TikTok, Instagram, Facebook, LinkedIn, Telegram, Facebook ads, TikTok Ad Library |
| [TikHub](https://user.tikhub.io/dashboard/api) | `TIKHUB_API_KEY` | Advanced Reddit, China social, TikTok Creative Center; X Communities |
| [Just One](https://dashboard.justoneapi.com/en) *(optional)* | `JUSTONE_API_KEY` | An alternative China social backend, used only when asked for |
| [Scrape.do](https://dashboard.scrape.do/) | `SCRAPE_DO_API_KEY` | Amazon products, search, deals, Best Sellers |
| [Nexscope](https://www.nexscope.ai) *(optional)* | `NEXSCOPE_API_KEY` | Amazon reviews and price/rank history |
| [Semantic Scholar](https://www.semanticscholar.org/product/api#api-key-form) *(optional)* | `SEMANTIC_SCHOLAR_API_KEY` | Higher limits for paper search |
| [OpenAlex](https://openalex.org/settings/api) *(optional)* | `OPENALEX_API_KEY` | Your own OpenAlex allowance |
| [Google Cloud](https://console.cloud.google.com/apis/credentials) *(optional)* | `OPENCODE_RESEARCH_GOOGLE_API_KEY` | YouTube Data API search |
| [DataForSEO](https://app.dataforseo.com/api-access) | `DATAFORSEO_USERNAME`, `DATAFORSEO_PASSWORD` | Search results, keywords, rankings, backlinks |

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
