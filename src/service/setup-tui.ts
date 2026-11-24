// Interactive SSH-safe `dig setup` CLI wizard built on Effect 4.1.5 `effect/cli` `Prompt`.
// Shares `SetupService` with the Web `/setup` wizard: writes `config.toml` + `keys.env` (0600)
// without ever echoing or logging API key values (`Prompt.Password` -> `Redacted`).
import { Console, Effect, Redacted } from "effect";
import * as CliError from "effect/cli/CliError";
import * as Prompt from "effect/cli/Prompt";
import { bootDigRuntime } from "../core/runtime.ts";
import { SETUP_PRESETS, SetupService, type SetupSnapshot } from "../core/setup.ts";
import { ACCOUNTS, SOURCES } from "../sources/index.ts";
import { digCommand } from "./daemon.ts";

export interface SetupWizardOptions {
  readonly preset?: string;
  readonly stateDir?: string;
  readonly isTTY?: boolean;
}

const VALID_PRESETS = Object.keys(SETUP_PRESETS);

/** Apply a named setup preset non-interactively and print a concise summary. */
export const runSetupPreset = (
  preset: string,
  stateDir?: string,
): Effect.Effect<SetupSnapshot, CliError.UserError> =>
  Effect.gen(function* () {
    if (!Object.hasOwn(SETUP_PRESETS, preset)) {
      return yield* Effect.fail(
        new CliError.UserError({
          cause: new Error(`Unknown preset: ${preset}`),
          userMessage: `Unknown preset "${preset}". Choose one of: ${VALID_PRESETS.join(", ")}.`,
        }),
      );
    }
    const snap = yield* Effect.tryPromise({
      try: async () => {
        const rt = await bootDigRuntime({
          stateDir,
          plugins: SOURCES,
          accounts: ACCOUNTS,
        });
        try {
          return await rt.runPromise(
            Effect.gen(function* () {
              const setup = yield* SetupService;
              yield* setup.applyPreset(preset);
              return yield* setup.snapshot();
            }),
          );
        } finally {
          await rt.dispose();
        }
      },
      catch: (e) =>
        new CliError.UserError({
          cause: e,
          userMessage: `Setup failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });

    const enabled = snap.sources.filter((s) => s.enabled);
    const ready = enabled.filter((s) => s.readiness === "ready");
    const missingKeys = [...new Set(enabled.flatMap((s) => s.missingKeys))];
    yield* Console.log(
      `Applied "${preset}" preset: ${enabled.length} sources enabled (${ready.length} ready now).`,
    );
    yield* Console.log(`Config: ${snap.configPath}`);
    if (missingKeys.length) {
      yield* Console.log(
        `Missing API keys for enabled sources: ${missingKeys.join(", ")}`,
      );
      yield* Console.log(
        `Enter them safely via \`${digCommand()} setup\` in an interactive terminal, \`${digCommand()} open --path /setup\`, or ${snap.keysPath}.`,
      );
    }
    return snap;
  });

function parseCapInput(
  raw: string,
  integer: boolean,
): Effect.Effect<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return Effect.succeed("");
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) {
    return Effect.fail("Enter a non-negative number (0 removes the cap, Enter keeps current)");
  }
  if (integer && !Number.isInteger(num)) {
    return Effect.fail("Enter a non-negative whole number (0 removes the cap, Enter keeps current)");
  }
  return Effect.succeed(trimmed);
}

/**
 * Interactive `dig setup` wizard using `effect/cli` `Prompt`:
 * 1. Select starter preset (`Prompt.Select`)
 * 2. Optionally fine-tune enabled sources (`Prompt.MultiSelect`)
 * 3. Enter missing API keys masked via `Prompt.Password` (`Redacted`, never echoed)
 * 4. Optionally configure multi-unit `[spend]` caps (`Prompt.Confirm` + `Prompt.String`)
 *
 * Refuses cleanly with actionable guidance if run without an interactive TTY.
 */
