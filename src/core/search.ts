import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Context, Effect, Layer, Result } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ConfigService } from "./config.ts";
import { LibraryError } from "./errors.ts";
import { LibraryService } from "./library.ts";
import { frontMatter } from "./markdown.ts";
import type { SourcePlugin } from "./plugin.ts";
import {
  chunkPassages,
  decodeVectorBlob,
  embeddingText,
  embedText,
  encodeVectorBlob,
  MODEL,
  queryText,
  sha256Hex,
  tokenCount,
} from "./search-onnx.ts";
import { knownSecrets, redactText } from "./secrets.ts";

/**
 * Rebuildable hybrid library search powered by SQLite FTS5 BM25 (`search_fts`)
 * and local ONNX 384-d semantic vectors (`search_passages`), fused via RRF.
 * Automatically re-syncs changed Markdown files from disk (and rebuilds cleanly
 * if `dig.sqlite` was deleted).
 */

export type SearchMode = "hybrid" | "keyword";

export type SearchWarningCode =
  | "semantic_disabled"
  | "semantic_unavailable"
  | "unreadable_file"
  | "invalid_metadata"
  | "correction_graph"
  | "changed_during_search"
  | "cache_unavailable";

export interface SearchWarning {
  readonly code: SearchWarningCode;
  readonly message: string;
}

export interface SearchHit {
  readonly file: string;
  readonly path: string;
  readonly project: string;
  readonly dig: string;
  readonly kind: "report" | "answer";
  readonly source: string | null;
  readonly method: string | null;
  readonly title: string;
  readonly question: string;
  readonly at: string | null;
  readonly superseded: boolean;
  readonly heading: string | null;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
  readonly score: number;
  readonly matched_by: readonly ("keyword" | "semantic")[];
  readonly read: {
    readonly file: string;
    readonly offset: number;
    readonly limit: number;
  };
}

export interface SearchQuery {
  readonly query: string;
  readonly mode?: SearchMode;
  readonly file?: string;
  readonly project?: string;
  readonly dig?: string;
  readonly source?: string;
  readonly after?: string;
  readonly before?: string;
  readonly include_superseded?: boolean;
  readonly limit?: number;
}

export interface SearchResponse {
  readonly status: "complete" | "partial";
  readonly mode_requested: SearchMode;
  readonly mode_used: SearchMode;
  readonly library: string;
  readonly index_revision: string | null;
  readonly coverage: {
    readonly eligible_files: number;
    readonly searched_files: number;
    readonly skipped_files: number;
    readonly semantic_passages: number;
    readonly lexical_passages: number;
  };
  readonly warnings: readonly SearchWarning[];
  readonly hits: readonly SearchHit[];
}

export type EmbedFn = (stateDir: string, text: string, signal?: AbortSignal) => Promise<number[]>;

const validUtcIso = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

