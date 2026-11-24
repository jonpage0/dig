import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { costSummary } from "../../core/cost.ts";
import type { Receipt } from "../../core/library.ts";
import { callWord, patternOf } from "../../status.ts";
import {
  absTime,
  callOutcome,
  clock,
  costShort,
  duration,
  plural,
} from "../../ui/format.ts";
import { readLibraryFile } from "../api/client.ts";
import {
  digRouteParams,
  libraryAtom,
  liveProgressAtom,
  resultData,
  sseStatusAtom,
} from "../state/atoms.ts";
import { useActiveActivity, useDigCatalog, useSourceLogoMap } from "../state/catalog.ts";
import { RawEvidenceView } from "../components/RawEvidenceView.tsx";
import { SourceIcon } from "../components/SourceIcon.tsx";
import { Badge, Button, Dialog, Disclosure } from "../shared/components.tsx";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "../shared/frame.tsx";

interface TrailReceiptEntry {
  readonly receipt: Receipt;
  readonly digHandle?: string;
  readonly digTitle?: string;
  readonly digProject?: string;
  readonly digId?: string;
}

function statusTone(status: string): "neutral" | "success" | "partial" | "warning" | "muted" {
  const pattern = patternOf(callWord(status));
  if (pattern === "solid") return "success";
  if (pattern === "stripes") return "partial";
  if (pattern === "warning") return "warning";
  return "muted";
}

function elapsedLabel(startedAt: string, now: number): string {
  const sec = Math.max(0, Math.round((now - (Date.parse(startedAt) || now)) / 1000));
  return sec < 120 ? `${sec} s` : `${Math.round(sec / 60)} min`;
}

