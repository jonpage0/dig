---
name: setup
description: Set up the native Dig plugin after installation or when the user asks to set up, onboard, enable sources or check what Dig needs. Reads Dig's settings and source readiness, asks which sources to enable, applies only the changes the user chooses, and explains each remaining credential or prerequisite step without ever handling a key.
---

# Set up Dig

Codex runs this skill after Dig is installed, and the user can run it any time with `$dig:setup`. You help the user choose research sources and tell them exactly what each still needs. You never run research here and never call a provider tool.

Use only this plugin's `dig` server. Another Dig edition's server, CLI, configuration, keys and library are separate and stay untouched.

## 1. Read the current state

Call `settings.read` and `source_info` (no arguments). From `source_info`, note each source's `enabled`, `readiness.status` and `readiness.message`, its `credentials` (names and whether each is set, never values), its `prerequisites`, and the top-level `configPath`, `keysPath` and `library`.

Readiness means a credential name is set or a local prerequisite exists. It is not proof that a key is valid, has credit, or that the provider is up; say so when it matters.

## 2. Show where things stand

Give a short overview, grouped by what the user would do next:

- **Ready to use**: enabled and ready.
- **Enabled but needs something**: name the missing credential or prerequisite.
- **Available to turn on**: disabled sources, each with one line on what it researches. Hacker News, DeepWiki and Polymarket need no key. GitHub works without a login at lower limits (a login is optional; see step 5).

Use the source labels, not ids. Keep it to one screen; offer details on request.

## 3. Ask, one question at a time

Ask which sources the user wants on, and wait for the answer. Recommend from what they said they research, not every source. Enabling a source turns on its tools for every conversation; it does not spend money by itself, but paid sources charge per request once research runs.

One source needs extra care:

- **DataForSEO** is paid per request from a prepaid DataForSEO account. It needs the account's API login and API password, which are not the dashboard password.

## 4. Apply only what the user chose

Call `settings.update` with `set` containing only the fields the user asked to change, for example `{ "set": { "exa_enabled": true, "reddit_enabled": true } }`. Field names are `<source id with underscores>_enabled`, plus `library`, `keep_raw`, the `x_` options, and the suggested worker fields (`worker_model` and `worker_effort` for every method, `<method with underscores>_worker_model` and `_worker_effort` for one), all listed by `settings.read`. Confirm the result from the values `settings.update` returns, not from what you sent. If the update fails, report the error and change nothing else.

Never change `library`, `keep_raw` or a worker suggestion unless the user asks. Changing `library` selects a different folder; it does not move existing research. A worker suggestion is guidance for the conversation that spawns source workers, not a setting that pins a model, and Dig does not check that the account offers the model named.

## 5. Explain the remaining steps

For each enabled source that still needs something, give the exact step. The user does these themselves.

- **API keys:** Dig takes credentials only from the `keys.env` file at `keysPath`, one `NAME=value` line each; a key exported in the environment that starts Codex is not used unless the user copies it. On Dig's Sources page, each source's **Setup details** (a fold on its card) shows when Codex's environment has a key Dig is not using: **Use existing key** copies it into `keys.env`, and **Update key from env** replaces a different value already there. **Edit keys.env** adds an empty `NAME=` line for each of that source's credential names the file lacks and asks Codex to open the file; the user fills in the values and saves. The page's **Accounts and keys** section, through its **Where to get each key** fold (closed by default), links each provider's page for creating or finding a key. Dig reloads `keys.env` when it is saved, so no restart is needed; Dig keeps the file private (mode 600), and a file the user created should stay private (`chmod 600` on macOS and Linux). Name the exact variable from `credentials`. **Never ask for a key, accept one pasted into chat, print one, or write the file with a key in it.** If the user pastes a key anyway, tell them not to and suggest rotating it.
- **YouTube:** `yt-dlp` must be installed by the user (for example `brew install yt-dlp`). Current yt-dlp also needs a JavaScript runtime for full YouTube support: Deno (its default) or Node 22 or newer. An optional Google key adds Data API search metadata. Dig never installs executables or reads browser cookies.
- **Papers bridge:** federated search, full text and PDF download need `git`, `uv` and the optional bridge. The setup command appears in the `detail` of the Papers prerequisite named "Papers bridge and uv"; a separate `git` prerequisite says whether git, which setup needs to clone the bridge, is installed (searches do not use it, so it does not change readiness). Offer to run setup only after the user says yes: run it with `--help` first, then run it without `--live-smoke`. Pass `--email` only with an address the user gives you for Unpaywall.
- **Unpaywall contact email (Papers, optional):** Unpaywall, one of the Papers bridge's federated search sources, looks up legal free copies of papers by DOI and is skipped without a contact email. `source_info` lists it under the Papers source's `envSettings` as `PAPER_SEARCH_MCP_UNPAYWALL_EMAIL`, with whether it is set. The user adds it as a `keys.env` line (Papers' **Edit keys.env** adds the empty line), or passes `--email` to the bridge setup above. It is not a secret, but the user still writes it themselves; never infer or copy an address.
- **GitHub (login optional):** say plainly what it loses without one, then offer the two fixes as optional. Without a login, GitHub allows 60 REST calls an hour per IP address instead of 5,000 and repository search at 10 a minute instead of 30; one repository inspection takes roughly 6–8 REST calls, so fewer than ten inspections fit in an anonymous hour. Inspections also lose their merged-PR review and issue first-reply samples, which come from GitHub's GraphQL API and need a login; the rest still runs. Fix one: a GitHub personal access token as `GH_TOKEN` (or `GITHUB_TOKEN`) in `keys.env` as above; a classic token with no scopes selected is enough, because Dig reads only public data, while a fine-grained token may be refused those samples for repositories its owner does not own. Fix two: `gh auth login`, which the user runs in a terminal; Dig asks `gh` for its token when `keys.env` has no GitHub token. Readiness does not check a `gh` login; the first search or inspection says which login it used or that it ran anonymously.
- **DataForSEO:** `DATAFORSEO_USERNAME` (the API login, usually the account email) and `DATAFORSEO_PASSWORD` (the API password from the API Access page of DataForSEO's dashboard), both in `keys.env` as above.

## 6. Finish

Call `source_info` again and summarize what is now ready and what still waits on the user. Then call `open_library` once so the user sees where saved research appears. If setup started in the middle of another task, return to that task.

Report failures plainly: a refused tool call, a failed update or a missing prerequisite is reported as exactly that, never smoothed over.
