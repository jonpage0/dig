import React, { useContext, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Switch } from "@base-ui/react/switch";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  SettingsResponse,
  SourceCatalogItem,
} from "../../core/api-types.ts";
import type { AccountStatus } from "../../core/setup.ts";
import { costAmounts, duration, num, plural } from "../../ui/format.ts";
import { httpUrl } from "../../ui/dom.ts";
import { enabledField, ownerOf } from "../../ui/settings.ts";
import { activityNote, latestSourceCalls, SOURCE_GUIDES } from "../../ui/source-guide.ts";
import { toolHistory } from "../../ui/usage.ts";
import { updateSettings } from "../api/client.ts";
import {
  libraryAtom,
  resultData,
  resultLoading,
  settingsAtom,
  setupAtom,
} from "../state/atoms.ts";
import { useDigCatalog } from "../state/catalog.ts";
import { SettingControl, type SaveSettingFn } from "../components/SettingControl.tsx";
import { SourceIcon } from "../components/SourceIcon.tsx";
import { Badge, Button, Disclosure } from "../shared/components.tsx";
import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../shared/frame.tsx";

const GROUP_DESCRIPTIONS: Readonly<Record<string, string>> = {
  web: "Discover and extract pages across the open web and Internet Archive.",
  code: "Inspect repositories, documentation, and developer discussions.",
  papers: "Search scholarly papers, citations, and open full text.",
  video: "Inspect YouTube transcripts, comments, and video intervals.",
  social: "Read public social posts, threads, and firsthand discussions.",
  markets: "Explore prediction markets, SEC filings, products, ads, and search visibility.",
  tools: "Optional analysis helpers for media and evidence already in hand.",
};

type ReadinessFilter = "all" | "enabled" | "ready" | "needs_setup";

function readinessBadge(
  source: SourceCatalogItem,
): { readonly label: string; readonly tone: "success" | "partial" | "warning" | "muted" } {
  if (!source.enabled) return { label: "Off", tone: "muted" };
  if (source.readiness === "ready") return { label: "Ready", tone: "success" };
  if (source.readiness === "partial") return { label: "Partial", tone: "partial" };
  return { label: "Needs setup", tone: "warning" };
}

function formatTypicalCost(
  cost: readonly { readonly amount: number; readonly unit: string }[] | null,
): string {
  if (cost === null) return "cost unrecorded";
  if (cost.length === 0) return "no charge";
  const byUnit: Record<string, number> = {};
  for (const item of cost) byUnit[item.unit] = (byUnit[item.unit] ?? 0) + item.amount;
  return `${costAmounts({ byUnit }).join(" + ")} typical`;
}

