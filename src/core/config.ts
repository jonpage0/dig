import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import TOML from "@iarna/toml";
import { Context, Effect, Layer, Redacted, Schema, Semaphore } from "effect";
import { ConfigError, KeysError } from "./errors.ts";
import type { SourcePlugin } from "./plugin.ts";
import { registerCredentialEnvNames, registerSecret, SECRET_NAME_PATTERN } from "./secrets.ts";

/**
 * Dig 2.0 configuration (`config.toml`) and credential store (`keys.env`, mode 0600).
 * Backed by `effect/Schema`, `Redacted`, and `Semaphore(1)` atomic writes.
 * Includes multi-unit `[spend]` caps (USD, provider credits, X post/account reads, unknown calls).
 */

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.DIG_STATE_DIR || join(homedir(), ".local", "share", "dig"));
}

export const configPath = (state = stateDirectory()): string => join(state, "config.toml");
export const keysPath = (state = stateDirectory()): string => join(state, "keys.env");
export const sourceSetting = (id: string): string => `${id.replaceAll("-", "_")}_enabled`;

export const WORKER_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type WorkerEffort = (typeof WORKER_EFFORTS)[number];

export const X_DEPTHS = ["quick", "standard", "max", "ultra"] as const;
export type XDepth = (typeof X_DEPTHS)[number];

export interface WorkerEntry {
  readonly model?: string;
  readonly effort?: WorkerEffort;
}

export const WORKER_DEFAULTS: Record<string, { readonly model: string; readonly effort: WorkerEffort }> = {
  default: { model: "gpt-6.1-sol", effort: "medium" },
  "x-breadth": { model: "gpt-6-luna", effort: "high" },
  "x-judge": { model: "gpt-6-astra", effort: "high" },
  "x-trace": { model: "gpt-6-astra", effort: "high" },
};

export const X_DEFAULTS = {
  model: "grok-4.7",
  depth: "quick" as XDepth,
  web_search: false,
  code_execution: false,
} as const;

export interface SpendConfig {
  readonly dig_ceiling_usd: number | null;
  readonly ask_above_usd: number | null;
  readonly max_credits: number | null;
  readonly max_x_post_reads: number | null;
  readonly max_x_account_reads: number | null;
  readonly max_unknown_calls: number | null;
}

export interface DigConfig {
  readonly path: string;
  readonly stateDir: string;
  readonly library: string;
  readonly keep_raw: boolean;
  readonly sources: { readonly enabled: readonly string[] };
  readonly x: {
    readonly model: string;
    readonly depth: XDepth;
    readonly web_search: boolean;
    readonly code_execution: boolean;
  };
  readonly workers: Record<string, WorkerEntry>;
  readonly search: { readonly semantic: boolean };
  readonly spend: SpendConfig;
}

export const SpendSchema = Schema.Struct({
  dig_ceiling_usd: Schema.optional(Schema.NullOr(Schema.Number)),
  ask_above_usd: Schema.optional(Schema.NullOr(Schema.Number)),
  max_credits: Schema.optional(Schema.NullOr(Schema.Number)),
  max_x_post_reads: Schema.optional(Schema.NullOr(Schema.Number)),
  max_x_account_reads: Schema.optional(Schema.NullOr(Schema.Number)),
  max_unknown_calls: Schema.optional(Schema.NullOr(Schema.Number)),
});

export interface CatalogMeta {
  readonly sourceIds: readonly string[];
  readonly methodNames: readonly string[];
  readonly envNames: readonly string[];
  /** Every declared credential name, required or optional: read from keys.env only, never inherited. */
  readonly credentialKeyNames: readonly string[];
}

export function catalogMetaFromPlugins(plugins: readonly SourcePlugin[]): CatalogMeta {
  const sourceIds = plugins.map((p) => p.id);
  const methodNames: string[] = [];
  for (const p of plugins) {
    if (p.kind !== "tool") {
      for (const s of p.skills ?? [p.id]) methodNames.push(s);
      for (const h of p.helpers ?? []) methodNames.push(h);
    } else if (p.helperSkill) {
      methodNames.push(p.helperSkill);
    }
  }
  const envNames = [...new Set(plugins.flatMap((p) => p.env ?? []))];
  const credentialKeyNames = [
    ...new Set(
      plugins.flatMap((p) => [...(p.keys ?? []).flat(), ...(p.optionalKeys ?? []).flatMap((g) => g.names)]),
    ),
  ];
  registerCredentialEnvNames(envNames);
  return { sourceIds, methodNames, envNames, credentialKeyNames };
}