export function TrailPage() {
  const search = useSearch({ strict: false }) as { dig?: string };
  const [digFilter, setDigFilter] = useState<string | null>(() =>
    typeof search.dig === "string" && search.dig ? search.dig : null,
  );
  useEffect(() => {
    setDigFilter(typeof search.dig === "string" && search.dig ? search.dig : null);
  }, [search.dig]);

  const libraryResult = useAtomValue(libraryAtom);
  const sseStatus = useAtomValue(sseStatusAtom);
  const live = useAtomValue(liveProgressAtom);

  const snapshot = resultData(libraryResult);
  const catalog = useDigCatalog(snapshot);
  const logoMap = useSourceLogoMap(snapshot);
  const { activeCalls, runningJobs } = useActiveActivity(snapshot, live);

  // Local display-only 1-second timer while calls are running (zero network requests).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (activeCalls.length === 0 && runningJobs.length === 0) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeCalls.length, runningJobs.length]);

  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  // Modal inspection for retained raw JSON.
  const [inspectReceipt, setInspectReceipt] = useState<Receipt | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawText, setRawText] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);

  useEffect(() => {
    const rawFile = inspectReceipt?.rawFile ?? null;
    if (!rawFile) {
      setRawText(null);
      setRawError(null);
      setRawLoading(false);
      return;
    }
    let cancelled = false;
    setRawLoading(true);
    setRawText(null);
    setRawError(null);
    readLibraryFile({ file: rawFile, offset: 0, limit: 500_000 })
      .then((res) => {
        if (!cancelled) {
          setRawText(res.text);
          setRawLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRawError(err instanceof Error ? err.message : "Could not read original response.");
          setRawLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inspectReceipt]);

  const allReceipts = useMemo<readonly TrailReceiptEntry[]>(() => {
    if (!snapshot) return [];
    const seen = new Set<string>();
    const merged: TrailReceiptEntry[] = [];

    for (const item of snapshot.items) {
      for (const receipt of item.calls) {
        const key = `${item.dig}:${receipt.id}:${receipt.at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({
          receipt,
          digHandle: item.dig,
          digTitle: item.displayTitle || item.title,
          digProject: item.project,
          digId: item.id,
        });
      }
    }

    for (const receipt of snapshot.live) {
      const key = `live:${receipt.id}:${receipt.at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ receipt });
    }

    return merged.sort(
      (a, b) => (Date.parse(b.receipt.at) || 0) - (Date.parse(a.receipt.at) || 0),
    );
  }, [snapshot]);

  const seenSources = useMemo(() => {
    const ids = new Set(allReceipts.map((r) => r.receipt.source).filter(Boolean));
    return [...ids].sort();
  }, [allReceipts]);

  const filteredReceipts = useMemo(
    () =>
      allReceipts.filter((entry) => {
        if (digFilter && entry.digHandle !== digFilter) return false;
        if (sourceFilter !== "all" && entry.receipt.source !== sourceFilter) return false;
        if (statusFilter !== "all" && entry.receipt.status !== statusFilter) return false;
        return true;
      }),
    [allReceipts, digFilter, sourceFilter, statusFilter],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">Live research trail</h1>
          <p className="mb-0 mt-1 text-sm text-muted-foreground">
            Real-time SSE stream of running provider calls and retained call receipts.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className="dig-live-dot"
            data-state={activeCalls.length > 0 ? "running" : sseStatus}
            aria-hidden="true"
          />
          <span className="font-medium text-foreground">
            {sseStatus === "open"
              ? "SSE stream connected"
              : sseStatus === "unauthorized"
                ? "Session expired — open a fresh link"
                : sseStatus === "reconnecting"
                  ? "Reconnecting to SSE stream…"
                  : "Connecting to SSE stream…"}
          </span>
        </div>
      </div>

      {digFilter && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs">
          <span>
            Filtered to dig <code>{digFilter}</code>
          </span>
          <Button variant="ghost" size="sm" onClick={() => setDigFilter(null)}>
            Show all digs
          </Button>
        </div>
      )}

      {/* Pending Spend Approvals (loaded from snapshot + SSE, even if tab opened after refusal) */}
      {(() => {
        const pendingApprovals = live.hasSnapshot
          ? live.pendingApprovals
          : (snapshot?.pendingApprovals ?? []);
        const filteredApprovals = digFilter
          ? pendingApprovals.filter((a) => !a.dig || a.dig === digFilter)
          : pendingApprovals;
        if (filteredApprovals.length === 0) return null;
        return (
          <Frame spacing="sm">
            <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <FrameTitle>Pending spend approvals</FrameTitle>
                <FrameDescription>
                  Single-use localhost confirmations awaiting your decision.
                </FrameDescription>
              </div>
              <Badge tone="partial">{plural(filteredApprovals.length, "approval")}</Badge>
            </FrameHeader>
            <FramePanel>
              <div className="space-y-2.5">
                {filteredApprovals.map((item) => (
                  <div
                    key={item.code}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/35 p-3 text-xs"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-sm font-semibold text-foreground">{item.title}</strong>
                        {item.tool && <code className="text-muted-foreground">{item.tool}</code>}
                      </div>
                      {item.message && <p className="m-0 text-muted-foreground">{item.message}</p>}
                    </div>
                    <a
                      href={`/approve/${encodeURIComponent(item.code)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex shrink-0 items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground no-underline hover:opacity-90"
                    >
                      Review &amp; approve
                    </a>
                  </div>
                ))}
              </div>
            </FramePanel>
          </Frame>
        );
      })()}

      {/* Currently Running Calls */}
      <Frame spacing="sm">
        <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <FrameTitle>Running right now</FrameTitle>
            <FrameDescription>
              Live progress pushed over <code>/api/events</code> as tools run.
            </FrameDescription>
          </div>
          <Badge tone={activeCalls.length > 0 ? "success" : "muted"}>
            {plural(activeCalls.length, "active call")}
          </Badge>
        </FrameHeader>
        <FramePanel>
          {activeCalls.length === 0 && runningJobs.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">
              No provider calls are running right now. Active calls appear here immediately when
              started by your assistant.
            </p>
          ) : (
            <div className="space-y-3">
              {activeCalls.map((call) => {
                const params = digRouteParams(call.dig, call.project);
                const pct =
                  call.progress?.total && call.progress.total > 0
                    ? Math.min(100, Math.round((call.progress.progress / call.progress.total) * 100))
                    : null;
                return (
                  <div
                    key={call.callId}
                    className="rounded-lg border border-primary/30 bg-accent/35 p-3.5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <SourceIcon id={call.source} logo={logoMap.get(call.source)} size="sm" />
                        <div className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <strong className="text-sm font-semibold text-foreground">
                              {catalog.label(call.source)}
                            </strong>
                            <code className="text-xs text-muted-foreground">{call.tool}</code>
                            <Badge tone="success">Running</Badge>
                          </div>
                          <p className="m-0 text-xs text-foreground">
                            {call.progress?.message || "Waiting for provider response…"}
                          </p>
                          {call.dig && (
                            <p className="m-0 text-xs text-muted-foreground">
                              Dig:{" "}
                              <Link
                                to="/dig/$project/$dig"
                                params={params}
                                className="text-primary hover:underline"
                              >
                                {call.dig}
                              </Link>
                            </p>
                          )}
                        </div>
                      </div>
                      <span className="text-xs font-medium tabular-nums text-muted-foreground">
                        {elapsedLabel(call.startedAt, now)}
                      </span>
                    </div>
                    {pct !== null && (
                      <div className="mt-2.5 space-y-1">
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[11px] text-muted-foreground">
                          <span>
                            Step {call.progress?.progress} of {call.progress?.total}
                          </span>
                          <span>{pct}%</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {runningJobs
                .filter((job) => !activeCalls.some((c) => c.callId === job.id))
                .map((job) => (
                  <div
                    key={job.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/35 p-3 text-xs"
                  >
                    <div className="flex items-center gap-2.5">
                      <SourceIcon id={job.source} logo={logoMap.get(job.source)} size="xs" />
                      <strong className="font-medium text-foreground">
                        {catalog.label(job.source)}
                      </strong>
                      <code className="text-muted-foreground">{job.tool}</code>
                      <Badge tone={job.status === "pending_approval" ? "partial" : "muted"}>
                        {job.status.replaceAll("_", " ")}
                      </Badge>
                    </div>
                    <span className="tabular-nums text-muted-foreground">
                      {elapsedLabel(job.createdAt, now)}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </FramePanel>
      </Frame>

      {/* Live SSE Event Log (since tab opened) */}
      {live.events.length > 0 && (
        <Frame spacing="sm">
          <FrameHeader>
            <FrameTitle>Live session events ({live.events.length})</FrameTitle>
          </FrameHeader>
          <FramePanel>
            <ul className="m-0 max-h-56 list-none space-y-1.5 overflow-y-auto p-0 text-xs">
              {live.events.slice(0, 30).map((ev) => (
                <li
                  key={ev.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-secondary/35 px-2.5 py-1.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        ev.kind === "approval_requested"
                          ? "partial"
                          : ev.kind === "job_finished"
                            ? "success"
                            : "muted"
                      }
                    >
                      {ev.kind.replaceAll("_", " ")}
                    </Badge>
                    {ev.source && <span className="font-medium">{catalog.label(ev.source)}</span>}
                    {ev.tool && <code className="text-muted-foreground">{ev.tool}</code>}
                    <span className="text-foreground">{ev.message}</span>
                    {ev.kind === "approval_requested" && ev.code && (
                      <a
                        href={`/approve/${encodeURIComponent(ev.code)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-primary underline"
                      >
                        Review &amp; approve
                      </a>
                    )}
                  </div>
                  <span className="tabular-nums text-muted-foreground">{clock(ev.at)}</span>
                </li>
              ))}
            </ul>
          </FramePanel>
        </Frame>
      )}

      {/* Recent Completed & Live Receipts */}
      <section aria-labelledby="recent-receipts-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="recent-receipts-heading" className="m-0 text-lg font-semibold tracking-tight">
              Recent retrievals
            </h2>
            <p className="m-0 text-xs text-muted-foreground">
              {plural(filteredReceipts.length, "receipt")} shown
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter by source"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="dig-input w-auto"
            >
              <option value="all">All sources</option>
              {seenSources.map((src) => (
                <option key={src} value={src}>
                  {catalog.label(src)}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by outcome"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="dig-input w-auto"
            >
              <option value="all">All outcomes</option>
              <option value="success">Succeeded</option>
              <option value="partial">Partial</option>
              <option value="empty">Empty</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Stopped</option>
            </select>
          </div>
        </div>

        {filteredReceipts.length === 0 ? (
          <Frame spacing="sm">
            <FramePanel>
              <p className="m-0 text-sm text-muted-foreground">
                No call receipts recorded yet matching this filter.
              </p>
            </FramePanel>
          </Frame>
        ) : (
          <div className="space-y-2.5">
            {filteredReceipts.slice(0, 80).map((entry, idx) => {
              const { receipt } = entry;
              const summary = costSummary([receipt]);
              const hasArgs = receipt.args && Object.keys(receipt.args).length > 0;
              const route = entry.digHandle
                ? digRouteParams(entry.digHandle, entry.digProject, entry.digId)
                : null;
              return (
                <article
                  key={`${receipt.id}-${idx}`}
                  className="rounded-xl border border-border bg-card p-3.5"
                >
                  <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <SourceIcon
                        id={receipt.source}
                        logo={logoMap.get(receipt.source)}
                        size="sm"
                      />
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-sm font-medium text-foreground">
                            {catalog.label(receipt.source)}
                          </strong>
                          <code className="text-xs text-muted-foreground">{receipt.tool}</code>
                          <Badge tone={statusTone(receipt.status)}>
                            {callOutcome(receipt.status)}
                          </Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          <time dateTime={receipt.at}>{absTime(receipt.at)}</time>
                          {typeof receipt.ms === "number" && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="tabular-nums">{duration(receipt.ms)}</span>
                            </>
                          )}
                          <span aria-hidden="true">·</span>
                          <span className="font-medium text-foreground">
                            {costShort(summary, 1)}
                          </span>
                        </div>
                        {route && entry.digTitle && (
                          <p className="m-0 text-xs text-muted-foreground">
                            Dig:{" "}
                            <Link
                              to="/dig/$project/$dig"
                              params={route}
                              className="text-primary hover:underline"
                            >
                              {entry.digTitle}
                            </Link>
                          </p>
                        )}
                        {receipt.error && (
                          <p className="m-0 text-xs text-destructive">{receipt.error}</p>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {receipt.rawFile ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setInspectReceipt(receipt)}
                        >
                          Inspect evidence
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">No raw file</span>
                      )}
                    </div>
                  </div>

                  {hasArgs && (
                    <div className="mt-2.5">
                      <Disclosure title="Arguments">
                        <pre className="m-0 overflow-x-auto rounded-lg border border-border bg-secondary/40 p-2.5 text-[11.5px] leading-snug">
                          <code>{JSON.stringify(receipt.args, null, 2)}</code>
                        </pre>
                      </Disclosure>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <Dialog
        open={Boolean(inspectReceipt)}
        onOpenChange={(open) => {
          if (!open) setInspectReceipt(null);
        }}
        title={
          inspectReceipt
            ? `${catalog.label(inspectReceipt.source)} · ${inspectReceipt.tool}`
            : "Original response"
        }
        description={inspectReceipt?.rawFile ?? inspectReceipt?.raw}
      >
        {rawLoading ? (
          <p className="m-0 text-sm text-muted-foreground">Reading retained original response…</p>
        ) : rawError ? (
          <p role="alert" className="m-0 text-sm text-destructive">
            {rawError}
          </p>
        ) : rawText !== null && inspectReceipt?.rawFile ? (
          <RawEvidenceView
            file={inspectReceipt.rawFile}
            text={rawText}
            receipt={inspectReceipt}
            catalog={catalog}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
