# Research cards in the conversation

Dig's cards make the saved state of research legible beside the conversation. Your assistant remains responsible for reading full reports and important originals; you can inspect a particular finding and choose what to ask next.

A card separates three different kinds of information:

- **The saved event:** Report saved or Answer saved identifies a retained document and its saved time.
- **The assessment:** a report's status, confidence and evidence grade are labeled as its author's judgment. An answer's outcome remains the saved answer's status.
- **The recorded activity:** retained calls and provider usage are scoped to that report or dig. Known amounts keep their original units, and unpriced calls remain explicit. Shared-tool evidence does not silently change report cost ownership.

The first layer shows the saved title, **What came back**, any displayed recorded limitation or follow-up, and a **Possible next step**. The summary comes from the saved research, or from the initiating thread's explicit presentation. It is not a live progress indicator or an independently verified conclusion.

**Review next step** opens an inert instruction preview. When an explicit insight supplies a proposal, that proposal is shown. Otherwise, a card with a canonical saved-file reference can offer to have the assistant review coverage, conflicting evidence and the next useful investigation. That default is a request to assess the records, not an inferred finding or an automatic research decision. Only a separate explicit action places an unsent draft in the native composer or copies the text. Host refusal offers a copy/manual fallback; it never retries by sending the message.

**Findings & evidence** expands the original question, reported or presented findings, ordered details and limitations. **Read evidence** opens the selected retained text; full pagination and canonical-path checks remain in force, and an incomplete or failed read says so. **Inspect research** opens the exact saved record in Dig, with an inline retained-file reader when no valid host deep link is available. Native file opening is offered within evidence inspection when supported.

A failed refresh may leave previously loaded details visible only when they belong to the same canonical saved file. New results and closed or replaced dialogs invalidate late reads, draft/copy acknowledgments and focus callbacks. These guards preserve the view's identity; closing the UI does not claim to cancel a host request that was already issued.

For a conclusion that benefits from a richer explanation, the initiating conversation can call `show_research` after reading the report or answer and its load-bearing originals. Its bounded findings can express a query → competing page → owned page comparison, timestamped video observations, or supporting and conflicting accounts. Fixed components render all supplied text as data. Validation of references and input shape does not establish truth, and opening a card is not evidence that the assistant read the report.

## Tool input

`show_research` takes an existing report or answer `file` and one to six `insights`. Each insight has:

| Field | Meaning |
| --- | --- |
| `title` | Concise finding title, up to 180 characters. |
| `statement` | Bounded finding or interpretation, up to 1500 characters. |
| `details` | Up to 4 ordered items with `label`, `value` and optional HTTP(S) `url`. |
| `evidence` | One to 4 existing library file references. Use actual report/original references returned by Dig. |
| `limits` | Up to 4 material limitations. |
| `nextStep` | Optional `label` and proposed `prompt`, presented as an unsent draft. |

Identity, report status and provider costs cannot be supplied by the model; the server derives them. Evidence must belong to the selected dig. Composed answers may reference only the reports they named. Entire session receipt files and unrelated shared transcript files are not accepted as card evidence because their dig ownership is not established by the current records. A report can still explain and link its transcript through ordinary library reading.

The presentation is transient tool-result data, not another saved report or a new library database. Rendering performs no provider request, website change, scheduling or publication. Cards pin reads and deep links to canonical source files; changing the selected library cannot substitute a same-named report underneath an existing finding.

## Frontend

The cards and library share React 19, Tailwind 4, Base UI controls and the open-source ReUI Frame, Icon Tile and Timeline components. Overview, conversation trail, question state, Sources, Accounts, Settings, About and Start here are React surfaces. The explicit full-record reader retains the existing allowlisted Markdown and original-evidence renderers. TanStack Router and Query use the existing local MCP operations; no paid research is automatically fetched by the view.

Each surface is packaged separately as self-contained versioned HTML, with no extra frontend server required by the installed plugin. Native placement, host theme propagation and composer-draft support depend on the host. Component and protocol checks establish their tested behavior; they do not establish native visual acceptance.
