import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ANSWER_STATUSES, digWord, type AnswerStatus } from "../status.ts";
import { ConfigService, type DigConfig } from "./config.ts";
import { costSummary, receiptCost, type CostAmount, type CostSummary, type ReceiptCost } from "./cost.ts";
import { LibraryError, RefusalError } from "./errors.ts";
import { frontMatter, reportParts } from "./markdown.ts";
import type { RetainedResponse } from "./http.ts";
import type { SourcePlugin } from "./plugin.ts";
import { ProgressHub } from "./progress.ts";
import { knownSecrets, redactRecord, redactValue, SECRET_NAME_PATTERN } from "./secrets.ts";

/**
 * Plain-file research archive (source of truth on disk) paired with an automatically
 * synchronized, rebuildable SQLite index (`library_digs`, `library_reports`, `library_calls`).
 */

export const TOPIC_VOLATILITIES = ["live", "fast", "medium", "slow", "reference"] as const;
export type TopicVolatility = (typeof TOPIC_VOLATILITIES)[number];

export const SESSION_UNAVAILABLE = "session-unavailable";
export const NO_DIG =
  "This call needs the dig handle that dig_start returns: call dig_start with the absolute project directory and the question, then pass its dig.";

const REPORT_SECTIONS = [
  "Summary",
  "Evidence Highlights",
  "Needs Follow-Up",
  "Negative Evidence (when relevant)",
] as const;

const quote = (value: unknown) => JSON.stringify(value);
const validToken = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,180}$/.test(value);
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 65) || "research";
const isValidReportName = (name: unknown): name is string =>
  typeof name === "string" &&
  /^[a-z0-9][a-z0-9-]*\.md$/.test(name) &&
  !["dig.md", "answer.md"].includes(name);

export function safeSegment(value: unknown, fallback: string): string {
  const cleaned =
    typeof value === "string"
      ? value
          .trim()
          .replace(/[^A-Za-z0-9._-]+/g, "-")
          .replace(/^[-.]+|[-.]+$/g, "")
          .slice(0, 120)
      : "";
  return cleaned || fallback;
}

export function projectFolder(project: string): string {
  if (!isAbsolute(project)) throw new LibraryError({ message: "project must be an explicit absolute project path" });
  const root = resolve(project);
  return `${slug(basename(root))}-${createHash("sha256").update(root).digest("hex").slice(0, 6)}`;
}

export const handleOf = (project: string, dig: string): string => `${projectFolder(project)}/${dig}`;
export const libraryUri = (file: string): string => `dig://library/${encodeURIComponent(file)}`;

export function withoutSecrets(
  args: Record<string, unknown>,
  declared: readonly string[] = [],
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  const allowed = declared.length ? new Set(declared) : null;
  for (const [key, val] of Object.entries(args)) {
    if (SECRET_NAME_PATTERN.test(key)) continue;
    if (allowed && !allowed.has(key)) continue;
    clean[key] = val;
  }
  return redactRecord(clean, knownSecrets());
}

function within(base: string, target: string): string {
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new LibraryError({ message: "Path is outside the library" });
  }
  return target;
}

async function contained(libraryRoot: string, target: string): Promise<string> {
  return within(await realpath(libraryRoot), await realpath(target));
}

async function ensureDirectory(libraryRoot: string, parts: readonly string[]): Promise<string> {
  await mkdir(libraryRoot, { recursive: true });
  const base = await realpath(libraryRoot);
  let cur = base;
  for (const part of parts) {
    if (!validToken(part)) throw new LibraryError({ message: "Invalid library directory identity" });
    cur = join(cur, part);
    try {
      await mkdir(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }
    cur = within(base, await realpath(cur));
  }
  return cur;
}

export interface ResolvedDig {
  readonly handle: string;
  readonly project: string;
  readonly dig: string;
  readonly folder: string;
  readonly path: string;
}

export interface Receipt extends ReceiptCost {
  readonly id: string;
  readonly at: string;
  readonly ms: number;
  readonly tool: string;
  readonly source: string;
  readonly status: string;
  readonly dig?: string;
  readonly raw?: string;
  readonly rawFile?: string | null;
  readonly claimedBy?: string | null;
  readonly error?: string;
  readonly attempts?: number;
  readonly args?: Record<string, unknown>;
}

export interface ReportDetail {
  readonly file: string;
  readonly source: string | null;
  readonly method: string | null;
  readonly supersedes: string | null;
  readonly summary: string;
  readonly at: string | null;
  readonly status: string | null;
}

export interface LibraryDigItem {
  readonly id: string;
  readonly dig: string;
  readonly project: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly snippet: string;
  readonly mode: string;
  readonly status: string;
  readonly answer: string | null;
  readonly session: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly planned: readonly string[];
  readonly refreshes: string | null;
  readonly sources: readonly string[];
  readonly methods: readonly string[];
  readonly files: readonly string[];
  readonly reports: readonly string[];
  readonly reportDetails: readonly ReportDetail[];
  readonly calls: readonly Receipt[];
}

export interface LibraryListing {
  readonly items: readonly LibraryDigItem[];
  readonly live: readonly (Receipt & { readonly projectFolder: string })[];
}

export interface ToolHistoryRow {
  readonly tool: string;
  readonly calls: number;
  readonly pricedCalls: number;
  readonly failedCalls: number;
  readonly medianMs: number | null;
  readonly typicalCost: readonly CostAmount[] | null;
  readonly totalCost: CostSummary;
}

export interface ReadFileResult {
  readonly file: string;
  readonly path: string;
  readonly text: string;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly totalCharacters: number;
}

function displayTitle(
  question: string,
  mode: string,
  reports: readonly { readonly title?: unknown; readonly topic?: unknown; readonly source?: unknown }[],
  answerTitle: unknown,
  sourceLabels: ReadonlyMap<string, string>,
): string {
  if (mode !== "single") {
    return typeof answerTitle === "string" &&
      answerTitle.trim() &&
      answerTitle.trim().length <= 140 &&
      answerTitle.trim().length < question.length
      ? answerTitle.trim()
      : question;
  }
  if (!reports.length) return question;
  const report = reports.at(-1)!;
  const title = typeof report.title === "string" ? report.title.trim() : "";
  if (
    title &&
    title !== question &&
    title.length <= 140 &&
    title.length < question.length &&
    title !== `${sourceLabels.get(String(report.source)) ?? report.source} research`
  ) {
    return title;
  }
  const topic = typeof report.topic === "string" ? report.topic : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic)) return question;
  const label = topic
    .replaceAll("-", " ")
    .replace(/\b(ai|api|mcp|ui|ux|seo|pdf|hn)\b/g, (w) => w.toUpperCase())
    .replace(/\bgithub\b/g, "GitHub");
  return label[0].toUpperCase() + label.slice(1);
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface LibraryServiceShape {
  readonly resolveHandle: (handle: unknown) => Effect.Effect<ResolvedDig, RefusalError>;
  readonly readFile: (
    file: string,
    offset?: number,
    limit?: number,
  ) => Effect.Effect<ReadFileResult, LibraryError>;
  readonly startDig: (input: {
    readonly project: string;
    readonly question: string;
    readonly planned?: readonly string[];
    readonly refreshes?: string;
    readonly mode?: "composed" | "single";
  }) => Effect.Effect<{ readonly dig: string; readonly handle: string; readonly project: string; readonly path: string }, LibraryError>;
  readonly saveReport: (input: {
    readonly dig: ResolvedDig;
    readonly source: string;
    readonly agent?: string;
    readonly content: string;
    readonly topic?: string;
    readonly topic_volatility?: TopicVolatility;
    readonly supersedes?: string;
  }) => Effect.Effect<{ readonly path: string; readonly file: string; readonly dig: string; readonly report: string }, LibraryError>;
  readonly finishDig: (input: {
    readonly dig: ResolvedDig;
    readonly answer: string;
    readonly status: AnswerStatus;
    readonly reports: readonly string[];
  }) => Effect.Effect<{ readonly path: string; readonly file: string; readonly dig: string }, LibraryError>;
  readonly recordCall: (input: {
    readonly dig: ResolvedDig;
    readonly tool: string;
    readonly source: string;
    readonly args: Record<string, unknown>;
    readonly declared?: readonly string[];
    readonly at: string;
    readonly ms: number;
    readonly status: string;
    readonly cost: unknown;
    readonly knownCost?: unknown;
    readonly responses: readonly RetainedResponse[];
    readonly error?: string;
    readonly callId?: string;
  }) => Effect.Effect<Receipt, LibraryError>;
  readonly syncIndex: () => Effect.Effect<void, LibraryError>;
  readonly listLibrary: () => Effect.Effect<LibraryListing, LibraryError>;
  readonly readDigCalls: (dig: ResolvedDig) => Effect.Effect<readonly Receipt[], LibraryError>;
  readonly digSpend: (dig: ResolvedDig) => Effect.Effect<CostSummary & { readonly calls: number }, LibraryError>;
  readonly toolHistory: (days?: number) => Effect.Effect<readonly ToolHistoryRow[], LibraryError>;
}