export function workerSetting(table: string, field: "model" | "effort"): string {
  return table === "default" ? `worker_${field}` : `${table.replaceAll("-", "_")}_worker_${field}`;
}

function inheritedWorker(
  workers: Record<string, WorkerEntry>,
  table: string,
  field: "model" | "effort",
): string {
  if (table === "default") return WORKER_DEFAULTS.default[field];
  return (
    WORKER_DEFAULTS[table]?.[field] ??
    workers.default?.[field] ??
    WORKER_DEFAULTS.default[field]
  );
}

export function workerGuidance(
  config: DigConfig,
  table: string,
): { readonly model: string; readonly effort: WorkerEffort; readonly configured: boolean } {
  const model = config.workers[table]?.model ?? inheritedWorker(config.workers, table, "model");
  const effort = (config.workers[table]?.effort ?? inheritedWorker(config.workers, table, "effort")) as WorkerEffort;
  const configured = (["model", "effort"] as const).some(
    (field) =>
      config.workers[table]?.[field] !== undefined ||
      (table !== "default" &&
        WORKER_DEFAULTS[table]?.[field] === undefined &&
        config.workers.default?.[field] !== undefined),
  );
  return { model, effort, configured };
}

function assertTable(value: unknown, name: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ConfigError({ message: `${name} must be a table` });
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      throw new ConfigError({ message: `Unknown configuration field: ${name}.${key}` });
    }
  }
  return obj;
}

function parsePositiveOrNull(
  value: unknown,
  field: string,
  options?: { readonly integer?: boolean },
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError({ message: `spend.${field} must be a positive number` });
  }
  if (options?.integer && !Number.isInteger(value)) {
    throw new ConfigError({ message: `spend.${field} must be a positive integer` });
  }
  return value;
}

function validateWorkerValue(name: string, field: "model" | "effort", value: unknown): string {
  if (field === "model") {
    if (typeof value !== "string" || !value.trim()) {
      throw new ConfigError({ message: `${name} must be a nonempty model name` });
    }
    return value.trim();
  }
  if (typeof value !== "string" || !WORKER_EFFORTS.includes(value as WorkerEffort)) {
    throw new ConfigError({ message: `${name} must be one of ${WORKER_EFFORTS.join(", ")}` });
  }
  return value;
}

