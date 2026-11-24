import { Effect, Result, Schema } from "effect";
import { receiptCost, type ReceiptCost } from "./cost.ts";
import type { FreeHttp, KeepRaw, PaidHttp, RetainedResponse } from "./http.ts";
import { knownSecrets, redactValue } from "./secrets.ts";

/**
 * Co-located Effect 4.1.5 Source Plugin contract.
 * Every source owns its metadata, credentials, Effect-Schema actions, billing rules,
 * and optional evidence renderer in one directory (`src/sources/<id>/`).
 */

export type OutcomeStatus =
  | "success"
  | "empty"
  | "partial"
  | "failed"
  | "cancelled"
  | "skipped";

export interface ImageBlock {
  readonly data: string;
  readonly mimeType: string;
}

export interface ActionOutcome {
  readonly status: OutcomeStatus;
  readonly text: string;
  readonly details?: Record<string, unknown>;
  /** Only honored when the action declares `returnsImages: true`. Never reaches receipts or raw files. */
  readonly images?: readonly ImageBlock[];
}

export interface ToolProgress {
  readonly progress: number;
  readonly total?: number;
  readonly message: string;
}

export interface ActionContext {
  readonly digId: string;
  readonly project: string;
  readonly keep: KeepRaw;
  readonly progress: (update: ToolProgress) => void;
  readonly signal: AbortSignal;
  /** Optional runtime-injected paths & settings so sources never read process.env directly when hosted. */
  readonly stateDir?: string;
  readonly library?: string;
  readonly xConfig?: {
    readonly model: string;
    readonly depth: "quick" | "standard" | "max" | "ultra";
    readonly webSearch: boolean;
    readonly codeExecution: boolean;
  };
  /** Persist a provider's remote job/response ID (e.g. xAI response ID) for crash-safe read-only reconcile(). */
  readonly reportRemoteJobId?: (remoteJobId: string) => void;
}

export type BillingPolicy<A = unknown> =
  | "free"
  | {
      readonly charge: (response: RetainedResponse, args: A) => ReceiptCost;
      readonly noCharge?: (args: A) => boolean;
    };

export type ActionRequirements = PaidHttp | FreeHttp;

export interface ActionDefinition<S extends Schema.Top = Schema.Top> {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  /** Provider evidence only. Omitted billing means paid with unknown cost, never implicitly free. */
  readonly billing?: BillingPolicy<Schema.Schema.Type<S>>;
  /** Slow actions (>30s latency/poll/process) execute through durable jobs & MCP Tasks. */
  readonly slow?: boolean;
  /** Allows returning image blocks directly to the model (bypassing receipts/redaction). */
  readonly returnsImages?: boolean;
  /**
   * Optional read-only reconciliation hook for a paid call interrupted mid-flight by daemon crash
   * (e.g. Grok `recoverResponseId`). Must NEVER trigger a new paid request.
   */
  readonly reconcile?: (
    remoteJobId: string,
    args: Schema.Schema.Type<S>,
    ctx: ActionContext,
  ) => Effect.Effect<ActionOutcome | null, never, ActionRequirements>;
  readonly execute: (
    args: Schema.Schema.Type<S>,
    ctx: ActionContext,
  ) => Effect.Effect<ActionOutcome, never, ActionRequirements>;
}

export type AnyActionDefinition = ActionDefinition<any>;

export type SourceGroupId =
  | "web"
  | "code"
  | "papers"
  | "video"
  | "social"
  | "markets"
  | "tools";

export interface EnvSettingMeta {
  readonly name: string;
  readonly label: string;
  readonly purpose: string;
}

export interface ProviderLink {
  readonly name: string;
  readonly url?: string;
}

export interface SourcePlugin {
  readonly id: string;
  readonly kind?: "tool";
  readonly group: SourceGroupId;
  readonly label: string;
  readonly description: string;
  readonly about: string;
  readonly providers: readonly ProviderLink[];
  readonly billing: string;
  readonly logo?: string;
  readonly skills?: readonly string[];
  readonly helpers?: readonly string[];
  readonly helperSkill?: string;
  readonly env?: readonly string[];
  readonly keys?: readonly (string | readonly string[])[];
  readonly credential?: string;
  readonly requires?: readonly string[];
  readonly envSettings?: readonly EnvSettingMeta[];
  readonly actions: readonly AnyActionDefinition[];
}

