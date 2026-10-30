# Library search v1

Dig 0.10.0 exposes local passage search through MCP. Research Markdown remains authoritative; the index is rebuildable derivative state.

## Scope and authority

Search complete saved report and answer files, across the active library or within one selected file. Include substantive text, headings, audit/provenance sections, URLs and code blocks; no silent exclusion of sections as in the first experiment. Exclude YAML front matter from passage text but retain its existing identity/source/date metadata. Question records supply context and filters, not separate hits. Raw provider JSON and shared transcripts are outside v1 indexing; agents reach originals through existing references. No inferred corroboration, report truth, or worker state.

Use BGE-small-en-v1.5 Q8, normalized CLS pooling and the prescribed retrieval query prefix, plus BM25. Pin model revision ea104dacec62c0de699686887e3f920caeb4f3e3. Model dimensions are 384; changes require a new index format/model identity, not mixed vectors. Direct ONNX CPU inference and the pure-JS tokenizer are the intended backend. No hosted database, embedding API, Python, GPU or persistent daemon is required.

## MCP input: library_search

Closed object; additional properties rejected. All filters intersect.

- query: required string, trim, 1–2000 UTF-16 units after trim. Reject a query exceeding 480 model tokens after the prefix; never silently truncate.
- mode: optional enum hybrid | keyword, default hybrid.
- file: optional string, 1–4096 units; library-relative or absolute canonical reference accepted by library_read. Must name an indexed report or answer. A question, receipt or original is an error, not an empty search.
- project: optional existing absolute project directory string, same validation as library_list; canonical comparison against recorded project identity.
- dig: optional existing dig id string, 1–200 units. Requires project to avoid ambiguous cross-project ids.
- source: optional existing report-source catalog id. Disabled sources' saved reports remain searchable. Saved answers have no source identity and are excluded when source is supplied.
- after: optional valid UTC ISO timestamp; inclusive document generated/finished time. Reject invalid timestamps. Undated documents do not match this filter.
- before: optional valid UTC ISO timestamp; exclusive document time. Requires after < before when both exist.
- include_superseded: optional boolean, default false. Follow existing explicit same-dig supersedes links only; do not infer that a later report replaces an earlier one. Cycles/missing targets produce a coverage warning and retain affected documents.
- limit: optional integer 1–30, default 10. Limits passages, not documents. At most three passages per file, with overlapping/duplicate passages collapsed before limiting.

The tool makes no source-provider call and changes no report, answer or receipt. It may build/update its disposable search cache. Its annotations are destructiveHint:false and openWorldHint:false; readOnlyHint:false because cache writes/downloads are possible. No retrieval receipt or provider cost is fabricated for local search.

## Successful output

Closed object; every key below is required. Content carries the same bounded JSON discovery result as text for host interoperability; structuredContent carries its typed object. Agents must read originals before relying on a result. Scores are rankings, never confidence probabilities.

- status: enum complete | partial.
- mode_requested: enum hybrid | keyword.
- mode_used: enum hybrid | keyword.
- library: absolute active library path string.
- index_revision: string, lowercase SHA-256 hex of the cache generation, or null if no index could be published.
- coverage: object {eligible_files: nonnegative integer, searched_files: nonnegative integer, skipped_files: nonnegative integer, semantic_passages: nonnegative integer, lexical_passages: nonnegative integer}. searched_files + skipped_files = eligible_files. Counts describe the filtered scope.
- warnings: array of objects {code: enum semantic_disabled | semantic_unavailable | unreadable_file | invalid_metadata | correction_graph | changed_during_search | cache_unavailable, message: nonempty string}. Messages are credential-redacted. Empty when no warning applies.
- hits: array, length <= limit, of the following closed object:
  - file: canonical library-relative file string; path: canonical absolute file string.
  - project: recorded absolute project string; dig: string.
  - kind: enum report | answer; source: report-source id or null for an answer; method: existing agent name string or null.
  - title: existing report/answer-derived title string; question: original saved question string.
  - at: UTC ISO timestamp string or null; superseded: boolean.
  - heading: nearest enclosing Markdown heading text string or null.
  - start: nonnegative integer; end: integer > start. Both use JavaScript UTF-16 offsets in the exact canonical file returned by library_read.
  - excerpt: exact file substring from start to end, maximum 2400 UTF-16 units; no generated prose or ellipsis added inside it.
  - score: finite nonnegative number; matched_by: nonempty unique array of enum keyword | semantic.
  - read: object {file: the same canonical absolute path, offset: start, limit: end-start}. This is directly usable with existing library_read. No new reader operation.

No matches is a complete response with hits:[] if all applicable work completed. Semantic disabled/unavailable in hybrid mode gives partial, mode_used:keyword, an explicit warning and usable lexical hits. A successful keyword request remains complete when semantics is disabled. All eligible files unreadable is an MCP error rather than a complete empty response. Invalid arguments, refused paths and unsupported files are MCP errors. Cancellation stops work and returns a cancellation error; a prior committed cache remains intact.

## Chunking and ranking

