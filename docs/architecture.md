# Dig architecture

Dig is one local MCP service that every host on a computer connects to. Dig 2.0 is written in strict TypeScript (`allowJs: false`) on **Effect-TS 4.1.5** (`effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`, `@effect/ai-typesafe`, `@effect/atom-react`) and **`@modelcontextprotocol/server` 2.4+**, serving MCP revision `2026-07-28` natively and `2025`-era clients through the SDK's legacy path. It hosts **27 research sources and 2 shared analysis tools** (`29` co-located `SourcePlugin` modules), **86 actions**, **38 methods**, a plain-file research archive on disk paired with a local SQLite engine/index (`dig.sqlite`), a single localhost React 19 web application (`dist/web/`), and an SSH-safe terminal setup wizard (`dig setup`). Below, `dig` stands for `node <checkout>/dist/dig.mjs`: nothing installs a `dig` command, and on macOS and Linux that name is the DNS lookup tool. `src/version.ts` is the single version source for the service, the web app, and the host wrappers; the build refuses a `package.json` or `package-lock.json` mismatch, and `dig mcp` replaces an idle running service of an older version or different build fingerprint.

## Boundaries

- **Runtime & build.** Dig requires Node.js `>=22.13` (built-in `node:sqlite`). `npm run build` bundles the CLI and daemon into `dist/dig.mjs`, builds the localhost React 19 SPA into `dist/web/`, packages the local ONNX semantic-search runtime into `runtime/`, generates thin host wrappers in `plugins/`, and rewrites `THIRD_PARTY_NOTICES.md` and root notices. `dist/`, `runtime/`, and `plugins/` are generated build outputs and untracked.
- **One state folder.** All mutable state lives under `DIG_STATE_DIR`, else `~/.local/share/dig`. Nothing implicitly reads another installation's configuration, keys, library, database, or Papers bridge.
- **No master composer.** The initiating thread chooses the source methods and each ordinary worker's model and effort. It can run a method inline or launch fresh workers with self-contained assignments (purpose, known facts, scope, names/terms, files/reports to read, explicit choices, privacy exclusions, today's date, `dig` handle, and exact method name). There are no generated agent definitions, persistent workers, master composer, or orchestration service.
- **Reading obligations.** Source workers return saved report paths. The initiating thread reads every relied-on report in full and checks load-bearing claims against retained originals; a pointer or summary is not proof of reading.
- **Read-only UI.** The localhost web application shows saved research, live dig progress, sources, setup, and settings. It never launches provider research.

## The process

The `dig` command (`src/service/cli.ts`, built with `effect/cli` and bundled as `dist/dig.mjs`):

| Command | What it does |
| --- | --- |
| `dig serve` | Runs the local HTTP/MCP/SPA daemon (`src/service/daemon.ts` + `http-api.ts`) until stopped or idle. Refuses to start when its port is in use. |
| `dig mcp` | What a host launches: a stdio front forwarding messages to the daemon over HTTP, starting `dig serve` when none is running and swapping an idle older build. |
| `dig setup` | Interactive SSH-safe terminal onboarding wizard (`effect/cli/Prompt`) for presets/sources, `keys.env` (`0600`), and `[spend]` caps. Supports `--preset starter\|research\|social\|all` to apply a preset directly. |
| `dig open [--no-browser]` | Starts the daemon if needed, requests a one-time `/open/<code>` address, and opens the localhost web SPA in the default browser (or prints the URL). |
| `dig status` | Reports whether the daemon is running, its PID, address, start time, active calls, and running jobs. |
| `dig stop` | Asks the daemon to stop cleanly and waits until it has exited. |
| `dig list` | Read-only listing of saved digs in the active library without starting the daemon (`--json` supported). |
| `dig read` | Read-only reader for a saved report, answer, transcript, receipt file, or retained original (`--json` supported). |
| `dig search` | Passage search across saved reports and answers using SQLite FTS5 + optional local ONNX embeddings (`--json` supported). |
| `dig stats` | Read-only summary of saved digs, calls, and provider-reported costs (`--json` supported). |
| `dig version` | Prints the version (`src/version.ts`). |

