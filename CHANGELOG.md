# Changelog

Below, `dig` stands for `node <checkout>/dist/dig.mjs`: nothing installs a `dig` command, and on macOS and Linux that name is the DNS lookup tool.

## 2.0.3 — 2026-11-25

- **Fewer cards in the conversation.** A host that renders Dig's inline card now shows it only for `research_save`, `dig_finish`, `keys` and `open_library`. Source calls and `job` show no card; their text is unchanged, and every call of a dig is still in the web app (`open_library`).

## 2.0.2 — 2026-11-25

- **GitHub no longer reads as needing setup.** Without a token in `keys.env`, `source_info`, the web app and `dig setup` now show GitHub as `partial` and say what is true: public search and reads work anonymously or through an existing `gh` login, and a token or a `gh` login raises the limits and adds the review and issue-reply samples. A source can now declare a credential optional.
- **The test suite no longer leaves a Dig service running.** A test that connected bridges to a service started inside the test process got that service replaced by a detached one that outlived the run; it now uses a service started from `dist/dig.mjs`, and the suite fails if any service it started is still running when it ends.
- **A lost start race logs one plain line.** When several hosts start Dig at once, each `dig serve` that finds Dig already on its port writes `dig: Dig <version> (pid <n>) already serves port <port>; …` and exits 0 instead of logging `ERROR An error occurred`. A port held by something else is named, with `DIG_PORT`, and exits 1, and no command prints a bare "An error occurred" any more.

## 2.0.1 — 2026-11-24

- **Minimal SEP-1865 inline event card (`ui://dig/card/v2.0.1.html`).** Added one static ~11 KB (~3.8 KB gzipped) zero-dependency read-only MCP App card (`src/service/card.ts`, `text/html;profile=mcp-app`, empty CSP `connectDomains: []` / `resourceDomains: []`, strict DOM construction with zero `innerHTML`, `ev.source === window.parent` check, and loopback-only `http://127.0.0.1:<port>/(open|keys)/...` `ui/open-link` allowlist) gated strictly on client `io.modelcontextprotocol/ui` capability. Attaches `_meta.ui.resourceUri` and best-effort `_meta.digCard` metadata on `research_save`, `dig_finish`, `keys`, `open_library`, `job`, and source provider calls—opening the full localhost Dig web SPA via `ui/open-link` while adding zero tools and zero `tools/list` overhead for non-UI clients. Spend-gate refusals render a safe pause card without ever exposing `/approve/:code`. *(Protocol and unit verified; not yet visually rendered in a live host.)*
- **Idle-swap token scoping & bridge error fidelity.** Scoped `ExecutionService.hasPendingTokens()` to active `keys` and `spend_approval` codes so ephemeral read-only `browser_open` deep links never block `POST /stop?ifIdle=1` or idle daemon exit. Updated `dig mcp` (`src/service/cli.ts`) to forward daemon JSON-RPC error codes/messages unchanged instead of wrapping HTTP 4xx JSON-RPC rejections as `"could not be reached"`. Kept `2025`-era legacy session compatibility alongside `2026-07-28` so Codex CLI (`0.171.0`) continues to work seamlessly.

## 2.0.0 — 2026-11-23

Dig 2.0 is a ground-up, 100% strict TypeScript (`allowJs: false`) rebuild on **Effect-TS 4.1.5** (`effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`, `@effect/ai-typesafe`, `@effect/atom-react`) and **`@modelcontextprotocol/server` 2.4+**, preserving Dig's plain-file research archive (`dig.md`, reports, `answer.md`, `calls.jsonl`, `raw/*.json`, `config.toml`, `keys.env`) while replacing legacy infrastructure with a unified, crash-safe Effect runtime and localhost web application.

### Highlights

- **Effect 4.1.5 end-to-end architecture & zero legacy JS.**
  - Rebuilt core, all 29 co-located source plugins (`src/sources/<id>/`), MCP/HTTP daemon (`src/service/`), CLI (`effect/cli`), and UI helpers (`src/ui/`) in strict TypeScript (`allowJs: false`).
  - Removed `@sinclair/typebox`, `zod`, `@modelcontextprotocol/ext-apps`, `@modelcontextprotocol/node`, `@openai/mcp-extensions`, `@tanstack/react-query`, npm `overrides`, `src/providers/`, and all `.mjs` files under `src/`. All MCP tool and prompt schemas derive directly from `effect/Schema` (`Schema.toStandardSchemaV1` + `Schema.toStandardJSONSchemaV1`).
- **Plain-file archive + local SQLite engine & FTS5/ONNX index (`dig.sqlite`).**
  - Plain files on disk remain the canonical archive. `<state>/dig.sqlite` (`node:sqlite` WAL, mode `0600`) provides the crash-safe `paid_call_ledger` (atomic `BEGIN IMMEDIATE` deduplication with a partial unique active index preventing concurrent double-charges even with `fresh: true`), per-dig `dig_spend_overrides`, browser sessions/codes, and a rebuildable read/search index combining SQLite FTS5 with optional local BGE-small ONNX embeddings (`darwin/arm64` and `linux/x64`).
  - Added read-only crash reconciliation (`reconcile()`): if the daemon stops mid-flight during a streaming `xsearch` pass, startup checks `GET /v1/responses/:id` without ever re-POSTing.
- **One universal localhost React 19 web app (`dist/web/`) + SSH-safe `dig setup` TUI.**
  - Replaced `ui://` MCP Apps and inline cards with a single localhost React 19 SPA (`@effect/atom-react`, `effect/reactivity`, TanStack Router, Tailwind CSS v4) with live Server-Sent Events (`/api/events`), side-by-side raw evidence inspection, live dig trail, sources/90-day cost history, settings editor, and a 4-step guided `/setup` wizard opened via `open_library` or `dig open`.
  - Added `dig setup` (`effect/cli/Prompt`) for interactive terminal onboarding (including `--preset starter|research|social|all`), writing `config.toml` and `keys.env` (`0600`) safely over SSH.