export function parseConfigObject(
  input: Record<string, unknown>,
  stateDir: string,
  meta: CatalogMeta,
): DigConfig {
  assertTable(input, "config", ["library", "keep_raw", "sources", "x", "workers", "search", "spend"]);
  if (input.library !== undefined && (typeof input.library !== "string" || !input.library.trim())) {
    throw new ConfigError({ message: "library must be a nonempty path" });
  }
  const rawLibrary = ((input.library as string | undefined) ?? join(stateDir, "library")).replace(
    /^~(?=\/|$)/,
    homedir(),
  );
  if (!isAbsolute(rawLibrary)) {
    throw new ConfigError({ message: "library must be an absolute path or start with ~/" });
  }
  if (input.keep_raw !== undefined && typeof input.keep_raw !== "boolean") {
    throw new ConfigError({ message: "keep_raw must be boolean" });
  }

  const sourcesTable = assertTable(input.sources, "sources", ["enabled"]);
  const defaultEnabled = meta.sourceIds.includes("hackernews") ? ["hackernews"] : meta.sourceIds.slice(0, 1);
  const enabledRaw = sourcesTable.enabled ?? defaultEnabled;
  if (
    !Array.isArray(enabledRaw) ||
    enabledRaw.some((id) => typeof id !== "string" || !meta.sourceIds.includes(id)) ||
    new Set(enabledRaw).size !== enabledRaw.length
  ) {
    throw new ConfigError({
      message: `sources.enabled must contain only supported, unique source ids (${meta.sourceIds.join(", ")})`,
    });
  }

  const xTable = { ...X_DEFAULTS, ...assertTable(input.x, "x", Object.keys(X_DEFAULTS)) };
  if (typeof xTable.model !== "string" || !xTable.model.trim()) {
    throw new ConfigError({ message: "x.model must be a nonempty string" });
  }
  if (!X_DEPTHS.includes(xTable.depth as XDepth)) {
    throw new ConfigError({ message: `x.depth must be one of ${X_DEPTHS.join(", ")}` });
  }
  if (typeof xTable.web_search !== "boolean") throw new ConfigError({ message: "x.web_search must be boolean" });
  if (typeof xTable.code_execution !== "boolean") {
    throw new ConfigError({ message: "x.code_execution must be boolean" });
  }

  const searchTable = { semantic: false, ...assertTable(input.search, "search", ["semantic"]) };
  if (typeof searchTable.semantic !== "boolean") {
    throw new ConfigError({ message: "search.semantic must be boolean" });
  }

  const spendRaw = assertTable(input.spend, "spend", [
    "dig_ceiling_usd",
    "ask_above_usd",
    "max_credits",
    "max_x_post_reads",
    "max_x_account_reads",
    "max_unknown_calls",
  ]);
  const spend: SpendConfig = {
    dig_ceiling_usd: parsePositiveOrNull(spendRaw.dig_ceiling_usd, "dig_ceiling_usd"),
    ask_above_usd: parsePositiveOrNull(spendRaw.ask_above_usd, "ask_above_usd"),
    max_credits: parsePositiveOrNull(spendRaw.max_credits, "max_credits"),
    max_x_post_reads: parsePositiveOrNull(spendRaw.max_x_post_reads, "max_x_post_reads", { integer: true }),
    max_x_account_reads: parsePositiveOrNull(spendRaw.max_x_account_reads, "max_x_account_reads", { integer: true }),
    max_unknown_calls: parsePositiveOrNull(spendRaw.max_unknown_calls, "max_unknown_calls", { integer: true }),
  };

  const workerTables = ["default", ...meta.methodNames];
  const workersRaw = assertTable(input.workers, "workers", workerTables);
  const workers: Record<string, WorkerEntry> = {};
  for (const [tableName, entry] of Object.entries(workersRaw)) {
    const t = assertTable(entry, `workers.${tableName}`, ["model", "effort"]);
    const next: { model?: string; effort?: WorkerEffort } = {};
    if (t.model !== undefined) next.model = validateWorkerValue(`workers.${tableName}.model`, "model", t.model);
    if (t.effort !== undefined) {
      next.effort = validateWorkerValue(`workers.${tableName}.effort`, "effort", t.effort) as WorkerEffort;
    }
    if (Object.keys(next).length) workers[tableName] = next;
  }

  return {
    path: configPath(stateDir),
    stateDir,
    library: resolve(rawLibrary),
    keep_raw: (input.keep_raw as boolean | undefined) ?? true,
    sources: { enabled: enabledRaw as string[] },
    x: {
      model: xTable.model.trim(),
      depth: xTable.depth as XDepth,
      web_search: xTable.web_search,
      code_execution: xTable.code_execution,
    },
    workers,
    search: { semantic: searchTable.semantic },
    spend,
  };
}

export function serializeConfigToml(c: DigConfig): string {
  const spend = Object.fromEntries(Object.entries(c.spend).filter(([, v]) => v !== null));
  const doc: Record<string, unknown> = {
    library: c.library,
    keep_raw: c.keep_raw,
    sources: { enabled: [...c.sources.enabled] },
    x: { ...c.x },
    search: { ...c.search },
  };
  if (Object.keys(spend).length) doc.spend = spend;
  if (Object.keys(c.workers).length) doc.workers = c.workers;
  return `# Dig 2.0 settings. Native controls edit this file.\n${TOML.stringify(doc as TOML.JsonMap)}`;
}

export function flatSettingsValues(c: DigConfig, meta: CatalogMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {
    library: c.library,
    keep_raw: c.keep_raw,
    search_semantic: c.search.semantic,
    spend_dig_ceiling_usd: c.spend.dig_ceiling_usd ?? 0,
    spend_ask_above_usd: c.spend.ask_above_usd ?? 0,
    spend_max_credits: c.spend.max_credits ?? 0,
    spend_max_x_post_reads: c.spend.max_x_post_reads ?? 0,
    spend_max_x_account_reads: c.spend.max_x_account_reads ?? 0,
    spend_max_unknown_calls: c.spend.max_unknown_calls ?? 0,
    x_model: c.x.model,
    x_depth: c.x.depth,
    x_web_search: c.x.web_search,
    x_code_execution: c.x.code_execution,
  };
  for (const id of meta.sourceIds) {
    out[sourceSetting(id)] = c.sources.enabled.includes(id);
  }
  for (const table of ["default", ...meta.methodNames]) {
    const g = workerGuidance(c, table);
    out[workerSetting(table, "model")] = g.model;
    out[workerSetting(table, "effort")] = g.effort;
  }
  return out;
}

