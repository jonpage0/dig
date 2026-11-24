import React, { useContext, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { AccountStatus, SourceStatus } from "../../core/setup.ts";
import { httpUrl } from "../../ui/dom.ts";
import { plural } from "../../ui/format.ts";
import {
  applySetupPreset,
  saveSetupKeys,
  saveSetupSources,
  updateSettings,
} from "../api/client.ts";
import {
  libraryAtom,
  resultData,
  resultError,
  resultLoading,
  settingsAtom,
  setupAtom,
} from "../state/atoms.ts";
import { useSourceLogoMap } from "../state/catalog.ts";
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
import { cn } from "../shared/utils.ts";

const STEPS = [
  { num: 1, title: "Choose a preset", short: "Preset" },
  { num: 2, title: "Pick your sources", short: "Sources" },
  { num: 3, title: "Connect API keys", short: "API keys" },
  { num: 4, title: "Spend guardrails & review", short: "Guardrails" },
] as const;

const PRESET_CARDS = [
  {
    id: "starter",
    label: "Starter (100% Free & Keyless)",
    badge: "Free & keyless",
    badgeTone: "success" as const,
    description:
      "Hacker News, DeepWiki, Polymarket, Wayback Machine, SEC EDGAR, Bluesky — zero API keys needed.",
    sources: ["hackernews", "deepwiki", "polymarket", "wayback", "sec", "bluesky"],
  },
  {
    id: "research",
    label: "Deep Technical Research",
    badge: "Recommended for engineers",
    badgeTone: "neutral" as const,
    description:
      "Web (Exa, Firecrawl, Wayback), Code (GitHub, DeepWiki, HN), Papers, SEC, YouTube, Evidence Ranking.",
    sources: [
      "hackernews",
      "deepwiki",
      "github",
      "exa",
      "firecrawl",
      "wayback",
      "papers",
      "sec",
      "youtube",
      "evidence",
    ],
  },
  {
    id: "social",
    label: "Social & Discourse",
    badge: "Multi-platform",
    badgeTone: "neutral" as const,
    description:
      "X, Bluesky, Reddit, Hacker News, TikTok, Instagram, Facebook, Threads, LinkedIn, Telegram.",
    sources: [
      "hackernews",
      "x",
      "bluesky",
      "reddit",
      "tiktok",
      "instagram",
      "facebook",
      "threads",
      "linkedin",
      "telegram",
    ],
  },
  {
    id: "all",
    label: "All Sources",
    badge: "Full catalog",
    badgeTone: "muted" as const,
    description: "Enable every research source and shared tool in the catalog.",
    sources: [] as readonly string[],
  },
] as const;

const GROUP_LABELS: Readonly<Record<string, string>> = {
  web: "Web search",
  code: "Code and developers",
  papers: "Papers",
  video: "Video",
  social: "Social",
  markets: "Markets and commerce",
  tools: "Shared tools",
};

const SPEND_FIELDS = [
  {
    key: "spend_dig_ceiling_usd",
    configKey: "dig_ceiling_usd" as const,
    label: "Max USD per dig",
    placeholder: "e.g. 2.50 (blank = unlimited)",
    help: "Refuses new paid USD calls in a dig once provider-reported USD spend reaches this ceiling.",
    integer: false,
  },
  {
    key: "spend_ask_above_usd",
    configKey: "ask_above_usd" as const,
    label: "Ask before spending above (USD)",
    placeholder: "e.g. 0.50 (blank = do not prompt)",
    help: "Asks for approval before running a single call whose estimated USD spend exceeds this amount.",
    integer: false,
  },
  {
    key: "spend_max_credits",
    configKey: "max_credits" as const,
    label: "Max provider credits per dig",
    placeholder: "e.g. 50 (blank = unlimited)",
    help: "Caps credit-billed calls (such as ScrapeCreators or Firecrawl credits) per dig.",
    integer: false,
  },
  {
    key: "spend_max_x_post_reads",
    configKey: "max_x_post_reads" as const,
    label: "Max X post reads per dig",
    placeholder: "e.g. 500 (blank = unlimited)",
    help: "Whole-number cap on X API post reads within one dig.",
    integer: true,
  },
  {
    key: "spend_max_x_account_reads",
    configKey: "max_x_account_reads" as const,
    label: "Max X account reads per dig",
    placeholder: "e.g. 100 (blank = unlimited)",
    help: "Whole-number cap on X API user/account lookups within one dig.",
    integer: true,
  },
  {
    key: "spend_max_unknown_calls",
    configKey: "max_unknown_calls" as const,
    label: "Max unknown-cost calls per dig",
    placeholder: "e.g. 10 (blank = unlimited)",
    help: "Caps calls whose provider reports no per-request price. Unknown cost is never treated as $0.",
    integer: true,
  },
] as const;

function isFreeSource(source: SourceStatus): boolean {
  return (
    source.missingKeys.length === 0 &&
    source.presentKeys.length === 0 &&
    /free|no key|keyless|no charge/i.test(source.billing)
  );
}

export function SetupWizardPage() {
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { step?: number };

  const setupResult = useAtomValue(setupAtom);
  const libraryResult = useAtomValue(libraryAtom);
  const setup = resultData(setupResult);
  const library = resultData(libraryResult);
  const loading = resultLoading(setupResult);
  const loadError = resultError(setupResult);
  const logoMap = useSourceLogoMap(library);

  const initialStep =
    typeof search.step === "number" && search.step >= 1 && search.step <= 4 ? search.step : 1;
  const [step, setStep] = useState<number>(initialStep);

  useEffect(() => {
    if (typeof search.step === "number" && search.step >= 1 && search.step <= 4) {
      setStep(search.step);
    }
  }, [search.step]);

  const goToStep = (next: number) => {
    const clamped = Math.max(1, Math.min(4, next));
    setStep(clamped);
    void navigate({ to: "/setup", search: { step: clamped }, replace: true });
  };

  const refreshAll = () => {
    registry.refresh(setupAtom);
    registry.refresh(libraryAtom);
    registry.refresh(settingsAtom);
  };

  // Step 1: Preset state
  const [presetBusy, setPresetBusy] = useState<string | null>(null);
  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);

  // Step 2: Source checkboxes state (synced from setup snapshot)
  const [selectedSources, setSelectedSources] = useState<Set<string>>(() => new Set());
  const [sourcesDirty, setSourcesDirty] = useState(false);
  const [sourcesBusy, setSourcesBusy] = useState(false);
  const [sourcesNotice, setSourcesNotice] = useState<string | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);

  useEffect(() => {
    if (!setup || sourcesDirty) return;
    setSelectedSources(new Set(setup.sources.filter((s) => s.enabled).map((s) => s.id)));
  }, [setup, sourcesDirty]);

  // Step 3: API Keys state (strictly ephemeral React state; cleared immediately upon save!)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  const [keysBusy, setKeysBusy] = useState(false);
  const [keysSavedNames, setKeysSavedNames] = useState<readonly string[]>([]);
  const [keysError, setKeysError] = useState<string | null>(null);

  // Step 4: Spend guardrails state
  const [spendDraft, setSpendDraft] = useState<Record<string, string>>({});
  const [spendDirty, setSpendDirty] = useState(false);
  const [spendBusy, setSpendBusy] = useState(false);
  const [spendNotice, setSpendNotice] = useState<string | null>(null);
  const [spendError, setSpendError] = useState<string | null>(null);

  useEffect(() => {
    if (!setup || spendDirty) return;
    const next: Record<string, string> = {};
    for (const field of SPEND_FIELDS) {
      const val = setup.spend[field.configKey];
      next[field.key] = val !== null && val !== undefined && val > 0 ? String(val) : "";
    }
    setSpendDraft(next);
  }, [setup, spendDirty]);

  const sourceLabelMap = useMemo(
    () => new Map((setup?.sources ?? []).map((s) => [s.id, s.label])),
    [setup?.sources],
  );

  const activePresetId = useMemo(() => {
    if (!setup) return null;
    const enabled = new Set(setup.sources.filter((s) => s.enabled).map((s) => s.id));
    if (enabled.size === setup.sources.length && setup.sources.length > 0) return "all";
    for (const preset of PRESET_CARDS) {
      if (preset.id === "all") continue;
      const available = preset.sources.filter((id) => setup.sources.some((s) => s.id === id));
      if (available.length === enabled.size && available.every((id) => enabled.has(id))) {
        return preset.id;
      }
    }
    return null;
  }, [setup]);

  const groupedSources = useMemo(() => {
    const groups = new Map<string, SourceStatus[]>();
    for (const s of setup?.sources ?? []) {
      const list = groups.get(s.group) ?? [];
      list.push(s);
      groups.set(s.group, list);
    }
    const orderedKeys = Object.keys(GROUP_LABELS).filter((k) => groups.has(k));
    for (const k of groups.keys()) {
      if (!orderedKeys.includes(k)) orderedKeys.push(k);
    }
    return orderedKeys.map((id) => ({
      id,
      label: GROUP_LABELS[id] ?? id,
      sources: groups.get(id) ?? [],
    }));
  }, [setup?.sources]);

  const enabledSourceIds = useMemo(
    () => new Set((setup?.sources ?? []).filter((s) => s.enabled).map((s) => s.id)),
    [setup?.sources],
  );

  const relevantAccounts = useMemo<readonly AccountStatus[]>(() => {
    if (!setup) return [];
    if (showAllAccounts) return setup.accounts;
    return setup.accounts.filter((acc) => acc.sources.some((id) => enabledSourceIds.has(id)));
  }, [setup, showAllAccounts, enabledSourceIds]);

  const handleApplyPreset = async (presetId: string) => {
    setPresetBusy(presetId);
    setPresetError(null);
    setPresetNotice(null);
    try {
      const updated = await applySetupPreset(presetId);
      setSelectedSources(new Set(updated.sources.filter((s) => s.enabled).map((s) => s.id)));
      setSourcesDirty(false);
      refreshAll();
      const label = PRESET_CARDS.find((p) => p.id === presetId)?.label ?? presetId;
      setPresetNotice(`Applied “${label}” (${updated.sources.filter((s) => s.enabled).length} sources enabled).`);
    } catch (err: unknown) {
      setPresetError(err instanceof Error ? err.message : "Could not apply preset.");
    } finally {
      setPresetBusy(null);
    }
  };

  const toggleSourceSelection = (id: string) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSourcesDirty(true);
    setSourcesNotice(null);
    setSourcesError(null);
  };

  const setGroupSelection = (ids: readonly string[], checked: boolean) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    setSourcesDirty(true);
    setSourcesNotice(null);
    setSourcesError(null);
  };

  const handleSaveSources = async (advance = false) => {
    setSourcesBusy(true);
    setSourcesError(null);
    setSourcesNotice(null);
    try {
      const ids = [...selectedSources];
      await saveSetupSources(ids);
      setSourcesDirty(false);
      refreshAll();
      setSourcesNotice(`Saved ${plural(ids.length, "enabled source")}.`);
      if (advance) goToStep(3);
    } catch (err: unknown) {
      setSourcesError(err instanceof Error ? err.message : "Could not save source selection.");
    } finally {
      setSourcesBusy(false);
    }
  };

  const handleSaveKeys = async (event: React.FormEvent) => {
    event.preventDefault();
    const payload: Record<string, string> = {};
    for (const [name, raw] of Object.entries(keyDrafts)) {
      const trimmed = raw.trim();
      if (trimmed) payload[name] = trimmed;
    }
    if (Object.keys(payload).length === 0) {
      setKeysError("Enter at least one key above before saving, or click Next to continue.");
      return;
    }

    setKeysBusy(true);
    setKeysError(null);
    setKeysSavedNames([]);
    try {
      const res = await saveSetupKeys(payload);
      // Immediately clear secret input drafts from React memory after saving.
      setKeyDrafts({});
      setKeysSavedNames(res.saved);
      refreshAll();
    } catch (err: unknown) {
      setKeysError(err instanceof Error ? err.message : "Could not save keys to keys.env.");
    } finally {
      setKeysBusy(false);
    }
  };

  const handleSaveSpend = async (event: React.FormEvent) => {
    event.preventDefault();
    setSpendError(null);
    setSpendNotice(null);

    const setPayload: Record<string, number> = {};
    for (const field of SPEND_FIELDS) {
      const raw = (spendDraft[field.key] ?? "").trim();
      if (!raw) {
        setPayload[field.key] = 0;
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setSpendError(`${field.label} must be a non-negative number.`);
        return;
      }
      if (field.integer && !Number.isInteger(parsed)) {
        setSpendError(`${field.label} must be a whole number.`);
        return;
      }
      setPayload[field.key] = parsed;
    }

    setSpendBusy(true);
    try {
      await updateSettings({ set: setPayload });
      setSpendDirty(false);
      refreshAll();
      setSpendNotice("Spend guardrails saved to config.toml.");
    } catch (err: unknown) {
      setSpendError(err instanceof Error ? err.message : "Could not save spend guardrails.");
    } finally {
      setSpendBusy(false);
    }
  };

  const enabledSourcesList = useMemo(
    () => (setup?.sources ?? []).filter((s) => s.enabled),
    [setup?.sources],
  );
  const readyEnabledCount = enabledSourcesList.filter((s) => s.readiness === "ready").length;
  const pendingKeyDraftCount = Object.values(keyDrafts).filter((v) => v.trim().length > 0).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="m-0 text-2xl font-semibold tracking-tight">Setup Dig</h1>
        <p className="mb-0 mt-1 text-sm text-muted-foreground">
          Choose sources, store API keys locally in <code>keys.env</code> (0600), and set spend
          guardrails. Jump to any step at any time.
        </p>
      </div>

      {loadError && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          Could not load setup snapshot: {loadError}
        </div>
      )}

      {/* 4-Step Freely Navigable Stepper */}
      <nav aria-label="Setup steps" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STEPS.map((s) => {
          const active = step === s.num;
          const passed = step > s.num;
          return (
            <button
              key={s.num}
              type="button"
              onClick={() => goToStep(s.num)}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                active
                  ? "border-primary bg-accent/60 text-foreground shadow-xs"
                  : "border-border bg-card text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  active
                    ? "bg-primary text-primary-foreground"
                    : passed
                      ? "bg-secondary text-foreground"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {s.num}
              </span>
              <span className="min-w-0 truncate text-xs font-medium">{s.title}</span>
            </button>
          );
        })}
      </nav>

      {!setup && loading ? (
        <Frame spacing="sm">
          <FramePanel>
            <p className="m-0 text-sm text-muted-foreground">Loading setup configuration…</p>
          </FramePanel>
        </Frame>
      ) : (
        <>
          {/* STEP 1: Choose a preset */}
          {step === 1 && (
            <Frame spacing="sm">
              <FrameHeader>
                <FrameTitle>Step 1 · Choose a preset</FrameTitle>
                <FrameDescription>
                  Start fast with a curated bundle of sources. You can fine-tune individual sources
                  in the next step.
                </FrameDescription>
              </FrameHeader>
              <FramePanel className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  {PRESET_CARDS.map((preset) => {
                    const isCurrent = activePresetId === preset.id;
                    const isApplying = presetBusy === preset.id;
                    const count =
                      preset.id === "all"
                        ? (setup?.sources.length ?? 0)
                        : preset.sources.filter((id) => setup?.sources.some((s) => s.id === id))
                            .length;
                    return (
                      <div
                        key={preset.id}
                        className={cn(
                          "flex flex-col justify-between gap-3 rounded-xl border p-4 transition-colors",
                          isCurrent
                            ? "border-primary bg-accent/35"
                            : "border-border bg-card hover:border-ring/50",
                        )}
                      >
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="m-0 text-sm font-semibold text-foreground">
                              {preset.label}
                            </h3>
                            <Badge tone={isCurrent ? "success" : preset.badgeTone}>
                              {isCurrent ? "Active ✓" : preset.badge}
                            </Badge>
                          </div>
                          <p className="m-0 text-xs leading-relaxed text-muted-foreground">
                            {preset.description}
                          </p>
                          <p className="m-0 text-[11px] font-medium text-muted-foreground">
                            {plural(count, "source")}
                          </p>
                        </div>

                        <div>
                          <Button
                            variant={isCurrent ? "outline" : "default"}
                            size="sm"
                            disabled={presetBusy !== null}
                            onClick={() => void handleApplyPreset(preset.id)}
                          >
                            {isApplying
                              ? "Applying…"
                              : isCurrent
                                ? "Re-apply preset"
                                : "Use this preset"}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {presetNotice && (
                  <p role="status" className="m-0 text-xs font-medium text-[var(--success)]">
                    {presetNotice}
                  </p>
                )}
                {presetError && (
                  <p role="alert" className="m-0 text-xs text-destructive">
                    {presetError}
                  </p>
                )}
              </FramePanel>
              <FrameFooter className="flex-row items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Currently enabled: {plural(enabledSourcesList.length, "source")}
                </span>
                <Button variant="default" size="sm" onClick={() => goToStep(2)}>
                  Next: Pick your sources →
                </Button>
              </FrameFooter>
            </Frame>
          )}

          {/* STEP 2: Pick your sources */}
          {step === 2 && (
            <Frame spacing="sm">
              <FrameHeader className="flex-row flex-wrap items-center justify-between gap-3">
                <div>
                  <FrameTitle>Step 2 · Pick your sources</FrameTitle>
                  <FrameDescription>
                    Select the exact research sources and shared tools you want enabled in{" "}
                    <code>config.toml</code>.
                  </FrameDescription>
                </div>
                <Badge tone="neutral">{plural(selectedSources.size, "selected")}</Badge>
              </FrameHeader>
              <FramePanel className="space-y-5">
                {groupedSources.map((group) => {
                  const groupIds = group.sources.map((s) => s.id);
                  const allSelected = groupIds.every((id) => selectedSources.has(id));
                  return (
                    <section key={group.id} className="space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {group.label}
                        </h3>
                        <button
                          type="button"
                          onClick={() => setGroupSelection(groupIds, !allSelected)}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          {allSelected ? "Clear group" : "Select group"}
                        </button>
                      </div>

                      <div className="grid gap-2.5 md:grid-cols-2">
                        {group.sources.map((src) => {
                          const checked = selectedSources.has(src.id);
                          const free = isFreeSource(src);
                          return (
                            <label
                              key={src.id}
                              className={cn(
                                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
                                checked
                                  ? "border-primary/60 bg-accent/30"
                                  : "border-border bg-card hover:bg-secondary/30",
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSourceSelection(src.id)}
                                className="mt-1 size-4 accent-[var(--primary)]"
                              />
                              <SourceIcon id={src.id} logo={logoMap.get(src.id)} size="sm" />
                              <div className="min-w-0 flex-1 space-y-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-sm font-medium text-foreground">
                                    {src.label}
                                  </span>
                                  <Badge tone={free ? "success" : "muted"}>
                                    {free ? "Free / keyless" : "Paid / key"}
                                  </Badge>
                                  {src.readiness === "ready" && !free && (
                                    <Badge tone="success">Key set ✓</Badge>
                                  )}
                                </div>
                                <p className="m-0 text-xs text-muted-foreground">
                                  {src.description}
                                </p>
                                <p className="m-0 text-[11px] text-muted-foreground/90">
                                  {src.billing}
                                </p>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}

                {sourcesNotice && (
                  <p role="status" className="m-0 text-xs font-medium text-[var(--success)]">
                    {sourcesNotice}
                  </p>
                )}
                {sourcesError && (
                  <p role="alert" className="m-0 text-xs text-destructive">
                    {sourcesError}
                  </p>
                )}
              </FramePanel>
              <FrameFooter className="flex-row flex-wrap items-center justify-between gap-2">
                <Button variant="outline" size="sm" onClick={() => goToStep(1)}>
                  ← Back
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={sourcesBusy || !sourcesDirty}
                    onClick={() => void handleSaveSources(false)}
                  >
                    {sourcesBusy ? "Saving…" : "Save selection"}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={sourcesBusy}
                    onClick={() => {
                      if (sourcesDirty) {
                        void handleSaveSources(true);
                      } else {
                        goToStep(3);
                      }
                    }}
                  >
                    {sourcesDirty ? "Save & continue →" : "Next: Connect API keys →"}
                  </Button>
                </div>
              </FrameFooter>
            </Frame>
          )}

          {/* STEP 3: Connect API keys */}
          {step === 3 && (
            <Frame spacing="sm">
              <FrameHeader className="flex-row flex-wrap items-center justify-between gap-3">
                <div>
                  <FrameTitle>Step 3 · Connect API keys</FrameTitle>
                  <FrameDescription>
                    Saved directly to{" "}
                    <code>{setup?.keysPath ?? "~/.local/share/dig/keys.env"}</code> (mode 0600) on
                    this computer. Keys are never echoed back or shared with models.
                  </FrameDescription>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAllAccounts((v) => !v)}
                >
                  {showAllAccounts ? "Show enabled sources only" : "Show all accounts"}
                </Button>
              </FrameHeader>
              <form onSubmit={(e) => void handleSaveKeys(e)}>
                <FramePanel className="space-y-4">
                  {relevantAccounts.length === 0 ? (
                    <div className="rounded-xl border border-border bg-secondary/35 p-5 text-center">
                      <p className="m-0 text-sm font-medium text-foreground">
                        All currently enabled sources are keyless and ready to use.
                      </p>
                      <p className="mb-0 mt-1 text-xs text-muted-foreground">
                        No API keys are required for your selected sources. Continue to review
                        spend guardrails or enable additional accounts above.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {relevantAccounts.map((acc) => {
                        const signupHref = httpUrl(acc.signup);
                        const unlocked = acc.sources
                          .filter((id) => enabledSourceIds.has(id) || showAllAccounts)
                          .map((id) => sourceLabelMap.get(id) ?? id);
                        return (
                          <div
                            key={acc.id}
                            className="space-y-3 rounded-xl border border-border bg-secondary/20 p-4"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="space-y-0.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h3 className="m-0 text-sm font-semibold text-foreground">
                                    {acc.name}
                                  </h3>
                                  <Badge tone={acc.ready ? "success" : "partial"}>
                                    {acc.ready ? "Already set ✓" : "Key needed"}
                                  </Badge>
                                </div>
                                <p className="m-0 text-xs text-muted-foreground">
                                  {acc.billing}
                                  {unlocked.length > 0 && ` · Used by ${unlocked.join(", ")}`}
                                </p>
                              </div>
                              {signupHref && (
                                <a
                                  href={signupHref}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs font-medium text-primary no-underline hover:underline"
                                >
                                  Get API key ↗
                                </a>
                              )}
                            </div>

                            <div className="space-y-2.5">
                              {acc.keys.map((k) => (
                                <div
                                  key={k.name}
                                  className="grid gap-1.5 sm:grid-cols-[240px_1fr] sm:items-center"
                                >
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <label
                                      htmlFor={`key-${k.name}`}
                                      className="font-mono text-xs font-medium text-foreground"
                                    >
                                      {k.name}
                                    </label>
                                    {k.set ? (
                                      <Badge tone="success">Already set ✓</Badge>
                                    ) : (
                                      <Badge tone="warning">Required</Badge>
                                    )}
                                  </div>
                                  <input
                                    id={`key-${k.name}`}
                                    name={k.name}
                                    type="password"
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={keyDrafts[k.name] ?? ""}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setKeyDrafts((prev) => ({ ...prev, [k.name]: val }));
                                      setKeysError(null);
                                    }}
                                    placeholder={
                                      k.set
                                        ? "Already set — leave blank to keep, or paste to replace"
                                        : `Paste ${k.name}…`
                                    }
                                    className="dig-input font-mono text-xs"
                                  />
                                </div>
                              ))}

                              {acc.optional.map((o) => (
                                <div
                                  key={o.name}
                                  className="grid gap-1.5 sm:grid-cols-[240px_1fr] sm:items-center"
                                >
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <label
                                      htmlFor={`key-${o.name}`}
                                      className="font-mono text-xs text-muted-foreground"
                                    >
                                      {o.name}
                                    </label>
                                    {o.set ? (
                                      <Badge tone="success">Already set ✓</Badge>
                                    ) : (
                                      <Badge tone="muted">Optional</Badge>
                                    )}
                                  </div>
                                  <input
                                    id={`key-${o.name}`}
                                    name={o.name}
                                    type="password"
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={keyDrafts[o.name] ?? ""}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setKeyDrafts((prev) => ({ ...prev, [o.name]: val }));
                                      setKeysError(null);
                                    }}
                                    placeholder={
                                      o.set
                                        ? "Already set — leave blank to keep"
                                        : `Optional ${o.name}…`
                                    }
                                    className="dig-input font-mono text-xs"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {keysSavedNames.length > 0 && (
                    <div
                      role="status"
                      className="rounded-lg border border-[var(--success)]/30 bg-[var(--success)]/10 px-3.5 py-2.5 text-xs text-[var(--success)]"
                    >
                      Saved {keysSavedNames.join(", ")} to <code>keys.env</code> and cleared input
                      fields from memory.
                    </div>
                  )}
                  {keysError && (
                    <p role="alert" className="m-0 text-xs text-destructive">
                      {keysError}
                    </p>
                  )}
                </FramePanel>
                <FrameFooter className="flex-row flex-wrap items-center justify-between gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => goToStep(2)}>
                    ← Back
                  </Button>
                  <div className="flex items-center gap-2">
                    {pendingKeyDraftCount > 0 && (
                      <Button type="submit" variant="default" size="sm" disabled={keysBusy}>
                        {keysBusy
                          ? "Saving keys…"
                          : `Save ${plural(pendingKeyDraftCount, "key")} to keys.env`}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant={pendingKeyDraftCount > 0 ? "outline" : "default"}
                      size="sm"
                      onClick={() => goToStep(4)}
                    >
                      Next: Spend guardrails &amp; review →
                    </Button>
                  </div>
                </FrameFooter>
              </form>
            </Frame>
          )}

          {/* STEP 4: Spend guardrails & review */}
          {step === 4 && (
            <div className="space-y-5">
              <Frame spacing="sm">
                <FrameHeader>
                  <FrameTitle>Step 4 · Optional multi-unit spend guardrails</FrameTitle>
                  <FrameDescription>
                    Set optional per-dig caps across USD, provider credits, X reads, and
                    unknown-cost calls. Leave any field blank (or 0) for no cap.
                  </FrameDescription>
                </FrameHeader>
                <form onSubmit={(e) => void handleSaveSpend(e)}>
                  <FramePanel className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      {SPEND_FIELDS.map((field) => (
                        <div key={field.key} className="space-y-1">
                          <label
                            htmlFor={`wizard-${field.key}`}
                            className="block text-xs font-medium text-foreground"
                          >
                            {field.label}
                          </label>
                          <input
                            id={`wizard-${field.key}`}
                            type="number"
                            min={0}
                            step={field.integer ? 1 : "any"}
                            value={spendDraft[field.key] ?? ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              setSpendDraft((prev) => ({ ...prev, [field.key]: val }));
                              setSpendDirty(true);
                              setSpendNotice(null);
                              setSpendError(null);
                            }}
                            placeholder={field.placeholder}
                            className="dig-input"
                          />
                          <p className="m-0 text-[11px] leading-snug text-muted-foreground">
                            {field.help}
                          </p>
                        </div>
                      ))}
                    </div>

                    {spendNotice && (
                      <p role="status" className="m-0 text-xs font-medium text-[var(--success)]">
                        {spendNotice}
                      </p>
                    )}
                    {spendError && (
                      <p role="alert" className="m-0 text-xs text-destructive">
                        {spendError}
                      </p>
                    )}
                  </FramePanel>
                  <FrameFooter className="flex-row flex-wrap items-center justify-between gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => goToStep(3)}>
                      ← Back to API keys
                    </Button>
                    <Button type="submit" variant="default" size="sm" disabled={spendBusy}>
                      {spendBusy ? "Saving guardrails…" : "Save guardrails"}
                    </Button>
                  </FrameFooter>
                </form>
              </Frame>

              {/* Live Readiness Checklist */}
              <Frame spacing="sm">
                <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2">
                  <div>
                    <FrameTitle>Source readiness checklist</FrameTitle>
                    <FrameDescription>
                      {readyEnabledCount} of {plural(enabledSourcesList.length, "enabled source")}{" "}
                      ready to use
                    </FrameDescription>
                  </div>
                  <Badge
                    tone={
                      enabledSourcesList.length > 0 &&
                      readyEnabledCount === enabledSourcesList.length
                        ? "success"
                        : "partial"
                    }
                  >
                    {readyEnabledCount}/{enabledSourcesList.length} ready
                  </Badge>
                </FrameHeader>
                <FramePanel>
                  {enabledSourcesList.length === 0 ? (
                    <p className="m-0 text-sm text-muted-foreground">
                      No sources enabled yet. Go back to Step 1 or 2 to enable at least one source.
                    </p>
                  ) : (
                    <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
                      {enabledSourcesList.map((src) => (
                        <li
                          key={src.id}
                          className="flex items-center justify-between gap-2 rounded-lg border border-border bg-secondary/20 px-3 py-2 text-xs"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <SourceIcon id={src.id} logo={logoMap.get(src.id)} size="xs" />
                            <div className="min-w-0">
                              <div className="truncate font-medium text-foreground">{src.label}</div>
                              {src.missingKeys.length > 0 && (
                                <div className="truncate text-[11px] text-muted-foreground">
                                  Needs {src.missingKeys.join(", ")}
                                </div>
                              )}
                              {src.missingPrereqs.length > 0 && (
                                <div className="truncate text-[11px] text-muted-foreground">
                                  Install {src.missingPrereqs.join(", ")}
                                </div>
                              )}
                            </div>
                          </div>
                          {src.readiness === "ready" ? (
                            <Badge tone="success">Ready ✓</Badge>
                          ) : src.missingKeys.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => goToStep(3)}
                              className="shrink-0 font-medium text-primary hover:underline"
                            >
                              Add key
                            </button>
                          ) : (
                            <Badge tone="warning">Needs tool</Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </FramePanel>
                <FrameFooter className="flex-row flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    Config: <code>{setup?.configPath}</code>
                  </span>
                  <Link
                    to="/"
                    className="dig-button dig-button-default dig-button-size-sm no-underline"
                  >
                    Open Research Library →
                  </Link>
                </FrameFooter>
              </Frame>
            </div>
          )}
        </>
      )}
    </div>
  );
}
