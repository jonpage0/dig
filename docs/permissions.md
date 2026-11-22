# Permissions

What Dig can reach, what it writes, and what it asks before doing. Your host's own permission settings are a separate control: they decide whether a Dig tool may run at all, and Dig changes none of them.

## The local service and who can call it

Dig runs one service per computer, listening on `127.0.0.1` only (port 47811, or `DIG_PORT`). Nothing on another computer can reach it. Below, `dig` stands for `node /absolute/path/to/dig/dist/dig.mjs`: nothing installs a `dig` command, and on macOS and Linux that name is the DNS lookup tool.

- **A token.** The service makes a random token the first time it starts and keeps it in `service.json` in Dig's folder, readable only by you. Every MCP request, and the `status`, `stop` and `open` requests the `dig` command makes, must carry it. `dig mcp` adds it itself, so a host launching `dig mcp` holds no credential; a host using the address form holds the token.
- **No web page can call it.** A request must name the service's own address (`127.0.0.1` or `localhost` with its port) as its host, and a request that carries an `Origin` is refused unless it comes from the service itself.
- **The key page** (`/keys/<code>`) needs no token: the code in its address is random, works for one submission and expires after 10 minutes. Its form posts only to itself, shows no key's value, runs no script and loads nothing from elsewhere.
- **The views in a browser** need a session, which a one-time address gives: it works once, within 5 minutes. `dig open` asks the service for one with the token. `open_library`, called by a client that shows no views, makes one and asks the client to open it for you, or gives it in its result; so any client connected to Dig can get one, and the session gives nothing that client cannot already do with Dig's tools. Opening the address gives that browser a session cookie for 24 hours (or until the service restarts). The views' pages and the requests they make work only with that cookie and only from the service's own address, and they can call only the tools the views use, never a source.
- **`/health`** answers anyone on the computer with the service's name, version, build fingerprint and process id, and nothing else.

## Your host's permissions

Every source tool is marked as reaching the outside world. Codex, ChatGPT and Claude Code each decide, by their own settings, whether to ask you before a tool runs; installing Dig adds no permission rule and grants nothing. A host that cannot ask and whose policy does not allow a tool refuses the call, and no request reaches the provider.

## Provider requests

A source tool sends requests only to that source's providers, with your keys, and only when the assistant calls it under a dig. A source that is turned off is not listed and refuses calls. Turning a source on lists its tool; **it does not authorise spending**, and Dig's methods tell the assistant so.

What leaves your computer: the query and arguments of each call go to that source's provider. YouTube video understanding sends the selected public video addresses and your question to Google; Video analysis sends selected media, or a clip Dig prepares from a local file inside your project, to Elorian; Evidence ranking sends the question, the excerpts and any claim to TypeSafe. Each provider keeps what it receives under its own terms. Apart from provider calls, Dig downloads its pinned search model once when you turn semantic search on, and the Papers bridge's setup downloads the bridge when you run it.

Dig never repeats a paid request that got no response: its cost is recorded as unknown instead. A call identical to one still running waits for it; a call identical to one that finished in the last 10 minutes gets the earlier result. Only `fresh: true` sends the same paid request again.

## Spending

Two settings, both optional, both in US dollars, under `[spend]` in `config.toml` (the `settings` tool calls them `spend_dig_ceiling_usd` and `spend_ask_above_usd`; 0 turns either off):

- **`dig_ceiling_usd`**, a ceiling per dig. Before a paid call in a dig whose calls have already recorded that much in US dollars, Dig asks you: **“Raise the ceiling for this dig by $…”** (the ceiling's own amount) or **“Stop here”**. Only dollar amounts count; credits, read counts and unknown costs are named in the question but not added. The call that crosses the ceiling completes, so the question comes before the next one.
- **`ask_above_usd`**, ask first. Before a paid call whose action has typically cost at least that much in your library (the median of its priced calls over the last 90 days), or has no priced call there yet, Dig asks: **“Send it”**, **“Send it, and don’t ask again for this dig”** or **“Don’t send it”**.

Your answers apply to that dig only and are kept in Dig's `jobs/digs/` folder, never in your settings. A free action, and a call a metered action makes at no charge (a DataForSEO sandbox request, a stored Grok answer read back), is never asked about or refused. When the host cannot ask (it declares no way to, or the run is not interactive), or you decline or dismiss the question, the call is refused with the reason and nothing is sent. With a host on the older, 2025-era protocol, Dig waits at most 5 minutes for an answer and then refuses the call the same way; it never waits indefinitely.

## Files Dig writes

All in Dig's folder (`~/.local/share/dig`, or `DIG_STATE_DIR`), and nowhere else except the library folder you choose:

- `config.toml`, when you or the assistant change a setting;
- `keys.env`, only from the key page (or your own edits);
- in the library: a dig's question, reports and answer, each written once and never overwritten; a receipt for every call; the provider's original response when `keep_raw` is on; YouTube transcripts and downloaded PDFs;
- `jobs/`, a record of each paid or slow call (with its arguments, credentials removed) kept for 24 hours after it finishes, and your answers to the spending questions;
- `service.json` and `service.log`, `search/` (the search index and, if you turn semantic search on, its model) and `tools/` (the Papers bridge, if you set it up).

Video analysis reads a local file only inside the project folder of the dig. Papers section extraction reads only PDFs in the library. Dig never moves research when you change the library setting.

## Keys

Keys are read only from `keys.env`. A key in the environment that started Dig is not used. Dig never asks for a key in the conversation, never returns a value, and removes known key values, in every spelling URL encoding gives them, from provider output, receipts, original responses and saved reports. The `keys` tool and `source_info` report keys by name only.

## When something is refused

The assistant reports a refusal as a refusal: a host permission refusal, a declined spending question, a ceiling, a disabled source and a missing key are not provider failures, and none of them is an empty search. It never invents a result or a saved path, and never works around a refusal by using another dig, changing a setting or calling another tool for the same request.
