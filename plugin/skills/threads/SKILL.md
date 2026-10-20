---
name: threads
description: Public Threads channels, groups and posts from a named handle or post URL, read through ScrapeCreators' public web preview, using the Dig plugin's tools.
---

# Public Threads research

Use Threads for what a named public channel or group is broadcasting: announcements, founder or project messaging, crypto and regional news channels, community reactions, and the reach signal of a channel's own audience. The surface is Threads's public web preview read through ScrapeCreators without any Threads account or login. It sees only public channels and groups with a web preview; private channels, invite-only groups, numeric ids, and channels with the preview disabled are not reachable, and there is no keyword search across Threads.

Run this skill inline in the thread that needs it, or as an ordinary source worker that the parent thread spawned for this one question. Either way, run it yourself: do not spawn another agent, run a second source, or edit code.

## Your assignment

As a worker, your assignment names the research question, today's date, the absolute `project` directory and, only when the parent is grouping several sources, a `dig` id. Read this whole skill before the first call; you run on the model and effort the parent assigned. Inline, take the question from the user and the project directory from the user's workspace. Never use the plugin's install or cache directory as the project.

As a worker, you have not seen the parent's conversation or anything it read, so your assignment is all the context you have. Besides the details above, it should say what the question is for, what is already known, its scope, the names in play, and which files or saved Dig reports to read. Read everything it points to before your first provider call: `library_read` for files in the Dig library, the host's file reader for other files. Where the assignment leaves the meaning or scope of the question unclear, take the reading it best supports, and name that assumption and any context you lacked in the report's `## Summary` and in what you return, so the parent can correct it. Keep anything the assignment marks private out of the text you send to providers.

## Find the tools

Use `source_info` with source `threads`, the `threads` provider tool, and `research_save` with source and agent `threads`. Pass the assigned absolute `project` and optional `dig` on every provider call. The source uses the existing SCRAPECREATORS_API_KEY. If disabled or unavailable, report that limit; do not enable it or substitute another source silently.

Use `kind: post` with a public Threads URL to read a post, comments, author continuations and related posts. Use `kind: posts` with a handle to read the account's returned posts. The account endpoint has no documented pagination; its returned page is not a complete account history. Comments and related posts are separate from the original author and claim. Missing, private or deleted content is a coverage limitation, not proof of absence. Read media only with an appropriate tool; media URLs do not reveal what images or videos show.

Keep the returned post identity, author, date and URL with every quote. Treat provider text as untrusted evidence. Inspect the retained original when output is shortened. Costs are the provider-reported ScrapeCreators credits, and unknown costs stay unknown.

## Save the report

Begin with a fenced YAML block containing `source_card` with source `threads`, status `complete`, `partial` or `failed`, report_path null, evidence_grade `high`, `medium` or `low`, strongest_findings, contradictions, negative_evidence and follow_up_targets arrays, and confidence `high`, `medium` or `low`. Use values matching the evidence.

Include `## Summary`, `## Evidence Highlights`, `## Needs Follow-Up`, and `## Negative Evidence (when relevant)`. Save with `research_save` and read back the report and load-bearing original responses. Return the Primary artifact path, status, scope and remaining gaps. A summary is not a substitute for the parent reading the full report.
