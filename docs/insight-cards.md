# Research cards in the conversation

Dig's cards show, beside the conversation, what was just saved and open it on request. Your assistant remains responsible for reading full reports and important originals and for explaining the findings.

A card shows one row of identity and one action:

- **Title:** the first supplied insight's title from `show_research`, otherwise the saved report's or answer's title, shortened to 96 characters. Hovering over it shows the original question.
- **Outcome:** **Report saved**, **Report saved · partial** or **Report saved · failed search** for a source report, as its author recorded the run; **Answer saved**, **Answer has gaps** or **Question unanswered** for a composed answer.
- **Sources:** the report's source, or the sources an answer cites (the first two by name, then a count).
- **Saved time and provider cost:** the cost covers only the calls that report claims, or the whole dig for an answer. Known amounts keep their original units, unpriced calls stay unknown, a save with no calls makes no zero-cost claim, and model usage is excluded.

**Open** follows the exact Dig link to the saved file. When the host cannot open that link, the card asks for fullscreen and reads the complete retained file into a dialog, page by page; a read that stops early says the file could not be read completely.

The card shows no summary, findings, evidence list or next step. The conversation carries the conclusions and the library carries the full retained research. A card is not a live progress indicator, and displaying it neither verifies the research nor shows that the assistant read it. A newer result replaces the card and discards late reads; a failed refresh keeps earlier details only when they belong to the same saved file. A failed save shows a short error, with no saved claim and no **Open** button.

Claude Code renders no card. There, the assistant cites the saved report's path and reads it through the conversation.

For a conclusion that benefits from a richer explanation, the initiating conversation can call `show_research` after reading the report or answer and its load-bearing originals. Its bounded findings can express a query → competing page → owned page comparison, timestamped video observations, or supporting and conflicting accounts. The card shows only the first finding's title; the findings themselves stay in the tool result for the conversation to explain. Validation of references and input shape does not establish truth, and showing a card is not evidence that the assistant read the report.

## Tool input

`show_research` takes an existing report or answer `file` and one to six `insights`. Each insight has:

| Field | Meaning |
| --- | --- |
| `title` | Concise finding title, up to 180 characters. |
| `statement` | Bounded finding or interpretation, up to 1500 characters. |
| `details` | Up to 4 ordered items with `label`, `value` and optional HTTP(S) `url`. |
| `evidence` | One to 4 existing library file references. Use actual report/original references returned by Dig. |
| `limits` | Up to 4 material limitations. |
| `nextStep` | Optional `label` and proposed `prompt`, kept in the tool result; the card does not show it. |

Identity, report status and provider costs cannot be supplied by the model; the server derives them. Evidence must belong to the selected dig. Composed answers may reference only the reports they named. Entire session receipt files and unrelated shared transcript files are not accepted as card evidence because their dig ownership is not established by the current records. A report can still explain and link its transcript through ordinary library reading.

The presentation is transient tool-result data, not another saved report or a new library database. Rendering performs no provider request, website change, scheduling or publication. Cards pin reads and deep links to canonical source files; changing the selected library cannot substitute a same-named report underneath an existing finding.

## Frontend

The cards and library share React 19, Tailwind 4, Base UI controls and the open-source ReUI Frame, Icon Tile and Timeline components. Overview, conversation trail, question state, Sources, Accounts, Settings, About and Start here are React surfaces. The explicit full-record reader retains the existing allowlisted Markdown and original-evidence renderers. TanStack Router and Query use the existing local MCP operations; no paid research is automatically fetched by the view.

Each surface is packaged separately as self-contained versioned HTML, with no extra frontend server required by the installed plugin. Native placement, host theme propagation and composer-draft support depend on the host. Component and protocol checks establish their tested behavior; they do not establish native visual acceptance.
