# Dig

Dig is a research plugin for Codex in the ChatGPT desktop app. Ask a question and Dig searches the sources you choose (web search, GitHub, papers, YouTube, X, Reddit, Hacker News, prediction markets and more), writes a report for each source, and keeps the original responses so you can check every claim. Everything is saved in a library on your computer that you can browse and search from Dig's sidebar view.

## What you need

- The ChatGPT desktop app with Codex. Dig has been tested on macOS.
- [Node.js](https://nodejs.org) 22 or newer (`node --version` to check).
- API keys for the sources you want to use. Hacker News needs none, so you can try Dig before setting up anything else.

## Install

Run these two commands in a terminal:

```sh
codex plugin marketplace add jonpage0/dig
codex plugin add dig@dig
```

If your terminal doesn't know `codex`, use the copy inside the ChatGPT app: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`.

Then quit and reopen ChatGPT.

## Set up

In a new conversation, type `$dig:setup`. It walks you through choosing sources and says what each one still needs.

Keys go in a file on your computer, never in the chat. On Dig's **Sources** page, **Edit keys.env** opens that file with an empty line for each key; paste your keys after the `=` signs and save. **Where to get each key**, at the top of the same page, links to the page where each service gives you one. [docs/sources.md](docs/sources.md) has the details for each source.

## Use

- **Ask a research question** normally, and Dig picks the sources.
- **Run one method directly** by typing `$dig:` and choosing one, for example `$dig:reddit` or `$dig:x-judge`.
- **Open Dig** from the sidebar to read reports, the original responses behind them, and what each search cost.
- **Attach saved research** to a new question by typing `@` in the composer.

## Update

```sh
codex plugin marketplace upgrade dig
```

Then quit and reopen ChatGPT.

## Privacy and costs

- **Local:** Dig runs entirely on your computer. It has no server of its own and collects nothing.
- **What leaves your computer:** your questions go only to the services you turn on, using your own keys.
- **Where things are kept:** your research, settings and keys stay in `~/.local/share/dig`.
- **Costs:** each service bills you directly. Dig shows the cost each one reports for every search; when a service doesn't report one, Dig shows the cost as unknown rather than guessing.

## Uninstall

```sh
codex plugin remove dig@dig
codex plugin marketplace remove dig
```

Your research stays in `~/.local/share/dig` until you delete that folder.

## Development

```sh
npm install
npm run check   # build and offline tests
npm run smoke   # one live, keyless Hacker News search in a throwaway folder
```

To install a local checkout instead of GitHub: `codex plugin marketplace add /path/to/dig`. How Dig works, and the rules it keeps, are in [docs/architecture.md](docs/architecture.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
