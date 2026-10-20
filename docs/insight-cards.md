# Research cards in the conversation

Dig keeps the saved report and original responses as the research record. Its native cards make those findings easier to inspect beside the conversation.

Every save shows a compact card with the report's concise title, original question, status and existing author assessments. Provider costs come from the associated receipts: known amounts retain their units, incompletely priced calls remain visible, and shared-tool evidence does not silently change the report's cost scope.

For a conclusion that benefits from a richer explanation, the initiating conversation can call `show_research` after reading the saved report or answer and its load-bearing originals. It supplies a bounded set of findings with ordered detail labels, retained evidence references, limits and an optional next-step prompt. This can express an SEO opportunity's query → competing page → owned page comparison, a timestamped video observation, or supporting and conflicting accounts. The renderer uses fixed components and treats all supplied text as data.

The card offers:

- **Read evidence:** inspect the selected retained originals, with complete pagination and an explicit warning if reading stops or fails.
- **Draft next step:** preview a proposed follow-up, then explicitly place it into the native composer without sending. An unavailable/refused host action offers copy/manual-text fallback.
- **Full report:** reopen the saved research in Dig.

Opening a card does not mean its report was read or its claims independently verified. Source-card confidence is the report author's assessment. Presented interpretations do not become verified facts merely because references and input shape passed validation.

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

The library and cards share React 19, Tailwind 4, Base UI/shadcn-style components and an open-source ReUI timeline. The library uses TanStack Router and Query over the existing MCP reads. Each surface is built separately into self-contained versioned HTML; installation needs no extra frontend server. The existing safe Markdown and evidence renderers remain in use inside the React library while their components migrate.

Native placement, host theme behavior and composer draft support depend on the host. Browser preview and protocol tests verify their own surfaces; they do not establish native-host acceptance.