- **Multi-unit `[spend]` controls & `/approve/:code`.**
  - Extended `[spend]` beyond USD with independent per-dig caps: `max_credits`, `max_x_post_reads`, `max_x_account_reads`, and `max_unknown_calls`, plus a zero-JS localhost `/approve/:code` approval page alongside MCP elicitation.
- **Provider upgrades & Perplexity removal.**
  - **Removed Perplexity** completely (source plugin, skill, logo, and notices). Dig now ships **27 research sources + 2 shared tools** (`29` entries, `86` actions, `38` methods, `41` tools with all sources enabled).
  - **Exa 3.0:** `exa_research` defaults to `dynamicHighlights: true` and `highlightVerbosity: "medium"` with the `Exa-Beta` header, supports `mode: "auto" | "deep-lite" | "deep" | "deep-reasoning"` (default `"deep"`, `$0.012`; `"auto"` `$0.007` quick tier), and emits live progress updates; `exa_search` exposes `highlightVerbosity`.
  - **TypeSafe Jev (`evidence_rank`):** Built on `@effect/ai-typesafe`, defaulting to `jev-latest` and displaying the exact resolved model returned by TypeSafe (for example `jev-1.14.0`).
  - **X API:** Updated billing reference to `docs.x.com/x-api/introduction`, fixed `x_explore(kind: "list")` to record honest X post/account reads, and wired `xsearch` `remote_job_id` for read-only crash reconciliation.
- **Security hardening.**
  - Added `PaidHttp` (zero retries, `TracerPropagationEnabled = false`, streaming response byte caps, cross-origin credential header stripping on redirects, strict SSRF guard covering `2002::/16`, `2001::/32`, `::/96`, and redirect hops), `isResearchFile` read allowlist enforcement on all library reads, scoped subprocess environment for the Papers bridge, and secret redaction across progress events and logs.

### Breaking changes from 1.3.0

- **Node.js `>=22.13` required** (for built-in `node:sqlite`).
- **Perplexity removed** (`perplexity` source, actions, and `skills/perplexity`). Remove `"perplexity"` from `[sources] enabled` in `config.toml` if present.
- **`ui://` MCP Apps and `open_trail` removed** in favor of `open_library` / `dig open` opening the localhost web SPA (`dist/web/`).
- **Existing research libraries, `config.toml`, and `keys.env` carry over intact.**

## 1.3.0 — 2026-11-23

- **Three new research sources: Firecrawl, SEC EDGAR, and Bluesky.**
  - **Firecrawl (`firecrawl`):** `firecrawl_scrape` (single-URL JS/SPA/anti-bot page extraction to clean Markdown/HTML/links via Firecrawl v2, with strict public-URL SSRF guard refusing loopback, private, link-local, metadata, and non-global-unicast IPv6 targets, zero retries, and honest Firecrawl credit metering) and `firecrawl_map` (bounded single-domain URL discovery up to 200 URLs).
  - **SEC EDGAR (`sec`):** Free, keyless `sec_search` (EFTS full-text search across 10-K/10-Q/8-K/S-1/DEF 14A/13F/Form 4), `sec_company` (ticker/CIK resolution and submission history), and `sec_facts` (structured XBRL company financials with comparative-period deduplication and optional `SEC_USER_AGENT` contact header).
  - **Bluesky (`bluesky`):** Free, keyless public ATProto `bluesky_search`, `bluesky_thread` (accepts `bsky.app` URLs or `at://` URIs with automatic handle-to-DID resolution), and `bluesky_profile`.
  - Wired all three into `skills/dig/SKILL.md` (routing + Wave 2 cross-source follow-up), `skills/setup/SKILL.md`, UI guides, and glyphs (now 28 sources + 2 shared tools, 90 actions, 39 methods).
- **41 KB `tools/list` schema headroom diet & `x-*` skill split.** `listed()` in `src/service/surface.ts` now strips verbose property-level `description` prose from listed `args` branches while keeping every property name, type, enum, required array, wrapper description, per-action summary, and full unmodified `actionSchemas` for validation error messages — cutting `tools/list` with all sources enabled from 139,153 chars to ~98,100 chars (even after adding 3 new sources). Moved verbose worked JSON playbooks out of `skills/x-{judge,breadth,post,trace}/SKILL.md` into `references/playbooks.md`, dropping every X `SKILL.md` to 16.8–18.0 KB cleanly below Antigravity's 24 KB limit.
- **Linux `x64` local semantic search.** Parameterized `scripts/search-runtime.mjs`, `scripts/build.mjs`, and `src/search/engine.mjs` to package and run the local BGE-small ONNX runtime dynamically on both `darwin/arm64` and `linux/x64` (preserving Linux `.so` symlinks).
- **Exa 3.0 optimization pass.** Upgraded `exa_research` default from legacy `deep-reasoning` ($15/1k) to Exa 3.0 `deep` ($12/1k) with optional `mode` override; omitted unconditional `contents.text` in `exa_search` when `dynamicHighlights: true` (cutting returned context ~64% at $0 extra fee); added `userLocation` on `exa_search`, optional `highlights: false` on `exa_contents` (cutting text-only `/contents` cost 50% from $2/1k to $1/1k), and optional `EXA_BASE_URL` allowlisted to `https://api.exa.ai` / `https://api.eu.exa.ai` for EU-residency keys; hardened redirect handling on Exa, Firecrawl, Perplexity, and xAI requests.
- **Provider freshness fixes & recipes.** Fixed ScrapeCreators Instagram restricted/age-gated profile handling (`social_read.ts`) for Oct 2026 uncharged HTTP 403/404 `success: false` responses; removed retired Google Events SERP from DataForSEO guidance, raised DataForSEO client timeout from 180s to 300s for `resolve_goto_urls`, and added Nov 2026 flags plus Google Maps/GBP, Yelp, Tripadvisor, Trustpilot, App Store/Play Store, and Google Trends recipes; migrated Perplexity `/v1/agent` from deprecated `preset` to `effort` and added Photon `search_type: "fast"` ($1/1k); added `gemini-4-hydrogen`, `gemini-4-neon`, and `thinking: "xhigh"` to Gemini YouTube video analysis ahead of late-2026/early-2027 promo price endings; mapped `xsearch` `ultra` depth to `reasoning.effort: "xhigh"` and added optional `webAllowedDomains`/`webExcludedDomains` (max 5 hostnames) on `web_search`.