**The daemon** listens on `127.0.0.1` only (`DIG_PORT`, else `service.json`, else `47811`), powered by Effect `HttpRouter` and `HttpEffect.fromWebHandler` (zero `@modelcontextprotocol/node`). It serves:

- `GET /health` (unauthenticated metadata: name, version, build fingerprint, PID)
- `GET /status`, `POST /stop` (supporting `?ifIdle=1`, returning `409` while calls, jobs, or pending approval/key codes are active), `POST /open` (Bearer token)
- `POST|GET|DELETE /mcp` (Bearer token; `2026-07-28` stateless `createMcpHandler` + `2025`-era sessionful `WebStandardStreamableHTTPServerTransport`)
- `GET|POST /keys/:code` and `GET|POST /approve/:code` (single-use opaque codes, zero JavaScript, strict CSP)
- `GET /open/:code` (single-use opaque code setting an `HttpOnly; SameSite=Strict` session cookie and redirecting to `/`)
- Cookie-authenticated SPA JSON APIs (`/api/library*`, `/api/settings`, `/api/setup*`), live Server-Sent Events (`/api/events`), and static assets from `dist/web/` with client-side route fallback.

**`service.json`** in the state folder (mode `0600`) stores `port`, `token`, `pid`, `version`, and `startedAt`. The token persists across restarts so HTTP-address hosts keep working; on exit `pid` and `startedAt` are cleared. `service.log` captures output when `dig mcp` launches `dig serve`.

**`dig mcp`** forwards JSON-RPC messages unchanged over stdio ↔ HTTP, attaching the Bearer token so host configs never hold credentials. It retries a request only when the connection was refused before reaching the daemon or when a `2025`-era session returns a JSON-RPC `404` (in which case it replays `initialize` + `notifications/initialized` once on a fresh session). If the stream drops mid-flight, it never resends a tool call: it answers immediately with an error noting that a paid request may have been sent and directing the caller to `job` or the dig's receipts.

**Idle exit.** The daemon exits after 30 minutes (`DIG_IDLE_EXIT_MS`) with no active requests, open SSE/MCP streams, or running jobs.

**Live reload.** Changing `config.toml` or `keys.env` applies without restarting the daemon: tool/prompt listings update and notify connected MCP clients, and SSE `/api/events` notifies open browser tabs.

### State folder layout

| Path in `<state>` | Holds |
| --- | --- |
| `config.toml` | Single inspectable settings authority. |
| `keys.env` | Provider credentials, mode `0600`. |
| `library/` | Default plain-file research archive (`library` setting can point elsewhere). |
| `dig.sqlite` (+ `-wal`/`-shm`) | Mode `0600` SQLite WAL database: operational ledger (`paid_call_ledger`, `dig_spend_overrides`, `browser_sessions`, `deferred_tokens`) and rebuildable read/search index (`library_*`, `search_fts`, `search_passages`). |
| `service.json`, `service.log` | Daemon port, Bearer token, PID/version, and log. |
| `search/models/` | Integrity-checked pinned BGE-small ONNX model weights (when semantic search is enabled). |
| `tools/paper-search-mcp` | Optional Papers bridge install. |

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `DIG_STATE_DIR` | `~/.local/share/dig` | State directory. |
| `DIG_PORT` | `47811` | Localhost TCP port. |
| `DIG_IDLE_EXIT_MS` | `30 minutes` | Idle shutdown delay. |
| `DIG_INLINE_WAIT_MS` | `40 seconds` | Inline wait before returning a slow job handle to clients without MCP Tasks. |
| `DIG_ASK_TIMEOUT_MS` | `5 minutes` | Wait timeout for spending questions or key-page submission. |
| `DIG_KEYS_TTL_MS` | `10 minutes` | Lifetime of a one-time `/keys/:code` link. |

## Security & access rules