function parseSpendSet(
  value: unknown,
  field: string,
  current: number | null,
  options?: { readonly integer?: boolean },
): number | null {
  if (value === undefined) return current;
  if (value === null || value === 0) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError({ message: `${field} must be a non-negative number (0 to remove)` });
  }
  if (options?.integer && !Number.isInteger(value)) {
    throw new ConfigError({ message: `${field} must be a non-negative integer (0 to remove)` });
  }
  return value;
}

export interface ConfigServiceShape {
  readonly stateDir: string;
  readonly meta: CatalogMeta;
  readonly load: () => Effect.Effect<DigConfig, ConfigError>;
  readonly initialize: () => Effect.Effect<DigConfig, ConfigError>;
  readonly update: (set: Record<string, unknown>) => Effect.Effect<DigConfig, ConfigError>;
  readonly flatValues: (c: DigConfig) => Record<string, unknown>;
}

export class ConfigService extends Context.Service<ConfigService, ConfigServiceShape>()("dig/ConfigService") {}

export function makeConfigLayer(
  stateDir: string,
  meta: CatalogMeta,
): Layer.Layer<ConfigService> {
  return Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const writeLock = yield* Semaphore.make(1);

      const load = (): Effect.Effect<DigConfig, ConfigError> =>
        Effect.tryPromise({
          try: async () => {
            const path = configPath(stateDir);
            let parsed: Record<string, unknown> = {};
            try {
              parsed = TOML.parse(await readFile(path, "utf8")) as Record<string, unknown>;
            } catch (e) {
              if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
                throw new ConfigError({
                  message: `Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`,
                  cause: e,
                });
              }
            }
            return parseConfigObject(parsed, stateDir, meta);
          },
          catch: (e) =>
            e instanceof ConfigError
              ? e
              : new ConfigError({ message: e instanceof Error ? e.message : String(e), cause: e }),
        });

      const initialize = (): Effect.Effect<DigConfig, ConfigError> =>
        writeLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* load();
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(stateDir, { recursive: true, mode: 0o700 });
                try {
                  await writeFile(current.path, serializeConfigToml(current), { flag: "wx", mode: 0o600 });
                } catch (e) {
                  if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
                }
              },
              catch: (e) => new ConfigError({ message: `Cannot initialize ${current.path}`, cause: e }),
            });
            return yield* load();
          }),
        );

      const update = (set: Record<string, unknown>): Effect.Effect<DigConfig, ConfigError> =>
        writeLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* load();
            const workerTables = ["default", ...meta.methodNames];
            const workerKeys = workerTables.flatMap((name) =>
              (["model", "effort"] as const).map((field) => [workerSetting(name, field), name, field] as const),
            );
            const allowed = new Set([
              "library",
              "keep_raw",
              "search_semantic",
              "spend_dig_ceiling_usd",
              "spend_ask_above_usd",
              "spend_max_credits",
              "spend_max_x_post_reads",
              "spend_max_x_account_reads",
              "spend_max_unknown_calls",
              ...meta.sourceIds.map(sourceSetting),
              ...Object.keys(X_DEFAULTS).map((k) => `x_${k}`),
              ...workerKeys.map(([key]) => key),
            ]);

            for (const key of Object.keys(set)) {
              if (!allowed.has(key)) {
                return yield* Effect.fail(new ConfigError({ message: `Unknown setting: ${key}` }));
              }
            }
            for (const id of meta.sourceIds) {
              const sk = sourceSetting(id);
              if (set[sk] !== undefined && typeof set[sk] !== "boolean") {
                return yield* Effect.fail(new ConfigError({ message: `${sk} must be boolean` }));
              }
            }

            const workers: Record<string, { model?: string; effort?: WorkerEffort }> = Object.fromEntries(
              Object.entries(current.workers).map(([name, entry]) => [name, { ...entry }]),
            );
            const touched = workerKeys.filter(([key]) => set[key] !== undefined);
            for (const [key, name, field] of touched) {
              const val = validateWorkerValue(key, field, set[key]);
              workers[name] ??= {};
              if (field === "model") workers[name].model = val;
              else workers[name].effort = val as WorkerEffort;
            }
            for (const [, name, field] of touched) {
              if (workers[name]?.[field] === inheritedWorker(workers, name, field)) {
                delete workers[name][field];
              }
              if (workers[name] && Object.keys(workers[name]).length === 0) {
                delete workers[name];
              }
            }

            const nextInput: Record<string, unknown> = {
              library: set.library ?? current.library,
              keep_raw: set.keep_raw ?? current.keep_raw,
              sources: {
                enabled: meta.sourceIds.filter((id) => {
                  const v = set[sourceSetting(id)];
                  return v !== undefined ? Boolean(v) : current.sources.enabled.includes(id);
                }),
              },
              x: {
                model: set.x_model ?? current.x.model,
                depth: set.x_depth ?? current.x.depth,
                web_search: set.x_web_search ?? current.x.web_search,
                code_execution: set.x_code_execution ?? current.x.code_execution,
              },
              workers,
              search: { semantic: set.search_semantic ?? current.search.semantic },
              spend: {
                dig_ceiling_usd: parseSpendSet(set.spend_dig_ceiling_usd, "spend_dig_ceiling_usd", current.spend.dig_ceiling_usd),
                ask_above_usd: parseSpendSet(set.spend_ask_above_usd, "spend_ask_above_usd", current.spend.ask_above_usd),
                max_credits: parseSpendSet(set.spend_max_credits, "spend_max_credits", current.spend.max_credits),
                max_x_post_reads: parseSpendSet(
                  set.spend_max_x_post_reads,
                  "spend_max_x_post_reads",
                  current.spend.max_x_post_reads,
                  { integer: true },
                ),
                max_x_account_reads: parseSpendSet(
                  set.spend_max_x_account_reads,
                  "spend_max_x_account_reads",
                  current.spend.max_x_account_reads,
                  { integer: true },
                ),
                max_unknown_calls: parseSpendSet(
                  set.spend_max_unknown_calls,
                  "spend_max_unknown_calls",
                  current.spend.max_unknown_calls,
                  { integer: true },
                ),
              },
            };

            const next = yield* Effect.try({
              try: () => parseConfigObject(nextInput, stateDir, meta),
              catch: (e) =>
                e instanceof ConfigError
                  ? e
                  : new ConfigError({ message: e instanceof Error ? e.message : String(e), cause: e }),
            });

            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(stateDir, { recursive: true, mode: 0o700 });
                const tmp = `${current.path}.${randomUUID()}.tmp`;
                await writeFile(tmp, serializeConfigToml(next), { mode: 0o600 });
                await chmod(tmp, 0o600);
                await rename(tmp, current.path);
              },
              catch: (e) => new ConfigError({ message: `Cannot write ${current.path}`, cause: e }),
            });

            return next;
          }),
        );

      return ConfigService.of({
        stateDir,
        meta,
        load,
        initialize,
        update,
        flatValues: (c) => flatSettingsValues(c, meta),
      });
    }),
  );
}

