import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Context, Effect, Layer } from "effect";
import { ConfigService, KeysService, sourceSetting, type DigConfig } from "./config.ts";
import { ConfigError, type KeysError } from "./errors.ts";
import type { ProviderAccount, SourcePlugin } from "./plugin.ts";
import { ProgressHub } from "./progress.ts";

const execFileAsync = promisify(execFile);

/**
 * Shared SetupService powering BOTH the interactive `dig setup` CLI TUI (`effect/cli/Prompt`)
 * and the guided Web `/setup` Wizard in the localhost SPA.
 */

export type SourceReadiness = "ready" | "partial" | "needs_setup";

export interface SourceStatus {
  readonly id: string;
  readonly kind: "source" | "tool";
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly readiness: SourceReadiness;
  readonly missingKeys: readonly string[];
  readonly presentKeys: readonly string[];
  readonly missingPrereqs: readonly string[];
  readonly credential?: string;
  readonly billing: string;
  readonly actions: readonly string[];
  readonly methods: readonly string[];
}

export interface AccountStatus {
  readonly id: string;
  readonly name: string;
  readonly signup: string;
  readonly billing: string;
  readonly keys: readonly { readonly name: string; readonly aliases: readonly string[]; readonly set: boolean }[];
  readonly optional: readonly { readonly name: string; readonly set: boolean }[];
  readonly sources: readonly string[];
  readonly ready: boolean;
}

export interface SetupSnapshot {
  readonly configPath: string;
  readonly keysPath: string;
  readonly library: string;
  readonly sources: readonly SourceStatus[];
  readonly accounts: readonly AccountStatus[];
  readonly spend: DigConfig["spend"];
  readonly keepRaw: boolean;
  readonly searchSemantic: boolean;
}

export const SETUP_PRESETS: Record<string, { readonly label: string; readonly description: string; readonly sources: readonly string[] }> = {
  starter: {
    label: "Starter (100% Free & Keyless)",
    description: "Hacker News, DeepWiki, Polymarket, Wayback, SEC EDGAR, Bluesky — zero API keys needed.",
    sources: ["hackernews", "deepwiki", "polymarket", "wayback", "sec", "bluesky"],
  },
  research: {
    label: "Deep Technical Research",
    description: "Web (Exa, Firecrawl, Wayback), Code (GitHub, DeepWiki, HN), Papers, SEC, YouTube, Evidence Ranking.",
    sources: ["hackernews", "deepwiki", "github", "exa", "firecrawl", "wayback", "papers", "sec", "youtube", "evidence"],
  },
  social: {
    label: "Social & Discourse",
    description: "X, Bluesky, Reddit, HN, TikTok, Instagram, Facebook, Threads, LinkedIn, Telegram.",
    sources: ["hackernews", "x", "bluesky", "reddit", "tiktok", "instagram", "facebook", "threads", "linkedin", "telegram"],
  },
  all: {
    label: "All Sources",
    description: "Enable every research source and shared tool in the catalog.",
    sources: [], // populated dynamically from registered plugins
  },
};

