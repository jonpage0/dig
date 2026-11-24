import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { costSummary } from "../../core/cost.ts";
import type { LibraryDigItem, Receipt } from "../../core/library.ts";
import { frontMatter, reportParts } from "../../core/markdown.ts";
import { answerWord, callWord, digWord, patternOf } from "../../status.ts";
import { fileKind } from "../../ui/catalog.ts";
import {
  absTime,
  basename,
  callOutcome,
  costShort,
  costTotal,
  duration,
  plural,
} from "../../ui/format.ts";
import { readLibraryFile } from "../api/client.ts";
import { libraryAtom, resultData, resultLoading } from "../state/atoms.ts";
import { useDigCatalog, useSourceLogoMap } from "../state/catalog.ts";
import { MarkdownView } from "../components/MarkdownView.tsx";
import { RawEvidenceView } from "../components/RawEvidenceView.tsx";
import { SourceCardView } from "../components/SourceCardView.tsx";
import { SourceIcon } from "../components/SourceIcon.tsx";
import { Badge, Button, Disclosure } from "../shared/components.tsx";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "../shared/frame.tsx";
import { cn } from "../shared/utils.ts";

interface LoadedFileState {
  readonly file: string;
  readonly loading: boolean;
  readonly text: string | null;
  readonly error: string | null;
  readonly truncated: boolean;
  readonly totalCharacters: number;
}

function statusTone(word: string): "neutral" | "success" | "partial" | "warning" | "muted" {
  const pattern = patternOf(word);
  if (pattern === "solid") return "success";
  if (pattern === "stripes") return "partial";
  if (pattern === "warning") return "warning";
  return "muted";
}

function defaultFileFor(item: LibraryDigItem): string | null {
  if (item.answer) return item.answer;
  if (item.reports.length > 0) return item.reports[item.reports.length - 1];
  return item.files[0] ?? null;
}

