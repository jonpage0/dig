# X post worked playbooks and operator reference

Read this reference via `method({ name: "x-post", file: "references/playbooks.md" })` when you need exact JSON call shapes, X API search operators, or media and Grok follow-up patterns. Every JSON example below calls the `x` tool.

## Worked post-inspection sequence

1. **Read the supplied post(s), author thread, and initial reactions** (add `reposters: 25` when who amplified it matters; for viral posts, follow with `x_search_posts` using `conversation_id:<id>` or `quotes_of_tweet_id:<id>` and `sort: "relevancy"`):

```json
{ "dig": "<dig>", "action": "x_post", "args": { "posts": ["https://x.com/author/status/123"], "thread": true, "replies": 20, "quotes": 20 } }
```

2. **Check the author's standing and recent pattern** (add `x_follows` with a small `limit` only when the author's place in a field matters, since every listed account is an account read):

```json
{ "dig": "<dig>", "action": "x_users", "args": { "handles": ["author"], "posts": 15, "mentions": 10 } }
```

3. **Inspect useful media immediately** — free `x_images` (`size: "large"` for screenshots/charts) on returned `Media:` photo URLs, and a targeted `xsearch` (`media: true`, `depth: "quick"`) naming only the 1–5 video post links when the post's substance is in a video:

```json
{ "dig": "<dig>", "action": "x_images", "args": { "images": ["https://pbs.twimg.com/media/EXAMPLE.jpg"], "size": "large" } }
{ "dig": "<dig>", "action": "xsearch", "args": { "query": "Describe what the video in https://x.com/author/status/123 shows, quote on-screen text verbatim, and note anything unclear.", "media": true, "depth": "quick", "passLabel": "pass-1" } }
```

4. **Measure spread and hunt earlier origin** (omit `end_time` on `x_count_posts` to count through now; pass `end_time` before the post's timestamp on `x_search_posts` to find earlier instances; add `x_web_search` for cheap historical mentions >24 h old when `SCRAPECREATORS_API_KEY` is set):

```json
{ "dig": "<dig>", "action": "x_count_posts", "args": { "query": "\"<distinctive phrase or url>\"", "granularity": "hour" } }
{ "dig": "<dig>", "action": "x_search_posts", "args": { "query": "\"<distinctive phrase or url>\"", "archive": true, "end_time": "2026-11-10T14:00:00Z", "sort": "recency", "limit": 25 } }
```

## X API operator & context reference

| Operator / Parameter | Usage |
| --- | --- |
| `conversation_id:<id>`, `in_reply_to_tweet_id:<id>`, `quotes_of_tweet_id:<id>` | Pull the highest-relevancy replies or quotes for viral posts (`sort: "relevancy"`). |
| `from:`, `to:` | Account-scoped search (including an account's reposts via `from:`). |
| `url:`, `has:links`, `has:media` | Find earlier or parallel posts sharing the same link or visual evidence. |
| `is:reply`, `is:quote`, `is:verified`, `lang:xx` | Slice reactions by post type, verification, or language. |
| `min_likes:N`, `min_replies:N`, `min_reposts:N` | Filter high-volume noise (with parentheses `(...)` and `OR`). |
| `archive: true`, `start_time`, `end_time` | Recent search covers 7 days; `archive: true` reaches back to 2006 (`x_count_posts` with `archive: true` requires `start_time`). Omit `end_time` for "through now". |
| `x_news` | `query` with `max_age_hours` and `limit`, or `id` for one X News story clustering the post. |
| `x_community` | Details (X's API, or TikHub without `X_BEARER_TOKEN`) and recent posts (TikHub with `TIKHUB_API_KEY`) when the post sits inside an X Community. |

- **Reposts since May 4, 2026:** X's search leaves reposts out of keyword matches (a `from:` search still returns an account's reposts), so `x_post` with `reposters` is how to see who amplified a post.
- **Wider Grok conversation (only when asked):** Run `xsearch` with `media` off (`mode: "semantic"` for fast semantic leads, or `depth: "quick"` / user's `[x]` depth for synthesis; completed passes report `Posts fetched` / `Users fetched` when xAI returns them) and label what it returns as Grok's account. Read any post Grok cites with `x_post` before quoting it.
- **Links off X:** Name links in the post without reading them; reading external destinations needs another source chosen by the parent.