const toIsoOrNull = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function buildFtsQuery(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const unique = [...new Set(tokens)].slice(0, 32);
  if (!unique.length) return null;
  // Quote every token so FTS5 operators (AND/OR/NOT/NEAR/punctuation) never cause syntax errors.
  return unique.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

async function listDirs(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
}

export interface SearchServiceShape {
  readonly search: (
    args: SearchQuery,
    options?: { readonly signal?: AbortSignal; readonly embed?: EmbedFn },
  ) => Effect.Effect<SearchResponse, LibraryError>;
}

export class SearchService extends Context.Service<SearchService, SearchServiceShape>()("dig/SearchService") {}

export function makeSearchLayer(
  plugins: readonly SourcePlugin[],
): Layer.Layer<SearchService, never, ConfigService | LibraryService | SqlClient.SqlClient> {
  const reportSources = new Set(plugins.filter((p) => p.kind !== "tool").map((p) => p.id));

  return Layer.effect(
    SearchService,
    Effect.gen(function* () {
      const configSvc = yield* ConfigService;
      const librarySvc = yield* LibraryService;
      const sql = yield* SqlClient.SqlClient;

      const search: SearchServiceShape["search"] = (args, options) =>
        Effect.gen(function* () {
          const signal = options?.signal;
          const embedFn = options?.embed ?? embedText;
          const mode: SearchMode = args.mode ?? "hybrid";
          const limit = Math.max(1, Math.min(30, args.limit ?? 10));
          const query = args.query.trim();

          if (!query || query.length > 2000 || tokenCount(queryText(query)) > 480) {
            return yield* Effect.fail(
              new LibraryError({
                message: "query must be 1–2000 characters and at most 480 model tokens including its prefix",
              }),
            );
          }
          for (const key of ["after", "before"] as const) {
            const val = args[key];
            if (val && !validUtcIso(val)) {
              return yield* Effect.fail(new LibraryError({ message: `${key} must be a valid UTC ISO timestamp` }));
            }
          }
          if (args.after && args.before && Date.parse(args.after) >= Date.parse(args.before)) {
            return yield* Effect.fail(new LibraryError({ message: "after must be before before" }));
          }

          const config = yield* configSvc
            .load()
            .pipe(Effect.mapError((e) => new LibraryError({ message: e.message, cause: e })));

          // Support dig handle directly (`<folder>/<dig>`) or `(project, dig)`.
          let projectFilter: string | null = null;
          let digFilter: string | null = null;
          if (args.dig && args.dig.includes("/")) {
            const resolved = yield* librarySvc
              .resolveHandle(args.dig)
              .pipe(Effect.mapError((e) => new LibraryError({ message: e.message })));
            projectFilter = resolved.project;
            digFilter = resolved.dig;
          } else {
            if (args.dig && !args.project) {
              return yield* Effect.fail(new LibraryError({ message: "dig requires project (or pass a dig handle)" }));
            }
            if (args.project) {
              if (!isAbsolute(args.project)) {
                return yield* Effect.fail(new LibraryError({ message: "project must be an existing absolute directory" }));
              }
              projectFilter = yield* Effect.tryPromise({
                try: async () => {
                  const st = await stat(args.project!);
                  if (!st.isDirectory()) throw new Error("not directory");
                  return realpath(args.project!);
                },
                catch: () => new LibraryError({ message: "project must be an existing absolute directory" }),
              });
            }
            digFilter = args.dig ?? null;
          }

          const libraryRoot = yield* Effect.tryPromise({
            try: async () => {
              try {
                return await realpath(config.library);
              } catch (e) {
                if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
                if (args.file) throw new LibraryError({ message: "Selected library does not exist" });
                return resolve(config.library);
              }
            },
            catch: (e) =>
              e instanceof LibraryError
                ? e
                : new LibraryError({ message: e instanceof Error ? e.message : String(e), cause: e }),
          });

          const warnings: SearchWarning[] = [];
          const warn = (code: SearchWarningCode, message: string) => {
            const clean = redactText(message, knownSecrets());
            if (!warnings.some((w) => w.code === code && w.message === clean)) {
              warnings.push({ code, message: clean });
            }
          };

          // Discover Markdown reports & answers on disk (plain-file source of truth).
          interface DiscoveredDoc {
            file: string;
            path: string;
            project: string | null;
            dig: string;
            kind: "report" | "answer";
            source: string | null;
            method: string | null;
            title: string;
            question: string;
            at: string | null;
            superseded: boolean;
            replaces: string | null;
            text?: string;
            error?: unknown;
          }

          const docs: DiscoveredDoc[] = [];
          const projectDirs = yield* Effect.tryPromise({
            try: () => listDirs(libraryRoot),
            catch: (e) => new LibraryError({ message: "Cannot read library directory", cause: e }),
          });

          for (const dir of projectDirs) {
            if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
            const digDirs = yield* Effect.tryPromise({
              try: () => listDirs(join(libraryRoot, dir.name, "digs")),
              catch: (e) => new LibraryError({ message: "Cannot read digs directory", cause: e }),
            });
            for (const digDir of digDirs) {
              if (!digDir.isDirectory() || digDir.isSymbolicLink()) continue;
              const prefix = `${dir.name}/digs/${digDir.name}`;
              let meta: Record<string, unknown> = {};
              let metaError: unknown = null;
              const digRead = yield* Effect.result(
                librarySvc.readFile(`${prefix}/dig.md`, 0, Number.MAX_SAFE_INTEGER),
              );
              if (Result.isSuccess(digRead)) meta = frontMatter(digRead.success.text).meta;
              else metaError = digRead.failure;

              const entries = yield* Effect.tryPromise({
                try: () => listDirs(join(libraryRoot, prefix)),
                catch: () => new LibraryError({ message: `Cannot read ${prefix}` }),
              });

              for (const f of entries) {
                if (!f.name.endsWith(".md") || f.name === "dig.md" || (!f.isFile() && !f.isSymbolicLink())) continue;
                const file = `${prefix}/${f.name}`;
                const fileRead = yield* Effect.result(librarySvc.readFile(file, 0, Number.MAX_SAFE_INTEGER));
                const text = Result.isSuccess(fileRead) ? fileRead.success.text : undefined;
                const head = text ? frontMatter(text).meta : {};
                const error = Result.isFailure(fileRead) ? fileRead.failure : metaError;
                const kind: "report" | "answer" = f.name === "answer.md" ? "answer" : "report";
                let proj: string | null = typeof meta.project === "string" ? meta.project : null;
                if (proj) {
                  const p0 = proj;
                  proj = yield* Effect.tryPromise({
                    try: () => realpath(p0),
                    catch: () => resolve(p0),
                  }).pipe(Effect.catch(() => Effect.succeed(resolve(p0))));
                }
                const title =
                  typeof head.title === "string"
                    ? head.title
                    : text?.match(/^# (.+)$/m)?.[1] ??
                      (typeof meta.question === "string" ? meta.question : f.name);
                docs.push({
                  file,
                  path: Result.isSuccess(fileRead) ? fileRead.success.path : join(libraryRoot, file),
                  project: proj,
                  dig: digDir.name,
                  kind,
                  source: kind === "answer" ? null : typeof head.source === "string" ? head.source : null,
                  method: kind === "answer" ? null : typeof head.agent === "string" ? head.agent : null,
                  title,
                  question: typeof meta.question === "string" ? meta.question : "",
                  at: toIsoOrNull(kind === "answer" ? head.finished_at : head.generated_at),
                  superseded: false,
                  replaces: typeof head.supersedes === "string" ? head.supersedes : null,
                  text,
                  error,
                });
              }
            }
          }

          // Mark superseded reports via same-dig correction chains.
          for (const d of docs) {
            const chain: DiscoveredDoc[] = [];
            let current: DiscoveredDoc | undefined = d;
            let invalid = false;
            while (current?.replaces) {
              const target = docs.find(
                (x) => x.project === d.project && x.dig === d.dig && x.file.split("/").at(-1) === current!.replaces,
              );
              if (!target || chain.includes(target) || target === d) {
                invalid = true;
                break;
              }
              chain.push(target);
              current = target;
            }
            if (invalid) warn("correction_graph", `Invalid correction chain in ${d.file}`);
            else for (const old of chain) old.superseded = true;
          }

          let selected = docs.filter(
            (d) =>
              (args.include_superseded || !d.superseded) &&
              (!projectFilter || d.project === projectFilter) &&
              (!digFilter || d.dig === digFilter) &&
              (!args.source || d.source === args.source) &&
              (!args.after || (d.at !== null && Date.parse(d.at) >= Date.parse(args.after))) &&
              (!args.before || (d.at !== null && Date.parse(d.at) < Date.parse(args.before))),
          );

          if (args.file) {
            const named = yield* librarySvc.readFile(args.file, 0, 1);
            if (!docs.some((d) => d.file === named.file)) {
              return yield* Effect.fail(new LibraryError({ message: "file must name a report or answer in this library" }));
            }
            selected = selected.filter((d) => d.file === named.file);
          }

          const eligible = selected.length;
          let skipped = 0;
          const useSemantic = mode === "hybrid" && config.search.semantic;
          let semanticWorking = Boolean(useSemantic);
          let queryVector: number[] | null = null;

          if (mode === "hybrid" && !useSemantic) {
            warn(
              "semantic_disabled",
              "Semantic search is disabled. Enable local semantic search in Dig settings for the pinned model download.",
            );
          }
          if (useSemantic) {
            const qRes = yield* Effect.result(
              Effect.tryPromise({
                try: () => embedFn(config.stateDir, queryText(query), signal),
                catch: (e) => e,
              }),
            );
            if (Result.isSuccess(qRes)) {
              queryVector = qRes.success;
            } else {
              if (signal?.aborted) {
                return yield* Effect.fail(new LibraryError({ message: "Search cancelled" }));
              }
              semanticWorking = false;
              warn(
                "semantic_unavailable",
                qRes.failure instanceof Error ? qRes.failure.message : String(qRes.failure),
              );
            }
          }

          // Reconcile selected docs into SQLite `search_passages` + `search_fts` by SHA-256.
          const validFiles = new Map<string, { doc: DiscoveredDoc; sha256: string }>();
          const docHashes: string[] = [];

          for (const d of selected) {
            if (signal?.aborted) return yield* Effect.fail(new LibraryError({ message: "Search cancelled" }));
            if (d.error || d.text === undefined) {
              skipped++;
              warn("unreadable_file", `Cannot read ${d.file}`);
              continue;
            }
            if (
              !d.project ||
              (d.kind === "report" && (!d.source || !reportSources.has(d.source))) ||
              typeof d.title !== "string"
            ) {
              skipped++;
              warn("invalid_metadata", `Invalid research metadata in ${d.file}`);
              continue;
            }

            const fileSha = sha256Hex(Buffer.from(d.text));
            validFiles.set(d.file, { doc: d, sha256: fileSha });
            docHashes.push(`${d.file}:${fileSha}`);

            const existingRows = yield* sql<{
              id: number;
              vector: Uint8Array | null;
              model_id: string | null;
              model_revision: string | null;
              start_offset: number;
              end_offset: number;
              heading: string | null;
            }>`
              SELECT id, vector, model_id, model_revision, start_offset, end_offset, heading
              FROM search_passages
              WHERE library_root = ${libraryRoot} AND file = ${d.file} AND sha256 = ${fileSha}
              ORDER BY start_offset ASC
            `.pipe(Effect.mapError((e) => new LibraryError({ message: "Search index read failed", cause: e })));

            if (existingRows.length === 0) {
              // Chunk and insert fresh passages + FTS5 entries atomically.
              const chunks = chunkPassages(d.text, d.title);
              const vectors: (Uint8Array | null)[] = [];
              for (const chunk of chunks) {
                if (semanticWorking) {
                  const vecRes = yield* Effect.result(
                    Effect.tryPromise({
                      try: () =>
                        embedFn(
                          config.stateDir,
                          embeddingText(d.title, chunk.heading, d.text!.slice(chunk.start, chunk.end)),
                          signal,
                        ),
                      catch: (e) => e,
                    }),
                  );
                  if (Result.isSuccess(vecRes)) {
                    vectors.push(encodeVectorBlob(vecRes.success));
                  } else {
                    if (signal?.aborted) return yield* Effect.fail(new LibraryError({ message: "Search cancelled" }));
                    semanticWorking = false;
                    warn(
                      "semantic_unavailable",
                      vecRes.failure instanceof Error ? vecRes.failure.message : String(vecRes.failure),
                    );
                    vectors.push(null);
                  }
                } else {
                  vectors.push(null);
                }
              }

              yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    yield* sql`DELETE FROM search_fts WHERE library_root = ${libraryRoot} AND file = ${d.file}`;
                    yield* sql`DELETE FROM search_passages WHERE library_root = ${libraryRoot} AND file = ${d.file}`;
                    for (let i = 0; i < chunks.length; i++) {
                      const ch = chunks[i];
                      const body = d.text!.slice(ch.start, ch.end);
                      const inserted = yield* sql<{ id: number }>`
                        INSERT INTO search_passages (
                          library_root, file, sha256, start_offset, end_offset,
                          heading, title, body, model_id, model_revision, vector
                        ) VALUES (
                          ${libraryRoot}, ${d.file}, ${fileSha}, ${ch.start}, ${ch.end},
                          ${ch.heading}, ${d.title}, ${body},
                          ${vectors[i] ? MODEL.id : null},
                          ${vectors[i] ? MODEL.revision : null},
                          ${vectors[i]}
                        ) RETURNING id
                      `;
                      const passageId = inserted[0]?.id;
                      if (passageId !== undefined) {
                        yield* sql`
                          INSERT INTO search_fts (passage_id, library_root, file, title, heading, body)
                          VALUES (${passageId}, ${libraryRoot}, ${d.file}, ${d.title}, ${ch.heading ?? ""}, ${body})
                        `;
                      }
                    }
                  }),
                )
                .pipe(Effect.mapError((e) => new LibraryError({ message: "Search index write failed", cause: e })));
            } else if (semanticWorking) {
              // Backfill missing or stale-model vectors for indexed passages.
              for (const row of existingRows) {
                if (row.vector && row.model_id === MODEL.id && row.model_revision === MODEL.revision) continue;
                const vecRes = yield* Effect.result(
                  Effect.tryPromise({
                    try: () =>
                      embedFn(
                        config.stateDir,
                        embeddingText(d.title, row.heading, d.text!.slice(row.start_offset, row.end_offset)),
                        signal,
                      ),
                    catch: (e) => e,
                  }),
                );
                if (Result.isSuccess(vecRes)) {
                  yield* sql`
                    UPDATE search_passages
                    SET vector = ${encodeVectorBlob(vecRes.success)},
                        model_id = ${MODEL.id},
                        model_revision = ${MODEL.revision}
                    WHERE id = ${row.id}
                  `.pipe(Effect.ignore);
                } else {
                  if (signal?.aborted) return yield* Effect.fail(new LibraryError({ message: "Search cancelled" }));
                  semanticWorking = false;
                  warn(
                    "semantic_unavailable",
                    vecRes.failure instanceof Error ? vecRes.failure.message : String(vecRes.failure),
                  );
                  break;
                }
              }
            }
          }

          // Prune indexed rows for files that no longer exist in this library root (only on unscoped full library scans).
          if (!args.project && !args.dig && !args.source) {
            const currentFiles = new Set(docs.map((d) => d.file));
            const indexedFiles = yield* sql<{ file: string }>`
              SELECT DISTINCT file FROM search_passages WHERE library_root = ${libraryRoot}
            `.pipe(Effect.orElseSucceed(() => [] as { file: string }[]));
            const stale = indexedFiles.map((r) => r.file).filter((f) => !currentFiles.has(f));
            if (stale.length > 0) {
              yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    yield* sql`DELETE FROM search_fts WHERE library_root = ${libraryRoot} AND file IN ${sql.in(stale)}`;
                    yield* sql`DELETE FROM search_passages WHERE library_root = ${libraryRoot} AND file IN ${sql.in(stale)}`;
                  }),
                )
                .pipe(Effect.ignore);
            }
          }

          if (eligible > 0 && skipped === eligible) {
            return yield* Effect.fail(new LibraryError({ message: "No eligible research file could be searched" }));
          }

          const selectedFiles = [...validFiles.keys()];
          if (selectedFiles.length === 0) {
            return {
              status: warnings.length ? "partial" : "complete",
              mode_requested: mode,
              mode_used: semanticWorking ? "hybrid" : "keyword",
              library: libraryRoot,
              index_revision: sha256Hex(docHashes.sort().join("\n")),
              coverage: {
                eligible_files: eligible,
                searched_files: 0,
                skipped_files: skipped,
                semantic_passages: 0,
                lexical_passages: 0,
              },
              warnings,
              hits: [],
            };
          }

          // Load all candidate passages for the scoped files.
          interface PassageRow {
            id: number;
            file: string;
            start_offset: number;
            end_offset: number;
            heading: string | null;
            body: string;
            model_id: string | null;
            model_revision: string | null;
            vector: Uint8Array | null;
          }

          const allPassages = yield* sql<PassageRow>`
            SELECT id, file, start_offset, end_offset, heading, body, model_id, model_revision, vector
            FROM search_passages
            WHERE library_root = ${libraryRoot}
              AND file IN ${sql.in(selectedFiles)}
          `.pipe(Effect.mapError((e) => new LibraryError({ message: "Failed to read search_passages", cause: e })));

          const passageById = new Map<number, PassageRow>(allPassages.map((p) => [p.id, p]));
          const semanticCount = allPassages.filter((p) => p.vector !== null).length;

          // 1. SQLite FTS5 BM25 lexical ranking
          const ftsQuery = buildFtsQuery(query);
          const lexicalRanked: { id: number; score: number }[] = [];
          if (ftsQuery) {
            const ftsRows = yield* sql<{ passage_id: number; bm25_score: number }>`
              SELECT passage_id, bm25(search_fts) AS bm25_score
              FROM search_fts
              WHERE search_fts MATCH ${ftsQuery}
                AND library_root = ${libraryRoot}
                AND file IN ${sql.in(selectedFiles)}
              ORDER BY bm25_score ASC
              LIMIT 100
            `.pipe(Effect.mapError((e) => new LibraryError({ message: "FTS5 query failed", cause: e })));
            for (const row of ftsRows) {
              // SQLite bm25() returns negative scores (more negative = better match).
              lexicalRanked.push({ id: Number(row.passage_id), score: Math.max(0.0001, -Number(row.bm25_score)) });
            }
          }

          // 2. Semantic dense cosine similarity ranking
          const denseRanked: { id: number; score: number }[] = [];
          if (semanticWorking && queryVector) {
            for (const p of allPassages) {
              if (!p.vector || p.model_id !== MODEL.id || p.model_revision !== MODEL.revision) continue;
              const vec = decodeVectorBlob(p.vector);
              let dot = 0;
              for (let i = 0; i < queryVector.length && i < vec.length; i++) {
                dot += queryVector[i] * vec[i];
              }
              if (Number.isFinite(dot)) denseRanked.push({ id: p.id, score: dot });
            }
            denseRanked.sort((a, b) => b.score - a.score || a.id - b.id);
            denseRanked.splice(100);
          }

          // 3. Reciprocal Rank Fusion (RRF) or pure BM25
          const fused = new Map<
            number,
            { score: number; matched_by: ("keyword" | "semantic")[] }
          >();
          lexicalRanked.forEach((item, rank) => {
            const cur = fused.get(item.id) ?? { score: 0, matched_by: [] };
            cur.score += semanticWorking ? 1 / (61 + rank) : item.score;
            cur.matched_by.push("keyword");
            fused.set(item.id, cur);
          });
          if (semanticWorking) {
            denseRanked.forEach((item, rank) => {
              const cur = fused.get(item.id) ?? { score: 0, matched_by: [] };
              cur.score += 1 / (61 + rank);
              cur.matched_by.push("semantic");
              fused.set(item.id, cur);
            });
          }

          const rankedEntries = [...fused.entries()]
            .map(([id, rank]) => ({ id, passage: passageById.get(id), ...rank }))
            .filter((x): x is typeof x & { passage: PassageRow } => x.passage !== undefined)
            .sort(
              (a, b) =>
                b.score - a.score ||
                a.passage.file.localeCompare(b.passage.file) ||
                a.passage.start_offset - b.passage.start_offset,
            );

          // Deduplicate overlaps & cap at 3 hits per file.
          const chosen: typeof rankedEntries = [];
          for (const entry of rankedEntries) {
            const sameFile = chosen.filter((c) => c.passage.file === entry.passage.file);
            if (sameFile.length >= 3) continue;
            if (
              sameFile.some(
                (c) =>
                  c.passage.start_offset < entry.passage.end_offset &&
                  entry.passage.start_offset < c.passage.end_offset,
              )
            ) {
              continue;
            }
            chosen.push(entry);
            if (chosen.length >= limit) break;
          }

          const hits: SearchHit[] = [];
          for (const entry of chosen) {
            const meta = validFiles.get(entry.passage.file);
            if (!meta) continue;
            const d = meta.doc;
            const start = entry.passage.start_offset;
            let end = Math.min(entry.passage.end_offset, start + 2400);
            const fullText = d.text ?? "";
            if (end < fullText.length && /[\uDC00-\uDFFF]/.test(fullText[end])) end--;
            hits.push({
              file: d.file,
              path: d.path,
              project: d.project!,
              dig: d.dig,
              kind: d.kind,
              source: d.source,
              method: d.method,
              title: d.title,
              question: d.question,
              at: d.at,
              superseded: d.superseded,
              heading: entry.passage.heading,
              start,
              end,
              excerpt: fullText.slice(start, end),
              score: Number(entry.score.toFixed(6)),
              matched_by: entry.matched_by,
              read: { file: d.path, offset: start, limit: Math.max(1, end - start) },
            });
          }

          return {
            status: warnings.length ? "partial" : "complete",
            mode_requested: mode,
            mode_used: semanticWorking ? "hybrid" : "keyword",
            library: libraryRoot,
            index_revision: sha256Hex(docHashes.sort().join("\n")),
            coverage: {
              eligible_files: eligible,
              searched_files: selectedFiles.length,
              skipped_files: skipped,
              semantic_passages: semanticWorking ? semanticCount : 0,
              lexical_passages: allPassages.length,
            },
            warnings,
            hits,
          };
        });

      return SearchService.of({ search });
    }),
  );
}