// ---- Keys Service (`keys.env`, mode 0600, Redacted) ---------------------------------------------------------

const startingEnvValues = new WeakMap<NodeJS.ProcessEnv, Map<string, string>>();

export interface KeysServiceShape {
  readonly path: string;
  readonly reload: () => Effect.Effect<void, KeysError>;
  readonly get: (name: string) => Redacted.Redacted<string> | undefined;
  readonly has: (name: string) => boolean;
  readonly save: (values: Record<string, string>) => Effect.Effect<{ readonly saved: readonly string[] }, KeysError>;
}

export class KeysService extends Context.Service<KeysService, KeysServiceShape>()("dig/KeysService") {}

export function loadKeysIntoEnv(
  stateDir: string,
  meta: CatalogMeta,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const catalogSet = new Set(meta.envNames);
  const credentialSet = new Set(meta.credentialKeyNames);
  const isCred = (name: string) => SECRET_NAME_PATTERN.test(name) || credentialSet.has(name);

  let text = "";
  try {
    text = readFileSync(keysPath(stateDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }

  const fileValues = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw.trim());
    if (!match || !catalogSet.has(match[1]) || fileValues.has(match[1])) continue;
    const rawVal = match[2].trim();
    const value =
      rawVal.startsWith("'") && rawVal.endsWith("'") && rawVal.length >= 2
        ? rawVal.slice(1, -1).replaceAll("'\\''", "'")
        : rawVal.startsWith('"') && rawVal.endsWith('"') && rawVal.length >= 2
          ? rawVal.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
          : rawVal;
    if (!value) continue;
    fileValues.set(match[1], value);
    if (SECRET_NAME_PATTERN.test(match[1])) registerSecret(value);
  }

  let starting = startingEnvValues.get(env);
  if (!starting) {
    starting = new Map();
    for (const name of catalogSet) {
      const val = env[name]?.trim();
      if (!val) continue;
      starting.set(name, val);
      if (SECRET_NAME_PATTERN.test(name)) registerSecret(val);
    }
    startingEnvValues.set(env, starting);
  }

  for (const name of catalogSet) {
    const val = fileValues.get(name) ?? (isCred(name) ? undefined : starting.get(name));
    if (val === undefined) delete env[name];
    else env[name] = val;
  }
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function makeKeysLayer(
  stateDir: string,
  meta: CatalogMeta,
  env: NodeJS.ProcessEnv = process.env,
): Layer.Layer<KeysService> {
  return Layer.effect(
    KeysService,
    Effect.gen(function* () {
      const writeLock = yield* Semaphore.make(1);
      const allowedNames = new Set(meta.envNames);
      const filePath = keysPath(stateDir);

      // Load immediately when layer boots (missing keys.env is fine).
      yield* Effect.sync(() => {
        try {
          loadKeysIntoEnv(stateDir, meta, env);
        } catch {
          // Leave existing process.env intact if keys.env is temporarily unreadable.
        }
      });

      const reload = (): Effect.Effect<void, KeysError> =>
        Effect.try({
          try: () => loadKeysIntoEnv(stateDir, meta, env),
          catch: (e) =>
            new KeysError({
              message: `Cannot reload ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
              cause: e,
            }),
        });

      const save = (
        values: Record<string, string>,
      ): Effect.Effect<{ readonly saved: readonly string[] }, KeysError> =>
        writeLock.withPermits(1)(
          Effect.gen(function* () {
            const updates = new Map<string, string>();
            for (const [name, raw] of Object.entries(values)) {
              if (!allowedNames.has(name)) {
                return yield* Effect.fail(new KeysError({ message: `${name} is not a credential` }));
              }
              if (/[\r\n\0]/.test(raw)) {
                return yield* Effect.fail(new KeysError({ message: `The value for ${name} spans multiple lines` }));
              }
              const trimmed = raw.trim();
              if (trimmed) updates.set(name, trimmed);
            }
            if (!updates.size) return { saved: [] };

            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(stateDir, { recursive: true, mode: 0o700 });
                let existing = "";
                try {
                  existing = await readFile(filePath, "utf8");
                } catch (e) {
                  if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
                }
                const lines = existing ? existing.split(/\r?\n/) : [];
                if (lines.length && lines.at(-1) === "") lines.pop();
                const remaining = new Map(updates);
                const nextLines = lines.map((line) => {
                  const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
                  if (!m || !remaining.has(m[1])) return line;
                  const val = remaining.get(m[1])!;
                  remaining.delete(m[1]);
                  return `${m[1]}=${quoteEnvValue(val)}`;
                });
                for (const [name, val] of remaining) {
                  nextLines.push(`${name}=${quoteEnvValue(val)}`);
                }
                const tmp = `${filePath}.${randomUUID()}.tmp`;
                await writeFile(tmp, `${nextLines.join("\n")}\n`, { mode: 0o600 });
                await chmod(tmp, 0o600);
                await rename(tmp, filePath);
              },
              catch: (e) => new KeysError({ message: "keys.env could not be written", cause: e }),
            });

            yield* reload();
            return { saved: [...updates.keys()] };
          }),
        );

      return KeysService.of({
        path: filePath,
        reload,
        get: (name) => {
          const val = env[name]?.trim();
          return val ? Redacted.make(val) : undefined;
        },
        has: (name) => Boolean(env[name]?.trim()),
        save,
      });
    }),
  );
}