export interface ProviderAccount {
  readonly id: string;
  readonly name: string;
  readonly signup: string;
  readonly keys: readonly (string | readonly string[])[];
  readonly optional?: readonly string[];
  readonly billing: string;
}

export function outcome(
  status: OutcomeStatus,
  text: string,
  details?: Record<string, unknown>,
  images?: readonly ImageBlock[],
): ActionOutcome {
  return {
    status,
    text,
    ...(details ? { details } : {}),
    ...(images ? { images } : {}),
  };
}

export function failed(text: string, details?: Record<string, unknown>): ActionOutcome {
  return outcome("failed", text.startsWith("ERROR:") ? text : `ERROR: ${text}`, details);
}

export const setOutsideChat = (several = false): string =>
  `The user sets ${several ? "them" : "it"} outside chat, on the page Dig's keys tool opens, via \`dig setup\`, or in keys.env.`;

export function meteredBilling<A>(
  unit: string,
  charge: (
    body: unknown,
    status: number | string,
    headers: RetainedResponse["headers"],
    args: A,
  ) => number | null,
  noCharge?: (args: A) => boolean,
): BillingPolicy<A> {
  return {
    charge(response, args) {
      const amount = charge(response.body, response.status, response.headers, args);
      return amount === null ? { cost: null } : { cost: [{ amount, unit }] };
    },
    ...(noCharge ? { noCharge } : {}),
  };
}

export function defineAction<S extends Schema.Top>(def: ActionDefinition<S>): ActionDefinition<S> {
  return def;
}

export function defineSource(plugin: SourcePlugin): SourcePlugin {
  return plugin;
}

/** Whether a call to `action` with `args` is unpaid (free action or explicit noCharge call). */
export function isUnpaidCall(action: AnyActionDefinition, args: unknown): boolean {
  if (action.billing === "free") return true;
  if (!action.billing) return false;
  try {
    return action.billing.noCharge?.(args) === true;
  } catch {
    return false;
  }
}

/**
 * Convert an Effect Schema to a compact JSON Schema object suitable for MCP `tools/list`.
 * Strips nested property `description` strings when `compact: true` to stay well inside
 * MCP host context budgets while keeping full types, enums, bounds, and required keys.
 */
export function schemaToMcpJson(
  schema: Schema.Top,
  options?: { readonly compact?: boolean; readonly title?: string },
): Record<string, unknown> {
  const doc = Schema.toJsonSchemaDocument(schema);
  const root = structuredClone(doc.schema) as Record<string, unknown>;
  if (!root.type && !root.anyOf && !root.oneOf && !root.$ref) {
    root.type = "object";
    root.properties ??= {};
  }
  if (doc.definitions && Object.keys(doc.definitions).length > 0) {
    root.$defs = structuredClone(doc.definitions);
  }
  if (options?.title) root.title = options.title;
  return options?.compact ? compactJsonSchema(root, true) : root;
}

function compactJsonSchema(value: unknown, isRoot: boolean): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "description" && !isRoot && typeof v === "string") continue;
    if (k === "$schema") continue;
    if (k === "additionalProperties" && v === false) continue;
    if (k === "default" || k === "const" || k === "enum" || k === "examples") {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? compactJsonSchema(item, false)
          : item,
      );
    } else if (v && typeof v === "object") {
      out[k] = compactJsonSchema(v, false);
    } else {
      out[k] = v;
    }
  }
  const branches = out.anyOf;
  if (
    Array.isArray(branches) &&
    branches.length > 0 &&
    branches.every(
      (b): b is Record<string, unknown> =>
        Boolean(b) &&
        typeof b === "object" &&
        "const" in (b as Record<string, unknown>) &&
        Object.keys(b as Record<string, unknown>).every((key) => key === "const" || key === "type") &&
        (b as Record<string, unknown>).type === (branches[0] as Record<string, unknown>).type,
    )
  ) {
    const { anyOf: _drop, ...rest } = out;
    return {
      ...rest,
      ...(branches[0].type !== undefined ? { type: branches[0].type } : {}),
      enum: branches.map((b) => b.const),
    };
  }
  return out;
}