export class LibraryService extends Context.Service<LibraryService, LibraryServiceShape>()("dig/LibraryService") {}

export function makeLibraryLayer(
  plugins: readonly SourcePlugin[],
): Layer.Layer<LibraryService, never, ConfigService | SqlClient.SqlClient | ProgressHub> {
  const sourceLabels = new Map(plugins.map((p) => [p.id, p.label]));
  const reportSources = new Set(plugins.filter((p) => p.kind !== "tool").map((p) => p.id));
  const methodsBySource = new Map<string, Set<string>>();
  const allMethods = new Set<string>();
  for (const p of plugins) {
    if (p.kind === "tool") continue;
    const ms = new Set(p.skills ?? [p.id]);
    methodsBySource.set(p.id, ms);
    for (const m of ms) allMethods.add(m);
  }

  return Layer.effect(
    LibraryService,
    Effect.gen(function* () {
      const configSvc = yield* ConfigService;
      const sql = yield* SqlClient.SqlClient;
      const hub = yield* ProgressHub;

      const loadCfg = (): Effect.Effect<DigConfig, LibraryError> =>
        configSvc.load().pipe(Effect.mapError((e) => new LibraryError({ message: e.message, cause: e })));

      const isResearchFile = (segments: readonly string[]): boolean => {
        const [first, second, , fourth, fifth] = segments;
        if (segments.length === 2) return first === "youtube-transcripts" && second.endsWith(".md");
        if (segments.length === 4) {
          return (second === "digs" && fourth.endsWith(".md")) || (second === "sessions" && fourth === "calls.jsonl");
        }
        return segments.length === 5 && second === "sessions" && fourth === "raw" && fifth.endsWith(".json");
      };

      const readFileRaw = (
        c: DigConfig,
        file: string,
        offset = 0,
        limit = 60_000,
      ): Effect.Effect<ReadFileResult, LibraryError> =>
        Effect.tryPromise({
          try: async () => {
            const refused =
              "Only Dig research files can be read: a dig’s reports and answer, a session’s calls.jsonl and original responses (raw/*.json), and YouTube transcripts.";
            if (!file || typeof file !== "string" || !/\.(md|json|jsonl)$/.test(file)) {
              throw new LibraryError({ message: refused });
            }
            if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) {
              throw new LibraryError({ message: "Invalid read bounds" });
            }
            const target = isAbsolute(file) ? file : resolve(c.library, file);
            const safe = await contained(c.library, target);
            const root = await realpath(c.library);
            const segments = relative(root, safe).split(sep);
            if (!isResearchFile(segments)) {
              throw new LibraryError({ message: refused });
            }
            const full = await readFile(safe, "utf8");
            const clampedOffset = Math.max(0, Math.min(offset, full.length));
            const end = Math.min(full.length, clampedOffset + Math.max(1, limit));
            const rel = segments.join("/");
            return {
              file: rel,
              path: safe,
              text: full.slice(clampedOffset, end),
              offset: clampedOffset,
              nextOffset: end < full.length ? end : null,
              totalCharacters: full.length,
            };
          },
          catch: (e) =>
            e instanceof LibraryError
              ? e
              : new LibraryError({ message: e instanceof Error ? e.message : String(e), cause: e }),
        });

      const assertDigRaw = async (c: DigConfig, project: string, dig: string): Promise<string> => {
        if (!validToken(dig)) throw new LibraryError({ message: "Invalid dig id" });
        const path = await contained(c.library, join(c.library, projectFolder(project), "digs", dig));
        const text = await readFile(await contained(c.library, join(path, "dig.md")), "utf8");
        if (!text.includes(`project: ${quote(resolve(project))}\n`)) {
          throw new LibraryError({ message: "Project does not match this dig" });
        }
        if (!text.includes(`dig: ${quote(dig)}\n`)) {
          throw new LibraryError({ message: "Dig metadata does not match the requested dig" });
        }
        return path;
      };

      const resolveHandle = (handle: unknown): Effect.Effect<ResolvedDig, RefusalError> =>
        Effect.gen(function* () {
          const match =
            typeof handle === "string"
              ? /^([a-z0-9][a-z0-9-]{0,80})\/([a-zA-Z0-9_][a-zA-Z0-9._-]{0,180})$/.exec(handle)
              : null;
          if (!match) return yield* Effect.fail(new RefusalError({ message: NO_DIG }));
          const [, folder, dig] = match;
          const c = yield* loadCfg().pipe(Effect.mapError(() => new RefusalError({ message: NO_DIG })));
          const read = yield* readFileRaw(c, `${folder}/digs/${dig}/dig.md`, 0, Number.MAX_SAFE_INTEGER).pipe(
            Effect.mapError(() => new RefusalError({ message: NO_DIG })),
          );
          const meta = frontMatter(read.text).meta;
          const project = typeof meta.project === "string" ? meta.project : "";
          if (!project || !isAbsolute(project) || projectFolder(project) !== folder) {
            return yield* Effect.fail(new RefusalError({ message: NO_DIG }));
          }
          const path = yield* Effect.tryPromise({
            try: () => assertDigRaw(c, project, dig),
            catch: () => new RefusalError({ message: NO_DIG }),
          });
          return { handle: `${folder}/${dig}`, project: resolve(project), dig, folder, path };
        });

      /**
       * Walk `<library>` on disk and reconcile SQLite index tables (`library_digs`,
       * `library_reports`, `library_calls`). Safe to call repeatedly; rebuilds completely
       * if `dig.sqlite` was deleted or files were synced from another machine.
       */
      const syncIndex = (): Effect.Effect<void, LibraryError> =>
        Effect.gen(function* () {
          const c = yield* loadCfg();
          const scanned = yield* Effect.tryPromise({
            try: async () => {
              let projects;
              try {
                projects = await readdir(c.library, { withFileTypes: true });
              } catch (e) {
                if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException)?.code ?? "")) {
                  return { digs: [], reports: [], calls: [] };
                }
                throw e;
              }
              const digs: Array<Record<string, unknown>> = [];
              const reports: Array<Record<string, unknown>> = [];
              const calls: Array<Record<string, unknown>> = [];

              for (const proj of projects) {
                if (!proj.isDirectory() || proj.isSymbolicLink()) continue;
                const digsDir = join(c.library, proj.name, "digs");
                let digEntries: import("node:fs").Dirent[] = [];
                try {
                  digEntries = await readdir(await contained(c.library, digsDir), { withFileTypes: true });
                } catch {
                  digEntries = [];
                }

                for (const d of digEntries) {
                  if (!d.isDirectory() || d.isSymbolicLink()) continue;
                  const prefix = `${proj.name}/digs/${d.name}`;
                  let folder: string;
                  let digMdText: string;
                  let digMdStat;
                  try {
                    folder = await contained(c.library, join(c.library, prefix));
                    const digMdPath = await contained(c.library, join(folder, "dig.md"));
                    digMdStat = await stat(digMdPath);
                    digMdText = await readFile(digMdPath, "utf8");
                  } catch {
                    continue;
                  }
                  const meta = frontMatter(digMdText).meta;
                  const projectPath = typeof meta.project === "string" ? resolve(meta.project) : proj.name;
                  const digHandle = `${proj.name}/${d.name}`;
                  const mdNames = (await readdir(folder)).filter((f) => f.endsWith(".md")).sort();

                  const parsedReports: Array<{
                    name: string;
                    file: string;
                    source: string | null;
                    method: string | null;
                    title: string;
                    topic: string | null;
                    summary: string;
                    supersedes: string | null;
                    runStatus: string | null;
                    at: string | null;
                    sha256: string;
                    mtimeMs: number;
                    size: number;
                  }> = [];

                  for (const name of mdNames.filter((n) => n !== "dig.md" && n !== "answer.md")) {
                    try {
                      const fPath = await contained(c.library, join(folder, name));
                      const st = await stat(fPath);
                      const text = await readFile(fPath, "utf8");
                      const { meta: rMeta, body } = frontMatter(text);
                      const parts = reportParts(body);
                      const rTitle =
                        typeof rMeta.title === "string"
                          ? rMeta.title
                          : parts.headings.find((h) => h.depth === 1)?.text ?? name;
                      const entry = {
                        name,
                        file: `${prefix}/${name}`,
                        source: typeof rMeta.source === "string" ? rMeta.source : null,
                        method: typeof rMeta.agent === "string" ? rMeta.agent : null,
                        title: rTitle,
                        topic: typeof rMeta.topic === "string" ? rMeta.topic : null,
                        summary: parts.summary.trim().slice(0, 280),
                        supersedes: typeof rMeta.supersedes === "string" ? rMeta.supersedes : null,
                        runStatus: typeof parts.card?.fields?.status === "string" ? parts.card.fields.status : null,
                        at: typeof rMeta.generated_at === "string" ? rMeta.generated_at : null,
                        sha256: createHash("sha256").update(text).digest("hex"),
                        mtimeMs: st.mtimeMs,
                        size: st.size,
                      };
                      parsedReports.push(entry);
                      reports.push({ ...entry, digHandle, project: projectPath, digId: d.name, kind: "report" });
                    } catch {
                      // Skip unreadable report file during index sync
                    }
                  }

                  parsedReports.sort(
                    (a, b) =>
                      (a.at ? Date.parse(a.at) : 0) - (b.at ? Date.parse(b.at) : 0) ||
                      a.name.localeCompare(b.name, undefined, { numeric: true }),
                  );

                  let answerFile: string | null = null;
                  let answerMeta: Record<string, unknown> = {};
                  let answerSnippet = "";
                  let answerTitle: string | undefined;
                  if (mdNames.includes("answer.md")) {
                    try {
                      const aPath = await contained(c.library, join(folder, "answer.md"));
                      const st = await stat(aPath);
                      const text = await readFile(aPath, "utf8");
                      const parsed = frontMatter(text);
                      answerFile = `${prefix}/answer.md`;
                      answerMeta = parsed.meta;
                      answerSnippet = parsed.body.trim().slice(0, 280);
                      answerTitle = reportParts(parsed.body).headings.find((h) => h.depth === 1)?.text;
                      reports.push({
                        file: answerFile,
                        digHandle,
                        project: projectPath,
                        digId: d.name,
                        kind: "answer",
                        source: null,
                        method: null,
                        title: answerTitle ?? String(meta.question ?? d.name),
                        topic: null,
                        summary: answerSnippet,
                        supersedes: null,
                        runStatus: typeof answerMeta.status === "string" ? answerMeta.status : null,
                        at: typeof answerMeta.finished_at === "string" ? answerMeta.finished_at : null,
                        sha256: createHash("sha256").update(text).digest("hex"),
                        mtimeMs: st.mtimeMs,
                        size: st.size,
                      });
                    } catch {
                      // Ignore unreadable answer
                    }
                  }

                  const question = typeof meta.question === "string" ? meta.question : d.name;
                  const mode = typeof meta.mode === "string" ? meta.mode : "composed";
                  const snippet =
                    parsedReports[0]?.summary || (answerFile ? answerSnippet : "Research started; no report saved yet.");
                  const files = [
                    "dig.md",
                    ...parsedReports.map((r) => r.name),
                    ...(answerFile ? ["answer.md"] : []),
                  ].map((f) => `${prefix}/${f}`);

                  digs.push({
                    digHandle,
                    projectFolder: proj.name,
                    digId: d.name,
                    project: projectPath,
                    title: question,
                    displayTitle: displayTitle(question, mode, parsedReports, answerTitle, sourceLabels),
                    snippet,
                    mode,
                    status: digWord(answerMeta.status, { answer: answerFile, reports: parsedReports.length }),
                    sessionId: typeof meta.session === "string" ? meta.session : null,
                    startedAt: typeof meta.started_at === "string" ? meta.started_at : null,
                    finishedAt: typeof answerMeta.finished_at === "string" ? answerMeta.finished_at : null,
                    answerFile,
                    plannedJson: JSON.stringify(Array.isArray(meta.planned) ? meta.planned : []),
                    refreshes: typeof meta.refreshes === "string" ? meta.refreshes : null,
                    sourcesJson: JSON.stringify([...new Set(parsedReports.map((r) => r.source).filter(Boolean))]),
                    methodsJson: JSON.stringify([...new Set(parsedReports.map((r) => r.method).filter(Boolean))]),
                    filesJson: JSON.stringify(files),
                    reportsJson: JSON.stringify(parsedReports.map((r) => r.file)),
                    mtimeMs: digMdStat.mtimeMs,
                  });
                }

                // Sessions / receipts
                const sessionsDir = join(c.library, proj.name, "sessions");
                let sessionEntries: import("node:fs").Dirent[] = [];
                try {
                  sessionEntries = await readdir(await contained(c.library, sessionsDir), { withFileTypes: true });
                } catch {
                  sessionEntries = [];
                }
                for (const s of sessionEntries) {
                  if (!s.isDirectory() || s.isSymbolicLink()) continue;
                  try {
                    const callsFile = await contained(c.library, join(sessionsDir, s.name, "calls.jsonl"));
                    const text = await readFile(callsFile, "utf8");
                    for (const line of text.split("\n")) {
                      if (!line.trim()) continue;
                      let parsed: Record<string, unknown>;
                      try {
                        parsed = JSON.parse(line) as Record<string, unknown>;
                      } catch {
                        continue;
                      }
                      if (typeof parsed.id !== "string" || typeof parsed.tool !== "string") continue;
                      const digId = typeof parsed.dig === "string" ? parsed.dig : null;
                      calls.push({
                        receiptId: parsed.id,
                        projectFolder: proj.name,
                        sessionFolder: s.name,
                        digHandle: digId ? `${proj.name}/${digId}` : null,
                        digId,
                        source: typeof parsed.source === "string" ? parsed.source : "unknown",
                        tool: parsed.tool,
                        status: typeof parsed.status === "string" ? parsed.status : "unknown",
                        at: typeof parsed.at === "string" ? parsed.at : new Date(0).toISOString(),
                        ms: typeof parsed.ms === "number" ? Math.round(parsed.ms) : 0,
                        costJson: parsed.cost === undefined ? null : JSON.stringify(parsed.cost),
                        knownCostJson: parsed.knownCost === undefined ? null : JSON.stringify(parsed.knownCost),
                        rawFile: typeof parsed.raw === "string" ? parsed.raw : null,
                        error: typeof parsed.error === "string" ? parsed.error : null,
                        argsJson: JSON.stringify(parsed.args ?? {}),
                        attempts: typeof parsed.attempts === "number" ? parsed.attempts : null,
                      });
                    }
                  } catch {
                    // Missing or unreadable calls.jsonl
                  }
                }
              }

              return { digs, reports, calls };
            },
            catch: (e) =>
              e instanceof LibraryError
                ? e
                : new LibraryError({ message: `Library sync failed: ${e instanceof Error ? e.message : String(e)}`, cause: e }),
          });

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM library_digs`;
                yield* sql`DELETE FROM library_reports`;
                yield* sql`DELETE FROM library_calls`;

                for (const d of scanned.digs) {
                  yield* sql`
                    INSERT INTO library_digs (
                      dig_handle, project_folder, dig_id, project, title, display_title, snippet,
                      mode, status, session_id, started_at, finished_at, answer_file, planned_json,
                      refreshes, sources_json, methods_json, files_json, reports_json, mtime_ms
                    ) VALUES (
                      ${d.digHandle as string}, ${d.projectFolder as string}, ${d.digId as string},
                      ${d.project as string}, ${d.title as string}, ${d.displayTitle as string},
                      ${d.snippet as string}, ${d.mode as string}, ${d.status as string},
                      ${d.sessionId as string | null}, ${d.startedAt as string | null},
                      ${d.finishedAt as string | null}, ${d.answerFile as string | null},
                      ${d.plannedJson as string}, ${d.refreshes as string | null},
                      ${d.sourcesJson as string}, ${d.methodsJson as string},
                      ${d.filesJson as string}, ${d.reportsJson as string}, ${d.mtimeMs as number}
                    )
                  `;
                }

                for (const r of scanned.reports) {
                  yield* sql`
                    INSERT INTO library_reports (
                      file, dig_handle, project, dig_id, kind, source, method, title, topic,
                      summary, supersedes, superseded, run_status, at, sha256, mtime_ms, size_bytes
                    ) VALUES (
                      ${r.file as string}, ${r.digHandle as string}, ${r.project as string},
                      ${r.digId as string}, ${r.kind as string}, ${r.source as string | null},
                      ${r.method as string | null}, ${r.title as string}, ${r.topic as string | null},
                      ${r.summary as string}, ${r.supersedes as string | null}, 0,
                      ${r.runStatus as string | null}, ${r.at as string | null},
                      ${r.sha256 as string}, ${r.mtimeMs as number}, ${r.size as number}
                    )
                  `;
                }

                for (const cRow of scanned.calls) {
                  yield* sql`
                    INSERT OR REPLACE INTO library_calls (
                      receipt_id, project_folder, session_folder, dig_handle, dig_id, source,
                      tool, status, at, ms, cost_json, known_cost_json, raw_file, error, args_json, attempts
                    ) VALUES (
                      ${cRow.receiptId as string}, ${cRow.projectFolder as string},
                      ${cRow.sessionFolder as string}, ${cRow.digHandle as string | null},
                      ${cRow.digId as string | null}, ${cRow.source as string},
                      ${cRow.tool as string}, ${cRow.status as string}, ${cRow.at as string},
                      ${cRow.ms as number}, ${cRow.costJson as string | null},
                      ${cRow.knownCostJson as string | null}, ${cRow.rawFile as string | null},
                      ${cRow.error as string | null}, ${cRow.argsJson as string},
                      ${cRow.attempts as number | null}
                    )
                  `;
                }
              }),
            )
            .pipe(Effect.mapError((e) => new LibraryError({ message: "SQLite library index update failed", cause: e })));
        });

      const rowToReceipt = (row: Record<string, unknown>): Receipt => {
        const parsedCost = row.cost_json !== null && row.cost_json !== undefined ? JSON.parse(String(row.cost_json)) : null;
        const parsedKnown =
          row.known_cost_json !== null && row.known_cost_json !== undefined
            ? JSON.parse(String(row.known_cost_json))
            : undefined;
        const rawRel = row.raw_file ? String(row.raw_file) : undefined;
        const rawFile =
          rawRel && row.project_folder && row.session_folder
            ? `${String(row.project_folder)}/sessions/${String(row.session_folder)}/${rawRel}`
            : null;
        return {
          id: String(row.receipt_id),
          at: String(row.at),
          ms: Number(row.ms ?? 0),
          tool: String(row.tool),
          source: String(row.source),
          status: String(row.status),
          ...(row.dig_id ? { dig: String(row.dig_id) } : {}),
          ...(rawRel ? { raw: rawRel } : {}),
          rawFile,
          claimedBy: null,
          ...(row.error ? { error: String(row.error) } : {}),
          ...(row.attempts !== null && row.attempts !== undefined ? { attempts: Number(row.attempts) } : {}),
          args: row.args_json ? (JSON.parse(String(row.args_json)) as Record<string, unknown>) : {},
          cost: parsedCost,
          ...(parsedKnown ? { knownCost: parsedKnown } : {}),
        };
      };

      const listLibrary = (): Effect.Effect<LibraryListing, LibraryError> =>
        Effect.gen(function* () {
          yield* syncIndex();
          const digRows = yield* sql<Record<string, unknown>>`
            SELECT * FROM library_digs ORDER BY COALESCE(started_at, '') DESC, dig_handle ASC
          `.pipe(Effect.mapError((e) => new LibraryError({ message: "Failed to query library_digs", cause: e })));

          const reportRows = yield* sql<Record<string, unknown>>`
            SELECT * FROM library_reports WHERE kind = 'report' ORDER BY COALESCE(at, '') ASC, file ASC
          `.pipe(Effect.mapError((e) => new LibraryError({ message: "Failed to query library_reports", cause: e })));

          const callRows = yield* sql<Record<string, unknown>>`
            SELECT * FROM library_calls ORDER BY at ASC, receipt_id ASC
          `.pipe(Effect.mapError((e) => new LibraryError({ message: "Failed to query library_calls", cause: e })));

          const reportsByDig = new Map<string, ReportDetail[]>();
          for (const r of reportRows) {
            const handle = String(r.dig_handle);
            const list = reportsByDig.get(handle) ?? [];
            list.push({
              file: String(r.file),
              source: r.source ? String(r.source) : null,
              method: r.method ? String(r.method) : null,
              supersedes: r.supersedes ? String(r.supersedes) : null,
              summary: String(r.summary ?? ""),
              at: r.at ? String(r.at) : null,
              status: r.run_status ? String(r.run_status) : null,
            });
            reportsByDig.set(handle, list);
          }

          type DigRowInfo = {
            readonly handle: string;
            readonly projectFolder: string;
            readonly sessionId: string | null;
            readonly answerFile: string | null;
            readonly finishedAt: string | null;
            readonly reports: readonly ReportDetail[];
          };
          const digInfoByHandle = new Map<string, DigRowInfo>();
          const digsByProjectSession = new Map<string, DigRowInfo[]>();
          for (const d of digRows) {
            const handle = String(d.dig_handle);
            const info: DigRowInfo = {
              handle,
              projectFolder: String(d.project_folder),
              sessionId: d.session_id ? String(d.session_id) : null,
              answerFile: d.answer_file ? String(d.answer_file) : null,
              finishedAt: d.finished_at ? String(d.finished_at) : null,
              reports: reportsByDig.get(handle) ?? [],
            };
            digInfoByHandle.set(handle, info);
            if (info.sessionId) {
              const key = `${info.projectFolder}\0${info.sessionId}`;
              const bucket = digsByProjectSession.get(key) ?? [];
              bucket.push(info);
              digsByProjectSession.set(key, bucket);
            }
          }

          const claimForDig = (dig: DigRowInfo, receipt: Receipt, sessionFolder: string): string | null => {
            if (dig.sessionId && sessionFolder && dig.sessionId !== sessionFolder) return null;
            const callMs = Date.parse(receipt.at);
            const validCallMs = Number.isFinite(callMs);
            const sameSourceReport = dig.reports.find((report) => {
              if (report.source !== receipt.source) return false;
              if (!validCallMs || !report.at) return true;
              const repMs = Date.parse(report.at);
              return !Number.isFinite(repMs) || repMs >= callMs;
            });
            if (sameSourceReport) return sameSourceReport.file;
            if (dig.answerFile) {
              const finMs = dig.finishedAt ? Date.parse(dig.finishedAt) : NaN;
              if (!validCallMs || !Number.isFinite(finMs) || finMs >= callMs) return dig.answerFile;
            }
            return null;
          };

          const callsByDig = new Map<string, Receipt[]>();
          const live: (Receipt & { readonly projectFolder: string })[] = [];
          for (const cRow of callRows) {
            const receipt = rowToReceipt(cRow);
            const sessionFolder = String(cRow.session_folder ?? "");
            const projFolder = String(cRow.project_folder ?? "");
            if (cRow.dig_handle) {
              const handle = String(cRow.dig_handle);
              const digInfo = digInfoByHandle.get(handle);
              if (digInfo) {
                const claimedBy = claimForDig(digInfo, receipt, sessionFolder);
                const list = callsByDig.get(handle) ?? [];
                list.push({ ...receipt, claimedBy });
                callsByDig.set(handle, list);
              } else {
                // Dig folder was removed on disk; preserve receipt in live activity instead of dropping it.
                live.push({ ...receipt, projectFolder: projFolder });
              }
            } else {
              // Legacy pre-1.0 receipt without `dig`: attribute to the first later save in the same session.
              const candidates = digsByProjectSession.get(`${projFolder}\0${sessionFolder}`) ?? [];
              const callMs = Date.parse(receipt.at);
              let best: { handle: string; file: string; atMs: number } | null = null;
              for (const digInfo of candidates) {
                for (const report of digInfo.reports) {
                  if (report.source !== receipt.source) continue;
                  const repMs = report.at ? Date.parse(report.at) : Infinity;
                  if (Number.isFinite(callMs) && repMs < callMs) continue;
                  if (!best || repMs < best.atMs) best = { handle: digInfo.handle, file: report.file, atMs: repMs };
                }
                if (digInfo.answerFile) {
                  const finMs = digInfo.finishedAt ? Date.parse(digInfo.finishedAt) : Infinity;
                  if (!Number.isFinite(callMs) || finMs >= callMs) {
                    if (!best || finMs < best.atMs) best = { handle: digInfo.handle, file: digInfo.answerFile, atMs: finMs };
                  }
                }
              }
              if (best) {
                const list = callsByDig.get(best.handle) ?? [];
                list.push({ ...receipt, claimedBy: best.file });
                callsByDig.set(best.handle, list);
              } else {
                live.push({ ...receipt, projectFolder: projFolder });
              }
            }
          }

          const items: LibraryDigItem[] = digRows.map((d) => {
            const handle = String(d.dig_handle);
            return {
              id: String(d.dig_id),
              dig: handle,
              project: String(d.project),
              title: String(d.title),
              displayTitle: String(d.display_title),
              snippet: String(d.snippet),
              mode: String(d.mode),
              status: String(d.status),
              answer: d.answer_file ? String(d.answer_file) : null,
              session: d.session_id ? String(d.session_id) : null,
              startedAt: d.started_at ? String(d.started_at) : null,
              finishedAt: d.finished_at ? String(d.finished_at) : null,
              planned: JSON.parse(String(d.planned_json)) as string[],
              refreshes: d.refreshes ? String(d.refreshes) : null,
              sources: JSON.parse(String(d.sources_json)) as string[],
              methods: JSON.parse(String(d.methods_json)) as string[],
              files: JSON.parse(String(d.files_json)) as string[],
              reports: JSON.parse(String(d.reports_json)) as string[],
              reportDetails: reportsByDig.get(handle) ?? [],
              calls: callsByDig.get(handle) ?? [],
            };
          });

          return { items, live };
        });

      const readDigCalls = (dig: ResolvedDig): Effect.Effect<readonly Receipt[], LibraryError> =>
        Effect.gen(function* () {
          const c = yield* loadCfg();
          const file = `${dig.folder}/sessions/${safeSegment(dig.dig, SESSION_UNAVAILABLE)}/calls.jsonl`;
          return yield* Effect.tryPromise({
            try: async () => {
              const target = join(c.library, file);
              let text: string;
              try {
                text = await readFile(await contained(c.library, target), "utf8");
              } catch (e) {
                if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
                throw e;
              }
              return text
                .trim()
                .split("\n")
                .filter(Boolean)
                .flatMap((line) => {
                  try {
                    const parsed = JSON.parse(line) as Receipt;
                    return parsed?.dig === dig.dig ? [parsed] : [];
                  } catch {
                    return [];
                  }
                });
            },
            catch: (e) =>
              e instanceof LibraryError
                ? e
                : new LibraryError({ message: `Cannot read calls for ${dig.handle}`, cause: e }),
          });
        });

      const digSpend = (dig: ResolvedDig): Effect.Effect<CostSummary & { readonly calls: number }, LibraryError> =>
        Effect.map(readDigCalls(dig), (calls) => ({ calls: calls.length, ...costSummary(calls) }));

      const toolHistory = (days = 90): Effect.Effect<readonly ToolHistoryRow[], LibraryError> =>
        Effect.gen(function* () {
          const counts = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM library_digs`.pipe(
            Effect.orElseSucceed(() => [{ n: 0 }]),
          );
          if (Number(counts[0]?.n ?? 0) === 0) {
            yield* syncIndex();
          }
          const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
          const rows = yield* sql<Record<string, unknown>>`
            SELECT * FROM library_calls WHERE at >= ${cutoff} ORDER BY at DESC
          `.pipe(Effect.mapError((e) => new LibraryError({ message: "Failed to query tool history", cause: e })));

          const byTool = new Map<string, Receipt[]>();
          for (const row of rows) {
            const r = rowToReceipt(row);
            if (r.status === "cancelled" || r.status === "skipped") continue;
            const list = byTool.get(r.tool) ?? [];
            list.push(r);
            byTool.set(r.tool, list);
          }

          const out: ToolHistoryRow[] = [];
          for (const [tool, receipts] of byTool) {
            const priced = receipts.filter((r) => r.cost !== null);
            const units = [...new Set(priced.flatMap((r) => (r.cost ?? []).map((a) => a.unit)))].sort();
            const typicalCost: CostAmount[] | null = priced.length
              ? units
                  .map((unit) => ({
                    unit,
                    amount: median(priced.map((r) => (r.cost ?? []).find((a) => a.unit === unit)?.amount ?? 0)) ?? 0,
                  }))
                  .filter(({ amount }) => amount > 0)
              : null;
            out.push({
              tool,
              calls: receipts.length,
              pricedCalls: priced.length,
              failedCalls: receipts.filter((r) => ["failed", "cancelled"].includes(r.status)).length,
              medianMs: median(receipts.map((r) => r.ms).filter((m) => Number.isFinite(m) && m >= 0)),
              typicalCost,
              totalCost: costSummary(receipts),
            });
          }
          return out.sort((a, b) => a.tool.localeCompare(b.tool));
        });

      const startDig: LibraryServiceShape["startDig"] = ({
        project,
        question,
        planned = [],
        refreshes,
        mode = "composed",
      }) =>
        Effect.gen(function* () {
          const c = yield* loadCfg();
          const cleanQuestion = question.trim();
          if (!cleanQuestion) return yield* Effect.fail(new LibraryError({ message: "The original question is required" }));
          if (!isAbsolute(project)) {
            return yield* Effect.fail(new LibraryError({ message: "project must be an explicit absolute project path" }));
          }
          const plannedBad = planned.find((name) => !allMethods.has(name));
          if (plannedBad) {
            return yield* Effect.fail(
              new LibraryError({ message: `planned must name source methods from source_info (unknown: ${plannedBad})` }),
            );
          }

          const created = yield* Effect.tryPromise({
            try: async () => {
              if (!(await stat(await realpath(project))).isDirectory()) {
                throw new LibraryError({ message: "project must be an existing directory" });
              }
              const cleanRefreshes = refreshes?.includes("/") ? refreshes.split("/").at(-1) : refreshes;
              if (cleanRefreshes) await assertDigRaw(c, project, cleanRefreshes);

              const at = new Date().toISOString();
              const baseSlug = slug(cleanQuestion).replace(/-+$/, "") || "research";
              const base = `${at.slice(0, 10)}-${at.slice(11, 16).replace(":", "")}-${baseSlug}`;
              const folder = projectFolder(project);
              const digsRoot = await ensureDirectory(c.library, [folder, "digs"]);

              for (let n = 1; n < 1000; n++) {
                const dig = n === 1 ? base : `${base}-${n}`;
                const path = join(digsRoot, dig);
                try {
                  await mkdir(path);
                } catch (e) {
                  if ((e as NodeJS.ErrnoException)?.code === "EEXIST") continue;
                  throw e;
                }
                const digMd = [
                  "---",
                  `dig: ${quote(dig)}`,
                  `question: ${quote(cleanQuestion)}`,
                  `project: ${quote(resolve(project))}`,
                  `mode: ${mode}`,
                  `started_at: ${quote(at)}`,
                  `session: ${quote(dig)}`,
                  ...(planned.length ? [`planned: ${JSON.stringify(planned)}`] : []),
                  ...(cleanRefreshes ? [`refreshes: ${quote(cleanRefreshes)}`] : []),
                  "---",
                  `# ${cleanQuestion.replaceAll("\n", " ")}`,
                  "",
                ].join("\n");
                await writeFile(join(path, "dig.md"), digMd, { flag: "wx" });
                return { dig, handle: `${folder}/${dig}`, project: resolve(project), path };
              }
              throw new LibraryError({ message: "Cannot allocate a unique dig id" });
            },
            catch: (e) =>
              e instanceof LibraryError
                ? e
                : new LibraryError({ message: e instanceof Error ? e.message : String(e), cause: e }),
          });

          yield* syncIndex().pipe(Effect.ignore);
          yield* hub.publish({ type: "library_changed", at: new Date().toISOString(), dig: created.handle });
          return created;
        });

      const saveReport: LibraryServiceShape["saveReport"] = ({
        dig,
        source,
        agent = source,
        content,
        topic,
        topic_volatility,
        supersedes,
      }) =>
        Effect.gen(function* () {
          const c = yield* loadCfg();
          if (!reportSources.has(source)) {
            return yield* Effect.fail(new LibraryError({ message: "source must name a report source from source_info" }));
          }
          if (!methodsBySource.get(source)?.has(agent)) {
            return yield* Effect.fail(new LibraryError({ message: `agent must name a ${source} source method from source_info` }));
          }
          const parts = reportParts(content);
          if (!parts.card) {
            return yield* Effect.fail(
              new LibraryError({
                message:
                  "The report must begin with its source_card block: a ```yaml fenced block whose first line is source_card:, closed by its fence",
              }),
            );
          }
          const sections = new Set(parts.headings.filter((h) => h.depth === 2).map((h) => h.text));
          for (const section of REPORT_SECTIONS) {
            if (!sections.has(section)) {
              return yield* Effect.fail(
                new LibraryError({
                  message: `Missing report section: ${section} (a "## ${section}" heading outside code, lists and quotes)`,
                }),
              );
            }
          }
          if (topic && (topic.length > 50 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic))) {
            return yield* Effect.fail(
              new LibraryError({ message: "topic must be lowercase, hyphenated and at most 50 characters" }),
            );
          }

          const saved = yield* Effect.tryPromise({
            try: async () => {
              const folder = await assertDigRaw(c, dig.project, dig.dig);
              if (supersedes) {
                if (!isValidReportName(supersedes)) throw new LibraryError({ message: "Invalid supersedes report reference" });
                await readFile(await contained(c.library, join(folder, supersedes)));
              }
              const title =
                parts.headings.find((h) => h.depth === 1)?.text ??
                topic ??
                `${sourceLabels.get(source) ?? source} research`;
              const at = new Date().toISOString();
              const root = await realpath(c.library);

              for (let n = 1; n < 1000; n++) {
                const name = n === 1 ? `${agent}.md` : `${agent}-${n}.md`;
                const target = join(folder, name);
                const head = [
                  "---",
                  `title: ${quote(title)}`,
                  `dig: ${quote(dig.dig)}`,
                  `source: ${source}`,
                  `agent: ${agent}`,
                  ...(topic ? [`topic: ${quote(topic)}`] : []),
                  ...(topic_volatility ? [`topic_volatility: ${quote(topic_volatility)}`] : []),
                  `generated_at: ${quote(at)}`,
                  `project: ${quote(resolve(dig.project))}`,
                  `session: ${quote(dig.dig)}`,
                  ...(supersedes ? [`supersedes: ${quote(supersedes)}`] : []),
                  "---",
                  "",
                ].join("\n");
                try {
                  await writeFile(target, head + content, { flag: "wx" });
                  const rel = relative(root, target).split(sep).join("/");
                  return { path: target, file: rel, dig: dig.handle, report: name };
                } catch (e) {
                  if ((e as NodeJS.ErrnoException)?.code === "EEXIST") continue;
                  throw e;
                }
              }
              throw new LibraryError({ message: "Cannot allocate report filename" });
            },
            catch: (e) =>
              e instanceof LibraryError
                ? e
                : new LibraryError({ message: e instanceof Error ? e.message : String(e), cause: e }),
          });

          yield* syncIndex().pipe(Effect.ignore);
          yield* hub.publish({ type: "library_changed", at: new Date().toISOString(), dig: dig.handle });
          return saved;
        });

      const finishDig: LibraryServiceShape["finishDig"] = ({ dig, answer, status, reports }) =>
        Effect.gen(function* () {
          const c = yield* loadCfg();
          if (!ANSWER_STATUSES.includes(status)) {
            return yield* Effect.fail(new LibraryError({ message: `status must be one of ${ANSWER_STATUSES.join(", ")}` }));
          }

          const finished = yield* Effect.tryPromise({
            try: async () => {
              const folder = await assertDigRaw(c, dig.project, dig.dig);
              const meta = frontMatter(await readFile(join(folder, "dig.md"), "utf8")).meta;
              if (meta.mode !== "composed") {
                throw new LibraryError({ message: "dig_finish answers only digs created with dig_start" });
              }
              const names: string[] = [];
              for (const report of reports) {
                let name = report;
                if (!isValidReportName(name)) {
                  const p = await contained(c.library, isAbsolute(report) ? report : resolve(c.library, report));
                  if (dirname(p) !== folder) throw new LibraryError({ message: "Report reference must belong to this dig" });
                  name = basename(p);
                }
                if (!isValidReportName(name)) {
                  throw new LibraryError({ message: "reports must name saved source reports in this dig" });
                }
                const target = await contained(c.library, join(folder, name));
                if (dirname(target) !== folder) throw new LibraryError({ message: "Report reference must belong to this dig" });
                await readFile(target);
                names.push(name);
              }
              if (status === "answered" && names.length === 0) {
                throw new LibraryError({ message: "An answered dig must name its source reports" });
              }
              const target = join(folder, "answer.md");
              const body = `---\ndig: ${quote(dig.dig)}\nfinished_at: ${quote(new Date().toISOString())}\nstatus: ${status}\nreports: ${JSON.stringify(names)}\n---\n${answer}`;
              await writeFile(target, body, { flag: "wx" });
              const root = await realpath(c.library);
              return { path: target, file: relative(root, target).split(sep).join("/"), dig: dig.handle };
            },
            catch: (e) =>
              e instanceof LibraryError
                ? e
                : new LibraryError({ message: e instanceof Error ? e.message : String(e), cause: e }),
          });

          yield* syncIndex().pipe(Effect.ignore);
          yield* hub.publish({ type: "library_changed", at: new Date().toISOString(), dig: dig.handle });
          return finished;
        });

      const recordCall: LibraryServiceShape["recordCall"] = ({
        dig,
        tool,
        source,
        args,
        declared = [],
        at,
        ms,
        status,
        cost,
        knownCost,
        responses,
        error,
        callId,
      }) =>
        Effect.gen(function* () {
          const c = yield* loadCfg();
          const pricing = yield* Effect.try({
            try: () => receiptCost({ cost, ...(knownCost !== undefined ? { knownCost } : {}) }),
            catch: (e) => new LibraryError({ message: e instanceof Error ? e.message : String(e), cause: e }),
          });

          const receipt = yield* Effect.tryPromise({
            try: async () => {
              await assertDigRaw(c, dig.project, dig.dig);
              const generated = () => `c-${at.replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
              let id = callId ? safeSegment(callId, generated()) : generated();
              const sessionFolder = safeSegment(dig.dig, SESSION_UNAVAILABLE);
              const folder = await ensureDirectory(c.library, [dig.folder, "sessions", sessionFolder]);

              const secrets = knownSecrets();
              const redactedResponses = redactValue(responses, secrets) as RetainedResponse[];
              let rawRel: string | undefined;

              if (c.keep_raw && redactedResponses.length) {
                await ensureDirectory(c.library, [dig.folder, "sessions", sessionFolder, "raw"]);
                const rawPayload = JSON.stringify(
                  {
                    tool,
                    at,
                    responses: redactedResponses.map(({ label, status: st, body, headers }) => ({
                      label,
                      status: st,
                      body,
                      ...(typeof headers?.["scrape.do-request-cost"] === "string"
                        ? { headers: { "scrape.do-request-cost": headers["scrape.do-request-cost"] } }
                        : {}),
                    })),
                  },
                  null,
                  2,
                );
                for (let attempt = 0; ; attempt++) {
                  try {
                    await writeFile(join(folder, "raw", `${id}.json`), rawPayload, { flag: "wx" });
                    break;
                  } catch (e) {
                    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST" || attempt > 2) throw e;
                    id = generated();
                  }
                }
                rawRel = `raw/${id}.json`;
              }

              const rec: Receipt = {
                id,
                at,
                ms: Math.max(0, Math.round(ms)),
                tool,
                source,
                status,
                dig: dig.dig,
                args: withoutSecrets(args, declared),
                ...pricing,
                ...(redactedResponses.length ? { attempts: redactedResponses.length } : {}),
                ...(rawRel ? { raw: rawRel } : {}),
                ...(error ? { error } : {}),
              };

              const callsPath = join(folder, "calls.jsonl");
              try {
                if ((await lstat(callsPath)).isSymbolicLink()) {
                  throw new LibraryError({ message: "Call receipts cannot be a symbolic link" });
                }
                await contained(c.library, callsPath);
              } catch (e) {
                if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
              }
              await appendFile(callsPath, `${JSON.stringify(rec)}\n`);
              return rec;
            },
            catch: (e) =>
              e instanceof LibraryError
                ? e
                : new LibraryError({ message: e instanceof Error ? e.message : String(e), cause: e }),
          });

          // Upsert immediately into SQLite calls index so O(1) queries see it right away.
          yield* sql`
            INSERT OR REPLACE INTO library_calls (
              receipt_id, project_folder, session_folder, dig_handle, dig_id, source,
              tool, status, at, ms, cost_json, known_cost_json, raw_file, error, args_json, attempts
            ) VALUES (
              ${receipt.id}, ${dig.folder}, ${safeSegment(dig.dig, SESSION_UNAVAILABLE)},
              ${dig.handle}, ${dig.dig}, ${receipt.source}, ${receipt.tool}, ${receipt.status},
              ${receipt.at}, ${receipt.ms},
              ${receipt.cost === null ? null : JSON.stringify(receipt.cost)},
              ${receipt.knownCost ? JSON.stringify(receipt.knownCost) : null},
              ${receipt.raw ?? null}, ${receipt.error ?? null},
              ${JSON.stringify(receipt.args ?? {})}, ${receipt.attempts ?? null}
            )
          `.pipe(Effect.ignore);

          yield* hub.publish({ type: "library_changed", at: new Date().toISOString(), dig: dig.handle });
          return receipt;
        });

      return LibraryService.of({
        resolveHandle,
        readFile: (file, offset, limit) => Effect.flatMap(loadCfg(), (c) => readFileRaw(c, file, offset, limit)),
        startDig,
        saveReport,
        finishDig,
        recordCall,
        syncIndex,
        listLibrary,
        readDigCalls,
        digSpend,
        toolHistory,
      });
    }),
  );
}
