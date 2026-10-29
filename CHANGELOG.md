# Changelog

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