## 1.2.2 — 2026-11-23

- **Live search-round progress for `xsearch`.** While `xsearch` consumes xAI's Responses SSE stream, completed search-round items (`custom_tool_call` such as `x_keyword_search`, `x_semantic_search`, `x_user_search`, and `x_thread_fetch`, as well as `web_search_call` and `x_search_call`) now emit live MCP `notifications/progress` updates (when the client supplied `_meta.progressToken`, across both 2025-era and 2026-07-28 clients, including attached duplicate calls and `job({ id, wait: true })`) and update in-memory running-job status (`job`, `tasks/get`, `dig status`, and the trail view) without persisting new fields to job files or receipts.

## 1.2.1 — 2026-11-22

- **Worked X playbooks and cheat sheets in every X method.** Added concrete JSON `x` tool call playbooks and operator/pitfall checklists across `x-judge` (action cheat sheet, historical discourse + screenshots, breaking <24 h + volume, and targeted video verification), `x-breadth` (6–8 pass allocation sequence), `x-post` (4-step post-inspection sequence), and `x-trace` (3-round trace within the default read budget), while deduplicating repeated prose so every X `SKILL.md` stays comfortably under Antigravity's 24,000-byte load cap. Added `x_web_search` to `x-judge`'s `QUICK` path and updated the X UI source guide.
- **Default `[x] depth` set to `quick`.** Fresh installs now start `[x] depth` at `quick` (still configurable to `standard`, `max`, or `ultra` in `config.toml` or via `settings`), keeping routine `grok-4.7` passes below xAI's 200k cumulative-token 2× billing cliff out of the box.
- **Sharper `tools/list` first-sentence descriptions.** Updated the `x_web_search` (`>24 h` scope + `Media:` links), `x_images` (free, no key, `Media:` links), and `xsearch` (`mode: "semantic"`, opt-in `media: true`) first sentences so direct callers see the tiering immediately in `tools/list`.

## 1.2.0 — 2026-11-22

- **X web search (`x_web_search`).** Added ScrapeCreators-backed Google-indexed public X post search (`GET /v1/twitter/search/posts`, optional `SCRAPECREATORS_API_KEY`, 1 credit per request, pages 1–11), returning ~8–10 live-hydrated posts per page with full text (including `note_tweet`), engagement metrics, views, bookmarks, quotes and `Media:` links (compatible with `x_images` and `video_analyze`) with zero X API post-read fees.
- **Fast semantic-only Grok lead mode (`xsearch` `mode: "semantic"`).** Added `mode: "standard" | "semantic"` to `xsearch`. `mode: "semantic"` restricts Grok to 2–4 `x_semantic_search` calls in one parallel round and defaults `depth` to `quick` (unless explicitly overridden) to stay far below xAI's 200k cumulative-token 2× billing tier while harvesting Grok's semantic discovery.
- **Trimmed X API v2 post fields & faster full-archive paging.** Dropped unused bloated fields (`context_annotations`, `edit_controls`, `display_text_range`, `media_metadata`, `paid_partnership`) and noisy expansions (`edit_history_post_ids`, `in_reply_to_user_id`) from X API v2 requests in `x_api.ts`, cutting raw JSON bloat and unneeded included resources and unlocking up to 500 posts per page on full-archive search (`/2/tweets/search/all`) instead of 100.
- **Sharper X media and orchestration methods.** Updated `x-judge`, `x-breadth`, `x-post` and `x-trace` to pair `x_web_search` (cheap broad historical discovery >24 h old), `x_search_posts` (last-24 h, exact operators, archive windows and verification), and `xsearch` (`mode: "semantic"` / `depth: "quick"`), and to pull relevant media without hesitation (`x_images` for images; targeted `xsearch(media: true, depth: "quick")` naming only the 1–5 specific video post links for videos).

## 1.1.0 — 2026-11-22

- **X search cost controls.** `xsearch` now leaves Grok image and video understanding off by default (opt in with `media: true` when a pass needs Grok to watch video or inspect images; `x_images` remains the free path for images) and surfaces `Posts fetched` and `Users fetched` in the summary line without duplicating them under server-side tool usage. The four X methods document opt-in `media: true` and the X-API-first workflow.
- **Antigravity host support.** The build now generates a native Antigravity plugin wrapper under `plugins/antigravity/` (`plugin.json`, `mcp_config.json` with a 600-second timeout, logo and `skills/` with `disable-model-invocation: true` on source methods), and the views recognize Antigravity clients.
- **Cross-source lead chasing.** The `dig` method adds a Wave 2 step for following load-bearing off-platform leads under the same dig handle, and source methods record typed cross-source leads in `## Needs Follow-Up`.
- **Local library CLI.** Added `dig list`, `dig read`, `dig search` and `dig stats` (each with `--json`) for inspecting the local library without starting the service or calling providers (`list`, `read` and `stats` write nothing; `search` is read-only on the library and refreshes the local search index cache as needed).
- **Reliability and performance fixes.** Trimmed trailing hyphens from newly allocated dig IDs (without altering `projectFolder`) and normalized session paths via `safeSegment` in resource links and crash-recovery receipt adoption; serialized `updateConfig` and per-dig spend-answer writes; made parallel spending-ceiling raises idempotent and re-checked spend on stale approvals; read single-dig `calls.jsonl` directly instead of rescanning the whole library on every provider call; added an atomic idle-only build replacement (`/health` build fingerprint, fail-closed status check, and `POST /stop?ifIdle=1` refusing while calls, jobs, or pending prompts/key pages are active); augmented `PATH` on POSIX with standard user, Cargo, Bun and Homebrew bin directories when spawning `dig serve`; and logged sanitized, deduplicated client names and declared capabilities to `service.log`.

## 1.0.0 — 2026-11-12

