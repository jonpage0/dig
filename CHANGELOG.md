# Changelog

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
