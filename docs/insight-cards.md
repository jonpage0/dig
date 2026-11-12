# Research cards in the conversation

In a host that renders Dig's views (ChatGPT desktop), each report saved with `research_save` and each answer saved with `dig_finish` shows a small card in the conversation: what was just saved, and a way to read it. Your assistant remains responsible for reading full reports and important originals and for explaining the findings.

A card shows one row of identity and one action:

- **Title:** the saved report's or answer's title, shortened to 96 characters. Hovering over it shows the original question.
- **Outcome:** **Report saved**, **Report saved · partial** or **Report saved · failed search** for a source report, as its author recorded the run; **Answer saved**, **Answer has gaps** or **Question unanswered** for an answer.
- **Sources:** the report's source, or the sources an answer cites (the first two by name, then a count).
- **Saved time and provider cost:** the cost covers only the calls that report claims, or the whole dig for an answer. Known amounts keep their original units, unpriced calls stay unknown, a save with no calls makes no zero-cost claim, and model usage is excluded.

**Open** asks the host for fullscreen and reads the complete saved file into a dialog, page by page, by its place in the library; a read that stops early says the file could not be read completely.

The card shows no summary, findings, evidence list or next step. The conversation carries the conclusions and the library carries the full retained research. A card is not a live progress indicator, and displaying it neither verifies the research nor shows that the assistant read it. A newer result replaces the card and discards late reads; a failed refresh keeps earlier details only when they belong to the same saved file. A failed save shows a short error, with no saved claim and no **Open** button.

The card reads the saved file's details through `saved_research`, a tool only the views call, which derives the title, outcome, sources and cost from the saved files and their receipts. Nothing the model writes can set them. Rendering a card makes no provider request and saves nothing.

In a host that renders no views (Claude Code, Codex in a terminal), there is no card: the assistant cites the saved report's path and reads it through the conversation. In Claude Code, asking the assistant to open Dig's library (it calls `open_library`, and the host asks to open a page) shows the same library, with every saved report and answer, in a browser; in any host, `node /absolute/path/to/dig/dist/dig.mjs open` in a terminal does the same.

## Frontend

The cards and the library share React 19, Tailwind 4, Base UI controls and the open-source ReUI Frame, Icon Tile and Timeline components. The full-record reader keeps the allowlisted Markdown and original-evidence renderers. Each view is built as self-contained HTML with its version in its address, served by Dig's service to the host or to a browser; no other frontend server is needed. Native placement and host theme follow the host. Component and protocol tests establish their tested behavior, not a host's visual acceptance.