/** Decode and validate raw action arguments using the action's Effect Schema. */
export function decodeActionArgs<S extends Schema.Top>(
  action: ActionDefinition<S>,
  rawArgs: unknown,
): { readonly ok: true; readonly args: Schema.Schema.Type<S> } | { readonly ok: false; readonly error: string } {
  const result = Schema.decodeUnknownResult(action.schema as unknown as Schema.Codec<Schema.Schema.Type<S>, unknown, never, never>)(rawArgs ?? {});
  if (Result.isSuccess(result)) {
    return { ok: true, args: result.success };
  }
  const fullSchema = JSON.stringify(schemaToMcpJson(action.schema, { compact: false }));
  return {
    ok: false,
    error: `Invalid arguments for ${action.name}: ${String(result.failure)}\nExpected schema: ${fullSchema}`,
  };
}

/**
 * Execute one validated action inside Effect, enforcing:
 * - honest per-response cost accumulation (partial/interrupted/unobserved → unknown cost `null`)
 * - automatic redaction of output text & details (never touching `images`)
 * - image stripping for tools without `returnsImages: true`
 */
export function executeAction<S extends Schema.Top>(
  action: ActionDefinition<S>,
  args: Schema.Schema.Type<S>,
  ctx: ActionContext,
): Effect.Effect<ActionOutcome, never, ActionRequirements> {
  return Effect.gen(function* () {
    if (ctx.signal.aborted) {
      return outcome("cancelled", "Research call cancelled", { cost: [] });
    }
    const totals = new Map<string, number>();
    let observations = 0;
    let incomplete = false;
    let billing = action.billing;
    if (billing && billing !== "free") {
      try {
        if (billing.noCharge?.(args)) billing = "free";
      } catch {
        // Invalid args handled elsewhere; never assume free.
      }
    }

    const capturedCtx: ActionContext = {
      ...ctx,
      keep(label, status, body, headers, interrupted) {
        if (billing && billing !== "free") {
          observations += 1;
          try {
            const pricing = receiptCost(
              billing.charge({ label, status, body, ...(headers ? { headers } : {}) }, args),
            );
            if (pricing.cost === null || interrupted) incomplete = true;
            for (const { amount, unit } of pricing.cost ?? pricing.knownCost ?? []) {
              const sum = (totals.get(unit) ?? 0) + amount;
              if (Number.isFinite(sum)) totals.set(unit, sum);
              else incomplete = true;
            }
          } catch {
            incomplete = true;
          }
        }
        if (headers) ctx.keep(label, status, body, headers, interrupted);
        else ctx.keep(label, status, body, undefined, interrupted);
      },
    };

    let threw = false;
    let rawResult: ActionOutcome;
    const exit = yield* Effect.exit(action.execute(args, capturedCtx));
    if (exit._tag === "Success") {
      rawResult = exit.value;
    } else {
      threw = true;
      rawResult = failed("Research tool failed unexpectedly");
    }

    if (ctx.signal.aborted) {
      rawResult = outcome("cancelled", "Research call cancelled");
    }

    const amounts = [...totals].map(([unit, amount]) => ({ amount, unit }));
    const partial = threw || ctx.signal.aborted || incomplete || observations === 0;
    const pricing: ReceiptCost =
      billing === "free"
        ? { cost: [] }
        : partial
          ? { cost: null, ...(amounts.length ? { knownCost: amounts } : {}) }
          : { cost: amounts };

    const { images, ...withoutImages } = rawResult;
    const secrets = knownSecrets();
    const clean = redactValue(withoutImages, secrets) as Omit<ActionOutcome, "images">;
    const { cost: _c, knownCost: _k, ...restDetails } = clean.details ?? {};
    const keepImages =
      action.returnsImages && !["failed", "cancelled"].includes(clean.status) ? images : undefined;

    return {
      ...clean,
      details: { ...restDetails, ...pricing },
      ...(keepImages?.length ? { images: keepImages } : {}),
    };
  });
}