- **Bearer token.** Every route except `/health`, `/keys/:code`, `/approve/:code`, `/open/:code`, and cookie-authenticated SPA routes requires `Authorization: Bearer <token>` compared with `timingSafeEqual`.
- **`Host` and `Origin` guards.** Every request must present `Host: 127.0.0.1:<port>` or `localhost:<port>`. Any `Origin` header must match the daemon's own origin, blocking DNS rebinding and cross-site requests.
- **No-JS form pages (`/keys/:code`, `/approve/:code`).** Single-use 24-byte random codes stored in `dig.sqlite` (key-page codes expire after `DIG_KEYS_TTL_MS`; approval codes expire after `DIG_ASK_TIMEOUT_MS`), served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, `Cache-Control: no-store`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`. `POST` enforces same-origin `Origin` (or `Origin: null` strictly when paired with `Sec-Fetch-Site: same-origin`), `Sec-Fetch-Site: same-origin` (when present), and a 64 KB body cap. `/approve/:code` additionally requires the browser session cookie and is surfaced only to authenticated browser tabs over `/api/events` (never returned to the model in tool output).
- **Browser session.** `POST /open` or MCP `open_library` issues a one-time `/open/:code` URL valid for 5 minutes. `GET /open/:code` sets a port-scoped `HttpOnly; SameSite=Strict` `dig_session_<port>` cookie (24-hour TTL; stored as its SHA-256 hash in `dig.sqlite`) and redirects to the requested SPA route (`/`, `/trail?dig=<handle>`, `/setup`, `/sources`, `/settings`). All `/api/*` endpoints and static SPA assets require this cookie and emit a strict `Content-Security-Policy` (`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`); mutating `/api/*` requests require same-origin `Origin`, and no `/api/*` route can invoke a provider source tool.
- **Outbound HTTP & SSRF (`src/core/http.ts`, `src/core/ssrf.ts`).** Every provider request resolves through `PaidHttp` or `FreeHttp` with `HttpClient.TracerPropagationEnabled = false` (no outbound `traceparent`/`b3` headers) and streaming response byte caps. User-supplied or public-fetch URLs pass `assertPublicUrl` + `resolvePublicIp` (refusing loopback, private RFC 1918, CGNAT `100.64.0.0/10`, link-local/metadata `169.254.0.0/16`, IPv4-mapped/compatible, `fc00::/7`, `fe80::/10`, `2002::/16`, `2001::/32`, and multi-hop redirects to private IPs). Redirects strip cross-origin `authorization`, `cookie`, and `x-api-key` headers, and actions that disallow redirects pass `followRedirects: false`.
- **Credential redaction (`src/core/secrets.ts`).** Known catalog credential values (current and previously loaded during the process lifetime) are scrubbed—including raw, percent-encoded, and `+`-space URL forms—from provider outputs, error messages, progress notifications, questions before slugifying, receipts, retained raw bodies, and saved Markdown reports/answers.

## The MCP protocol & tool surface

- **2026-07-28 + 2025-era compatibility.** Stateless `2026-07-28` requests are handled by `createMcpHandler`; legacy `initialize` clients use sessionful `WebStandardStreamableHTTPServerTransport`. List responses carry private cache hints, and config changes emit `listChanged` notifications.
- **Resources.** `dig://library/{file}` serves saved reports, answers, receipts, and retained originals through the same `isResearchFile` containment allowlist as `library_read`. `resources/list` lists the 50 newest saved reports and answers.
- **Extensions:** `io.modelcontextprotocol/skills` (all 38 methods) and `io.modelcontextprotocol/tasks` (`tasks/get`, `tasks/cancel` backed by `paid_call_ledger`). **`io.modelcontextprotocol/ui` (`ui://` MCP Apps) is removed in Dig 2.0** in favor of the single universal localhost web SPA opened via `open_library`.
- **Zero `zod`, zero TypeBox.** Every tool and prompt schema is derived directly from Effect 4.1.5 `Schema` via `Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1` (`src/service/surface.ts`).
- **Fixed tool order (41 tools with every source enabled):**
  1. **11 core tools:** `dig_start`, `dig_finish`, `research_save`, `library_list`, `library_search`, `library_read`, `source_info`, `settings`, `keys`, `job`, `open_library`.
  2. **29 catalog tools** (27 research sources + 2 shared tools `video`, `evidence`), registered in catalog order from `src/sources/index.ts`, named by source id with `-` as `_`. Disabled sources are unlisted and refused.
  3. **`method`** (returns a method's `SKILL.md` or a supporting file inside its folder).
- **Source tool call form:** `{ dig, action, args?, fresh? }`. Listed `args` schemas are compacted (`schemaToMcpJson` with `compact: true`) while server validation uses the action's full Effect `Schema` and returns structured path errors plus the full action schema with `"No request was sent."` on mismatch.

## Durable paid calls & never repeating a charge

Every provider plugin lives co-located under `src/sources/<id>/` (`src/core/plugin.ts`) and uses two distinct Effect HTTP services:

- **`PaidHttp`** (`src/core/http.ts`): strictly **zero retries** on HTTP 5xx, timeouts, or transport failures. A request that gets no response records `cost: null` (unknown, never zero) and is never sent again.
- **`FreeHttp`**: bounded safe transport retries only for explicitly free actions (never retrying SSRF or `InvalidUrlError` rejections).

Between MCP/HTTP and every paid or slow action sits `ExecutionService` (`src/core/workflow.ts`) backed by `paid_call_ledger` in `dig.sqlite`:

1. **Atomic deduplication & crash safety.** Before sending any paid or slow provider call, `ExecutionService` runs an atomic `BEGIN IMMEDIATE` transaction checking `paid_call_ledger` keyed by `(dig_handle, action, args_hash)` with a partial unique index (`idx_paid_call_active_unique`) covering active (`working` / `pending_approval`) rows:
   - An identical active call **always attaches** to the running execution (even when `fresh: true`), so two concurrent identical calls can never double-charge.
   - An identical `completed` or `failed` call finished within 10 minutes returns the cached result without charging again unless `fresh: true` is explicitly passed.
   - A `cancelled` call is never reused.
   - Missing or disappeared ledger rows refuse execution rather than replaying a paid call.
2. **Crash recovery & read-only `reconcile()`.** Only after `dig serve` binds its port exclusively (never from `dig list|read|search|stats|setup` or a failing duplicate `dig serve`), `ExecutionService.recoverCrashedCalls()` settles any stale `pending_approval` rows as `cancelled` and inspects any `dispatched` rows left by an interrupted process:
   - If the action defines a read-only `reconcile(remoteJobId, args, ctx)` hook and a `remote_job_id` was persisted (for example `xsearch` storing its xAI response ID), Dig performs read-only recovery (`GET /v1/responses/:id`, never `POST`) to capture the finished answer and receipt.
   - Otherwise, the row is marked `failed` with `"The service stopped while this job was running: its request may have been sent and charged, and its cost is unknown."` and a `failed` receipt with `cost: null` is written if absent. It is never retried.
3. **Slow actions (12 catalog actions)** (`xsearch`, `youtube`, `youtube_analyze`, `youtube_analysis_status`, `video_analyze`, `exa_research`, `papers_multi_search`, `papers_sections`, `papers_fulltext_read`, `papers_pdf_download`, `deepwiki_ask_question`, `dataforseo_request`) return an MCP Task to task-capable clients or wait up to `DIG_INLINE_WAIT_MS` (40 s) before returning a job ID for `job({ id, wait?, cancel? })`. Live progress updates flow through `ProgressHub` (`PubSub.sliding(256)` with secret redaction) to MCP `notifications/progress` and browser SSE `/api/events`.

## Multi-unit `[spend]` controls & approvals

`[spend]` in `config.toml` supports independent per-unit caps without ever converting between currencies or provider units:

- `dig_ceiling_usd`: per-dig US-dollar ceiling.
- `ask_above_usd`: ask before any paid call whose 90-day median USD cost meets or exceeds this threshold, or which has no priced call yet.
- `max_credits`: per-dig cap on total provider credits (Firecrawl, ScrapeCreators, Scrape.do, OpenAlex credits).
- `max_x_post_reads`: per-dig cap on X API post reads.
- `max_x_account_reads`: per-dig cap on X API account reads.
- `max_unknown_calls`: per-dig cap on paid calls whose provider reports no per-call amount (`cost: null`).

When a cap or `ask_above_usd` triggers before a paid call (never for free actions or zero-charge modes like DataForSEO sandbox or `xsearch` `recoverResponseId`):

1. If the MCP client supports form elicitation (`2026-07-28` `input_required` or `2025`-era `elicitation/create`), Dig asks inline to raise that specific cap for this dig, send once, send without asking again for this dig, or stop.
2. If the client cannot elicit, Dig can issue a single-use localhost `/approve/:code` URL for human approval or return an explicit refusal naming the exact cap and totals—never silently sending a paid request.
3. Per-dig approvals and cap raises are persisted in `dig_spend_overrides` (keyed by dig handle), never mutating `config.toml`.

## Plain-file archive + rebuildable SQLite index

Plain files on disk remain the canonical archive and keep Dig's exact file contract:

```text
<library>/<project-folder>/
  digs/<dig-id>/
    dig.md
    <method>.md
    <method>-2.md
    answer.md                 # optional answer of the initiating thread
  sessions/<dig-id>/
    calls.jsonl
    raw/<call-id>.json
<library>/papers/             # downloaded PDFs shared by Papers methods
<library>/youtube-transcripts/ # transcripts and optional helper summaries
```

- **Rebuildable index.** Deleting `dig.sqlite` loses zero research data: the next `library_list`, `library_search`, or `dig stats` scans the library and rebuilds `library_digs`, `library_reports`, `library_calls`, `search_fts`, and `search_passages` directly from the plain files on disk.
- **Report structure.** Every saved report must start with its closed YAML `source_card` fence and include top-level `## Summary`, `## Evidence Highlights`, `## Needs Follow-Up`, and `## Negative Evidence (when relevant)` headings (`reportParts` in `src/core/markdown.ts`).
- **Attribution.** Receipts naming `dig` belong to that dig and are claimed in `library_list` by the first later report of the same source in the same session, else the dig's `answer.md` (`claimedBy: null` if unclaimed). Legacy receipts without `dig` follow the same-session rule or appear as live activity.
- **Read allowlist.** `library_read`, `dig://library/{file}`, and `/api/library/read` enforce canonical path containment (refusing symlinks outside the library) AND `isResearchFile`: only `<project>/digs/<dig>/*.md`, `<project>/sessions/<session>/calls.jsonl`, `<project>/sessions/<session>/raw/*.json`, and `youtube-transcripts/*.md` are readable. Changing `library` can never expose `keys.env` or arbitrary host files.
- **Local search (`src/core/search.ts`, `src/core/search-onnx.ts`).** Combines SQLite FTS5 lexical matching with optional local BGE-small-en-v1.5 Q8 ONNX embeddings (`darwin/arm64` and `linux/x64` packaged in `runtime/`), verifying model revision and file hashes on every query and pruning deleted files automatically. See [library search](library-search.md).

## Localhost web application (`dist/web/`) & host wrappers

- **One universal web SPA (`src/frontend/` → `dist/web/`).** Built with React 19, Vite 8, Tailwind CSS v4, `@effect/atom-react`, `effect/reactivity`, TanStack Router, and Base UI/ReUI primitives. Served directly by the local Dig daemon over cookie-authenticated HTTP with live SSE updates (`/api/events`) and an inline validated SVG logo sprite. Routes: `/` (Library & cost overview), `/dig/$project/$digId` (allowlisted Markdown reader + side-by-side raw evidence inspector + receipt ledger), `/trail` (live SSE progress, pending spend approvals, and running jobs; optional `?dig=<handle>` filter), `/sources` (catalog readiness, 90-day action history, one-click key entry), `/setup` (4-step guided onboarding wizard), `/settings` (flat `config.toml` editor), and `/about`.
- **Host wrappers (`plugins/`).** Generated by `scripts/wrappers.mjs` and never hand-edited:
  - `plugins/claude` + `plugins/.claude-plugin/marketplace.json`: points Claude Code at `node <checkout>/dist/dig.mjs mcp` (methods served as MCP prompts/skills).
  - `plugins/chatgpt` + `plugins/.agents/plugins/marketplace.json`: points Codex/ChatGPT at `dig mcp` (`tool_timeout_sec: 600`, `env_vars: ['DIG_STATE_DIR', 'DIG_PORT']`) and bundles `skills/` with generated `agents/openai.yaml` (`allow_implicit_invocation: false` on source methods).
  - `plugins/antigravity`: native Antigravity plugin (`plugin.json`, `mcp_config.json` with `timeoutSeconds: 600`, `assets/logo.png`, and `skills/` with `disable-model-invocation: true` on non-implicit source methods).