export const runSetupWizard = (
  options: SetupWizardOptions = {},
): Effect.Effect<void, CliError.UserError | import("effect/Terminal").QuitError, Prompt.Environment> =>
  Effect.gen(function* () {
    if (options.preset) {
      yield* runSetupPreset(options.preset, options.stateDir);
      return;
    }

    const isInteractive = options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!isInteractive) {
      return yield* Effect.fail(
        new CliError.UserError({
          cause: new Error("Interactive TTY required for dig setup"),
          userMessage: [
            "Interactive `dig setup` requires a TTY.",
            `For non-interactive setup, pass a preset: ${digCommand()} setup --preset <${VALID_PRESETS.join("|")}>`,
            `Or use the localhost Web setup wizard: ${digCommand()} open --path /setup`,
          ].join("\n"),
        }),
      );
    }

    const rt = yield* Effect.tryPromise({
      try: () =>
        bootDigRuntime({
          stateDir: options.stateDir,
          plugins: SOURCES,
          accounts: ACCOUNTS,
        }),
      catch: (e) =>
        new CliError.UserError({
          cause: e,
          userMessage: `Could not open Dig state: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });

    const runRt = <A, E>(eff: Effect.Effect<A, E, any>) =>
      Effect.tryPromise({
        try: () => rt.runPromise(eff as any) as Promise<A>,
        catch: (e) =>
          new CliError.UserError({
            cause: e,
            userMessage: e instanceof Error ? e.message : String(e),
          }),
      });

    const wizard = Effect.gen(function* () {
      let snap = yield* runRt(Effect.flatMap(SetupService, (s) => s.snapshot()));

      yield* Console.log(`\nDig 2.0 Setup · Config: ${snap.configPath}\n`);

      // Step 1: Choose a source preset
      const presetChoice = yield* Prompt.Select({
        message: "Choose a source preset to start from",
        choices: [
          ...Object.entries(SETUP_PRESETS).map(([id, meta]) => ({
            title: meta.label,
            value: id,
            description: meta.description,
          })),
          {
            title: "Keep current selection and customize",
            value: "custom",
            description: `${snap.sources.filter((s) => s.enabled).length} sources currently enabled.`,
          },
        ],
      });

      // Step 2: Optional per-source multi-select customization
      const customize =
        presetChoice === "custom" ||
        (yield* Prompt.Confirm({
          message: "Customize individual enabled sources?",
          initial: false,
        }));

      if (!customize && presetChoice !== "custom") {
        // Route preset application through SetupService.applyPreset so DataForSEO stays opt-in under "all".
        yield* runRt(Effect.flatMap(SetupService, (s) => s.applyPreset(presetChoice)));
      } else {
        const initialIds: readonly string[] =
          presetChoice === "custom"
            ? snap.sources.filter((s) => s.enabled).map((s) => s.id)
            : presetChoice === "all"
              ? snap.sources.filter((s) => s.id !== "dataforseo").map((s) => s.id)
              : SETUP_PRESETS[presetChoice].sources.filter((id) =>
                  snap.sources.some((s) => s.id === id),
                );
        const chosenSet = new Set(initialIds);
        const chosenIds = yield* Prompt.MultiSelect({
          message: "Select enabled research sources and shared tools",
          maxPerPage: 12,
          choices: snap.sources.map((s) => ({
            title: `${s.label} [${s.readiness === "ready" ? "ready" : s.missingKeys.length ? `needs ${s.missingKeys.join(", ")}` : s.readiness}]`,
            value: s.id,
            description: s.description,
            selected: chosenSet.has(s.id),
          })),
        });
        yield* runRt(Effect.flatMap(SetupService, (s) => s.setEnabledSources(chosenIds)));
      }
      snap = yield* runRt(Effect.flatMap(SetupService, (s) => s.snapshot()));

      // Step 3: Enter missing API keys masked via Prompt.Password (Redacted)
      const enabledSources = snap.sources.filter((s) => s.enabled);
      const missingByKey = new Map<string, string[]>();
      for (const s of enabledSources) {
        for (const keyName of s.missingKeys) {
          const list = missingByKey.get(keyName) ?? [];
          list.push(s.label);
          missingByKey.set(keyName, list);
        }
      }

      if (missingByKey.size > 0) {
        yield* Console.log(
          `\n${missingByKey.size} credential${missingByKey.size === 1 ? "" : "s"} missing for enabled sources: ${[...missingByKey.keys()].join(", ")}`,
        );
        const enterKeys = yield* Prompt.Confirm({
          message: "Enter missing API keys now? (Masked; saved only to keys.env with mode 0600)",
          initial: true,
        });
        if (enterKeys) {
          const valuesToSave: Record<string, string> = {};
          for (const [keyName, labels] of missingByKey) {
            const account = snap.accounts.find((a) =>
              a.keys.some((k) => k.name === keyName || k.aliases.includes(keyName)),
            );
            const hint = account?.signup ? ` · ${account.signup}` : "";
            const secret: Redacted.Redacted<string> = yield* Prompt.Password({
              message: `${keyName} (${labels.join(", ")}${hint}) — Enter to skip`,
            });
            const rawVal = Redacted.value(secret).trim();
            if (rawVal) valuesToSave[keyName] = rawVal;
          }
          if (Object.keys(valuesToSave).length > 0) {
            const { saved } = yield* runRt(
              Effect.flatMap(SetupService, (s) => s.saveKeys(valuesToSave)),
            );
            yield* Console.log(`Saved ${saved.join(", ")} to ${snap.keysPath} (mode 0600).`);
            snap = yield* runRt(Effect.flatMap(SetupService, (s) => s.snapshot()));
          }
        }
      }

      // Step 4: Optional multi-unit [spend] caps
      const configureSpend = yield* Prompt.Confirm({
        message: "Configure multi-unit [spend] guardrails (USD, credits, X reads, unknown calls)?",
        initial: false,
      });

      if (configureSpend) {
        const capSpecs: readonly {
          readonly field: string;
          readonly label: string;
          readonly current: number | null;
          readonly integer: boolean;
        }[] = [
          {
            field: "spend_dig_ceiling_usd",
            label: "Per-dig USD spending ceiling (0 removes)",
            current: snap.spend.dig_ceiling_usd,
            integer: false,
          },
          {
            field: "spend_ask_above_usd",
            label: "Ask before paid calls at/above USD (0 never asks)",
            current: snap.spend.ask_above_usd,
            integer: false,
          },
          {
            field: "spend_max_credits",
            label: "Per-dig provider credits cap (ScrapeCreators/Scrape.do/Firecrawl; 0 removes)",
            current: snap.spend.max_credits,
            integer: false,
          },
          {
            field: "spend_max_x_post_reads",
            label: "Per-dig X post reads cap (integer; 0 removes)",
            current: snap.spend.max_x_post_reads,
            integer: true,
          },
          {
            field: "spend_max_x_account_reads",
            label: "Per-dig X account reads cap (integer; 0 removes)",
            current: snap.spend.max_x_account_reads,
            integer: true,
          },
          {
            field: "spend_max_unknown_calls",
            label: "Per-dig unknown-cost paid calls cap (integer; 0 removes)",
            current: snap.spend.max_unknown_calls,
            integer: true,
          },
        ];

        const patch: Record<string, number> = {};
        for (const spec of capSpecs) {
          const curLabel = spec.current === null ? "unlimited" : String(spec.current);
          const raw = yield* Prompt.String({
            message: `${spec.label} [current: ${curLabel}, Enter to keep]`,
            default: "",
            validate: (v) => parseCapInput(v, spec.integer),
          });
          if (raw.trim() !== "") {
            patch[spec.field] = Number(raw.trim());
          }
        }
        if (Object.keys(patch).length > 0) {
          yield* runRt(Effect.flatMap(SetupService, (s) => s.updateSettings(patch)));
          snap = yield* runRt(Effect.flatMap(SetupService, (s) => s.snapshot()));
        }
      }

      const finalEnabled = snap.sources.filter((s) => s.enabled);
      const finalReady = finalEnabled.filter((s) => s.readiness === "ready");
      yield* Console.log(
        `\nSetup complete: ${finalEnabled.length} sources enabled, ${finalReady.length} ready.`,
      );
      yield* Console.log(`Config: ${snap.configPath}`);
      yield* Console.log(`Keys:   ${snap.keysPath}`);
      yield* Console.log(`Web UI: ${digCommand()} open --path /setup\n`);
    });

    return yield* wizard.pipe(
      Effect.ensuring(Effect.promise(() => rt.dispose().catch(() => {}))),
    );
  });