Dig 1.0 is one local MCP service that every host on a computer connects to, built on the MCP revision 2026-07-28 and its official extensions, with 2025-era clients served through the SDK's legacy path. The sources, their actions, receipts, reports, answers, retained originals, `config.toml` and `keys.env` keep their meaning, and an existing library and settings are used as they are.

- **One service.** `dig mcp` is what a host launches; it starts the service when needed and adds the service's token itself. Hosts that prefer an address connect to `http://127.0.0.1:47811/mcp` with the token. `dig status`, `dig stop` and `dig open` report on, stop and open the service. It listens on `127.0.0.1` only, refuses requests from web pages, and exits after 30 idle minutes.
- **The call form.** Each source is one tool, called with `dig`, `action` (the existing provider tool's name, such as `x_post`) and `args`. Arguments are checked against the action's schema, and a mistake comes back with the schema. A source's result is content only: a first line with the source, action, status, receipt and costs, the text (ending with a `Details:` block of JSON when the action returned data beside it), links to the receipt and the original, and any pictures. `x_images` is an ordinary action of the `x` tool.
- **A dig on every call.** `dig_start` returns a handle, and every source call and `research_save` takes it; nothing reads a host's conversation id. A new dig's receipts are filed under `sessions/<dig id>/`.
- **Jobs, and no repeated charge.** Every paid or slow call is a job that the service owns, so a dropped connection neither stops it nor sends it twice. An identical call attaches to a running job or, within 10 minutes, gets its result; `fresh: true` pays again. Slow actions answer with an MCP task where the host supports tasks, or with a job id for the new `job` tool after 40 seconds. A job cut off by a stop is marked failed with its cost unknown.
- **Questions before spending.** At a dig's spending ceiling, Dig asks whether to raise it for that dig or stop. The new `[spend] ask_above_usd` makes Dig ask before a paid call whose action typically costs at least that much, or has no priced call yet. Answers apply to one dig. A host that cannot ask gets the refusal.
- **The key page.** The new `keys` tool opens a one-time page on your computer where you type keys; they go to `keys.env` and never through the conversation. A call whose key is missing says the same, in words true in any host.
- **Methods from the server.** The methods live in `skills/` and are served through MCP's Skills extension, as prompts, and through the new `method` tool, to any host.
- **A tool list a third of the size.** With every source on, the model sees 39 tools in about 136,000 characters, against 0.15's 100 tools in 408,388. `settings` replaces the two settings tools.
- **Views in any host.** The library, the trail and the saved-research card are served as MCP Apps, and in a browser, which `open_library` opens for a host that shows no views (or `dig open` in a terminal). The trail follows one dig and shows its running jobs.

### Coming from 0.15

- Remove the 0.15 plugin from each host, build Dig, and connect each host to `dig mcp` (see the README). Settings, keys and the library carry over.
- Per-host plugins and per-host skills are gone: one service serves every host, and generated wrappers in `plugins/` only point a host at it. `DIG_HOST` is no longer read. Methods are no longer invoked with a host's plugin prefix; ask for one by name, or use the host's prompt command.
- Calls name the source's tool and an `action`; `project` is passed only to `dig_start`.
- Removed: the host settings page and the composer mentions add-on (use the `settings` tool and the views), `settings.read`, `settings.update`, `source_readiness`, `show_research`, the Open in Dig links, and the **Edit keys.env** and **Use existing key** buttons (use **Enter keys**).

## 0.15.0 — 2026-11-12

- Add `x_images`: the model looks at the pictures in X posts itself. Pass it the image links an X read printed; it returns the pictures, makes no X API request and costs nothing. It keeps a note in place of each picture.
- The X methods send image questions to `x_images` and keep Grok for video and for what keyword search cannot find.

## 0.14.0 — 2026-11-12

- Add X trace, a fourth X method: it starts from a post, an account or a claim and works outward through the thread, the people replying, their profiles and what they point to, weighing each voice by who it is and what it knows, not by engagement. It works to a budget of reads and uses Grok for at most one pass.
- Add `x_follows`: who an account follows, and who follows it.
- Record what each X API call read, as post reads and account reads, where its cost was unknown. The counts are not money; X bills reads per post and account returned.
- Name what a dig recorded in other units when the spending ceiling refuses a call.
- X judge and X breadth: when a cut Grok pass is not stored, say that it is lost and that running it again is a new pass.

## 0.13.0 — 2026-11-10

- Add the Wayback Machine as a free source: list the Internet Archive's captures of a page and read what the page said on a given date.
- Add Google ads and LinkedIn ads as sources, and YouTube comments to the YouTube source, through ScrapeCreators.
- Show what each tool has cost, how long it took and how often it failed, from this library's own receipts over the last 90 days: in `source_info` and on the Sources & tools page.
- Return a dig's running cost with every call that names the dig, and add an optional spending ceiling per dig (`dig_ceiling_usd` under `[spend]`), which refuses the dig's next paid call once its recorded US-dollar cost reaches it.
- When a Grok stream is cut, look for the finished answer under its response id before failing, and read a stored pass later, free, with `recoverResponseId`. xAI keeps a finished pass, not one whose connection dropped while it ran.
- Add `npm run live-check`, which calls each tool once for real and saves what came back, a tracked record of when each tool last worked, and a test that replays saved responses through the parsers.
- Type-check the TypeScript in `npm run check`.
- Fix Semantic Scholar recommendations and sorted searches, which asked for a field those endpoints refuse.
- DataForSEO method: add routes for Google Trends, the ads a company runs on Google, and app-store and Trustpilot reviews.

## 0.12.0 — 2026-11-10

- Never send a paid request again when it got no response; record its cost as unknown. Stream Grok searches, so a long pass is no longer cut off at 300 seconds.
- Show the whole paid page by default in the social, Commerce and China social tools. Send one request for a subreddit-scoped Reddit search and show its posts and comments. Keep a paid Commerce product page when only its offers request fails.
- Give `partial` one meaning: part of what was asked for failed or was cut short. Another page is `success`, with its cursor stated.
- Refuse before any request: a full-archive X count without `start_time`, a Semantic Scholar token combined with a sort, a TikTok ads sub-industry name that exists under two parents, and a paper `savePath` outside the project and Dig's own folder. Stop a call's remaining X reads after a rate-limit, credit or sign-in failure.
- YouTube: read uploaded captions before automatic ones, give yt-dlp Dig's own Node as its JavaScript runtime, and run at most three yt-dlp processes at once. Keep a Gemini video analysis running when one status check fails, and return its ID.
- Keep the arguments a tool's schema declares, such as `token_id`, in receipts. Start with every source disabled when `config.toml` is malformed, where the server used not to start. Skip an unreadable receipt line where it used to break every library view.
- Let a Hacker News `all` search return comments. Record an incomplete Perplexity answer as partial. Cut DeepWiki contents at 200,000 characters. Record DataForSEO sandbox calls as free. Make a GitHub inspection's recorded status agree with its text.
- Name the host in the views and in key and readiness messages. Send `dig/<version>` as the User-Agent. Report an out-of-date Papers bridge. Stop a library refresh and a search from reading unchanged files again.
- Remove the pre-React app and its styles. Bring the documentation in line with the compact saved-research card and with Claude Code.
- Fix about a hundred smaller defects found in a review of the whole repository: parsing, labels, counts, error wording and timing-dependent tests.

## 0.11.0 — 2026-10-30

- Add Claude Code support from the same package: a Claude plugin manifest launches the existing server from the plugin root, and a Claude marketplace names it `dig@dig`. Settings, keys and the research library are shared with Codex.
- Make the shared skills host-aware: `/dig:<method>` in Claude Code, Claude worker-model choice, and no Dig views or `codex://` links there. Source methods stay out of Claude's automatic skill list, as they do in Codex.
- In hosts without a conversation id, start the dig before the first provider call and pass it to every call, so receipts stay with their report.

## 0.10.1 — 2026-10-30

- Make inline result cards compact: short title, save time, source, scoped provider cost and one Open action. Keep findings in the conversation and full research in Dig.
- Use composed answers’ saved H1 headings for concise names while preserving original questions. Bound legacy card labels to two lines.
- Accept same-dig report paths as well as filenames when finishing an answer; validate membership and retain the existing filename-only answer metadata.

## 0.10.0 — 2026-10-29

- Add library_search over full saved report and answer bodies, with file/project/source/date filters, exact passage readback and explicit correction handling.
- Combine BM25 with optional local BGE-small Q8 embeddings. Keep a rebuildable content-checked cache outside the package; return honest keyword fallback and coverage warnings.
- Add the existing-authority search_semantic setting, off by default, with pinned integrity-checked model assets and a packaged macOS arm64 CPU runtime. No embedding API or provider retrieval is required.

## 0.9.4 — 2026-10-29

- Open library now requests host fullscreen from the activity panel. This conversation returns inline; unsupported or refused expansion keeps navigation usable.
- Add a direct Configure action to open existing source and provider settings in the expanded view.

## 0.9.3 — 2026-10-29

- Replace the in-thread dashboard with compact conversation activity: observed running calls, call/source/report counts, source outcomes and links to saved results. Keep the full library an explicit destination.
- Observe executing provider calls in memory while they run and finalize their receipts; never infer active work from unassigned receipts. Add an inline-preferred thread resource with its own initial route.

## 0.9.2 — 2026-10-28

- Focus the conversation trail on saved questions and findings, with compact usage and expandable records. Add local library filtering, clearer composer mention choices, and direct answer/report opening.
- Put retained documents before detailed question accounting, preserve evidence inspection, and fall back to the in-app reader when a host rejects a native report link. Remove the Overview/trail Discuss next step action.
- Keep chained X searches from retrying without their prior context; preserve incomplete results as partial, validate full handle scope and make date boundaries explicit.
- Correct remaining social transcript pricing/excerpt wording and report unreadable entries or failed enrichment as partial coverage.
- Allow staged source-worker reuse when one inventory should inform the next method, while preserving independent parallel inquiry and initiating-thread composition.

## 0.9.1 — 2026-10-20

- Add direct TikTok and Instagram reads for supplied posts, public creator profiles and feeds, standalone transcripts, and selected comment replies. Preserve TikTok photo posts and Instagram carousel identities.
- Keep cursor scope, missing metrics, private/restricted profile states and partial responses explicit; use one request per operation without automatic pagination, retries or media downloads.
- Correct short TikTok transcription price guidance and explain Instagram’s 15-credit bulk-replies option. Actual reported charges and the existing source/report/settings contracts are unchanged.
- Update source cards and worker guidance so agents can inspect known evidence without repeating discovery searches.

## 0.9.0 — 2026-10-20

- Recompose Overview, the conversation trail and question detail around saved research state: outcomes, method coverage, recorded findings and gaps, dated activity, and visible provider usage.
- Keep planned methods, saved reports and receipt outcomes distinct. Show no inferred worker lifecycle or progress; preserve conversation attribution and honest cost units and unknowns.
- Make full reports and originals an explicit Inspect records action. Load existing author assessments on demand with library/question/file guards; preserve inspected text and late-response boundaries.
- Add Steer research directions that preview a canonical-reference instruction for an unsent native conversation draft or copy fallback. No provider request or execution control is started by the interface.
- Unify React/ReUI presentation across research views, Sources, Accounts, Settings, About and Start here. Saved cards separate the save event, author judgment, scoped usage, What came back and Review next step, with stale draft/copy acknowledgments guarded.
- Reframe onboarding around human observation and steering while assistants read the detailed evidence. Keep the illustrative inspection example ahead of the capability catalog. Existing durable research and settings contracts are unchanged.

## 0.8.1 — 2026-10-20

- Add a ReUI Start here tab with a plain-language introduction, practical example questions, a research walkthrough, result/cost/privacy explanations and a directory derived from the installed source catalog.
- Teach evidence inspection with a clearly illustrative finding, supporting passage and original-response example, revealed through local tabs without creating research records.
- Add a companion getting-started guide linked from the README; keep technical version and file details in About Dig.

## 0.8.0 — 2026-10-20

- Rebuild Sources, accounts and Settings as React views using actual free ReUI Frame and Icon Tile components with Base UI switches, inputs, selects and disclosures. Keep local settings drafts and saves stable across refreshes.
- Refresh library overview, saved-research rows, report reading and inline cards with shared frames, stronger typography and clearer cost hierarchy.
- Make source example prompts a small disclosure beneath About this source, matching its typography and keeping capability summaries prominent.

## 0.7.0 — 2026-10-20

- Adopt React 19, Tailwind 4, Base UI/shadcn conventions and an open-source ReUI timeline. The library uses TanStack Router and Query; inline cards remain a separate self-contained bundle sharing components and a native host adapter.
- Add read-only `show_research` insight cards for retained findings and comparisons, with scoped provider usage, validated evidence references, safe original-reading dialogs and explicit unsent next-step drafts. Saved reports also gain concise titles and their existing author assessments.
- Pin card/evidence reads to their originating canonical files, reject mixed-file pagination, and clear open research when the selected library changes.
- Add an initiating-thread website opportunity workflow and DataForSEO/GEO endpoint recipes connecting queries and AI answers to inspected competing and owned pages, specific recommendations and verification. No new history store or scheduler.
- Upgrade MCP Extensions to 0.2.0 and the MCP SDK to 1.32.1. Preserve versioned inline resources, startup-cached HTML and independent source enablement.

## 0.6.0 — 2026-10-20

- Add optional Evidence ranking with TypeSafe Jev: suggest a reading order for supplied excerpts and optionally assess their support, contradiction or insufficiency for one claim. Every candidate and its uncertainty remains available; no automatic filtering or source fetching.
- Give the helper independent enablement, native key setup and compact source-card guidance. It is a shared tool with ordinary receipts, not a new report source or worker.
- Validate bounded requests and provider distributions, retain unknown judgments and dollar costs honestly, and permit explicit use within source methods without weakening evidence-reading requirements.

## 0.5.0 — 2026-10-20

- Add optional YouTube video understanding with Gemini 3.8 Flash by default, Gemini 4 Argon for harder reasoning, and an ordinary `youtube-video` source method. Search and transcripts remain available without a Gemini key.
- Add static clips, frame sampling and resolution, agentic video processing, multi-video comparisons, structured answers, explicit Google Search/URL context, stored follow-ups, and background status/cancellation. Provider tokens remain distinct from unknown billed dollars.
- Expand the YouTube source card and shared Glimpse guidance. Glimpse remains a standalone focused visual tool; YouTube reasoning prefers Flash, then Argon when needed, with no automatic paid fallback.
- Fix composer mentions to sort individual reports and answers before the twenty-result limit. Update worker fork guidance to the host's supported options.

## 0.4.3 — 2026-10-19

- Add optional shared Video analysis with Elorian Glimpse. It complements source research without becoming a report source or a second corroborating source. Existing settings, receipts and reports keep their fields.
- Analyze direct media, uploaded file IDs, local project clips, and bounded public YouTube intervals. Local preparation uses installed tools without cookies or sign-in; unsupported inputs fail explicitly.
- Expose visual/audio coverage, original clip offsets, token usage and incomplete answers. Provider dollar costs remain unknown when no charge is reported. One cancellable provider run, no automatic retries or external search.
- Add discoverable video-analysis guidance and let relevant source methods use the helper while keeping observations, speech and inference distinct. Sources & tools separates shared utilities from source methods.

## 0.4.2 — 2026-10-19

- Polymarket search works again. A search whose results included an active market with a condition ID failed with "lines is not defined"; each market shown now lists its condition ID and outcome token IDs, which the price-history and resolution reads take.
- Grouped Polymarket events label each outcome's odds by Polymarket's own short name ("No change", "25 bps decrease") instead of a fragment of its question such as "there" or "the".
- YouTube transcripts no longer keep a configured key that yt-dlp captions or a video's title echoed, as written or URL-encoded. Every transcript file, from yt-dlp or the hosted fallback, is redacted the same way before it is written; transcripts saved earlier are not rewritten.
- The Threads method now describes Meta's Threads (public posts with their replies, and an account's returned posts) instead of Telegram channels.
- The Papers method names all 20 federated search connectors, OpenReview included.

