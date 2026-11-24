import React, { useContext, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { SettingsFieldSchema } from "../../core/api-types.ts";
import { basename, plural } from "../../ui/format.ts";
import { updateSettings } from "../api/client.ts";
import {
  libraryAtom,
  resultData,
  resultError,
  resultLoading,
  settingsAtom,
  setupAtom,
} from "../state/atoms.ts";
import { SettingControl, type SaveSettingFn } from "../components/SettingControl.tsx";
import { Badge, Disclosure } from "../shared/components.tsx";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../shared/frame.tsx";

const LIBRARY_KEYS = ["library", "keep_raw", "search_semantic"] as const;

const SPEND_META: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly integer: boolean;
}> = [
  {
    key: "spend_dig_ceiling_usd",
    label: "Max USD per dig",
    description: "Refuses new paid USD calls in a dig once provider-reported USD reaches this cap. Leave blank or 0 to remove.",
    integer: false,
  },
  {
    key: "spend_ask_above_usd",
    label: "Ask before spending above (USD)",
    description: "Requests approval before running a single call estimated above this USD threshold. Leave blank or 0 to disable.",
    integer: false,
  },
  {
    key: "spend_max_credits",
    label: "Max provider credits per dig",
    description: "Caps credit-metered provider calls per dig (ScrapeCreators, Firecrawl, etc.). Leave blank or 0 for unlimited.",
    integer: false,
  },
  {
    key: "spend_max_x_post_reads",
    label: "Max X post reads per dig",
    description: "Whole-number cap on X API post reads within one dig. Leave blank or 0 for unlimited.",
    integer: true,
  },
  {
    key: "spend_max_x_account_reads",
    label: "Max X account reads per dig",
    description: "Whole-number cap on X API user/account lookups within one dig. Leave blank or 0 for unlimited.",
    integer: true,
  },
  {
    key: "spend_max_unknown_calls",
    label: "Max unknown-cost calls per dig",
    description: "Whole-number cap on calls whose provider reports no per-request cost. Unknown cost is never treated as $0.",
    integer: true,
  },
];

const X_KEYS = ["x_model", "x_depth", "x_web_search", "x_code_execution"] as const;
const DEFAULT_WORKER_KEYS = ["worker_model", "worker_effort"] as const;

const ENABLED_SUFFIX = /_enabled$/;
const WORKER_OVERRIDE = /^(.+)_worker_(model|effort)$/;

function fallbackSchema(key: string, value: unknown): SettingsFieldSchema {
  if (typeof value === "boolean") return { type: "boolean", title: key };
  if (typeof value === "number") return { type: "number", title: key, minimum: 0 };
  return { type: "string", title: key };
}

