import React, { useId, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { LibrarySearchResponse } from "../../core/api-types.ts";
import { costSummary } from "../../core/cost.ts";
import type { LibraryDigItem } from "../../core/library.ts";
import { digWord, patternOf } from "../../status.ts";
import {
  basename,
  clock,
  COST_CAVEAT,
  costAmounts,
  costScope,
  costShort,
  costTotal,
  num,
  plural,
  shortDate,
} from "../../ui/format.ts";
import { usageOf, WINDOWS, type UsageSummary } from "../../ui/usage.ts";
import { searchLibrary } from "../api/client.ts";
import {
  digRouteFromFile,
  digRouteParams,
  libraryAtom,
  resultData,
  resultError,
  resultLoading,
  usageWindowDaysAtom,
} from "../state/atoms.ts";
import { useDigCatalog, useSourceLogoMap } from "../state/catalog.ts";
import { SourceIcon } from "../components/SourceIcon.tsx";
import { Badge, Button } from "../shared/components.tsx";
import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../shared/frame.tsx";

const OUTCOMES = [
  { id: "results" as const, label: "Success / partial" },
  { id: "empty" as const, label: "Empty" },
  { id: "failed" as const, label: "Failed / stopped" },
];

type StatusFilter = "all" | "answered" | "partial" | "open";

function statusTone(word: string): "neutral" | "success" | "partial" | "warning" | "muted" {
  const pattern = patternOf(word);
  if (pattern === "solid") return "success";
  if (pattern === "stripes") return "partial";
  if (pattern === "warning") return "warning";
  return "muted";
}

function SvgPatterns({ id }: { readonly id: string }) {
  return (
    <defs>
      <pattern id={`${id}-dots`} width="5" height="5" patternUnits="userSpaceOnUse">
        <rect width="5" height="5" fill="var(--muted)" />
        <circle cx="2.5" cy="2.5" r="1" fill="var(--foreground)" opacity="0.65" />
      </pattern>
      <pattern
        id={`${id}-hatch`}
        width="5"
        height="5"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="5" height="5" fill="var(--muted)" />
        <rect width="1.7" height="5" fill="var(--destructive)" opacity="0.7" />
      </pattern>
    </defs>
  );
}

function outcomeFill(patternId: string, outcome: "results" | "empty" | "failed"): string {
  if (outcome === "results") return "var(--primary)";
  return `url(#${patternId}-${outcome === "empty" ? "dots" : "hatch"})`;
}

function ActivityBars({ usage }: { readonly usage: UsageSummary }) {
  const id = `act-${useId().replaceAll(":", "")}`;
  const width = 560;
  const height = 110;
  const maximum = Math.max(1, ...usage.buckets.map((b) => b.total));
  const slot = width / Math.max(1, usage.buckets.length);
  const barWidth = Math.max(2, Math.min(slot * 0.66, 28));
  const unit = usage.weekly ? "week" : "day";

  const bucketLabel = (start: number) =>
    `${usage.weekly ? "Week of " : ""}${shortDate(new Date(start).toISOString())}`;

  return (
    <figure className="m-0 space-y-2">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <figcaption className="font-medium text-foreground">Activity by {unit}</figcaption>
        <span className="text-muted-foreground">
          {plural(usage.totals.total, "retrieval")}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-28 w-full rounded-md bg-secondary/30"
        role="img"
        aria-label={`${num(usage.totals.total)} retained retrievals by ${unit}`}
      >
        <SvgPatterns id={id} />
        {[0.5, 1].map((ratio) => (
          <line
            key={ratio}
            x1={0}
            x2={width}
            y1={height * ratio - 0.5}
            y2={height * ratio - 0.5}
            stroke="var(--border)"
            strokeDasharray={ratio < 1 ? "2 5" : undefined}
          />
        ))}
        {usage.buckets.map((bucket, idx) => {
          let y = height;
          return (
            <g key={bucket.start}>
              <title>
                {bucketLabel(bucket.start)}: {plural(bucket.total, "retrieval")}
              </title>
              {OUTCOMES.filter((o) => bucket[o.id] > 0).map((o) => {
                const h = (bucket[o.id] / maximum) * height;
                y -= h;
                return (
                  <rect
                    key={o.id}
                    x={idx * slot + (slot - barWidth) / 2}
                    y={y}
                    width={barWidth}
                    height={h}
                    rx={1.5}
                    fill={outcomeFill(id, o.id)}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{usage.buckets.length ? bucketLabel(usage.buckets[0].start) : ""}</span>
        <span>
          {usage.weekly && usage.buckets.length
            ? bucketLabel(usage.buckets[usage.buckets.length - 1].start)
            : "Today"}
        </span>
      </div>
    </figure>
  );
}

function DigRowCard({
  item,
  catalogLabel,
  fileLabel,
  logoMap,
}: {
  readonly item: LibraryDigItem;
  readonly catalogLabel: (id: unknown) => string;
  readonly fileLabel: (file: string) => string;
  readonly logoMap: ReadonlyMap<string, string | undefined>;
}) {
  const params = digRouteParams(item.dig, item.project, item.id);
  const stateWord = digWord(item.status, { answer: item.answer, reports: item.reports.length });
  const itemCost = useMemo(() => costSummary(item.calls), [item.calls]);
  const shortCost = costShort(itemCost, item.calls.length);
  const fullCost = costTotal(itemCost, item.calls.length);
  const sourceList = item.sources.length
    ? item.sources
    : [...new Set(item.calls.map((c) => c.source).filter(Boolean))];

  return (
    <article className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-ring/50">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1.5">
          {sourceList.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {sourceList.slice(0, 4).map((src) => (
                <SourceIcon key={src} id={src} logo={logoMap.get(src)} size="xs" />
              ))}
              <span className="text-xs text-muted-foreground">
                {sourceList.map((src) => catalogLabel(src)).join(" · ")}
              </span>
            </div>
          )}

          <h3 className="m-0 text-[15px] font-semibold leading-snug tracking-tight">
            <Link
              to="/dig/$project/$dig"
              params={params}
              className="text-foreground no-underline hover:text-primary hover:underline"
            >
              {item.displayTitle || item.title}
            </Link>
          </h3>

          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
            <span title={item.project}>{basename(item.project) || item.project}</span>
            {item.startedAt && (
              <>
                <span aria-hidden="true">·</span>
                <time dateTime={item.startedAt}>
                  {shortDate(item.startedAt)} · {clock(item.startedAt)}
                </time>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>{plural(item.reports.length, "report")}</span>
            <span aria-hidden="true">·</span>
            <span>{plural(item.calls.length, "call")}</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-row items-center gap-2 sm:flex-col sm:items-end">
          <Badge tone={statusTone(stateWord)}>{stateWord}</Badge>
          {shortCost && (
            <span
              className="text-xs font-medium tabular-nums text-foreground"
              title={fullCost ?? undefined}
            >
              {shortCost}
            </span>
          )}
        </div>
      </div>

      {item.snippet && (
        <p className="mb-0 mt-2.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {item.snippet}
        </p>
      )}

      {(item.answer || item.reports.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-2.5">
          {item.answer && (
            <Link
              to="/dig/$project/$dig"
              params={params}
              search={{ file: item.answer }}
              className="rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground no-underline hover:underline"
            >
              Answer
            </Link>
          )}
          {item.reports.slice(0, 5).map((reportFile) => (
            <Link
              key={reportFile}
              to="/dig/$project/$dig"
              params={params}
              search={{ file: reportFile }}
              className="rounded-md bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground no-underline hover:bg-muted"
            >
              {fileLabel(reportFile)}
            </Link>
          ))}
          {item.reports.length > 5 && (
            <span className="text-[11px] text-muted-foreground">
              +{item.reports.length - 5} more
            </span>
          )}
        </div>
      )}
    </article>
  );
}

export function LibraryPage() {
  const libraryResult = useAtomValue(libraryAtom);
  const refreshLibrary = useAtomRefresh(libraryAtom);
  const [usageDays, setUsageDays] = useAtom(usageWindowDaysAtom);

  const snapshot = resultData(libraryResult);
  const loading = resultLoading(libraryResult);
  const error = resultError(libraryResult);
  const catalog = useDigCatalog(snapshot);
  const logoMap = useSourceLogoMap(snapshot);

  // Local FTS5 / hybrid search state (`POST /api/library/search`).
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"auto" | "keyword" | "hybrid">("auto");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<LibrarySearchResponse | null>(null);

  // Dig list client filter state.
  const [filterText, setFilterText] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const runSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    const q = searchQuery.trim();
    if (!q) {
      setSearchResult(null);
      setSearchError(null);
      return;
    }
    setSearchBusy(true);
    setSearchError(null);
    try {
      const res = await searchLibrary({ query: q, mode: searchMode, limit: 25 });
      setSearchResult(res);
    } catch (err: unknown) {
      setSearchError(err instanceof Error ? err.message : "Library search failed.");
    } finally {
      setSearchBusy(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchResult(null);
    setSearchError(null);
  };

  const todayKey = new Date().toDateString();
  const usage = useMemo(
    () => usageOf(snapshot, { days: usageDays }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, usageDays, todayKey],
  );

  const projects = useMemo(() => {
    const set = new Set((snapshot?.items ?? []).map((i) => i.project));
    return [...set].sort();
  }, [snapshot?.items]);

  const filteredItems = useMemo(() => {
    const items = snapshot?.items ?? [];
    const tokens = filterText.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      if (projectFilter !== "all" && item.project !== projectFilter) return false;
      if (statusFilter === "answered" && item.status !== "answered" && !item.answer) return false;
      if (statusFilter === "partial" && item.status !== "partly-answered") return false;
      if (statusFilter === "open" && Boolean(item.answer)) return false;
      if (!tokens.length) return true;
      const haystack = [
        item.displayTitle,
        item.title,
        item.snippet,
        item.project,
        ...item.sources,
      ]
        .join(" ")
        .toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }, [snapshot?.items, filterText, projectFilter, statusFilter]);

  const usageAmounts = costAmounts(usage.totals.cost);
  const topSourceMax = Math.max(1, ...usage.sources.map((s) => s.total));
  const readySourcesCount = snapshot?.sources.filter((s) => s.enabled && s.readiness === "ready").length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-2xl font-semibold tracking-tight text-foreground">
            Research library
          </h1>
          <p className="mb-0 mt-1 text-sm text-muted-foreground">
            Saved questions, retained source reports, and honest provider usage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {snapshot && readySourcesCount === 0 && (
            <Link to="/setup" className="dig-button dig-button-default dig-button-size-sm no-underline">
              Run Setup Wizard
            </Link>
          )}
          <Button variant="outline" size="sm" onClick={() => refreshLibrary()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <span>Could not load library: {error}</span>
          <Button variant="outline" size="sm" onClick={() => refreshLibrary()}>
            Retry
          </Button>
        </div>
      )}

      {/* Local FTS5 / hybrid full-text search */}
      <Frame spacing="sm">
        <FramePanel>
          <form onSubmit={(e) => void runSearch(e)} className="flex flex-col gap-2.5 sm:flex-row">
            <label htmlFor="library-search-input" className="sr-only">
              Search saved reports and answers
            </label>
            <input
              id="library-search-input"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search saved reports and answers (full-text FTS5 & optional semantic)…"
              className="dig-input flex-1"
            />
            <div className="flex items-center gap-2">
              <select
                aria-label="Search mode"
                value={searchMode}
                onChange={(e) => setSearchMode(e.target.value as "auto" | "keyword" | "hybrid")}
                className="dig-input w-auto min-w-28"
              >
                <option value="auto">Auto</option>
                <option value="keyword">Keyword</option>
                <option value="hybrid">Hybrid</option>
              </select>
              <Button type="submit" variant="default" size="sm" disabled={searchBusy}>
                {searchBusy ? "Searching…" : "Search"}
              </Button>
              {searchResult && (
                <Button type="button" variant="ghost" size="sm" onClick={clearSearch}>
                  Clear
                </Button>
              )}
            </div>
          </form>

          {searchError && (
            <p role="alert" className="mb-0 mt-2.5 text-xs text-destructive">
              {searchError}
            </p>
          )}

          {searchResult && (
            <div className="mt-4 space-y-3 border-t border-border pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  <strong className="font-medium text-foreground">
                    {plural(searchResult.hits.length, "match")}
                  </strong>{" "}
                  across {plural(searchResult.coverage.searched_files, "file")} · mode:{" "}
                  <code>{searchResult.mode_used}</code>
                </span>
                {searchResult.status === "partial" && (
                  <Badge tone="partial">Partial coverage</Badge>
                )}
              </div>

              {searchResult.warnings.length > 0 && (
                <ul className="m-0 list-none space-y-1 p-0 text-xs text-muted-foreground">
                  {searchResult.warnings.map((w, idx) => (
                    <li
                      key={`${w.code}-${idx}`}
                      className="rounded-md bg-secondary/60 px-2.5 py-1.5"
                    >
                      {w.message}
                    </li>
                  ))}
                </ul>
              )}

              {searchResult.hits.length === 0 ? (
                <p className="m-0 text-sm text-muted-foreground">
                  No passages matched that query. Try broader terms or switch to keyword mode.
                </p>
              ) : (
                <ul className="m-0 list-none space-y-2 p-0">
                  {searchResult.hits.map((hit, idx) => {
                    const route =
                      digRouteFromFile(hit.file) ??
                      digRouteParams(hit.dig, hit.project, hit.dig);
                    return (
                      <li
                        key={`${hit.file}-${hit.start}-${idx}`}
                        className="rounded-lg border border-border bg-secondary/25 p-3 transition-colors hover:border-ring/50"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <Link
                            to="/dig/$project/$dig"
                            params={route}
                            search={{ file: hit.file }}
                            className="text-sm font-medium text-primary no-underline hover:underline"
                          >
                            {hit.title || hit.question}
                          </Link>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone="muted">{catalog.fileLabel(hit.file)}</Badge>
                            {hit.matched_by.map((by) => (
                              <Badge key={by} tone="neutral">
                                {by}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        {hit.heading && (
                          <p className="mb-0 mt-1 text-xs font-medium text-muted-foreground">
                            § {hit.heading}
                          </p>
                        )}
                        <p className="mb-0 mt-1.5 text-xs leading-relaxed text-foreground/90">
                          {hit.excerpt}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </FramePanel>
      </Frame>

      {/* Provider usage & honest cost summary */}
      <Frame spacing="sm">
        <FrameHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <FrameTitle>Provider usage</FrameTitle>
            <FrameDescription>
              {usage.days
                ? `Last ${usage.days} days · all projects in this library`
                : `All time · since ${shortDate(new Date(usage.start).toISOString())}`}
            </FrameDescription>
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="Usage window">
            {WINDOWS.map((w) => (
              <Button
                key={w.days}
                size="sm"
                variant={usageDays === w.days ? "default" : "ghost"}
                aria-pressed={usageDays === w.days}
                onClick={() => setUsageDays(w.days)}
              >
                {w.label}
              </Button>
            ))}
          </div>
        </FrameHeader>
        <FramePanel className="space-y-4">
          {!snapshot && loading ? (
            <p className="m-0 text-sm text-muted-foreground">Reading retained usage…</p>
          ) : (
            <>
              <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-border bg-secondary/30 p-3">
                  <dt className="text-xs text-muted-foreground">
                    {usage.totals.cost.unknownCalls > 0
                      ? usageAmounts.length > 0
                        ? "Known subtotal"
                        : "Unpriced usage"
                      : "Provider cost"}
                  </dt>
                  <dd className="m-0 mt-1 text-base font-semibold tabular-nums text-foreground">
                    {usage.totals.total === 0
                      ? "No calls"
                      : usageAmounts.length > 0
                        ? usageAmounts.join(" + ")
                        : usage.totals.cost.unknownCalls > 0
                          ? `${plural(usage.totals.cost.unknownCalls, "unknown call")}`
                          : "No charge"}
                  </dd>
                  {usage.totals.cost.unknownCalls > 0 && usageAmounts.length > 0 && (
                    <p className="mb-0 mt-0.5 text-[11px] text-muted-foreground">
                      + {plural(usage.totals.cost.unknownCalls, "unpriced call")}
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-border bg-secondary/30 p-3">
                  <dt className="text-xs text-muted-foreground">Retrievals</dt>
                  <dd className="m-0 mt-1 text-base font-semibold tabular-nums text-foreground">
                    {num(usage.totals.total)}
                  </dd>
                  <p className="mb-0 mt-0.5 text-[11px] text-muted-foreground">
                    {num(usage.totals.results)} success / partial
                  </p>
                </div>

                <div className="rounded-lg border border-border bg-secondary/30 p-3">
                  <dt className="text-xs text-muted-foreground">Saved reports</dt>
                  <dd className="m-0 mt-1 text-base font-semibold tabular-nums text-foreground">
                    {num(usage.totals.reports)}
                  </dd>
                  <p className="mb-0 mt-0.5 text-[11px] text-muted-foreground">
                    {num(snapshot?.items.length ?? 0)} total digs
                  </p>
                </div>

                <div className="rounded-lg border border-border bg-secondary/30 p-3">
                  <dt className="text-xs text-muted-foreground">Other outcomes</dt>
                  <dd className="m-0 mt-1 text-base font-semibold tabular-nums text-foreground">
                    {num(usage.totals.failed)}
                  </dd>
                  <p className="mb-0 mt-0.5 text-[11px] text-muted-foreground">
                    {num(usage.totals.empty)} empty · failed/stopped
                  </p>
                </div>
              </dl>

              {usage.recorded > 0 && (
                <div className="grid gap-5 border-t border-border pt-4 lg:grid-cols-2">
                  <ActivityBars usage={usage} />

                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="font-medium text-foreground">Sources used</span>
                      <span className="text-muted-foreground">Calls &amp; reported cost</span>
                    </div>
                    {usage.sources.length === 0 ? (
                      <p className="m-0 text-xs text-muted-foreground">
                        No source calls in this window.
                      </p>
                    ) : (
                      <ul className="m-0 list-none space-y-2.5 p-0">
                        {usage.sources.slice(0, 5).map((row) => (
                          <li key={row.id} className="space-y-1">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="flex items-center gap-2 font-medium text-foreground">
                                <SourceIcon id={row.id} logo={logoMap.get(row.id)} size="xs" />
                                {catalog.label(row.id)}
                              </span>
                              <span className="tabular-nums text-muted-foreground">
                                {plural(row.total, "call")}
                                {row.total > 0 && (
                                  <> · {costShort(row.cost, row.total)}</>
                                )}
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${Math.max(4, (row.total / topSourceMax) * 100)}%` }}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </FramePanel>
        <FrameFooter className="text-[11px] text-muted-foreground">
          {costScope(snapshot?.host)} · {COST_CAVEAT}
        </FrameFooter>
      </Frame>

      {/* Filterable list of digs */}
      <section aria-labelledby="digs-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="digs-heading" className="m-0 text-lg font-semibold tracking-tight">
              Recent research
            </h2>
            <p className="m-0 text-xs text-muted-foreground">
              Showing {filteredItems.length} of {plural(snapshot?.items.length ?? 0, "dig")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="dig-list-filter" className="sr-only">
              Filter digs
            </label>
            <input
              id="dig-list-filter"
              type="search"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter title, project, source…"
              className="dig-input w-52"
            />
            {projects.length > 1 && (
              <select
                aria-label="Filter by project"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="dig-input w-auto max-w-48"
              >
                <option value="all">All projects</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {basename(p) || p}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="dig-input w-auto"
            >
              <option value="all">All statuses</option>
              <option value="answered">Answered</option>
              <option value="partial">Partly answered</option>
              <option value="open">No answer yet</option>
            </select>
          </div>
        </div>

        {!snapshot && loading ? (
          <Frame spacing="sm">
            <FramePanel>
              <p className="m-0 text-sm text-muted-foreground">Loading research library…</p>
            </FramePanel>
          </Frame>
        ) : filteredItems.length === 0 ? (
          <Frame spacing="sm">
            <FramePanel className="space-y-2 py-8 text-center">
              {(snapshot?.items.length ?? 0) > 0 ? (
                <>
                  <h3 className="m-0 text-base font-medium">No digs match these filters</h3>
                  <p className="m-0 text-xs text-muted-foreground">
                    Clear your filter to see all saved questions.
                  </p>
                  <div className="pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setFilterText("");
                        setProjectFilter("all");
                        setStatusFilter("all");
                      }}
                    >
                      Reset filters
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="m-0 text-base font-medium">
                    Your next question starts in your assistant
                  </h3>
                  <p className="mx-auto m-0 max-w-md text-xs leading-relaxed text-muted-foreground">
                    Ask Dig to investigate a question from Codex, Claude Code, or Antigravity.
                    Saved source reports, retained evidence, and honest provider costs appear here
                    automatically in real time.
                  </p>
                  <div className="pt-2">
                    <Link
                      to="/setup"
                      className="dig-button dig-button-outline dig-button-size-sm no-underline"
                    >
                      Configure sources in Setup →
                    </Link>
                  </div>
                </>
              )}
            </FramePanel>
          </Frame>
        ) : (
          <div className="space-y-3">
            {filteredItems.map((item) => (
              <DigRowCard
                key={item.dig}
                item={item}
                catalogLabel={catalog.label}
                fileLabel={catalog.fileLabel}
                logoMap={logoMap}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
