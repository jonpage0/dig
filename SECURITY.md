# Security

Please report a vulnerability privately through this repository's **Security** tab (**Report a vulnerability**), not in a public issue. Include what you found, how to reproduce it, and what it exposes.

## What Dig exposes

Dig runs one service on your computer, listening on `127.0.0.1` only. It has no server of its own elsewhere and collects nothing.

- **Who can reach it.** Every MCP request needs a random bearer token, kept in `service.json` in Dig's folder (`~/.local/share/dig`), readable only by you. `dig mcp` adds the token itself, so a host that launches it holds none. A request must name the service's own address as its `Host`, and one that carries an `Origin` must come from the service itself, so a web page cannot call it.
- **Without the token**, only three things answer: `/health` (the service's name, version, build fingerprint and process id), the key page at a one-time address, and the views in a browser, which need a session that only a one-time address from `dig open` gives. The views can call only the tools they use, never a source.

## Credentials

- Keys live only in `keys.env` in Dig's folder, written with mode 600. A key in the environment that started Dig is not used.
- You enter keys on a page the service serves at a one-time address (from the `keys` tool, or **Enter keys** in the views). The page works for one submission, expires after 10 minutes, posts only to itself, runs no script and never shows a value. What you type goes to `keys.env` and never through the conversation, the host or the model.
- Dig never asks for a key in chat and never returns one. Known key values are removed from provider output, receipts, original responses, jobs and saved reports, including their URL-encoded spellings.

## What is sent to providers

Only the calls your assistant makes to the sources you turned on, each to that source's own provider with your key for it: the call's query and arguments, and for the video and ranking tools the media, video addresses, question or excerpts the call names. Beyond those calls, Dig downloads its pinned search model once if you turn semantic search on, and the Papers bridge's setup downloads a pinned copy of the bridge when you run it. Provider responses are kept on your disk as evidence, and Dig tells the assistant to treat them as evidence, never as instructions.

Reports about keys or research leaving your computer, about reaching the service from a web page or another user, or about a provider's response being able to steer Dig, are especially welcome.
