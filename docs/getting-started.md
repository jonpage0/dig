# Start here

Dig helps your assistant research a question across the web, software projects, papers, social posts, videos and other services. It saves research so you can inspect the evidence, ask follow-up questions and return to it later.

You ask in your normal conversation. Dig's interface is where you explore its capabilities, choose sources, read saved research and see usage.

## Your first research question

1. **Choose a place to look.** Open **Sources & tools** to see what's available and what needs setup. You only need to configure the sources you want. Hacker News, DeepWiki and Polymarket need no account; other sources may need a provider account, key or local tool. `$dig:setup` in the conversation can explain the choices.
2. **Ask a useful question.** Say what you want to learn, who or what matters, and any relevant place, time period or limit. You can name a source or let your assistant choose from the enabled sources.
3. **Read the result and its evidence.** Open the saved report, inspect the original response behind an important finding, and ask a follow-up in the same conversation.

For example:

> Use Dig and Hacker News to research how developers approach local-first software. Explain the strongest arguments, include contrary experiences, and save the report with links to the original discussions.

## What you can explore

| Your question | Useful capabilities |
| --- | --- |
| “What do reliable sources say about this?” | Find web pages, read page text, explore related pages and compare claims. |
| “Which software project fits our needs?” | Discover repositories, inspect code and activity, ask questions about a public codebase, and compare developer discussion. |
| “What does the research show?” | Find papers, follow citations and related work, and read available full text or PDFs. |
| “What are people actually experiencing?” | Inspect public posts, threads, replies and accounts across supported social platforms. Separate anecdotes from corroborated findings. |
| “What happens in this video?” | Find videos, read transcripts, or use optional video analysis to examine demonstrations, visuals and selected moments. |
| “How could people find our website?” | Explore search results, keywords, competitors and AI-answer visibility, then compare cited or competing pages with your own page to suggest concrete improvements. |
| “What advertising and product patterns can we learn from?” | Inspect available public ad creatives, product details, reviews and supported price history. An ad's presence does not reveal its business results. |
| “What do prediction markets expect?” | Inspect available probabilities, trading activity and price history. Market prices express participants' beliefs rather than establish facts. |

The **Start here** tab includes a directory derived from the installed source catalog. **Sources & tools** adds the setup requirements, current local readiness and cost guidance for each one. Coverage varies by service; an enabled source is not a promise that every item or operation is accessible.

## How it works

**You ask a question.** Your assistant identifies what evidence would help and selects useful sources. It can work directly or divide the research among focused helpers.

**The sources return information.** A source might return web pages, posts, video transcripts, search data or another kind of evidence. Dig records the retrieval and any reported provider usage. Original responses are kept when retention is enabled and capture succeeds.

**Your assistant checks and explains it.** It reads the source reports and important originals, separates observations from interpretation, and describes agreements, contradictions and gaps. A saved report or a confident model answer is not proof that a claim is true.

**The research stays available.** Reports live in your selected library. You can reopen them, ask Dig to find earlier work, or request a fresh look when the information is out of date.

## What the different pieces mean

- **Source:** where the information comes from, such as GitHub, YouTube or a search service.
- **Retrieval or call:** one recorded use of a Dig research or analysis tool. It may make several requests to its provider; several calls may contribute to a report.
- **Report:** saved findings from a research method, including its evidence and limitations.
- **Answer:** a saved explanation that brings selected source reports together.
- **Original response:** the information returned by the provider, retained when enabled. It helps you check what the provider actually returned.
- **Insight card:** a compact presentation of a finding, comparison or next step, with links to evidence and the full report. It does not add proof to the underlying research.
- **Library:** saved research across projects. **Research trail** shows the work associated with the current conversation.

Ask, “Use Dig to find what we already researched about [topic],” or invoke `$dig:library`. Reusing a saved report does not make its information current; ask for a refresh when that matters.

## Optional tools that help with the evidence

**Video understanding** can add information that a transcript misses, such as an on-screen demonstration. YouTube's deeper-analysis method uses Gemini; Glimpse is available for focused visual inspection. Give a clear question and, where useful, a time range. Exact speech, timestamps and model interpretations still need checking.

**Evidence ranking** uses TypeSafe Jev to suggest which supplied excerpts to read first and how they relate to a claim. It keeps every candidate available. A high score is reading advice, not a fact-check.

These helpers require their own setup and may cost money. Enabling them makes them available; it does not run them automatically.

## Understanding costs

Some providers report dollars, some report credits, and some report no price for the call. Dig preserves those distinctions:

- Dollar amounts and each provider's credits stay in their own units.
- **Known subtotal** means some usage has a reported amount and some remains unpriced.
- **Unknown** does not mean free. Call counts still show activity when pricing is unavailable.
- Figures describe retained provider usage, not a reconciled invoice. They exclude the model usage billed by your chat or coding assistant.

Provider charges are billed by those services, separately from your ChatGPT plan.

The Library overview keeps usage and costs visible. A report or card's usage is limited to the receipts associated with it; its reference to another piece of evidence does not automatically include that evidence's cost.

## Setup and privacy

Your reports, retained responses and settings live in local folders outside the installed plugin package. Your provider keys belong in **keys.env**, opened from **Sources & tools**, rather than in the conversation. An API key is a provider-issued access code that lets Dig use your account with that service.

Local storage does not mean all research stays on your computer. Queries and selected inputs go to the services used for the request. Optional video analysis may send selected media to a provider; evidence ranking sends the supplied excerpts. Those services have their own storage and retention behavior.

**Settings** lets you choose the library, original-response retention and suggested research-worker defaults. Changing the library selects a folder; it does not move existing research. **About Dig** contains version information, file locations and credits.