async function hasBinary(name: string): Promise<boolean> {
  const bin = name.split(/\s+/)[0];
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [bin], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export interface SetupServiceShape {
  readonly snapshot: () => Effect.Effect<SetupSnapshot, ConfigError>;
  readonly applyPreset: (presetId: string) => Effect.Effect<DigConfig, ConfigError>;
  readonly setEnabledSources: (enabledIds: readonly string[]) => Effect.Effect<DigConfig, ConfigError>;
  readonly saveKeys: (values: Record<string, string>) => Effect.Effect<{ readonly saved: readonly string[] }, KeysError>;
  readonly updateSettings: (set: Record<string, unknown>) => Effect.Effect<DigConfig, ConfigError>;
}

export class SetupService extends Context.Service<SetupService, SetupServiceShape>()("dig/SetupService") {}

export function makeSetupLayer(
  plugins: readonly SourcePlugin[],
  accounts: readonly ProviderAccount[],
): Layer.Layer<SetupService, never, ConfigService | KeysService | ProgressHub> {
  return Layer.effect(
    SetupService,
    Effect.gen(function* () {
      const configSvc = yield* ConfigService;
      const keysSvc = yield* KeysService;
      const hub = yield* ProgressHub;

      const snapshot = (): Effect.Effect<SetupSnapshot, ConfigError> =>
        Effect.gen(function* () {
          const config = yield* configSvc.load();
          const prereqNames = [...new Set(plugins.flatMap((p) => p.requires ?? []))];
          const prereqMap = new Map<string, boolean>();
          for (const req of prereqNames) {
            const optional = req.includes("(optional");
            const present = optional ? true : yield* Effect.promise(() => hasBinary(req));
            prereqMap.set(req, present);
          }

          const sources: SourceStatus[] = plugins.map((p) => {
            const groups = (p.keys ?? []).map((entry) => (Array.isArray(entry) ? [...entry] : [entry as string]));
            const missingKeys: string[] = [];
            const presentKeys: string[] = [];
            for (const aliases of groups) {
              const found = aliases.find((name) => keysSvc.has(name));
              if (found) presentKeys.push(found);
              else missingKeys.push(aliases[0]);
            }
            const missingPrereqs = (p.requires ?? []).filter((r) => !prereqMap.get(r));
            const readiness: SourceReadiness =
              missingKeys.length === 0 && missingPrereqs.length === 0
                ? "ready"
                : presentKeys.length > 0
                  ? "partial"
                  : groups.length === 0 && missingPrereqs.length > 0
                    ? "needs_setup"
                    : "needs_setup";

            const methods =
              p.kind === "tool"
                ? p.helperSkill
                  ? [p.helperSkill]
                  : []
                : [...(p.skills ?? [p.id]), ...(p.helpers ?? [])];

            return {
              id: p.id,
              kind: p.kind === "tool" ? "tool" : "source",
              group: p.group,
              label: p.label,
              description: p.description,
              enabled: config.sources.enabled.includes(p.id),
              readiness,
              missingKeys,
              presentKeys,
              missingPrereqs,
              credential: p.credential,
              billing: p.billing,
              actions: p.actions.map((a) => a.name),
              methods,
            };
          });

          const accountStatuses: AccountStatus[] = accounts.map((acc) => {
            const keys = acc.keys.map((entry) => {
              const aliases = Array.isArray(entry) ? [...entry] : [entry as string];
              const set = aliases.some((n) => keysSvc.has(n));
              return { name: aliases[0], aliases, set };
            });
            const optional = (acc.optional ?? []).map((name) => ({ name, set: keysSvc.has(name) }));
            const allAccKeyNames = new Set([
              ...keys.flatMap((k) => k.aliases),
              ...optional.map((o) => o.name),
            ]);
            const servingSources = plugins
              .filter((p) => (p.env ?? []).some((e) => allAccKeyNames.has(e)))
              .map((p) => p.id);

            return {
              id: acc.id,
              name: acc.name,
              signup: acc.signup,
              billing: acc.billing,
              keys,
              optional,
              sources: servingSources,
              ready: keys.every((k) => k.set),
            };
          });

          return {
            configPath: config.path,
            keysPath: keysSvc.path,
            library: config.library,
            sources,
            accounts: accountStatuses,
            spend: config.spend,
            keepRaw: config.keep_raw,
            searchSemantic: config.search.semantic,
          };
        });

      const setEnabledSources = (enabledIds: readonly string[]): Effect.Effect<DigConfig, ConfigError> =>
        Effect.gen(function* () {
          const wanted = new Set(enabledIds);
          const patch: Record<string, boolean> = {};
          for (const p of plugins) patch[sourceSetting(p.id)] = wanted.has(p.id);
          const updated = yield* configSvc.update(patch);
          yield* hub.publish({ type: "settings_changed", at: new Date().toISOString() });
          return updated;
        });

      const applyPreset = (presetId: string): Effect.Effect<DigConfig, ConfigError> => {
        if (presetId !== "all" && !Object.hasOwn(SETUP_PRESETS, presetId)) {
          return Effect.fail(
            new ConfigError({
              message: `Unknown setup preset "${presetId}". Choose from: ${Object.keys(SETUP_PRESETS).join(", ")}.`,
            }),
          );
        }
        const ids =
          presetId === "all"
            ? plugins.filter((p) => p.id !== "dataforseo").map((p) => p.id)
            : SETUP_PRESETS[presetId].sources.filter((id) => plugins.some((p) => p.id === id));
        return setEnabledSources(ids);
      };

      const saveKeys: SetupServiceShape["saveKeys"] = (values) =>
        Effect.tap(keysSvc.save(values), () =>
          hub.publish({ type: "settings_changed", at: new Date().toISOString() }),
        );

      const updateSettings: SetupServiceShape["updateSettings"] = (set) =>
        Effect.tap(configSvc.update(set), () =>
          hub.publish({ type: "settings_changed", at: new Date().toISOString() }),
        );

      return SetupService.of({
        snapshot,
        applyPreset,
        setEnabledSources,
        saveKeys,
        updateSettings,
      });
    }),
  );
}