export function SettingsPage() {
  const registry = useContext(RegistryContext);
  const settingsResult = useAtomValue(settingsAtom);
  const libraryResult = useAtomValue(libraryAtom);

  const settings = resultData(settingsResult);
  const library = resultData(libraryResult);
  const loading = resultLoading(settingsResult);
  const error = resultError(settingsResult);

  const saveSetting: SaveSettingFn = async (key, value) => {
    await updateSettings({ set: { [key]: value } });
    registry.refresh(settingsAtom);
    registry.refresh(libraryAtom);
    registry.refresh(setupAtom);
  };

  const properties = settings?.schema.properties ?? {};
  const values = settings?.values ?? {};

  const methodWorkerOverrides = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const key of Object.keys(properties)) {
      const match = WORKER_OVERRIDE.exec(key);
      if (!match) continue;
      const method = match[1];
      const list = groups.get(method) ?? [];
      list.push(key);
      groups.set(method, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [properties]);

  const placedKeys = useMemo(
    () =>
      new Set<string>([
        ...LIBRARY_KEYS,
        ...SPEND_META.map((s) => s.key),
        ...X_KEYS,
        ...DEFAULT_WORKER_KEYS,
      ]),
    [],
  );

  const otherKeys = useMemo(
    () =>
      Object.keys(properties).filter(
        (key) =>
          !placedKeys.has(key) &&
          !ENABLED_SUFFIX.test(key) &&
          !WORKER_OVERRIDE.test(key),
      ),
    [properties, placedKeys],
  );

  const activeSpendCaps = useMemo(() => {
    if (!settings) return 0;
    return Object.values(settings.config.spend).filter((v) => v !== null && v > 0).length;
  }, [settings]);

  const libraryPath = typeof values.library === "string" ? values.library : library?.library;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mb-0 mt-1 text-sm text-muted-foreground">
            Native controls editing Dig’s single <code>config.toml</code> file. Changes save
            automatically.
          </p>
        </div>
        <Badge tone="muted">Saves automatically</Badge>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          Could not load settings: {error}
        </div>
      )}

      {/* Quick state overview */}
      {settings && (
        <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-border bg-card p-3">
            <dt className="text-xs text-muted-foreground">Library folder</dt>
            <dd
              className="m-0 mt-1 truncate text-sm font-semibold text-foreground"
              title={libraryPath}
            >
              {libraryPath ? basename(libraryPath) || libraryPath : "Default"}
            </dd>
          </div>
          <div className="rounded-xl border border-border bg-card p-3">
            <dt className="text-xs text-muted-foreground">Original responses</dt>
            <dd className="m-0 mt-1 text-sm font-semibold text-foreground">
              {settings.config.keep_raw ? "Retained" : "Not retained"}
            </dd>
          </div>
          <div className="rounded-xl border border-border bg-card p-3">
            <dt className="text-xs text-muted-foreground">Semantic search</dt>
            <dd className="m-0 mt-1 text-sm font-semibold text-foreground">
              {settings.config.search.semantic ? "Enabled" : "Keyword only"}
            </dd>
          </div>
          <div className="rounded-xl border border-border bg-card p-3">
            <dt className="text-xs text-muted-foreground">Spend guardrails</dt>
            <dd className="m-0 mt-1 text-sm font-semibold text-foreground">
              {activeSpendCaps > 0 ? plural(activeSpendCaps, "active cap") : "No caps set"}
            </dd>
          </div>
        </dl>
      )}

      {!settings && loading ? (
        <Frame spacing="sm">
          <FramePanel>
            <p className="m-0 text-sm text-muted-foreground">Reading config.toml…</p>
          </FramePanel>
        </Frame>
      ) : settings ? (
        <div className="space-y-5">
          {/* Library & Storage */}
          <Frame spacing="sm">
            <FrameHeader>
              <FrameTitle>Library &amp; Storage</FrameTitle>
              <FrameDescription>
                Where plain Markdown reports and JSONL receipts live, original response retention,
                and local semantic indexing.
              </FrameDescription>
            </FrameHeader>
            <FramePanel className="divide-y divide-border">
              {LIBRARY_KEYS.map((key) => {
                const schema = properties[key] ?? fallbackSchema(key, values[key]);
                return (
                  <SettingControl
                    key={key}
                    settingKey={key}
                    schema={schema}
                    value={values[key]}
                    onSave={saveSetting}
                  />
                );
              })}
            </FramePanel>
          </Frame>

          {/* Spend Guardrails */}
          <Frame spacing="sm">
            <FrameHeader>
              <FrameTitle>Spend Guardrails</FrameTitle>
              <FrameDescription>
                Multi-unit caps enforced per dig across USD, provider credits, X API read counters,
                and unknown-cost calls. Enter <code>0</code> or clear a field to remove its cap.
              </FrameDescription>
            </FrameHeader>
            <FramePanel className="divide-y divide-border">
              {SPEND_META.map((item) => {
                const schema: SettingsFieldSchema = properties[item.key] ?? {
                  type: "number",
                  title: item.label,
                  description: item.description,
                  minimum: 0,
                };
                return (
                  <SettingControl
                    key={item.key}
                    settingKey={item.key}
                    schema={schema}
                    value={values[item.key]}
                    onSave={saveSetting}
                    label={item.label}
                    description={item.description}
                    placeholder="No cap (0)"
                    allowEmptyZero
                    integerOnly={item.integer}
                  />
                );
              })}
            </FramePanel>
          </Frame>

          {/* X Search Defaults */}
          <Frame spacing="sm">
            <FrameHeader>
              <FrameTitle>X Search Defaults</FrameTitle>
              <FrameDescription>
                Default Grok search model, reasoning depth, and optional tool toggles for X
                research passes.
              </FrameDescription>
            </FrameHeader>
            <FramePanel className="divide-y divide-border">
              {X_KEYS.map((key) => {
                const schema = properties[key] ?? fallbackSchema(key, values[key]);
                return (
                  <SettingControl
                    key={key}
                    settingKey={key}
                    schema={schema}
                    value={values[key]}
                    onSave={saveSetting}
                  />
                );
              })}
            </FramePanel>
          </Frame>

          {/* Worker Guidance */}
          <Frame spacing="sm">
            <FrameHeader>
              <FrameTitle>Worker Guidance</FrameTitle>
              <FrameDescription>
                Suggested default model and reasoning effort for source workers. The initiating
                assistant chooses worker settings and may pick others.
              </FrameDescription>
            </FrameHeader>
            <FramePanel className="space-y-3">
              <div className="divide-y divide-border">
                {DEFAULT_WORKER_KEYS.map((key) => {
                  const schema = properties[key] ?? fallbackSchema(key, values[key]);
                  return (
                    <SettingControl
                      key={key}
                      settingKey={key}
                      schema={schema}
                      value={values[key]}
                      onSave={saveSetting}
                    />
                  );
                })}
              </div>

              {methodWorkerOverrides.length > 0 && (
                <Disclosure
                  title={`Per-method worker overrides (${methodWorkerOverrides.length})`}
                >
                  <div className="grid gap-4 pt-2 sm:grid-cols-2">
                    {methodWorkerOverrides.map(([method, keys]) => (
                      <div
                        key={method}
                        className="space-y-2 rounded-lg border border-border bg-secondary/20 p-3"
                      >
                        <p className="m-0 font-mono text-xs font-semibold text-foreground">
                          {method.replaceAll("_", "-")}
                        </p>
                        {keys.map((key) => {
                          const schema = properties[key];
                          if (!schema) return null;
                          const isEffort = key.endsWith("_effort");
                          return (
                            <SettingControl
                              key={key}
                              settingKey={key}
                              schema={schema}
                              value={values[key]}
                              onSave={saveSetting}
                              label={isEffort ? "Effort" : "Model"}
                              compact
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </Disclosure>
              )}
            </FramePanel>
          </Frame>

          {/* Any additional schema settings */}
          {otherKeys.length > 0 && (
            <Frame spacing="sm">
              <FrameHeader>
                <FrameTitle>Other settings</FrameTitle>
              </FrameHeader>
              <FramePanel className="divide-y divide-border">
                {otherKeys.map((key) => {
                  const schema = properties[key];
                  if (!schema) return null;
                  return (
                    <SettingControl
                      key={key}
                      settingKey={key}
                      schema={schema}
                      value={values[key]}
                      onSave={saveSetting}
                    />
                  );
                })}
              </FramePanel>
            </Frame>
          )}

          {/* Authority footer */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
            <div>
              <strong className="font-medium text-foreground">Single settings authority:</strong>{" "}
              <code className="break-all">{settings.config.path}</code>
            </div>
            <div className="flex items-center gap-3">
              <Link to="/sources" className="text-primary no-underline hover:underline">
                Manage sources →
              </Link>
              <Link to="/setup" search={{ step: 3 }} className="text-primary no-underline hover:underline">
                Manage API keys →
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