function SourceCatalogCard({
  source,
  allSourceIds,
  settings,
  onToggle,
  onSaveSetting,
  recentCall,
  fallbackHistory,
}: {
  readonly source: SourceCatalogItem;
  readonly allSourceIds: readonly string[];
  readonly settings: SettingsResponse | undefined;
  readonly onToggle: (id: string, next: boolean) => Promise<void>;
  readonly onSaveSetting: SaveSettingFn;
  readonly recentCall: ReturnType<typeof latestSourceCalls> extends Map<string, infer V>
    ? V | undefined
    : never;
  readonly fallbackHistory: ReturnType<typeof toolHistory>;
}) {
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const guide = SOURCE_GUIDES[source.id];
  const badge = readinessBadge(source);
  const tasks = guide?.tasks ?? [source.about];

  const ownSettingKeys = useMemo(() => {
    if (!settings) return [];
    const ownToggle = enabledField(source.id);
    return Object.keys(settings.schema.properties).filter(
      (key) => key !== ownToggle && ownerOf(key, allSourceIds) === source.id,
    );
  }, [settings, source.id, allSourceIds]);

  const historyRows = useMemo(() => {
    if (source.history && source.history.length > 0) {
      return source.history.map((h) => ({
        tool: h.tool,
        calls: h.calls,
        failed: h.failedCalls,
        medianMs: h.medianMs,
        typicalCost: h.typicalCost,
      }));
    }
    return fallbackHistory
      .filter((row) => row.source === source.id)
      .map((h) => ({
        tool: h.tool,
        calls: h.calls,
        failed: h.failed,
        medianMs: h.medianMs,
        typicalCost: h.typicalCost,
      }));
  }, [source.history, source.id, fallbackHistory]);

  const handleToggle = async (next: boolean) => {
    setToggling(true);
    setToggleError(null);
    try {
      await onToggle(source.id, next);
    } catch (err: unknown) {
      setToggleError(err instanceof Error ? err.message : "Could not update source.");
    } finally {
      setToggling(false);
    }
  };

  const copyExample = async () => {
    if (!guide?.example) return;
    try {
      await navigator.clipboard.writeText(guide.example);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; text remains selectable below.
    }
  };

  return (
    <article id={`source-${source.id}`} className="min-w-0">
      <Frame spacing="sm" className="h-full">
        <FrameHeader className="flex-row items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <SourceIcon id={source.id} logo={source.logo} size="default" />
            <div className="min-w-0 space-y-0.5">
              <FrameTitle className="flex flex-wrap items-center gap-2">
                <span>{source.label}</span>
                {source.kind === "tool" && <Badge tone="muted">Shared tool</Badge>}
              </FrameTitle>
              <FrameDescription className="text-xs">{source.description}</FrameDescription>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Switch.Root
              aria-label={`Enable ${source.label}`}
              checked={source.enabled}
              disabled={toggling}
              onCheckedChange={(next) => {
                void handleToggle(next);
              }}
              className="dig-switch"
            >
              <Switch.Thumb className="dig-switch-thumb" />
            </Switch.Root>
          </div>
        </FrameHeader>

        <FramePanel className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {source.providers.length > 0 && (
              <span className="text-xs text-muted-foreground">
                Via{" "}
                {source.providers.map((p, idx) => {
                  const href = httpUrl(p.url);
                  return (
                    <React.Fragment key={`${p.name}-${idx}`}>
                      {idx > 0 && " · "}
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          {p.name}
                        </a>
                      ) : (
                        p.name
                      )}
                    </React.Fragment>
                  );
                })}
              </span>
            )}
          </div>

          {toggleError && (
            <p role="alert" className="m-0 text-xs text-destructive">
              {toggleError}
            </p>
          )}

          <ul className="m-0 list-disc space-y-1 pl-4 text-xs leading-relaxed text-foreground/90">
            {tasks.slice(0, 2).map((task, idx) => (
              <li key={idx}>{task}</li>
            ))}
          </ul>

          <div className="rounded-lg bg-secondary/45 px-3 py-2 text-xs">
            <span className="font-medium text-foreground">Billing: </span>
            <span className="text-muted-foreground">{source.billing}</span>
          </div>

          {(source.missingKeys.length > 0 || source.missingPrereqs.length > 0) && (
            <div className="space-y-1.5 rounded-lg border border-border bg-secondary/30 p-2.5 text-xs">
              {source.missingKeys.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium text-foreground">Missing keys: </span>
                    <span className="space-x-1">
                      {source.missingKeys.map((k) => (
                        <code key={k} className="rounded bg-card px-1.5 py-0.5 text-[11px]">
                          {k}
                        </code>
                      ))}
                    </span>
                  </div>
                  <Link
                    to="/setup"
                    search={{ step: 3 }}
                    className="font-medium text-primary no-underline hover:underline"
                  >
                    Add in Setup →
                  </Link>
                </div>
              )}
              {source.missingPrereqs.length > 0 && (
                <div>
                  <span className="font-medium text-foreground">Missing local tools: </span>
                  <span className="text-muted-foreground">
                    {source.missingPrereqs.join(", ")}
                  </span>
                </div>
              )}
            </div>
          )}

          {source.notes.length > 0 && (
            <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border bg-secondary/30 p-2.5 text-xs">
              <div className="space-y-1 text-muted-foreground">
                <span className="font-medium text-foreground">Optional keys: </span>
                <span className="space-x-1">
                  {source.optionalKeys
                    .filter((k) => !k.set)
                    .map((k) => (
                      <code key={k.name} className="rounded bg-card px-1.5 py-0.5 text-[11px]">
                        {k.name}
                      </code>
                    ))}
                </span>
                {source.notes.map((note) => (
                  <p key={note} className="m-0">
                    {note}
                  </p>
                ))}
              </div>
              <Link
                to="/setup"
                search={{ step: 3 }}
                className="font-medium text-primary no-underline hover:underline"
              >
                Add in Setup →
              </Link>
            </div>
          )}

          {(source.presentKeys.length > 0 || source.optionalKeys.some((k) => k.set)) && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>Configured keys:</span>
              {[...source.presentKeys, ...source.optionalKeys.filter((k) => k.set).map((k) => k.name)].map((k) => (
                <Badge key={k} tone="success">
                  {k} ✓
                </Badge>
              ))}
            </div>
          )}

          {historyRows.length > 0 && (
            <div className="space-y-1.5 border-t border-border/70 pt-2.5">
              <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Last 90 days by tool
              </p>
              <ul className="m-0 list-none space-y-1 p-0 text-xs">
                {historyRows.map((row) => {
                  const failPct = row.calls > 0 ? Math.round((row.failed / row.calls) * 100) : 0;
                  return (
                    <li
                      key={row.tool}
                      className="flex flex-wrap items-center justify-between gap-2 rounded bg-secondary/30 px-2 py-1"
                    >
                      <code className="text-[11px] font-medium text-foreground">{row.tool}</code>
                      <span className="flex flex-wrap items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
                        <span>{plural(row.calls, "call")}</span>
                        {failPct > 0 && <span className="text-destructive">{failPct}% failed</span>}
                        {row.medianMs !== null && <span>{duration(row.medianMs)} med</span>}
                        <span>{formatTypicalCost(row.typicalCost)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <p className="m-0 text-[11px] text-muted-foreground">{activityNote(recentCall)}</p>

          {ownSettingKeys.length > 0 && settings && (
            <Disclosure title={`${source.label} settings (${ownSettingKeys.length})`}>
              <div className="space-y-2.5 pt-1">
                {ownSettingKeys.map((key) => {
                  const schema = settings.schema.properties[key];
                  if (!schema) return null;
                  return (
                    <SettingControl
                      key={key}
                      settingKey={key}
                      schema={schema}
                      value={settings.values[key]}
                      onSave={onSaveSetting}
                      compact
                    />
                  );
                })}
              </div>
            </Disclosure>
          )}
        </FramePanel>

        <FrameFooter className="gap-1.5">
          {guide?.example && (
            <Disclosure title="Example prompt for your assistant">
              <div className="space-y-2">
                <p className="m-0 rounded-md bg-secondary/40 p-2.5 text-xs leading-relaxed text-foreground">
                  {guide.example}
                </p>
                <Button variant="ghost" size="sm" onClick={() => void copyExample()}>
                  {copied ? "Copied ✓" : "Copy example"}
                </Button>
              </div>
            </Disclosure>
          )}
          {source.about && (
            <Disclosure title={source.kind === "tool" ? "About this tool" : "About this source"}>
              <p className="m-0 text-xs leading-relaxed text-muted-foreground">{source.about}</p>
            </Disclosure>
          )}
        </FrameFooter>
      </Frame>
    </article>
  );
}

function AccountsSection({
  accounts,
  keysPath,
  catalogLabel,
}: {
  readonly accounts: readonly AccountStatus[];
  readonly keysPath: string | undefined;
  readonly catalogLabel: (id: unknown) => string;
}) {
  const readyCount = accounts.filter((a) => a.ready).length;
  return (
    <section aria-labelledby="accounts-heading" className="space-y-3">
      <Frame spacing="sm">
        <FrameHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <FrameTitle id="accounts-heading">Provider accounts &amp; API keys</FrameTitle>
            <FrameDescription>
              {readyCount} of {accounts.length} provider accounts configured · stored locally in{" "}
              <code>keys.env</code> (mode 0600)
            </FrameDescription>
          </div>
          <Link
            to="/setup"
            search={{ step: 3 }}
            className="dig-button dig-button-default dig-button-size-sm no-underline"
          >
            Enter keys in Setup →
          </Link>
        </FrameHeader>
        <FramePanel>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((acc) => {
              const signupHref = httpUrl(acc.signup);
              return (
                <div
                  key={acc.id}
                  className="flex flex-col justify-between gap-2 rounded-lg border border-border bg-secondary/20 p-3 text-xs"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      {signupHref ? (
                        <a
                          href={signupHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-primary hover:underline"
                        >
                          {acc.name} ↗
                        </a>
                      ) : (
                        <strong className="font-semibold text-foreground">{acc.name}</strong>
                      )}
                      <Badge tone={acc.ready ? "success" : "muted"}>
                        {acc.ready ? "Set" : "Not set"}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {acc.keys.map((k) => (
                        <code
                          key={k.name}
                          className="rounded bg-card px-1.5 py-0.5 text-[10.5px] text-foreground"
                        >
                          {k.name}
                          {k.set ? " ✓" : ""}
                        </code>
                      ))}
                      {acc.optional.map((o) => (
                        <code
                          key={o.name}
                          className="rounded bg-card/70 px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
                        >
                          {o.name} (opt{o.set ? " ✓" : ""})
                        </code>
                      ))}
                    </div>
                    {acc.sources.length > 0 && (
                      <p className="m-0 text-[11px] text-muted-foreground">
                        Serves: {acc.sources.map((id) => catalogLabel(id)).join(", ")}
                      </p>
                    )}
                  </div>
                  <p className="m-0 border-t border-border/60 pt-1.5 text-[11px] text-muted-foreground">
                    {acc.billing}
                  </p>
                </div>
              );
            })}
          </div>
          {keysPath && (
            <p className="mb-0 mt-3 text-[11px] text-muted-foreground">
              Keys file: <code className="break-all text-foreground">{keysPath}</code>
            </p>
          )}
        </FramePanel>
      </Frame>
    </section>
  );
}

export function SourcesPage() {
  const registry = useContext(RegistryContext);
  const libraryResult = useAtomValue(libraryAtom);
  const settingsResult = useAtomValue(settingsAtom);

  const snapshot = resultData(libraryResult);
  const settings = resultData(settingsResult);
  const loading = resultLoading(libraryResult);
  const catalog = useDigCatalog(snapshot);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ReadinessFilter>("all");

  const sources = snapshot?.sources ?? [];
  const allSourceIds = useMemo(() => sources.map((s) => s.id), [sources]);

  const recentCalls = useMemo(() => latestSourceCalls(snapshot ?? {}), [snapshot]);
  const fallback90DayHistory = useMemo(() => {
    const allCalls = [
      ...(snapshot?.items ?? []).flatMap((i) => i.calls),
      ...(snapshot?.live ?? []),
    ];
    return toolHistory(allCalls, { days: 90 });
  }, [snapshot]);

  const handleSaveSetting: SaveSettingFn = async (key, value) => {
    await updateSettings({ set: { [key]: value } });
    registry.refresh(settingsAtom);
    registry.refresh(libraryAtom);
    registry.refresh(setupAtom);
  };

  const handleToggleSource = async (id: string, next: boolean) => {
    await handleSaveSetting(enabledField(id), next);
  };

  const filteredSources = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sources.filter((s) => {
      if (filter === "enabled" && !s.enabled) return false;
      if (filter === "ready" && (!s.enabled || s.readiness !== "ready")) return false;
      if (filter === "needs_setup" && s.missingKeys.length === 0 && s.missingPrereqs.length === 0) return false;
      if (!q) return true;
      return (
        s.id.toLowerCase().includes(q) ||
        s.label.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.billing.toLowerCase().includes(q)
      );
    });
  }, [sources, query, filter]);

  const groupedSections = useMemo(() => {
    const byId = new Map(filteredSources.map((s) => [s.id, s]));
    const placed = new Set<string>();
    const sections: Array<{
      readonly id: string;
      readonly label: string;
      readonly members: SourceCatalogItem[];
    }> = [];

    for (const grp of snapshot?.groups ?? []) {
      const members: SourceCatalogItem[] = [];
      for (const id of grp.sources) {
        const src = byId.get(id);
        if (src) {
          members.push(src);
          placed.add(id);
        }
      }
      if (members.length > 0) {
        sections.push({ id: grp.id, label: grp.label, members });
      }
    }

    const leftovers = filteredSources.filter((s) => !placed.has(s.id));
    if (leftovers.length > 0) {
      sections.push({ id: "other", label: "Other sources", members: leftovers });
    }
    return sections;
  }, [filteredSources, snapshot?.groups]);

  const enabledCount = sources.filter((s) => s.enabled).length;
  const readyCount = sources.filter((s) => s.enabled && s.readiness === "ready").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">Sources &amp; tools</h1>
          <p className="mb-0 mt-1 text-sm text-muted-foreground">
            {num(enabledCount)} enabled ({num(readyCount)} ready) out of {num(sources.length)}{" "}
            available research sources.
          </p>
        </div>
        <Link
          to="/setup"
          className="dig-button dig-button-default dig-button-size-sm no-underline"
        >
          Open Guided Setup →
        </Link>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <label htmlFor="sources-search" className="sr-only">
          Filter sources
        </label>
        <input
          id="sources-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter sources by name, capability, or billing…"
          className="dig-input max-w-sm"
        />
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter sources">
          {(
            [
              ["all", "All"],
              ["enabled", "Enabled"],
              ["ready", "Ready"],
              ["needs_setup", "Needs setup"],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              size="sm"
              variant={filter === id ? "default" : "ghost"}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {!snapshot && loading ? (
        <Frame spacing="sm">
          <FramePanel>
            <p className="m-0 text-sm text-muted-foreground">Loading source catalog…</p>
          </FramePanel>
        </Frame>
      ) : groupedSections.length === 0 ? (
        <Frame spacing="sm">
          <FramePanel>
            <p className="m-0 text-sm text-muted-foreground">No sources match that filter.</p>
          </FramePanel>
        </Frame>
      ) : (
        <div className="space-y-8">
          {groupedSections.map((group) => (
            <section key={group.id} aria-labelledby={`group-${group.id}`} className="space-y-3">
              <div>
                <h2 id={`group-${group.id}`} className="m-0 text-base font-semibold tracking-tight">
                  {group.label}
                </h2>
                {GROUP_DESCRIPTIONS[group.id] && (
                  <p className="m-0 text-xs text-muted-foreground">
                    {GROUP_DESCRIPTIONS[group.id]}
                  </p>
                )}
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {group.members.map((source) => (
                  <SourceCatalogCard
                    key={source.id}
                    source={source}
                    allSourceIds={allSourceIds}
                    settings={settings}
                    onToggle={handleToggleSource}
                    onSaveSetting={handleSaveSetting}
                    recentCall={recentCalls.get(source.id)}
                    fallbackHistory={fallback90DayHistory}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {snapshot && snapshot.accounts.length > 0 && (
        <AccountsSection
          accounts={snapshot.accounts}
          keysPath={snapshot.keysPath}
          catalogLabel={catalog.label}
        />
      )}
    </div>
  );
}
