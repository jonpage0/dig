# X judge worked playbooks and operator reference

Read this reference via `method({ name: "x-judge", file: "references/playbooks.md" })` when you need exact JSON call shapes, X API vs Grok operator dialect tables, or `xsearch` chaining and recovery mechanics. Every JSON example below calls the `x` tool.

## Worked playbooks

### 1. Historical discourse + screenshots (>24 h)

Lead with `x_web_search` and `x_search_posts`, run one semantic `xsearch` pass for paraphrases/leads, then verify load-bearing posts with `x_post` and inspect screenshots with `x_images`:

```json
{ "dig": "<dig>", "action": "x_web_search", "args": { "query": "<topic terms>" } }
{ "dig": "<dig>", "action": "x_search_posts", "args": { "query": "\"<exact term>\" -is:nullcast lang:en", "sort": "relevancy", "limit": 50 } }
{ "dig": "<dig>", "action": "xsearch", "args": { "query": "Find practitioner posts and dissent on <topic>; list key handles, phrasing, and post links.", "mode": "semantic", "passLabel": "pass-1", "fromDate": "2026-10-01", "toDate": "2026-11-23" } }
{ "dig": "<dig>", "action": "x_post", "args": { "posts": ["https://x.com/handle/status/123"], "thread": true, "quotes": 15 } }
{ "dig": "<dig>", "action": "x_images", "args": { "images": ["https://pbs.twimg.com/media/EXAMPLE.jpg"], "size": "large" } }
```

### 2. Breaking (<24 h) claim & volume

Skip `x_web_search` (indexing lags); measure volume with `x_count_posts`, search relevancy with `x_search_posts`, and verify the primary thread and author with `x_post` and `x_users`:

```json
{ "dig": "<dig>", "action": "x_count_posts", "args": { "query": "\"<claim or product>\"", "granularity": "hour" } }
{ "dig": "<dig>", "action": "x_search_posts", "args": { "query": "\"<claim or product>\" -is:nullcast", "sort": "relevancy", "limit": 50 } }
{ "dig": "<dig>", "action": "x_post", "args": { "posts": ["https://x.com/primary/status/456"], "thread": true, "replies": 20, "quotes": 20 } }
{ "dig": "<dig>", "action": "x_users", "args": { "handles": ["primary"], "posts": 10 } }
```

### 3. Video post / demo check

Read the post and quotes with `x_post`, then target **only the 1–5 video links** in `xsearch` (`media: true`, `depth: "quick"`; follow a returned job handle with `job({ id })`):

```json
{ "dig": "<dig>", "action": "x_post", "args": { "posts": ["https://x.com/handle/status/789"], "thread": true, "quotes": 15 } }
{ "dig": "<dig>", "action": "xsearch", "args": { "query": "Inspect the video in https://x.com/handle/status/789. Describe what happens, quote on-screen text verbatim, and note anything unclear.", "media": true, "depth": "quick", "passLabel": "pass-1" } }
```

## X API vs Grok operator & parameter reference

| Capability | `x_search_posts` / `x_count_posts` (X API) | `xsearch` (Grok X search) |
| --- | --- | --- |
| Account filters | `from:`, `to:` | `handles`, `excludeHandles` arguments |
| Date window | ISO timestamps `start_time`, `end_time` (omit `end_time` for "through now"); recent 7 days, or `archive: true` back to 2006 (up to 500/page) | `YYYY-MM-DD` strings `fromDate` (inclusive 00:00 UTC) and `toDate` (exclusive 00:00 UTC — use next day to include a UTC date) |
| Engagement thresholds | `min_likes:N`, `min_replies:N`, `min_reposts:N` (`min_faves`/`min_retweets` fail in X's API) | `min_faves:N`, `min_retweets:N`, `min_replies:N` |
| Media & links | `has:media`, `has:links`, `url:` | `filter:media` (keep `media` argument off on broad passes) |
| Thread & post type | `conversation_id:`, `in_reply_to_tweet_id:`, `quotes_of_tweet_id:`, `is:reply`, `is:quote`, `is:verified`, `-is:nullcast` | Natural-language angle plus URLs/handles |
| Language & grouping | `lang:xx`, parentheses `(...)`, `OR` | `lang:xx` |
| Ordering & yield | `sort: "relevancy"` (what carried) or `"recency"` (latest); returns 100% of billed posts | Synthesized search; fetches many posts internally while linking a fraction |

- **Reposts since May 4, 2026:** X search omits reposts from keyword matches, though `from:` still returns an account's reposts.
- **Empty thresholds:** Operators constrain candidates but do not prove relevance; record empty threshold results in `## Negative Evidence (when relevant)` instead of silently loosening them. Report ignored Grok operators explicitly.
- **Additional X API discovery actions:**
  - `x_news`: finds an X News story on the topic (`query` with `max_age_hours` and `limit`, or one story by `id`).
  - `x_explore`: reaches trends (by `woeid`), Spaces (by `state`), Communities (`kind: "communities"` — uses X sign-in keys or, without them, TikHub), and Lists (by `list`).
  - `x_community`: reads a Community's details (X's API, or TikHub without `X_BEARER_TOKEN`) and posts (TikHub with `TIKHUB_API_KEY`); quote posts like any other and still verify load-bearing ones with `x_post`.
  - `x_users` & `x_follows`: `x_users` (`mentions` adds recent posts naming it; people search with `query` needs optional X sign-in keys) checks account standing; `x_follows` shows whom it follows and who follows it (every listed account is an account read, so request a small page).

## Grok `xsearch` depth, chaining, and stream recovery

- **Settings & depth:** Grok's xAI model, starting depth and web search come from the user's `[x]` settings; each completed `xsearch` pass prints the model, mode, depth, media state, active X tools, and `Posts fetched` / `Users fetched` when reported. Leave `enableWebSearch` out unless the assignment explicitly asks for non-X corroboration (`true`) or to keep web results out (`false`). Do not invent result caps or unlisted flags.
- **Configured `max`/`ultra`:** When the user's `[x]` depth is `max` or `ultra`, ordinary passes without `depth` run at that depth (`mode: "semantic"` still defaults to `quick`) and only the three-pass limit applies.
- **Chaining:** Label passes `passLabel: "pass-1"` onward. Chain with `previousResponseId` only while refining one angle on standard passes (`mode: "semantic"` starts fresh); start fresh when pivoting and never chain from `max`/`ultra`.
- **Stream recovery:** If a stream cuts with a response id, first call `xsearch` with the same `query` and `recoverResponseId` (free, same pass). If xAI holds nothing under that id, the pass was dropped and rerunning counts as a new pass.
- **Verification rule:** A Grok-cited post is a lead until `x_post` reads it; label Grok's media descriptions as Grok's and verify key claims against the original clip when possible.

## Avoid

- Opening with broad `xsearch` (`media: true`) or `depth: "max"`.
- Mixing operator dialects (`min_likes:N`/`has:media` for `x_search_posts` vs `min_faves:N`/`filter:media` for `xsearch`).
- Passing ISO timestamps to `fromDate`/`toDate` or future timestamps to `end_time`.
- Spending `xsearch` (`media: true`) on still photos instead of free `x_images`.
