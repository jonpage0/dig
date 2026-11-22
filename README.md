# Dig

Dig is a research service that runs on your computer. Your assistant (ChatGPT desktop, Codex, Claude Code, Antigravity or another MCP host) connects to it and searches the sources you turn on: the web, code, papers, videos, social platforms, ads and markets. Every call leaves a receipt, and with it the provider's original response, in a library on your disk; reports and answers are saved there too. Dig's methods tell the assistant how to research each source.

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

**New to Dig?** Read the [getting started guide](docs/getting-started.md).

## Requirements

- **[Node.js](https://nodejs.org) 22 or newer** (`node --version` to check).
- An MCP host: ChatGPT desktop, Codex, Claude Code, Antigravity or another client.
- Optional local programs for some sources: [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) for YouTube search and transcripts, `ffmpeg` and `ffprobe` for video clips, `git` and `uv` for the Papers bridge.

## Install

Build Dig from a checkout:

```sh
git clone https://github.com/jonpage0/dig.git
cd dig
npm ci
npm run build
```

The build writes the `dig` command to `dist/dig.mjs`, the local search runtime to `runtime/` and the host wrappers to `plugins/`; all three are generated, not tracked. Below, `dig` stands for `node /absolute/path/to/dig/dist/dig.mjs`: nothing installs a `dig` command, and on macOS and Linux that name is the DNS lookup tool, so type the full form in a terminal. In a host's configuration, use the absolute path.

### Connect a host

There are two ways to connect. In the **command form** the host launches `dig mcp`, which starts Dig's service when it is not running and forwards to it; nothing in the host's configuration holds a credential. In the **address form** the host connects to the running service at `http://127.0.0.1:47811/mcp` with a bearer token. The command form is the one to use unless your host can only connect to an address.

**Remove or disable the released Dig plugin first.** If Dig 0.15 or earlier is installed as a plugin in a host, remove or disable it there before you connect this one: both register a server named `dig`.

**Claude Code**, command form:

```sh
claude mcp add dig -- node /absolute/path/to/dig/dist/dig.mjs mcp
```

**Codex and ChatGPT desktop**, command form, in `~/.codex/config.toml`:

```toml
[mcp_servers.dig]
command = "node"
args = ["/absolute/path/to/dig/dist/dig.mjs", "mcp"]
tool_timeout_sec = 600
```

**Antigravity (`agy`)**, command form:

```sh
agy mcp add dig -- node /absolute/path/to/dig/dist/dig.mjs mcp
```

Then set `"timeoutSeconds": 600` on the `dig` entry in `~/.gemini/config/mcp_config.json` so slow provider calls do not time out.

**Address form.** Start the service with `dig serve` (or let a `dig mcp` start it). The token is `token` in `~/.local/share/dig/service.json`, which only you can read.

```sh
claude mcp add --transport http dig http://127.0.0.1:47811/mcp --header "Authorization: Bearer $(jq -r .token ~/.local/share/dig/service.json)"
```

For Codex, set `url = "http://127.0.0.1:47811/mcp"` under `[mcp_servers.dig]` and `bearer_token_env_var` to the name of an environment variable that holds the token. The token stays the same across restarts. The service exits after 30 minutes with nothing to do, and in the address form nothing starts it again: run `dig serve` before you use it.

**Host wrappers.** The build also generates thin wrappers in `plugins/` that launch `dig mcp` from your checkout: a marketplace named `dig-local` with a `dig` entry for Claude Code and one for Codex and ChatGPT (whose copy carries Dig's methods as ChatGPT skills), and a direct plugin directory `plugins/antigravity` for Antigravity (carrying `mcp_config.json` with `timeoutSeconds: 600` and Dig's methods as skills).

```sh
claude plugin marketplace add /absolute/path/to/dig/plugins
claude plugin install dig@dig-local
codex plugin marketplace add /absolute/path/to/dig/plugins
agy plugin install /absolute/path/to/dig/plugins/antigravity
```

then install `dig` from `dig-local` in Codex's plugin browser.

## First run

1. **Turn sources on.** Ask your assistant to set Dig up: it reads the `setup` method, shows the sources and turns on the ones you choose through the `settings` tool. Hacker News is on from the start. Hacker News, DeepWiki, Polymarket and the Wayback Machine need no key.
2. **Enter keys.** For a source that needs one, your assistant calls the `keys` tool. Your host asks you to open a page that Dig serves on your computer, with one field per key; what you type there goes straight into `keys.env` and never into the conversation. If the host cannot open pages, the assistant gives you the address to open in a browser. Never paste a key into the chat.
3. **Ask a question.** For example: **“Use Dig and Hacker News to research how developers approach local-first software. Show the strongest findings, disagreements and remaining gaps, and save the supporting research.”**

## Sources

**25 sources and 2 shared tools · 30 research methods · 82 actions · 39 tools the model sees, with every source on**

Each source and each shared tool is one tool, named after it (`hackernews`, `x`, `papers`, `google_ads`). A call names one of its actions, such as `x_post` or `papers_openalex_search`. With every source on, the model sees those 27 tools, 11 of Dig's own and `open_library`: a tool list of about 135,000 characters. A host that shows Dig's views also gets the views' own tools.

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Source | What you get |
| :---: | --- | --- |
| <img src="docs/logos/exa.svg" width="22" height="22" alt=""> | **Exa** | Web search and page text |
| <img src="docs/logos/perplexity.svg" width="22" height="22" alt=""> | **Perplexity** | Cited web answers |
|  | **Wayback&nbsp;Machine** | What a web page said on a given date, from the Internet Archive |
| <img src="docs/logos/github.svg" width="22" height="22" alt=""> | **GitHub** | Repositories, their activity and source code |
|  | **DeepWiki** | Questions about a public codebase |
| <img src="docs/logos/ycombinator.svg" width="22" height="22" alt=""> | **Hacker&nbsp;News** | Developer stories and discussion |
|  | **Papers** | Semantic Scholar, OpenAlex and 18 more indexes; full text, PDFs and section extraction |
| <img src="docs/logos/youtube.svg" width="22" height="22" alt=""> | **YouTube** | Video discovery, saved transcripts, comments and optional Gemini video understanding |
| <img src="docs/logos/x.svg" width="22" height="22" alt=""> | **X** | Exact posts, threads, accounts, who follows whom, web-indexed search and the pictures in posts; Grok for search by meaning, images and video |
| <img src="docs/logos/reddit.svg" width="22" height="22" alt=""> | **Reddit** | Threads, comments and collapsed replies |
| <img src="docs/logos/tiktok.svg" width="22" height="22" alt=""> | **TikTok** | Videos, captions and transcripts |
| <img src="docs/logos/instagram.svg" width="22" height="22" alt=""> | **Instagram** | Reels, accounts and transcripts |
|  | **Facebook** | Public pages, posts, groups and events |
| <img src="docs/logos/linkedin.svg" width="22" height="22" alt=""> | **LinkedIn** | Profiles, companies and posts |
| <img src="docs/logos/telegram.svg" width="22" height="22" alt=""> | **Telegram** | Public channels and posts |
|  | **Threads** | Public posts, replies and account posts |
|  | **China&nbsp;social** | Xiaohongshu, Bilibili, Douyin, Weibo, Zhihu, Kuaishou, WeChat |
|  | **Facebook&nbsp;ads** | Meta Ad Library advertisers and creatives |
|  | **Google&nbsp;ads** | Ads Transparency Center advertisers, their ads and ad details |
| <img src="docs/logos/linkedin.svg" width="22" height="22" alt=""> | **LinkedIn&nbsp;ads** | Ad Library ads with their payer and published targeting |
| <img src="docs/logos/tiktok.svg" width="22" height="22" alt=""> | **TikTok&nbsp;ads** | Creative Center analytics and the Ad Library |
| <img src="docs/logos/polymarket.svg" width="22" height="22" alt=""> | **Polymarket** | Prediction-market odds |
|  | **Commerce** | Amazon products, reviews and price history |
|  | **DataForSEO** | Search results, keywords, rankings and backlinks; Google Trends, Google ads, and app-store and Trustpilot reviews |
| <img src="docs/logos/reddit.svg" width="22" height="22" alt=""> | **TikHub&nbsp;Reddit** | Advanced Reddit discovery and enrichment |

The two shared tools work alongside any source: **Video analysis** inspects a video or a clip of one with Elorian Glimpse, and **Evidence ranking** suggests a reading order for a shortlist of excerpts with TypeSafe Jev. [Sources and their keys](docs/sources.md) has each source's keys, actions, methods and costs.

## How a question runs

1. **A dig.** The assistant starts a dig with `dig_start`, giving your project folder and the question. A dig groups everything one question produces, and its handle goes on every call that follows.
2. **Source calls.** The assistant calls each source's tool with the dig, an action and that action's arguments. Each call's result starts with one line: the source, the action, its status, its receipt and what the call and the dig so far have cost. The action's text follows; when the action also returned data (a structured answer, ids, a cursor), the text ends with a `Details:` block of that data as JSON, cut at 20,000 characters. Links to the receipt and the original response follow.
3. **Reports and follow-up.** For each source it researched, the assistant (or a helper it starts) saves a report with `research_save`: a summary, the evidence, what needs follow-up (including cross-source leads) and what was looked for and not found. When a load-bearing lead points to another enabled source, the assistant can chase it in a second wave under the same dig handle.
4. **An answer.** The assistant reads the reports and the originals its conclusions rest on, answers you, and can save the answer with `dig_finish`.

Ask for a method by name (“use Dig's x-judge method”) or let the assistant choose. Earlier research is reused: ask the assistant to find what you already researched about a topic.

## Cost

- **Receipts.** Every call records what the provider reported it cost, in the provider's own units: US dollars, ScrapeCreators or Scrape.do credits, OpenAlex credits, X post and account reads. Units are never converted or added together. A cost the provider did not report is unknown, never zero.
- **Running cost.** Every result says what the call cost and what its dig has cost so far.
- **Spending ceiling.** `[spend] dig_ceiling_usd` in Dig's settings caps what one dig may record in US dollars. When a dig reaches it, Dig asks you whether to raise it for that dig or stop.
- **Ask first.** `[spend] ask_above_usd` makes Dig ask you before a paid call whose action has typically cost at least that much in your library, or has never been priced there.
- **No double charge.** A call identical to one that just finished returns the earlier result instead of paying again.

Each provider bills you directly, separately from your ChatGPT or Claude plan. Dig does not count your assistant's own model use.

## Slow calls

A slow action (a Grok search, a video analysis, deep research) runs as a job in Dig's service, not in the connection. A host that supports MCP tasks follows it as a task; in any other host, if it is still running after 40 seconds the result is a job id, and the assistant asks the `job` tool for the result.

## Views

Dig's views show the library, the current dig's trail and a card for each saved report or answer. A host that renders MCP Apps (ChatGPT desktop) shows them in the conversation; a client that names itself as Codex or ChatGPT gets them without declaring the MCP Apps extension. In a host that renders none, such as Claude Code, ask the assistant to open Dig's library: it calls `open_library`, and the host asks you to open the library in your browser. In a terminal, `dig open` does the same; use it in Codex in a terminal, which is given the views but cannot show them. Either way the browser gets a one-time address that works once, within 5 minutes.

## Where things are

Settings, keys, the library, jobs and the service's own files live in `~/.local/share/dig` (`DIG_STATE_DIR` chooses another folder). `dig status` says whether the service is running and lists running jobs; `dig stop` stops it. Local library commands inspect saved research without starting the service or calling providers: `dig list`, `dig read`, `dig search` and `dig stats` (`list`, `read` and `stats` write nothing; `search` is read-only on the library and refreshes the local search index cache as needed). See [getting started](docs/getting-started.md), [permissions](docs/permissions.md) and [the architecture](docs/architecture.md).

## Development

```sh
npm ci
npm run build        # dist/ (the dig command and the views), runtime/ and plugins/
npm run typecheck
npm test             # offline tests
npm run check        # build, type check and tests
npm run smoke        # one keyless Hacker News call through the service, in a throwaway folder
npm run live-check   # one live call per free action, captured under verification/live; --paid with --keys adds paid ones, which cost money
```

See [AGENTS.md](AGENTS.md), the [changelog](CHANGELOG.md) and the [security policy](SECURITY.md).

## Optional: route Dig from another conversation

The [Dig routing companion](optional/dig-routing/README.md) is a separate, instruction-only Codex add-on that uses the current Dig connection or hands the task to an authorized connected computer. It has no server, keys or library of its own; its README says how to install it.

## License

MIT. See [LICENSE](LICENSE); bundled third-party licences are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Service logos are their owners' trademarks, shown to identify each service. Dig is an independent project, not affiliated with OpenAI, Anthropic, X or any provider.
