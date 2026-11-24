# Getting started

Dig is a research service on your computer. Your assistant connects to it, searches the sources you turn on, and keeps what it found in a library on your disk: a receipt for every call, the provider's original response, and the reports and answers written from them. You set the direction in the conversation; the assistant does the detailed reading, and the records stay for you to check.

## 1. Install and connect

You need Node.js 22.13 or newer. Build Dig from a checkout:

```sh
git clone https://github.com/jonpage0/dig.git
cd dig
npm ci
npm run build
```

The build writes `dist/`, `runtime/` and `plugins/`, all three generated. If the released Dig plugin (0.15 or earlier) is installed in a host, remove or disable it there first: both register a server named `dig`.

Then add it to your host so that the host launches `node /absolute/path/to/dig/dist/dig.mjs mcp`:

- **Claude Code:** `claude mcp add dig -- node /absolute/path/to/dig/dist/dig.mjs mcp`
- **Codex and ChatGPT desktop:** in `~/.codex/config.toml`,

  ```toml
  [mcp_servers.dig]
  command = "node"
  args = ["/absolute/path/to/dig/dist/dig.mjs", "mcp"]
  tool_timeout_sec = 600
  ```

- **Antigravity (`agy`):** install the generated plugin wrapper (`agy plugin install /absolute/path/to/dig/plugins/antigravity`), or add the server directly with `agy mcp add dig -- node /absolute/path/to/dig/dist/dig.mjs mcp` and set `"timeoutSeconds": 600` on the `dig` entry in `~/.gemini/config/mcp_config.json`.
- **Another MCP host:** launch the same command over stdio, or connect to `http://127.0.0.1:47811/mcp` with the token from `~/.local/share/dig/service.json` as a bearer token. The [README](../README.md#connect-a-host) has the address form in full.

Below, `dig` stands for `node /absolute/path/to/dig/dist/dig.mjs`: nothing installs a `dig` command, and on macOS and Linux that name is the DNS lookup tool, so type the full form in a terminal.

`dig mcp` starts Dig's service the first time it is needed. Every host on your computer then uses the same service, settings, keys and library. The service stops by itself after 30 minutes with nothing to do and starts again, without a message, on the next request. Codex and ChatGPT keep a connection to it open, so it stays up while they run; if it stops under them anyway (`dig stop`, a newer Dig replacing it, or a crash), their next request starts it again and goes through, with nothing to restart. A call that was running when it stopped is answered with an error saying so: a paid request may still have been sent, so it is not sent again, and the dig's receipts show what happened.

## 2. Turn on sources

Choose whichever setup flow fits your workflow:

- **In a terminal (SSH-safe):** run `node /absolute/path/to/dig/dist/dig.mjs setup` for the interactive TUI wizard (or pass `--preset starter|research|social|all`).
- **In a browser:** run `dig open` or ask your assistant to call `open_library({ view: "setup" })` to walk through the 4-step `/setup` wizard.
- **In chat:** ask **“Set up Dig.”** The assistant reads Dig's `setup` method, shows you the sources, and turns on the ones you choose via `settings`. It changes a setting only when you ask it to.

Hacker News is on from the start and needs no key. DeepWiki, Polymarket, the Wayback Machine, SEC EDGAR and Bluesky need no key either. GitHub and the direct Papers searches work without one, at lower limits. [Sources and their keys](sources.md) lists what each source needs.

## 3. Enter keys

Keys never go in the chat. When a source needs one, the assistant calls Dig's `keys` tool:

1. Your host asks whether to open a page. The page is served by Dig on your computer and lists one field per key, with where to get it and whether it is already set.
2. Type the keys and press **Save**. Dig writes them to `keys.env` and uses them at once. The page works for one submission and expires after 10 minutes.
3. The assistant is told which keys are now set and which are still missing, by name only.

If your host cannot open pages, the assistant gives you the page's address; open it in a browser on the same computer. You can also edit `~/.local/share/dig/keys.env` yourself, one `NAME=value` per line.

## 4. Ask your first question

> Use Dig and Hacker News to research how people choose a note-taking app. Show the strongest findings, disagreements and what is still missing. Save the supporting research and check the original discussions.

What happens:

1. The assistant starts a **dig** for the question. Everything the question produces is filed under it.
2. It calls the source: here, the `hackernews` tool with the action `hackernews`. The first line of each result names the source, the action, its status, the receipt and the cost.
3. It saves a **report** for the source: a summary, the evidence, what needs follow-up and what it looked for and did not find.
4. It reads the report and the original responses its conclusions rest on, and answers you. It can save that **answer** in the dig.

You can name a method (“use Dig's x-judge method”), name sources, or let the assistant choose from the ones you turned on. It can research one source itself or start helpers, one per source, and bring their reports together.

**Slow calls.** Some actions take minutes: a Grok search, a video analysis, deep research. Dig runs them as jobs. If one is still running after 40 seconds, the assistant gets a job id and asks the `job` tool for the result; it does not send the call again.

**Questions before spending.** If you set a spending ceiling or an amount above which Dig should ask, your host shows you a short question before a paid call: send it, send it and don't ask again for this dig, or don't send it; at the ceiling, raise it for this dig or stop. A declined question means no request is sent.

## 5. Read a report and its evidence

- **In the conversation.** Ask the assistant to show you a report or to quote the original response behind a claim. It reads them with `library_read`.
- **In the localhost web app.** Ask your assistant to open Dig's library (it calls `open_library`), or run `dig open` in a terminal. Dig serves one universal React web application on `127.0.0.1` with the library, side-by-side raw evidence reader, live SSE dig trail, sources/history catalog, `/setup` wizard, and settings, authenticated with a one-time `/open/<code>` link.
- **On disk.** Reports and originals are ordinary files in the library folder (below).

In the library view, select a question to read its answer, or its latest report when there is no answer. **Research details & activity** holds the coverage, the follow-up targets and the calls; **Retrievals** opens the original responses. **Steer research** prepares an instruction for the next step, which you send yourself.

What the records show and do not show:

- A report's findings are its author's assessment. Your assistant should read the full report and the originals before relying on it.
- A source count is breadth, not proof of complete coverage or agreement.
- “No answer saved” does not mean a helper is still running.
- Reusing a saved report does not make it current; ask for a refresh when that matters.

To find earlier research, ask: “Use Dig to find what we already researched about [topic].”

## 6. Understand costs

- Each provider reports usage in its own units: US dollars, Firecrawl, ScrapeCreators or Scrape.do credits, OpenAlex credits, or X post and account reads. Dig keeps each unit separate and never converts between them.
- **Unknown** means the provider reported no cost for the call. It does not mean free.
- A **reported subtotal** means part of a call was priced and part was not, so its total is unknown.
- Figures are what providers reported, not an invoice, and leave out your assistant's own model use, which your ChatGPT or Claude plan covers.

Optional spending controls under `[spend]` (each independent; Dig never converts between units):

- **Spending ceiling per dig** (`spend_dig_ceiling_usd`): once one dig's calls have recorded that much in US dollars, Dig asks before its next paid call whether to raise the ceiling for that dig or stop.
- **Ask before a paid call** (`spend_ask_above_usd`): Dig asks before a paid call whose action has typically cost at least that much in your library, or has no priced call there yet.
- **Per-unit caps** (`spend_max_credits`, `spend_max_x_post_reads`, `spend_max_x_account_reads`, `spend_max_unknown_calls`): optional per-dig caps on provider credits, X API post/account reads, and unknown-cost calls.

When the host cannot ask you, such as in a non-interactive run, Dig refuses the call and says why. A call identical to one that finished in the last 10 minutes returns the earlier result without paying again.

`source_info`, and the **Sources & tools** page in the views, show what each action has cost in your library over the last 90 days, how long its calls took and how often they failed.

## 7. Where things are on disk

Everything lives in `~/.local/share/dig`, or the folder `DIG_STATE_DIR` names:

| Path | What it holds |
| --- | --- |
| `config.toml` | Settings: the library folder, the sources turned on, spending, retention, search and suggested helper models. |
| `keys.env` | Your provider keys, readable only by you. |
| `library/` | The plain-file research archive (you can choose another folder). Each project has a folder; inside it, `digs/<dig>/` holds the question, the reports and the answer, and `sessions/<dig>/` the receipts (`calls.jsonl`) and original responses (`raw/`). |
| `dig.sqlite` | Mode `0600` SQLite WAL database holding the paid-call ledger, per-dig spend approvals, browser sessions, and the rebuildable library & FTS5/ONNX search index. Deleting it loses no research files. |
| `service.json`, `service.log` | The running service's port, token and version, and its log. |
| `search/` | Integrity-checked local semantic search model weights (when semantic search is enabled). |
| `tools/` | The optional Papers bridge. |

Changing the library setting selects another folder; it does not move existing research. `dig status` shows whether the service is running and its running jobs; `dig stop` stops it. Local library commands inspect saved research without starting the service or calling providers: `dig list`, `dig read`, `dig search` and `dig stats` (each supports `--json`; `list`, `read` and `stats` write nothing, while `search` refreshes the local search index cache as needed).

## Notes for each host

**Claude Code** opens Dig's web library in your browser through `open_library` (or `dig open` in a terminal). It supports MCP elicitation for spending questions and the key page, exposes Dig's methods as `/` commands (`/mcp__dig__<method>`), and follows slow calls as MCP tasks.

**ChatGPT desktop and Codex** connect to `dig mcp` (with `tool_timeout_sec = 600`) and open Dig's localhost web app via `open_library` or `dig open`. With the generated ChatGPT wrapper installed, Dig's methods also appear as Codex/ChatGPT skills; otherwise ask for a method by name and the assistant reads it with `method`.

**Antigravity (`agy`)** connects via the generated plugin wrapper at `plugins/antigravity` (`timeoutSeconds: 600` and Dig's methods as skills, keeping source methods out of automatic invocation) and opens the web library via `open_library` or `dig open`.

**Other hosts** reach every method through the `method` tool (or the MCP Skills extension), slow calls through `job` (or MCP Tasks), and the web app via `open_library` or `dig open`.
