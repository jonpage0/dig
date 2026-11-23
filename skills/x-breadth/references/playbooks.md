# X breadth worked playbooks and operator reference

Read this reference via `method({ name: "x-breadth", file: "references/playbooks.md" })` when you need exact JSON call shapes, X API vs Grok operator tables, or `xsearch` chaining and recovery mechanics. Every JSON example below calls the `x` tool.

## Worked multi-pass sequence

Allocate cheap direct retrieval first and reserve Grok passes (at most four per run) for semantic discovery and targeted video reads:

1. **`pass-1` (+ `pass-1b`): Cheap historical baseline (>24 h)** via `x_web_search` (when `SCRAPECREATORS_API_KEY` is set; paginate with `cursor` pages 1–11):

```json
{ "dig": "<dig>", "action": "x_web_search", "args": { "query": "<topic keywords>" } }
{ "dig": "<dig>", "action": "x_web_search", "args": { "query": "<topic keywords>", "cursor": "2" } }
```

2. **`pass-2` & `pass-3`: Exact X API slices** — recent relevancy, plus archive, non-English (`lang:`), or visual (`has:media`) slices:

```json
{ "dig": "<dig>", "action": "x_search_posts", "args": { "query": "(<term A> OR <term B>) -is:nullcast", "sort": "relevancy", "limit": 50 } }
{ "dig": "<dig>", "action": "x_search_posts", "args": { "query": "(<term A> OR <term B>) has:media -is:nullcast", "archive": true, "start_time": "2026-09-01T00:00:00Z", "sort": "relevancy", "limit": 100 } }
```

3. **`pass-4`: Semantic lead discovery** via `xsearch` (`mode: "semantic"`, `media` off, auto-`quick`):

```json
{ "dig": "<dig>", "action": "xsearch", "args": { "query": "Surface distinct camps, slang, complaints, and practitioner threads about <topic>.", "mode": "semantic", "passLabel": "pass-4", "fromDate": "2026-09-01", "toDate": "2026-11-23" } }
```

4. **`pass-5`+: Feed discovered handles/terms into X's API, expand dominant threads, verify leads, and pull useful visuals** (`x_images` with `size: "large"` for photos; targeted `xsearch` with `media: true`, `depth: "quick"` on 1–5 video links):

```json
{ "dig": "<dig>", "action": "x_search_posts", "args": { "query": "(<new term> OR from:<discovered_handle>) -is:nullcast", "sort": "recency", "limit": 50 } }
{ "dig": "<dig>", "action": "x_search_posts", "args": { "query": "quotes_of_tweet_id:<dominant_post_id>", "sort": "relevancy", "limit": 50 } }
{ "dig": "<dig>", "action": "x_post", "args": { "posts": ["https://x.com/handle/status/123"] } }
```

**Checks:** skip `x_web_search` for events <24 h old; keep X API operators (`min_likes:N`, `has:media`) separate from Grok (`min_faves:N`, `filter:media`); omit `end_time` for "through now"; set `toDate` to the day *after* the last UTC day wanted.

## X API vs Grok operator & parameter reference

| Capability | `x_search_posts` / `x_count_posts` (X API) | `xsearch` (Grok X search) |
| --- | --- | --- |
| Ordering | `sort: "recency"` (window coverage) or `"relevancy"` (posts that carried an angle) | Synthesized search; returns links rather than full fetched set |
| Date window | Recent 7 days; `archive: true` with `start_time`/`end_time` back to 2006 (`x_count_posts` with `archive: true` needs `start_time`); omit `end_time` for "through now" | `YYYY-MM-DD` `fromDate` (inclusive 00:00 UTC) and `toDate` (exclusive 00:00 UTC) |
| Accounts & threads | `from:`, `to:`, `url:`, `conversation_id:`, `in_reply_to_tweet_id:`, `quotes_of_tweet_id:` | `handles`, `excludeHandles` arguments |
| Engagement filters | `min_likes:N`, `min_replies:N`, `min_reposts:N` (`min_faves`/`min_retweets` fail in X's API) | `min_faves:N`, `min_retweets:N` |
| Content & language | `lang:xx`, `has:media`, `is:reply`, `is:quote`, `-is:nullcast`, parentheses `(...)`, `OR` | `filter:media`, `lang:xx` |

- **Reposts since May 4, 2026:** X's search leaves reposts out of keyword matches, though a `from:` search still returns an account's reposts; say so when amplification matters, and use `x_post` with `reposters` for who reposted a post.
- **Volume mapping:** `x_count_posts` gives each angle's volume by hour or day (`granularity`; with `archive: true` it needs a `start_time`), showing where discussion concentrated and which windows to search; report counts as volume, never as posts you read.
- **Communities & people search:** People search (`x_users` with `query`) needs optional X sign-in keys. Community search (`x_explore` with `kind: "communities"`) uses them or, without them, TikHub. `x_community` reads a Community's details (X's API, or TikHub without `X_BEARER_TOKEN`) and posts (`sort: "recent"` for coverage, `"relevant"` for what carried, via TikHub with `TIKHUB_API_KEY`); give each Community its own labeled pass and name it in `## Coverage`.
- **Dominant threads:** Expand with `x_post` (`replies`, `quotes`) or `x_search_posts` (`conversation_id:<id>`, `quotes_of_tweet_id:<id>`). Report the observed limit and recovery query.

## Grok `xsearch` depth, chaining, and stream recovery

- **Settings & pass cap:** Grok's xAI model, starting depth and web search come from the user's `[x]` settings; each completed `xsearch` pass prints the model, mode, depth, media state, active X tools, and `Posts fetched` / `Users fetched` when reported. Leave `enableWebSearch` out unless the assignment explicitly asks to add web results (`true`) or keep them out (`false`). Do not invent a result cap or unlisted flags.
- **Depth rules:** Run at most four `xsearch` passes per run, with `depth: "max"` at most once (final sweep if angles remain uncovered); prefer `mode: "semantic"` (2–4 semantic search calls, auto-`quick`, staying well under xAI's 200k-token cliff) and `depth: "quick"` for routine or targeted-video passes. When the user's `[x]` depth is `max` or `ultra`, ordinary passes without `depth` run at that depth (`mode: "semantic"` still defaults to `quick`) and only the four-pass limit applies.
- **Chaining & recovery:** Chain with `previousResponseId` when refining one angle on standard passes (`mode: "semantic"` starts fresh) and start fresh when pivoting. If a stream cuts with a response id, first call `xsearch` with the same `query` and `recoverResponseId` (free, same pass); if xAI holds nothing under that id, the pass was dropped and rerunning counts as a new pass.
- **Verification:** A Grok-cited post enters the inventory once `x_post` reads it; label Grok's media descriptions as Grok's and verify key details against the original clip when possible.
