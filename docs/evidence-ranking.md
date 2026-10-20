# Evidence ranking

Evidence ranking is an optional reading aid for a burdensome shortlist of already collected text excerpts. The `evidence_rank` tool uses TypeSafe Jev to suggest an order and, when given a claim, assess how each excerpt relates to it. Every candidate stays available. A few obvious items generally need no extra provider call.

Enable **Evidence ranking** under **Sources & tools → Shared tools**, then add `TYPESAFE_API_KEY` to Dig’s private keys.env. The [official TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart) links to the [console’s key page](https://console.typesafe.ai/keys). Keys stay outside chat. Enabling the helper does not trigger it automatically, and other research works without it.

Ask in the conversation:

> Use Dig’s optional evidence-ranking helper to suggest a reading order for these excerpts against my question. Keep every candidate, highlight relevant contradictions, and identify which original sources still need reading.

The helper uses the pinned `jev-1.13.0` provider model. That is separate from the Codex model conducting the research; there is no Evidence ranking worker-model setting. It can run directly with an explicit project and optional dig, or support a source method using snippets already obtained from its assigned source.

## Inputs and boundaries

| Input | Scope |
| --- | --- |
| `question` | The research question, 1–4000 characters. |
| `candidates` | One to 32 supplied excerpts. |
| Candidate `id` | A unique ASCII identifier, at most 80 characters, preserved in the output. |
| Candidate `text` | The actual excerpt, 1–6000 characters. Include context needed to understand qualifications and negation. |
| Candidate `reference` | An optional original URL or library reference, at most 512 characters. It is a pointer, not an instruction to retrieve it. |
| `claim` | An optional specific claim, 1–4000 characters, compared with each excerpt. |

Combined provider state is limited to 24000 UTF-8 bytes, and the complete request to 64000 UTF-8 bytes. Individually valid excerpts can still exceed the total allowance. Oversized requests fail instead of silently truncating text; reduce the shortlist deliberately or submit smaller explicit batches while keeping the remaining candidates in the reading plan.

Caller IDs and references remain local; the question, optional claim and candidate text go to TypeSafe. The helper receives only the supplied text. It cannot recover a passage that retrieval omitted, inspect a linked page or video, or determine what a full document says from an incomplete snippet. Selected material is sent to TypeSafe; do not include context the user has kept private from providers.

## Reading the result

Every candidate retains its ID, reference and input index. Available relevance scores range from 0 to 3, with confidence and probabilities; the output also suggests a reading order. Partial results preserve unscored entries, which remain unresolved rather than irrelevant. Nothing is automatically discarded, fetched or merged.

Relevant contradiction is as useful as relevant support. With a claim, the relation is `supported`, `contradicted` or `insufficient` **according to that excerpt**. This does not establish real-world truth or source reliability. A short excerpt may omit the qualification that changes the answer.

[TypeSafe’s confidence value](https://docs.typesafe.ai/confidence) summarizes concentration in the returned probability distribution. It is not a probability that the evidence is true. Dig applies no automatic exclusion threshold. The agent decides what to read, preserves contrary evidence and returns to the original shortlist if the ranking is unhelpful or incomplete.

Ranking never replaces Dig’s full-report and original-evidence rules. The initiating thread reads every relied-on report in full and checks load-bearing claims against retained originals. Library snippets are discovery pointers; an absent snippet fact does not prove the full report lacks it. The library skill itself remains read-only and can hand a candidate list back to the initiating thread for an optional ranking call.

## Retention and costs

The call uses Dig’s ordinary receipt and raw-response retention. It creates no independent source report or persistent evidence score. A source report can cite the helper receipt while keeping its own source identity; a worker’s shared-tool call counts toward its explicitly named dig without being claimed by a report of another source.

TypeSafe’s returned token usage is preserved when available. A token-price estimate is not a provider-reported charge, so Dig records dollar cost as unknown. Missing raw evidence, unscored candidates and provider failures stay explicit. There is no automatic background ranking, source selection or library-wide scan.