## 0.4.1 — 2026-10-19

- Saved research becomes a compact list with clear source, project and date cues, a short usage line, and expandable details. Long questions and summary previews no longer compete for space.
- Single-source digs use an existing concise report title or a readable saved topic as their display label. The full original question remains available in details and the reader; no saved report is rewritten.
- Source-method instructions now ask the reporting agent for a short descriptive H1 title, using the existing title field without a separate inference request.

## 0.4.0 — 2026-10-19

- A compact visual overview keeps activity, failures, provider costs and charts immediately visible, with an expanded chart view on demand. Recent research starts higher on the page; dashboard search is removed in favor of agent library tools.
- Incomplete pricing is labeled as a known subtotal. Provider-specific credits stay separate, and calls without reported pricing remain visible as usage rather than a zero cost.
- Source cards explain their capabilities with copyable examples, including Exa snapshots, direct Hacker News reads and AI brand visibility. Configuration status is separate from the latest retained call outcome; viewing Sources makes no provider requests.
- Reports gain an outline and sticky file navigation. Original responses open beside the report in a wide view, or in a focused narrow view with a return action, preserving the report and reading position.
- Late evidence reads cannot reopen a closed pane or replace another dig's evidence. Existing reports, receipts, settings and library files keep their formats.

## 0.3.1 — 2026-10-19

