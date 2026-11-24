# Permissions

What Dig can reach, what it writes, and what it asks before doing. Your host's own permission settings are a separate control: they decide whether a Dig tool may run at all, and Dig changes none of them.

## The local service and who can call it

Dig runs one service per computer, listening on `127.0.0.1` only (port 47811, or `DIG_PORT`). Nothing on another computer can reach it. Below, `dig` stands for `node /absolute/path/to/dig/dist/dig.mjs`: nothing installs a `dig` command, and on macOS and Linux that name is the DNS lookup tool.

- **A token.** The service makes a random token the first time it starts and keeps it in `service.json` in Dig's folder, readable only by you. Every MCP request, and the `status`, `stop` and `open` requests the `dig` command makes, must carry it. `dig mcp` adds it itself, so a host launching `dig mcp` holds no credential; a host using the address form holds the token.
- **No web page can call it.** A request must name the service's own address (`127.0.0.1` or `localhost` with its port) as its host, and a request that carries an `Origin` is refused unless it comes from the service itself.
- **The key and approval pages** (`/keys/<code>`, `/approve/<code>`) need no bearer token: each code is 24 random bytes, works for one submission, and expires automatically (`10 minutes` for keys, `5 minutes` for spend approvals). Each form posts only to itself, runs zero JavaScript, and loads nothing external.
- **The localhost web app** needs a session, granted by a one-time `/open/<code>` address valid for 5 minutes from `dig open` or `open_library`. Opening it sets an `HttpOnly; SameSite=Strict` cookie (`dig_session`, 24-hour TTL). Every SPA page, SSE event stream (`/api/events`), and `/api/*` route requires that cookie and same-origin headers for mutations, and can never invoke a provider source tool.
- **`/health`** answers anyone on the computer with the service's name, version, build fingerprint and process id, and nothing else.

## Your host's permissions

Every source tool is marked as reaching the outside world. Codex, ChatGPT and Claude Code each decide, by their own settings, whether to ask you before a tool runs; installing Dig adds no permission rule and grants nothing. A host that cannot ask and whose policy does not allow a tool refuses the call, and no request reaches the provider.

## Provider requests

A source tool sends requests only to that source's providers, with your keys, and only when the assistant calls it under a dig. A source that is turned off is not listed and refuses calls. Turning a source on lists its tool; **it does not authorise spending**, and Dig's methods tell the assistant so.

What leaves your computer: the query and arguments of each call go to that source's provider. YouTube video understanding sends the selected public video addresses and your question to Google; Video analysis sends selected media, or a clip Dig prepares from a local file inside your project, to Elorian; Evidence ranking sends the question, the excerpts and any claim to TypeSafe. Each provider keeps what it receives under its own terms. Apart from provider calls, Dig downloads its pinned search model once when you turn semantic search on, and the Papers bridge's setup downloads the bridge when you run it.

Dig never repeats a paid request that got no response: its cost is recorded as unknown instead. A call identical to one still running waits for it; a call identical to one that finished in the last 10 minutes gets the earlier result. Only `fresh: true` sends the same paid request again.

## Spending

Optional per-dig spending controls under `[spend]` in `config.toml` (`settings` prefixes them with `spend_`; `0` or `null` disables a cap). Each unit is enforced independently and never converted across currencies or providers:

- **`dig_ceiling_usd`**: US-dollar ceiling per dig. Before a paid call once the dig's recorded USD total reaches it, Dig asks whether to raise the ceiling for this dig or stop.
- **`ask_above_usd`**: ask first before any paid call whose 90-day median USD cost in your library meets or exceeds this threshold, or which has no priced call yet.
- **`max_credits`**: per-dig cap on provider credits (Firecrawl, ScrapeCreators, Scrape.do, OpenAlex credits).
- **`max_x_post_reads`** and **`max_x_account_reads`**: per-dig caps on X API post and account reads.
- **`max_unknown_calls`**: per-dig cap on paid calls whose provider reports no per-call amount (`cost: null`).

Your answers apply to that dig only and are stored in `dig.sqlite` (`dig_spend_overrides`), never mutating `config.toml`. Free actions and zero-charge modes (DataForSEO sandbox, `xsearch` `recoverResponseId`) are never asked about or refused. When the host cannot elicit inline, Dig can offer a single-use localhost `/approve/<code>` page or refuse explicitly with the reason and totals; it never silently sends a paid request.

## Files Dig writes

All in Dig's folder (`~/.local/share/dig`, or `DIG_STATE_DIR`), and nowhere else except the library folder you choose:

- `config.toml`, when you or the assistant change a setting;
- `keys.env` (mode `0600`), only from `dig setup`, the key page, or your own edits;
- in the library: a dig's question, reports and answer, each written once and never overwritten; a receipt for every call; the provider's original response when `keep_raw` is on; YouTube transcripts and downloaded PDFs;
- `dig.sqlite` (mode `0600` WAL): the crash-safe `paid_call_ledger`, per-dig spend approvals, browser sessions, one-time codes, and the rebuildable library & FTS5/ONNX search index;
- `service.json` and `service.log`, `search/models/` (pinned ONNX model weights when semantic search is enabled), and `tools/` (the Papers bridge, if installed).

Video analysis reads a local file only inside the project folder of the dig. Papers section extraction reads only PDFs in the library. Dig never moves research when you change the library setting.

## Keys

Keys are read only from `keys.env`. A key in the environment that started Dig is not used. Dig never asks for a key in the conversation, never returns a value, and removes known key values, in every spelling URL encoding gives them, from provider output, receipts, original responses and saved reports. The `keys` tool and `source_info` report keys by name only.

## When something is refused

The assistant reports a refusal as a refusal: a host permission refusal, a declined spending question, a ceiling, a disabled source and a missing key are not provider failures, and none of them is an empty search. It never invents a result or a saved path, and never works around a refusal by using another dig, changing a setting or calling another tool for the same request.
