# X trace worked playbooks and operator reference

Read this reference via `method({ name: "x-trace", file: "references/playbooks.md" })` when you need exact JSON call shapes, a worked 3-round trace within the default read budget, or X API operator and media/Grok call patterns. Every JSON example below calls the `x` tool.

## Worked 3-round trace (within the default 300 post / 60 account budget)

- **Round 1 — Read the seed and surface substantive replies/quotes:**

```json
{ "dig": "<dig>", "action": "x_post", "args": { "posts": ["https://x.com/seed_author/status/123"], "thread": true, "replies": 30, "quotes": 20 } }
```

If starting from an unlinked claim instead of a post URL, find seeds with `x_web_search` for historical claims >24 h old (when `SCRAPECREATORS_API_KEY` is set) or `x_search_posts` for recent/exact terms; spend your single allowed `xsearch` pass with `mode: "semantic"` (leaving `media` off) only when the wording cannot be guessed.

- **Round 2 — Batch-check who the substantive voices are, plus early track record on the key 1–2 accounts** (chosen for specific detail, dissent, or author engagement — never likes):

```json
{ "dig": "<dig>", "action": "x_users", "args": { "handles": ["voice_a", "voice_b", "voice_c"], "posts": 10 } }
{ "dig": "<dig>", "action": "x_search_posts", "args": { "query": "from:voice_a (<topic term>)", "archive": true, "end_time": "2026-10-01T00:00:00Z", "limit": 20 } }
```

- **Round 3 — Follow shared links across threads, verify origin timing, and check network standing only on accounts that decide the answer:**

```json
{ "dig": "<dig>", "action": "x_search_posts", "args": { "query": "url:\"example.com/report\"", "sort": "relevancy", "limit": 25 } }
{ "dig": "<dig>", "action": "x_count_posts", "args": { "query": "\"<distinctive phrase>\"", "archive": true, "start_time": "2026-10-01T00:00:00Z", "granularity": "day" } }
{ "dig": "<dig>", "action": "x_follows", "args": { "handle": "voice_a", "direction": "following", "limit": 25 } }
```

- **Media inspection when load-bearing** — inspect screenshots immediately with free `x_images` (`size: "large"`), or inspect 1–5 specific video post links with your single allowed `xsearch` pass (`media: true`, `depth: "quick"`, `passLabel: "pass-1"`):

```json
{ "dig": "<dig>", "action": "x_images", "args": { "images": ["https://pbs.twimg.com/media/EXAMPLE.jpg"], "size": "large" } }
{ "dig": "<dig>", "action": "xsearch", "args": { "query": "Inspect the video in https://x.com/seed_author/status/123. Describe what happens, quote on-screen text verbatim, and note anything unclear.", "media": true, "depth": "quick", "passLabel": "pass-1" } }
```

## Operator & budget-sizing reference

| Task | Action & pattern | Budget / billing note |
| --- | --- | --- |
| Read seed thread & reactions | `x_post` with `thread: true`, sized `replies` / `quotes` | Reading a wide reply section is cheaper than reading many profiles; X dedupes reads per UTC day. |
| Batch-read candidate profiles | `x_users` with multiple `handles` in one call; add `posts` (and `mentions`) only for the few whose standing decides the answer | Each account returned counts toward the ~60 account-read default budget. |
| Check early track record | `x_search_posts` with `from:<handle>` + topic words, `archive: true`, `end_time` before the topic went mainstream | Shows whether a voice arrived early or joined the crowd. |
| Follow shared link across threads | `x_search_posts` with `url:"<link>"` | Finds parallel conversations that share no keywords. |
| Trace strand origin | `x_count_posts` (`granularity: "day"`, `archive: true` needs `start_time`), then `x_search_posts` over that first day | Separates one original source from ten accounts repeating it. |
| Check network standing | `x_follows` (`direction: "following"` for community peers; `"followers"` for audience) | Most expensive single call (every listed account is an account read); keep `limit` small and use only on decisive accounts. |
| Communities & Lists | `x_community` and `x_explore` (`kind: "communities"` or `list`) | Use when the trail leads into an X Community or List. |
| One-off Grok pass (max 1) | `xsearch` (`mode: "semantic"`, `media` off) for unguessable claim seeds, OR (`media: true`, `depth: "quick"`) on 1–5 video links | Slow (follow a job handle with `job({ id })`); completed passes report `Posts fetched` / `Users fetched` when returned. Any Grok-cited post is a lead until `x_post` reads it. |

- **Stream recovery (`recoverResponseId`):** When an `xsearch` pass fails saying its stream was cut, read it once with `recoverResponseId` set to the response id it names (free, same pass). If xAI holds nothing under that id, the pass was dropped, and sending it again counts as a new pass.

## Voice-weighing rubric & report-section notes

When weighing voices in `## Who Is Speaking`:

- **Proximity:** Did they build, measure, or witness it first-hand, or repeat someone else? First-hand and specific outranks second-hand and general regardless of follower count.
- **Standing in the subject:** What their profile and recent posts show they actually work on (authoritative in one field does not transfer automatically to another).
- **Track record:** Whether they posted about the subject before it went mainstream and whether earlier claims held up where checkable.
- **Stake:** What they gain if believed (selling, competing, employment, position, audience growth); state beside the claim without treating stake as proof of falsity.
- **Independence:** Original voice vs echo tracing back to another account's post.
- **Specificity and checkability:** Names, numbers, versions, steps, primary links; vague certainty weighs little.
- **Conduct in the conversation:** Whether they answer challenges, show their working, and correct themselves.
- **Patterns, not labels:** Describe observed patterns (e.g., recently created account, repeated near-identical replies, single-purpose promotional bio) and what they suggest; never call an account fake, paid, or automated without evidence, never attempt to unmask anonymous accounts or infer private life, and route external affiliation checks to `## Needs Follow-Up`.

For report sections:

- `## Trace Method`: seeds, one line per round (what was read and why the next step was chosen), budget and actual post/account reads used (from receipts or running totals), and any Grok pass.
- `## Who Is Speaking`: table with columns `Account | Who they are, and how that is known | Stake | What they said (link) | Weight and why` covering every voice the answer rests on, strongest dissent included.
- `## What the Conversation Establishes`: what holds, what is contested, and what is only repeated, each tied to voices and claim class.
- `## Strands and Origins`: each distinct claim traced to its earliest post found, with repeater count.
- `## Leads Not Followed`: accounts, threads, and links left unread and why (budget, access, out of scope), or `None.`.