function sortDigFiles(files: readonly string[]): string[] {
  const rank = (f: string): number => {
    const k = fileKind(f);
    if (k === "answer") return 0;
    if (k === "report") return 1;
    if (k === "question") return 2;
    return 3;
  };
  return [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function DigDetailPage() {
  const { project, dig } = useParams({ strict: false }) as { project?: string; dig?: string };
  const search = useSearch({ strict: false }) as { file?: string };
  const navigate = useNavigate();

  const libraryResult = useAtomValue(libraryAtom);
  const snapshot = resultData(libraryResult);
  const loadingSnapshot = resultLoading(libraryResult);
  const catalog = useDigCatalog(snapshot);
  const logoMap = useSourceLogoMap(snapshot);

  const item = useMemo(() => {
    if (!snapshot || !project || !dig) return undefined;
    const handle = `${project}/${dig}`;
    return (
      snapshot.items.find((d) => d.dig === handle) ??
      snapshot.items.find(
        (d) =>
          d.id === dig &&
          (d.dig.startsWith(`${project}/`) ||
            d.project === project ||
            encodeURIComponent(d.project) === project),
      )
    );
  }, [snapshot, project, dig]);

  const orderedFiles = useMemo(() => (item ? sortDigFiles(item.files) : []), [item]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [docState, setDocState] = useState<LoadedFileState | null>(null);

  // Side-pane raw evidence drawer state.
  const [inspectCall, setInspectCall] = useState<Receipt | null>(null);
  const [rawState, setRawState] = useState<LoadedFileState | null>(null);

  // Sync selected file from `?file=` param or default primary file.
  useEffect(() => {
    if (!item) return;
    if (search.file && (item.files.includes(search.file) || search.file.endsWith(".json"))) {
      setSelectedFile(search.file);
      return;
    }
    setSelectedFile((prev) =>
      prev && item.files.includes(prev) ? prev : defaultFileFor(item),
    );
  }, [item, search.file]);

  // Fetch active Markdown/text document via `POST /api/library/read`.
  useEffect(() => {
    if (!selectedFile) {
      setDocState(null);
      return;
    }
    let cancelled = false;
    setDocState({
      file: selectedFile,
      loading: true,
      text: null,
      error: null,
      truncated: false,
      totalCharacters: 0,
    });
    readLibraryFile({ file: selectedFile, offset: 0, limit: 250_000 })
      .then((res) => {
        if (cancelled) return;
        setDocState({
          file: res.file,
          loading: false,
          text: res.text,
          error: null,
          truncated: res.nextOffset !== null,
          totalCharacters: res.totalCharacters,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDocState({
          file: selectedFile,
          loading: false,
          text: null,
          error: err instanceof Error ? err.message : "Unable to read file.",
          truncated: false,
          totalCharacters: 0,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFile]);

  // Fetch retained original JSON when a call receipt is selected in the side pane.
  useEffect(() => {
    const rawFile = inspectCall?.rawFile ?? null;
    if (!rawFile) {
      setRawState(null);
      return;
    }
    let cancelled = false;
    setRawState({
      file: rawFile,
      loading: true,
      text: null,
      error: null,
      truncated: false,
      totalCharacters: 0,
    });
    readLibraryFile({ file: rawFile, offset: 0, limit: 500_000 })
      .then((res) => {
        if (cancelled) return;
        setRawState({
          file: res.file,
          loading: false,
          text: res.text,
          error: null,
          truncated: res.nextOffset !== null,
          totalCharacters: res.totalCharacters,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRawState({
          file: rawFile,
          loading: false,
          text: null,
          error: err instanceof Error ? err.message : "Unable to read original response.",
          truncated: false,
          totalCharacters: 0,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [inspectCall]);

  const parsedDoc = useMemo(() => {
    if (!docState?.text) return null;
    const kind = fileKind(docState.file);
    if (kind === "raw") {
      return { kind: "raw" as const, text: docState.text };
    }
    const { meta, body } = frontMatter(docState.text);
    if (kind === "report") {
      const parts = reportParts(body);
      return { kind: "report" as const, meta, card: parts.card, body: parts.rest };
    }
    return { kind, meta, card: null, body };
  }, [docState]);

  const digCost = useMemo(() => (item ? costSummary(item.calls) : null), [item]);
  const sortedCalls = useMemo(
    () =>
      item
        ? [...item.calls].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
        : [],
    [item],
  );

  const selectFileTab = (file: string) => {
    setSelectedFile(file);
    if (project && dig) {
      void navigate({
        to: "/dig/$project/$dig",
        params: { project, dig },
        search: { file },
        replace: true,
      });
    }
  };

  if (!snapshot && loadingSnapshot) {
    return (
      <Frame spacing="sm">
        <FramePanel>
          <p className="m-0 text-sm text-muted-foreground">Loading dig…</p>
        </FramePanel>
      </Frame>
    );
  }

  if (!item) {
    return (
      <div className="space-y-4">
        <Link to="/" className="dig-button dig-button-ghost dig-button-size-sm no-underline">
          ← Back to Library
        </Link>
        <Frame spacing="sm">
          <FramePanel className="space-y-2 py-8 text-center">
            <h1 className="m-0 text-lg font-semibold">Dig not found</h1>
            <p className="m-0 text-sm text-muted-foreground">
              Could not locate <code>{project}/{dig}</code> in this library.
            </p>
          </FramePanel>
        </Frame>
      </div>
    );
  }

  const stateWord = digWord(item.status, { answer: item.answer, reports: item.reports.length });
  const shortCost = digCost ? costShort(digCost, item.calls.length) : "";
  const fullCost = digCost ? costTotal(digCost, item.calls.length) : null;

  return (
    <div className="space-y-5">
      {/* Breadcrumb & Dig Header */}
      <div className="space-y-2">
        <Link to="/" className="dig-button dig-button-ghost dig-button-size-sm -ml-2 no-underline">
          ← Library
        </Link>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {item.displayTitle || item.title}
            </h1>
            {item.displayTitle && item.displayTitle !== item.title && (
              <p className="m-0 text-xs text-muted-foreground">{item.title}</p>
            )}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
              <Badge tone={statusTone(stateWord)}>{stateWord}</Badge>
              <span title={item.project}>{basename(item.project) || item.project}</span>
              {item.startedAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Started {absTime(item.startedAt)}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>{plural(item.reports.length, "report")}</span>
              <span aria-hidden="true">·</span>
              <span>{plural(item.calls.length, "retrieval")}</span>
              {shortCost && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-medium text-foreground" title={fullCost ?? undefined}>
                    {shortCost}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main Reader + Optional Evidence Side Pane */}
      <div
        className={cn(
          "grid gap-5",
          inspectCall ? "lg:grid-cols-[minmax(0,1fr)_minmax(340px,440px)]" : "grid-cols-1",
        )}
      >
        <Frame spacing="sm" className="min-w-0">
          {/* File Tab Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5">
            <nav
              aria-label="Files in this dig"
              className="flex flex-wrap items-center gap-1"
            >
              {orderedFiles.map((file) => {
                const active = selectedFile === file;
                return (
                  <button
                    key={file}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => selectFileTab(file)}
                    className={cn(
                      "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                      active
                        ? "bg-card text-foreground shadow-xs ring-1 ring-border"
                        : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                    )}
                  >
                    {catalog.fileLabel(file)}
                  </button>
                );
              })}
            </nav>
            {selectedFile && (
              <span className="truncate font-mono text-[11px] text-muted-foreground" title={selectedFile}>
                {basename(selectedFile)}
              </span>
            )}
          </div>

          <FramePanel className="min-w-0">
            {!docState || docState.loading ? (
              <p className="m-0 text-sm text-muted-foreground">Reading retained research…</p>
            ) : docState.error ? (
              <p role="alert" className="m-0 text-sm text-destructive">
                Unable to read {basename(docState.file)}: {docState.error}
              </p>
            ) : parsedDoc?.kind === "raw" ? (
              <RawEvidenceView
                file={docState.file}
                text={parsedDoc.text}
                receipt={item.calls.find((c) => c.rawFile === docState.file || c.raw === docState.file)}
                catalog={catalog}
              />
            ) : parsedDoc ? (
              <article className="space-y-4">
                <DocumentFacts meta={parsedDoc.meta} kind={parsedDoc.kind} catalog={catalog} />

                {parsedDoc.kind === "report" &&
                  (parsedDoc.card ? (
                    <SourceCardView card={parsedDoc.card} />
                  ) : (
                    <p className="m-0 text-xs text-muted-foreground">
                      This report has no structured source card.
                    </p>
                  ))}

                <MarkdownView
                  markdown={parsedDoc.body}
                  idPrefix={docState.file.replace(/[^a-z0-9]+/gi, "-")}
                />

                {docState.truncated && (
                  <p className="m-0 rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
                    Showing the first 250,000 characters of {plural(docState.totalCharacters, "character")}.
                  </p>
                )}
              </article>
            ) : null}
          </FramePanel>
        </Frame>

        {/* Evidence Side Pane */}
        {inspectCall && (
          <aside aria-label="Original provider response" className="min-w-0">
            <Frame spacing="sm" className="sticky top-16 max-h-[calc(100vh-5rem)] overflow-hidden">
              <FrameHeader className="flex-row items-center justify-between gap-2">
                <div className="min-w-0">
                  <FrameTitle className="truncate">Original response</FrameTitle>
                  <p className="m-0 truncate font-mono text-[11px] text-muted-foreground">
                    {inspectCall.tool}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setInspectCall(null)}>
                  Close
                </Button>
              </FrameHeader>
              <FramePanel className="max-h-[calc(100vh-10rem)] overflow-y-auto">
                {!rawState || rawState.loading ? (
                  <p className="m-0 text-sm text-muted-foreground">Reading retained evidence…</p>
                ) : rawState.error ? (
                  <p role="alert" className="m-0 text-sm text-destructive">
                    {rawState.error}
                  </p>
                ) : rawState.text !== null ? (
                  <RawEvidenceView
                    file={rawState.file}
                    text={rawState.text}
                    receipt={inspectCall}
                    catalog={catalog}
                  />
                ) : null}
              </FramePanel>
            </Frame>
          </aside>
        )}
      </div>

      {/* Retrievals & Original Evidence Ledger */}
      <Frame spacing="sm">
        <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <FrameTitle>Retrievals &amp; original evidence</FrameTitle>
            <p className="m-0 text-xs text-muted-foreground">
              {plural(sortedCalls.length, "recorded call")}
              {fullCost ? ` · ${fullCost}` : ""}
            </p>
          </div>
          {inspectCall && (
            <Button variant="ghost" size="sm" onClick={() => setInspectCall(null)}>
              Close evidence pane
            </Button>
          )}
        </FrameHeader>
        <FramePanel>
          {sortedCalls.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">
              No provider retrievals recorded for this dig yet.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {sortedCalls.map((call, idx) => {
                const callCostSummary = costSummary([call]);
                const selected = inspectCall?.id === call.id;
                return (
                  <div
                    key={`${call.id}-${idx}`}
                    className={cn(
                      "flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between",
                      selected && "rounded-lg bg-accent/40 px-2.5 -mx-2.5",
                    )}
                  >
                    <div className="flex min-w-0 items-start gap-2.5">
                      <SourceIcon id={call.source} logo={logoMap.get(call.source)} size="sm" />
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-sm font-medium text-foreground">
                            {catalog.label(call.source)}
                          </strong>
                          <code className="text-xs text-muted-foreground">{call.tool}</code>
                          <Badge tone={statusTone(callWord(call.status))}>
                            {callOutcome(call.status)}
                          </Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          <span>{absTime(call.at)}</span>
                          {typeof call.ms === "number" && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="tabular-nums">{duration(call.ms)}</span>
                            </>
                          )}
                          <span aria-hidden="true">·</span>
                          <span>{costShort(callCostSummary, 1)}</span>
                        </div>
                        {call.error && (
                          <p className="mb-0 mt-1 text-xs text-destructive">{call.error}</p>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {call.rawFile ? (
                        <Button
                          variant={selected ? "default" : "outline"}
                          size="sm"
                          onClick={() => setInspectCall(selected ? null : call)}
                        >
                          {selected ? "Inspecting" : "Inspect original"}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Original not retained</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {item.reportDetails.length > 0 && (
            <div className="mt-4">
              <Disclosure title={`Saved source reports (${item.reportDetails.length})`}>
                <ul className="m-0 list-none space-y-2 p-0 text-xs">
                  {item.reportDetails.map((rep) => (
                    <li
                      key={rep.file}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/25 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">
                            {catalog.fileLabel(rep.file)}
                          </span>
                          {rep.status && <Badge tone="muted">{rep.status}</Badge>}
                          {rep.at && (
                            <span className="text-muted-foreground">{absTime(rep.at)}</span>
                          )}
                        </div>
                        {rep.summary && (
                          <p className="m-0 truncate text-muted-foreground">{rep.summary}</p>
                        )}
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => selectFileTab(rep.file)}>
                        Open report
                      </Button>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </div>
          )}
        </FramePanel>
      </Frame>
    </div>
  );
}

function DocumentFacts({
  meta,
  kind,
  catalog,
}: {
  readonly meta: Record<string, unknown>;
  readonly kind: "question" | "answer" | "report";
  readonly catalog: ReturnType<typeof useDigCatalog>;
}) {
  const items: Array<{ readonly label: string; readonly value: React.ReactNode }> = [];

  if (kind === "report") {
    if (typeof meta.agent === "string") {
      items.push({ label: "Method", value: catalog.methodLabel(meta.agent) });
    }
    if (meta.generated_at) items.push({ label: "Saved", value: absTime(meta.generated_at) });
    if (meta.topic) items.push({ label: "Topic", value: String(meta.topic) });
    if (meta.topic_volatility) {
      items.push({ label: "Volatility", value: String(meta.topic_volatility) });
    }
    if (typeof meta.supersedes === "string" && meta.supersedes) {
      items.push({ label: "Corrects", value: catalog.fileLabel(meta.supersedes) });
    }
  } else if (kind === "answer") {
    if (meta.status) {
      const word = answerWord(meta.status) ?? String(meta.status);
      items.push({ label: "Status", value: <Badge tone={statusTone(word)}>{word}</Badge> });
    }
    if (meta.finished_at) items.push({ label: "Written", value: absTime(meta.finished_at) });
    if (Array.isArray(meta.reports) && meta.reports.length > 0) {
      items.push({
        label: "Relies on",
        value: meta.reports.map((r) => catalog.fileLabel(String(r))).join(", "),
      });
    }
  } else {
    if (meta.started_at) items.push({ label: "Started", value: absTime(meta.started_at) });
    if (Array.isArray(meta.planned) && meta.planned.length > 0) {
      items.push({
        label: "Planned methods",
        value: meta.planned.map((m) => catalog.methodLabel(String(m))).join(", "),
      });
    }
    if (meta.refreshes) items.push({ label: "Refreshes", value: String(meta.refreshes) });
  }

  if (items.length === 0) return null;

  return (
    <dl className="m-0 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-border pb-3 text-xs">
      {items.map((fact) => (
        <div key={fact.label} className="flex items-center gap-1.5">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="m-0 font-medium text-foreground">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