- Updating Dig refreshes the plugin connection first. The stale-version notice and release instructions now reserve quitting and reopening the host as a fallback, instead of requiring it for every update.

## 0.3.0 — 2026-10-19

- Exa 3.0: Lite search, historical Snapshot retrieval and structured result entities, while retaining existing search modes.
- Direct Hacker News item reads, GitHub REST 2026-03-10, and a DataForSEO AI-brand-visibility research method.
- Current Nexscope HTTP routes and response envelopes; unfinished responses are not reported as empty results.
- Hosted YouTube transcripts with timestamps and language, TikTok photo search/comments, Instagram comments, and a Threads source.
- Semantic Scholar passages, citation/reference reads and provider-side bulk sorting; OpenAlex semantic search and cached content.
- Polymarket price-history and resolution reads through Data API v2.
- Updated Papers bridge with OpenReview and bounded PDF section extraction; preserved provider health and per-response billing, and supported macOS parser memory supervision.

## 0.2.32 — 2026-10-14

- **Keys echoed in any URL encoding stay private.** A key that a provider echoed with lowercase percent escapes (`%2f` rather than `%2F`), form-encoded with them, or with ordinary letters and digits escaped too (`%52` for `R`), could reach results, receipts, original responses and the kept Scrape.do cost header. Each key is now redacted as written or with any of its characters percent-encoded, escape letters in either case, and a space as `+`, whole or mixed, and a key ending in `%` leaves nothing behind when echoed as `%25`; the key's own characters still match exactly, so ordinary text is not redacted.
- **No part of a key survives a shortened excerpt or a JSON escape.** Some tools cut provider text short, such as Perplexity's error detail, Commerce's raw response excerpt or DeepWiki's error, after removing only the key as written, so an encoded echo across the cut left part of the key in results, receipts and saved reports; a JSON escape (`\/`) could also hide a whole key. Provider responses are now redacted as they arrive, before any tool reads or shortens them: JSON is decoded first and its text redacted, so redaction neither misses an escaped key nor breaks a valid response and its reported cost, and the Papers bridge's output is read the same way. Every tool's own error redaction uses the same matcher, and Exa's and Perplexity's redaction marks now read `[redacted]` like everywhere else.
- **A response cut off mid-body leaves the cost unknown.** When a request's own timeout or a network failure stopped a response after its Scrape.do cost header had arrived, the call recorded that header as its complete cost, or as no charge when it said zero. The response is now kept once with its header, the failure is reported without repeating the request, and the call's cost is unknown, with the reported amount kept as a subtotal. An OpenAlex error whose body is cut off is likewise no longer recorded as free.
- **Saved reports are checked the way Markdown reads them.** The save looked for a report's sections anywhere in its text, so sections written only inside a code block, or a `source_card` block that never closed, passed. It now requires the card to close and the four sections to be the report's own `##` headings. The save and the readers of the source card, title and Summary read a report's structure exactly as the reader renders it, so code inside a list or quote, indented and underlined headings, and a heading's closing `#`s count as Markdown has them; existing reports read as before. Like the renderer, a closing fence followed by a tab does not close its block.
- **Easier-to-read README.** Installation comes first; what Dig does and which services and keys unlock what are now tables with each source's logo. The source guide lists every optional key and alias.
- **Third-party notices.** The build now writes `plugin/THIRD_PARTY_NOTICES.md` with the license of every package bundled into the plugin, and fails if a bundled package's license cannot be included.

