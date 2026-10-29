# Start here

Dig shows where your research stands: the question, saved findings and gaps, source coverage, recorded outcomes, and provider usage. Your assistant can research across the web, software projects, papers, social posts, videos and other services.

You set the direction in your normal conversation. Your assistant uses the source instructions, reads the detailed reports and original evidence, and explains what it finds. Dig gives you a clear view of the saved work so you can decide what matters next. Full records remain available when you want to inspect a particular point.

## Your first research question

1. **Ask what matters to you.** Say “Use Dig…” with the question or decision, who or what matters, and any relevant place, time period, or spending limit. You can name a source or let your assistant choose from the enabled sources. Open **Sources & tools** or use the setup skill in the conversation if you need help choosing sources.
2. **Observe what is recorded.** **Overview** shows saved questions, outcomes, source coverage, and provider usage. Select a question to see its recorded findings, uncertainty, and dated activity.
3. **Steer the next step.** **Steer research** lets you choose a direction and preview an instruction. Place it in your conversation as an unsent draft, or copy it there if drafts are unavailable. Review, adjust, and send it when ready; choosing a direction in Dig does not itself start research.

For example:

> Use Dig and Hacker News to investigate how people choose a note-taking app. Show me the strongest findings, disagreements, and what is still missing. Save the supporting research, check the original discussions, and suggest a useful next question.

Hacker News needs no provider account; enable it first. DeepWiki and Polymarket are also keyless options. Other sources may need a provider account, key, or local tool. You only need to configure what you want to use.

## Observe the state, then decide what matters

An open research question helps you answer five practical questions:

- **What is this about?** The question and its saved answer outcome provide the context.
- **What has been reported?** Coverage shows which research methods have saved reports, with their recorded outcomes.
- **What did the research find?** Available findings, contradictions, and follow-up targets are shown as the report author's assessment.
- **What did it use?** Retained calls and reported provider usage give the cost and activity context.
- **What should I ask next?** Use a gap, uncertainty, or new direction to prepare the next instruction.

These are observations from saved records. “No answer saved yet” does not mean a worker is running, paused, or stopped. A count of sources is breadth of retained material, not a guarantee of complete coverage or independent agreement. Dig does not infer a live progress percentage.

Your assistant does the detailed reading. Open a saved question to read its answer, or its latest report when no answer is saved. **Research details & activity** keeps coverage, follow-up targets and calls available; **Inspect records** can reopen a hidden document. An overflowing row of document tabs has left/right controls, and **Retrievals** opens the retained originals.

The **Start here** tab includes a made-up worked example near the top: a finding, the passage supporting it, and an illustrative original response. It shows how one passage can support offline editing while leaving sync reliability unanswered—and how that gap becomes a useful next question. The example runs no research and is not saved in your library.

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

**You set the direction.** Your assistant identifies what evidence would help and selects useful enabled sources. It can work directly or divide the research among focused helpers.

**The sources return information.** A source might return web pages, posts, video transcripts, search data or another kind of evidence. Dig records the retrieval and any reported provider usage. Original responses are kept when retention is enabled and capture succeeds.

**Your assistant checks and explains it.** It reads the source reports and important originals, separates observations from interpretation, and describes agreements, contradictions and gaps. A saved report or a confident model answer is not proof that a claim is true.

**You observe and steer.** Dig presents the saved question, reported coverage, findings, gaps, and provider usage. You decide what needs more attention and send the next instruction through the conversation. Reports stay in your selected library for the assistant to reuse and for you to inspect when useful.

## What the different pieces mean

- **Source:** where the information comes from, such as GitHub, YouTube or a search service.
- **Retrieval or call:** one recorded use of a Dig research or analysis tool. It may make several requests to its provider; several calls may contribute to a report.
- **Report:** saved findings from a research method, including its evidence and limitations.
- **Answer:** a saved explanation that brings selected source reports together.
- **Original response:** the information returned by the provider, retained when enabled. It helps you check what the provider actually returned.
- **Insight card:** a compact presentation of a finding, comparison or proposed next step, with optional evidence inspection and an unsent discussion draft. It does not add proof to the underlying research.
- **Overview:** the human view of saved research across projects, including usage and costs. The underlying **library** is the folder holding those records. **Research trail** shows recorded work associated with the current conversation.
- **Steering draft:** a proposed instruction for the next question or direction. Preparing it does not run a research tool, send the message, or start research.

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

Overview keeps usage and costs visible. A report or card's usage is limited to the receipts associated with it; its reference to another piece of evidence does not automatically include that evidence's cost.

## Setup and privacy

Your reports, retained responses and settings live in local folders outside the installed plugin package. Your provider keys belong in **keys.env**, opened from **Sources & tools**, rather than in the conversation. An API key is a provider-issued access code that lets Dig use your account with that service.

Local storage does not mean all research stays on your computer. Queries and selected inputs go to the services used for the request. Optional video analysis may send selected media to a provider; evidence ranking sends the supplied excerpts. Those services have their own storage and retention behavior.

**Settings** lets you choose the library, original-response retention and suggested research-worker defaults. Changing the library selects a folder; it does not move existing research. **About Dig** contains version information, file locations and credits.