Read files through the same containment/allowlist boundary as library_read; never follow an out-of-library symlink or trust an index path as permission. Each input file has a SHA-256 over exact UTF-8 bytes. Passage offsets refer to its decoded JS string. Start after front matter; cover every remaining non-whitespace code unit with at least one passage. Prefer paragraph/heading boundaries, recursively split oversized paragraphs or code blocks, and never split a surrogate pair. Target 320 body tokens, maximum 384 body tokens; prepend at most 64 title/heading tokens and keep the final model input <=480 tokens. Adjacent passages overlap by at most 48 body tokens; exact boundaries are recorded. Output excerpt limit can shorten a hit's end at a Unicode boundary without changing its starting offset. Long headings/titles are bounded in embedding context only, not mutated in the saved file.

BM25: Unicode letter/number terms, lowercase, preserve exact identifier/URL components, no English stopword removal or stemming in v1; k1=1.2, b=0.75. Index title/heading tokens and passage text once each. Dense ranking uses dot products of L2-normalized 384-dimensional vectors. Retrieve at most 100 passages per ranker after filters. Hybrid combines ranks by reciprocal-rank fusion, constant 60, equal weight; keyword mode uses BM25 alone. Discard zero-score lexical candidates. Rank ties by file, start, end. Dense similarity is not a relevance guarantee; no arbitrary similarity cutoff or absence claim. Deduplicate overlapping hits from the same file, retaining the highest score, then apply the per-file cap and limit.

## Settings and assets

Extend the existing TOML authority only:

[search]
semantic = false

New flat native setting: search_semantic, boolean, default false; both settings surfaces map to that same field. Keyword search works immediately. Semantic enablement authorizes a one-time model asset download (about 34 MB plus tokenizer); display that fact and local-only inference before enabling. Existing users are not silently opted in. No API credential or model selector in v1. Hybrid is the search input default but honestly falls back to keyword when semantics is off.

The exact proposed asset manifest is [model asset manifest](../src/search/assets/manifest.json), with pinned URLs, byte counts and SHA-256 hashes checked against the tested files. Its closed shape is {model: string, revision: 40-character git SHA string, files: array of {path: relative string, sha256: 64-character lowercase hex string, bytes: positive integer, url: HTTPS string}}. Integrity-check every asset before use; no model-metadata-selected files or executable code downloads. Store assets under <state>/search/models/<model revision>/, never the package cache. Download into temporary files and atomically publish only verified assets. No execution or dynamic package installation from model metadata. Runtime JS and supported ONNX platform binaries are shipped with the plugin, not downloaded/executed at search time. Unsupported semantic platforms retain keyword mode with an explicit warning. Release acceptance requires macOS arm64; any additional supported platform must pass the same packaged smoke before being advertised. Limits: four CPU threads, single embedding batch per process, idle model disposal after 60 seconds with no embedding work. No background process survives the MCP server.

## Disposable index schema and lifecycle

Cache directory: <state>/search/indexes/<sha256(canonical library path)>/. One atomically replaced index.json, UTF-8, closed schema:

- format: integer literal 1.
- library: canonical absolute library path string.
- generation: random UUID string identifying this write.
- model: object {id: literal Xenova/bge-small-en-v1.5, revision: literal ea104dacec62c0de699686887e3f920caeb4f3e3, dtype: literal q8, pooling: literal cls, dimensions: literal 384, normalized: literal true}.
- chunker: literal markdown-v1.
- files: array of {file: canonical library-relative string, sha256: lowercase 64-hex string, passages: array of {start: integer >=0, end: integer >start, heading: string|null, vector: null|array of exactly 384 finite numbers}}.

Each file appears once; passage ranges are within that file, ascending, and correspond to the coverage/chunking rules. Vectors are null until generated or when unavailable. Non-null vectors must have L2 norm within 0.0001 of one. All per-file metadata, excerpts and lexical postings are derived from current canonical files at read time, not duplicated durable fields. The cache stores no keys, query text, receipts or independent source-of-truth metadata.

Every search inventories eligible report/answer files and compares their hashes; reuse embeddings for unchanged ranges only when model/chunker/file identity match exactly. Add/change/delete files incrementally; perform first build on demand. Before returning a hit, verify its file still matches the searched bytes. If any file changes during work, retry its indexing once; if still changing skip it and return partial with changed_during_search. Changes to the active library select a different cache namespace and invalidate pending results from the previous selection.

Multiple processes may compute the same derivative work. Each writes a unique temporary sibling and atomically renames a whole valid generation; readers validate model/library/file hashes before reuse, so a last-writer stale generation cannot authorize stale hits. No persistent lock ownership or worker registry is added. Partial/cancelled temporary files never replace a valid generation and are cleaned on next startup. Cache corruption, unknown format or incompatible model/chunker discards the derivative and rebuilds; never migrate or rewrite research. A failed cache write permits in-memory keyword results with partial status, index_revision:null and cache_unavailable; use semantic_unavailable for model loading/inference failures, with a concrete message.

## Verification boundaries

Offline checks exercise full-body discovery, exact offsets, scoped search, corrections, corrupt caches, changing files, concurrent writes, cancellation and explicit fallback. Native protocol readback and packaged CPU inference are separate checks. Model ranking does not establish truth, and search excerpts do not replace full report/original reading.