## 0.2.31 — 2026-10-08

- **Facebook research through ScrapeCreators.** Public profiles, page posts, reels, photos, video search, individual posts, transcripts, comments and replies, plus public group information and posts. A separate events tool discovers events by name, page or city and reads individual event details.
- **Facebook ads.** Search Meta's Ad Library, find advertiser page IDs, inspect an advertiser's ads and read ad details and available transcripts. Creative variants, run dates, media links and returned transparency disclosures stay attached to their ad.
- **Two source methods, one existing key.** Facebook and Facebook ads have separate source controls and research skills, both using `SCRAPECREATORS_API_KEY`. Each call reads one page, exposes continuation and records reported credits. No Facebook login, automatic crawl, request retry or redirect; private/gated content and missing data are reported rather than invented.

## 0.2.30 — 2026-10-08

- **Grok for what only Grok does.** The X methods find and read posts through X's API, and now name what to keep Grok for: watching a post's video and reading its images (X's API returns media links and metadata such as alt text, not what the media show, and nothing else in Dig watches video), searching by meaning, finding accounts from a description, and the shape of a discussion. X post asks Grok to describe a supplied post's video or images when its substance is there, not only when asked, and every method reports what Grok says media show as Grok's description. The Sources page's X card says Grok watches videos and reads images.

## 0.2.29 — 2026-10-07

- **Grok cites posts by link.** `xsearch` now asks Grok to cite every post inline with its full link. Grok sometimes cited posts by number (`[post:50]`, `[120]`) with no link, and those numbers identified no post. When a write-up still has bracketed numbers in its prose (outside links and code), the result says how many look like citations, that they are not links and that Dig's Sources list is numbered separately, so a worker finds the post through X's search before relying on it.
- **Fewer Grok passes in the X methods.** X judge runs at most three Grok passes and X breadth at most four, each passing `max` at most once; a `max` or `ultra` starting depth you set still applies to every pass. Both find posts through X's own search and keep Grok for interpretation: a Grok pass pays for every post it fetches, while its write-up links only a fraction of them.

## 0.2.28 — 2026-10-07

- **Figures at the top of the conversation panel.** The panel beside a conversation now opens with four small figures for that conversation's research: retrievals, sources, failed or stopped, and provider cost. They count the same calls as the conversation's cost did, and say how many retrievals by workers or other conversations are not included until a saved report claims them.

## 0.2.27 — 2026-10-07

- **A short README for installing from GitHub:** what you need, how to install, set up, use, update and uninstall, and what stays on your computer. Setup details for each source moved to [docs/sources.md](docs/sources.md).
- **SECURITY.md** says how to report a vulnerability privately.

## 0.2.26 — 2026-10-06

X as you: optional sign-in with your own X account, and Communities.

- **Optional X sign-in.** Put the X app's Consumer Key and Secret and an Access Token and Secret for your own account in keys.env (`X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`) and Dig signs four reads as that account, the ones X serves only to a signed-in account: people search, Communities search, your bookmarks and your liked posts. Every other read still uses the app's Bearer Token. Sign-in is optional: the X card's readiness and the X API account's set state do not depend on it, and a read that needs it says which keys are missing before sending anything.
- **New tool `x_bookmarks`.** Reads your bookmarks newest first, or one bookmark folder by name or id, up to 800 posts, with `match` to keep only posts in which every word you give starts a word (so "ai" finds "AI" and "#AI" but not "brainstorm"), in the text, the author, the links or a quoted or reposted post. X has no search inside bookmarks, so Dig filters what it read and says how many posts it read and how many matched.
- **New tool `x_likes`.** Reads the posts you have liked, with the same `limit` and `match`.
- **New tool `x_community`.** Reads one X Community by id or link: its details from X's API (or TikHub without a Bearer Token) and up to 500 of its posts through TikHub, labeled "via TikHub": by TikHub's Recency ranking, shown newest first by each post's own time because that ranking is not strictly by time, or by its Relevance ranking in TikHub's order.
- **People and Communities search work.** `x_users` with `query` runs signed in; `x_explore` Communities search runs signed in, or through TikHub without sign-in. Both answered "Unsupported Authentication" with the app token alone.
- **Community links.** A post in a Community, and each Community a search finds, shows the Community's link, which `x_community` reads.
- Reads of your own bookmarks and likes are priced by X as Owned Reads; Dig still shows every X and TikHub call's cost as unknown, because neither reports a per-call charge.

## 0.2.25 — 2026-10-06

- **X through X's own API.** Six new tools read X directly with an X developer account's Bearer Token (`X_BEARER_TOKEN`): `x_post` reads posts by link or ID with their exact text, author, metrics, media and the posts they quote or reply to, and optionally the thread, replies, quote posts and reposters; `x_search_posts` searches the last 7 days or the full archive (back to March 2006 unless a start time is given) with X's search operators; `x_count_posts` gives post volume over time; `x_users` reads accounts with their posts and mentions; `x_news` reads X News stories; `x_explore` covers trends, Spaces, Communities and Lists. Grok's `xsearch` stays. X does not report what a call costs, so these calls show their cost as unknown.
- **Failures X reports inside a response are never read as results.** A failure X reports beside or instead of data (an internal error, a refused or capped request) makes the call partial or failed, never "no posts". That is distinct from X answering that a requested post or account is missing, protected or suspended: that answer is reported for the item, and a lookup is empty only when X answered for every requested item; on a search, count or enrichment read with no data, even that answer is a failed read. A search that stops early says why, and a thread or reply read that X has more of says how many posts it read and gives the search that reads on from the oldest of them.
- **TikHub fallback for one post.** When a single post is requested and X's API cannot serve it (no token, no credits, a rate limit or an outage), `x_post` reads it through TikHub instead, labeled "via TikHub". A post X reports missing, protected or suspended is reported as such, not fetched elsewhere.
- **Keys stay redacted after a change.** A key replaced or removed in keys.env while a request that used it is still running stays redacted from that request's result and saved response.
- **X judge and X breadth use X's API.** The judge finds posts through X's search and reads every post it relies on before quoting it; the breadth finder lists posts through paged searches and counts; both use Grok for interpretation and for phrasing keyword search misses.
- **New method: X post.** `$dig:x-post` reads particular posts exactly and reports what surrounds them: the author, thread, replies grouped by stance, quote posts, reposters, how discussion grew and where the claim started.
- The X card shows the X API and xAI accounts and reads partly ready with one of the two keys.

## 0.2.24 — 2026-10-06

Security fixes from the review before the first testers.

- **Library reads return only Dig's research files.** `library_read`, the `dig://library/` resource and the saved-research card now read only a dig's Markdown, a session's `calls.jsonl` and original responses, and YouTube transcripts. Because the library folder is a setting the model can change, reading any Markdown or JSON under it could have exposed another folder's private files.
- **Malformed OpenAlex abstracts.** An abstract index with an out-of-range or non-integer position leaves that work without an abstract instead of building an array from it.
- **URL-encoded keys are redacted.** A key is also redacted in its URL-encoded spellings, so a provider response that echoes a request URL carrying the key cannot leak it into results or retained responses.

## 0.2.23 — 2026-10-06

- **Usage moved to the Library.** The Usage section (retrievals, reports saved, failed or stopped calls and provider cost, by day and by source) now opens the Library page instead of Sources; Sources starts with Accounts and keys. The cost note above the dig cards is gone, since Usage states the same scope and caveat just above them.
- **Compact in narrow views.** Where the Library is narrow, as in the conversation panel, Usage keeps its window switch, its four figures and the cost caveat, and leaves the charts to a wider view.
- **No usage yet.** A library with no retrievals or reports in any window says so, instead of showing empty figures.

## 0.2.22 — 2026-10-06

The first shared version.

- **Research:** 44 provider tools across 19 sources, 20 source methods, the YouTube transcript helper, and the `dig`, `library` and `setup` skills. One source is a complete workflow: retrieve, save a report, retain the original responses. A composed dig's answer records whether it settles the question: `answered`, `partly-answered` or `unanswered`.
- **Library:** a fullscreen library from Codex's sidebar, a **Research trail** beside a conversation, and an inline card for each saved report or answer, with Open in Dig links and composer `@` mentions. An open dig starts with a summary of its retrievals (how many, from which sources, how many failed or stopped, and what providers reported they cost), then every call listed under the report that saved it.
- **Status tags:** digs, reports, answers, calls and source readiness show their status as lowercase words on patterned fills, so no state depends on telling red from green.
- **Sources, Settings and About pages** in Dig's view, editing the same `config.toml` as Codex's native plugin settings page. Keys live only in `keys.env`; Dig shows names and presence, never values.
- **Costs:** provider-reported amounts from each call's receipt, per unit, with unknown cost kept apart from no charge. Each call records the dig it served, so a worker that stops before saving still leaves its calls and their cost in that dig.
- **Installation:** marketplace `dig` (plugin id `dig@dig`); settings, keys and the default library live in `~/.local/share/dig`. Each version publishes its views under resource URIs that carry the version, so Codex loads the new view after an update rather than a cached one.
