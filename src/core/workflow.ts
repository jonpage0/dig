import { createHash } from "node:crypto";
import { Context, Effect, Exit, Layer, Result, Schedule, Schema } from "effect";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as Activity from "effect/workflow/Activity";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { ConfigService, type DigConfig } from "./config.ts";
import { costAmounts, costShort, costTotal, formatUsd, plural } from "./cost.ts";
import { RefusalError } from "./errors.ts";
import { FreeHttp, PaidHttp, type KeepRaw, type RetainedResponse } from "./http.ts";
import { LibraryService, libraryUri, safeSegment, SESSION_UNAVAILABLE, type ResolvedDig } from "./library.ts";
import {
  decodeActionArgs,
  executeAction,
  isUnpaidCall,
  schemaToMcpJson,
  type ActionContext,
  type ActionOutcome,
  type AnyActionDefinition,
  type SourcePlugin,
  type ToolProgress,
} from "./plugin.ts";
import { ProgressHub, type LiveProgress } from "./progress.ts";
import { knownSecrets, redactRecord, redactText } from "./secrets.ts";

/**
 * Dig 2.0 durable provider-call engine built on Effect 4.1.5 `Workflow`, `Activity`,
 * `DurableDeferred`, `WorkflowEngine.layerMemory` (process-local),
 * and SQLite `paid_call_ledger` (`BEGIN IMMEDIATE` atomic claim).
 *
 * CRITICAL INVARIANT — ZERO DUPLICATE PAID REQUESTS:
 * 1. `Activity.make` explicitly sets `interruptRetryPolicy: Schedule.recurs(0)` (disabling Effect's
 *    default 10x interrupt-retry loop).
 * 2. Before the first byte leaves this machine, an atomic `BEGIN IMMEDIATE` SQLite transaction
 *    claims `paid_call_ledger(call_id, status='dispatched')`.
 * 3. If the daemon crashes mid-request and restarts, any `status='dispatched'` row is NEVER
 *    re-sent: if the action defines a safe read-only `reconcile` hook, that runs; otherwise it
 *    marks the call `failed` with `STOPPED` and records an unknown-cost receipt (`cost: null`).
 */

export const KEEP_MS = 24 * 60 * 60_000;
export const REUSE_MS = 10 * 60_000;
export const POLL_MS = 3_000;
export const DETAILS_LIMIT = 20_000;

export const STOPPED =
  "The service stopped while this job was running: its request may have been sent and charged, and its cost is unknown.";

export const inlineWaitMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env.DIG_INLINE_WAIT_MS;
  const ms = Number(raw);
  return raw && Number.isFinite(ms) && ms >= 0 ? ms : 40_000;
};

export const askTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const ms = Number(env.DIG_ASK_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 5 * 60_000;
};

export const keyCodeMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const ms = Number(env.DIG_KEYS_TTL_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 10 * 60_000;
};

export const OPEN_CODE_MS = 5 * 60_000;

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .sort()
            .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
        )
      : value;

export const argsHash = (args: Record<string, unknown>): string =>
  createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex");

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export interface CallResultContent {
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "resource_link";
        readonly uri: string;
        readonly name: string;
        readonly title: string;
        readonly description?: string;
        readonly mimeType: string;
      }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  >;
  readonly isError?: boolean;
}

export type JobStatus = "pending_approval" | "working" | "completed" | "failed" | "cancelled";

export interface LedgerJob {
  readonly id: string;
  readonly workflowExecutionId: string | null;
  readonly dig: string;
  readonly project: string;
  readonly source: string;
  readonly tool: string;
  readonly argsHash: string;
  readonly status: JobStatus;
  readonly isPaid: boolean;
  readonly isSlow: boolean;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly finishedAt?: string;
  readonly receiptId?: string | null;
  readonly result?: CallResultContent;
  readonly error?: string;
}

// ---- Effect Workflow & DurableDeferred Definitions -------------------------------------------------

const ProviderCallPayload = Schema.Struct({
  callId: Schema.String,
  digHandle: Schema.String,
  sourceId: Schema.String,
  actionName: Schema.String,
  argsJson: Schema.String,
  isPaid: Schema.Boolean,
  isSlow: Schema.Boolean,
});

const ProviderCallResult = Schema.Struct({
  callId: Schema.String,
  status: Schema.String,
  receiptId: Schema.NullOr(Schema.String),
  resultJson: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

export const ProviderCallWorkflow = Workflow.make("DigProviderCall", {
  payload: ProviderCallPayload,
  success: ProviderCallResult,
  error: Schema.String,
  idempotencyKey: ({ callId }) => callId,
});

export const SpendApprovalDeferred = DurableDeferred.make("DigSpendApproval", {
  success: Schema.Struct({
    choice: Schema.String,
    targetRaised: Schema.optional(Schema.Number),
  }),
  error: Schema.String,
});

export const KeyEntryDeferred = DurableDeferred.make("DigKeyEntry", {
  success: Schema.Struct({
    saved: Schema.Array(Schema.String),
  }),
  error: Schema.String,
});

// ---- Multi-Unit Spend Override & Gate Types --------------------------------------------------------

export interface DigSpendOverrides {
  readonly digHandle: string;
  readonly raisedUsd: number;
  readonly raisedCredits: number;
  readonly raisedXPostReads: number;
  readonly raisedXAccountReads: number;
  readonly raisedUnknownCalls: number;
  readonly dontAsk: boolean;
  readonly updatedAt: string | null;
}

export interface SpendPromptQuestion {
  readonly key: "ceiling" | "spend";
  readonly unit: string;
  readonly title: string;
  readonly message: string;
  readonly bind: string;
  readonly choices: readonly { readonly value: string; readonly title: string }[];
  readonly targetRaised?: number;
}

export type SpendCheckResult =
  | { readonly allow: true }
  | { readonly allow: false; readonly question: SpendPromptQuestion; readonly refusalText: string };

// ---- Formatting Helpers ----------------------------------------------------------------------------

function detailsText(details: Record<string, unknown>): string {
  const { cost: _c, knownCost: _k, ...rest } = details;
  if (!Object.keys(rest).length) return "";
  let json: string;
  try {
    json = JSON.stringify(rest, null, 1);
  } catch {
    return "";
  }
  return `\n\nDetails:\n${
    json.length > DETAILS_LIMIT
      ? `${json.slice(0, DETAILS_LIMIT)}\n… cut at ${DETAILS_LIMIT.toLocaleString("en-US")} of ${json.length.toLocaleString("en-US")} characters; the retained original holds the response.`
      : json
  }`;
}

export function formatToolResult(input: {
  readonly sourceLabel: string;
  readonly actionName: string;
  readonly dig: ResolvedDig;
  readonly outcome: ActionOutcome;
  readonly receipt: { readonly id: string; readonly raw?: string } | null;
  readonly retentionError: string | null;
  readonly digCost: {
    readonly calls: number;
    readonly byUnit: Record<string, number>;
    readonly unknownCalls: number;
    readonly freeCalls: number;
  } | null;
}): CallResultContent {
  const details = input.outcome.details ?? {};
  const callCost = costShort(
    {
      byUnit: (() => {
        const out: Record<string, number> = {};
        const arr = (details.cost ?? details.knownCost ?? []) as readonly { amount: number; unit: string }[];
        for (const item of arr) out[item.unit] = (out[item.unit] ?? 0) + item.amount;
        return out;
      })(),
      unknownCalls: details.cost === null ? 1 : 0,
      freeCalls: Array.isArray(details.cost) && details.cost.length === 0 ? 1 : 0,
    },
    1,
  );
  const sofar = input.digCost ? costTotal(input.digCost, input.digCost.calls) : null;
  const head = [
    input.sourceLabel,
    input.actionName,
    input.outcome.status,
    input.receipt ? `receipt ${input.receipt.id}` : input.retentionError ?? "no receipt saved",
    `cost: ${callCost}`,
    ...(sofar ? [`dig so far: ${sofar}`] : []),
  ].join(" · ");

  const sessions = `${input.dig.folder}/sessions/${safeSegment(input.dig.dig, SESSION_UNAVAILABLE)}`;
  const links = input.receipt
    ? [
        {
          type: "resource_link" as const,
          uri: libraryUri(`${sessions}/calls.jsonl`),
          name: "calls.jsonl",
          title: `Receipts of dig ${input.dig.dig}`,
          description: `This call's receipt is ${input.receipt.id}.`,
          mimeType: "application/jsonl",
        },
        ...(input.receipt.raw
          ? [
              {
                type: "resource_link" as const,
                uri: libraryUri(`${sessions}/${input.receipt.raw}`),
                name: input.receipt.raw.split("/").at(-1) ?? input.receipt.raw,
                title: `Original response of ${input.receipt.id}`,
                mimeType: "application/json",
              },
            ]
          : []),
      ]
    : [];

  const failedStatus = ["failed", "cancelled"].includes(input.outcome.status);
  const images = (input.outcome.images ?? []).map(({ data, mimeType }) => ({
    type: "image" as const,
    data,
    mimeType,
  }));

  return {
    content: [
      { type: "text", text: `${head}.\n\n${input.outcome.text}${detailsText(details)}` },
      ...links,
      ...images,
    ],
    ...(failedStatus ? { isError: true } : {}),
  };
}

// ---- Workflow Engine & Call Runner Service ---------------------------------------------------------

export interface DeferredTokenRecord {
  readonly code: string;
  readonly kind: "keys" | "spend_approval" | "browser_open";
  readonly deferredToken: string | null;
  readonly payload: Record<string, unknown>;
  readonly used: boolean;
  readonly result: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PendingApproval {
  readonly code: string;
  readonly dig: string;
  readonly tool: string;
  readonly source: string;
  readonly title: string;
  readonly message: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ExecutionServiceShape {
  /** Recover any orphaned `dispatched` paid calls after a daemon restart without re-sending HTTP. */
  readonly recoverCrashedCalls: () => Effect.Effect<number>;
  /** Sweep finished jobs older than `KEEP_MS` and expired tokens. */
  readonly sweep: (nowMs?: number) => Effect.Effect<void>;
  /** Check multi-unit `[spend]` caps and `ask_above_usd` for a dig & action without sending anything. */
  readonly checkSpendGate: (input: {
    readonly config: DigConfig;
    readonly dig: ResolvedDig;
    readonly sourceLabel: string;
    readonly actionName: string;
    readonly args: Record<string, unknown>;
  }) => Effect.Effect<SpendCheckResult>;
  /** Persist a user's spend override ("raise ceiling" or "don't ask again for this dig") in SQLite. */
  readonly applySpendOverride: (
    digHandle: string,
    update: Partial<Omit<DigSpendOverrides, "digHandle" | "updatedAt">>,
  ) => Effect.Effect<DigSpendOverrides>;
  readonly getSpendOverrides: (digHandle: string) => Effect.Effect<DigSpendOverrides>;
  /** Find a reusable job (running or finished within `REUSE_MS` unless `fresh`). */
  readonly findReusableJob: (
    digHandle: string,
    actionName: string,
    hash: string,
    fresh: boolean,
  ) => Effect.Effect<LedgerJob | null>;
  /** Get any job by id. */
  readonly getJob: (callId: string) => Effect.Effect<LedgerJob | null>;
  /** List currently running jobs. */
  readonly runningJobs: () => Effect.Effect<readonly LedgerJob[]>;
  /** Start or attach to a durable provider call via `ProviderCallWorkflow`. */
  readonly dispatchCall: (input: {
    readonly plugin: SourcePlugin;
    readonly action: AnyActionDefinition;
    readonly dig: ResolvedDig;
    readonly args: Record<string, unknown>;
    readonly fresh?: boolean;
    readonly waitMs?: number;
    readonly onProgress?: (p: LiveProgress) => void;
    readonly signal?: AbortSignal;
  }) => Effect.Effect<{
    readonly job: LedgerJob;
    readonly reused: boolean;
    readonly stillWorking: boolean;
  }, RefusalError>;
  /** Cancel a running job (aborts live HTTP call; paid calls record unknown cost). */
  readonly cancelJob: (callId: string) => Effect.Effect<boolean>;
  /** List unexpired, unredeemed browser spend approvals for display in the localhost Web SPA. */
  readonly listPendingApprovals: () => Effect.Effect<readonly PendingApproval[]>;
  /** Issue a cryptographically random opaque 24-byte token in SQLite (`deferred_tokens`). */
  readonly createOpaqueCode: (input: {
    readonly kind: "keys" | "spend_approval" | "browser_open";
    readonly payload: Record<string, unknown>;
    readonly ttlMs: number;
    readonly deferredToken?: string;
  }) => Effect.Effect<{ readonly code: string; readonly expiresAt: string }>;
  readonly readOpaqueCode: (code: string) => Effect.Effect<DeferredTokenRecord | null>;
  readonly redeemOpaqueCode: (
    code: string,
    result?: Record<string, unknown>,
  ) => Effect.Effect<DeferredTokenRecord | null>;
  readonly hasPendingTokens: () => Effect.Effect<boolean>;
  /** Create & verify HMAC-SHA256 sealed state strings via `effect/crypto/Mac`. */
  readonly sealState: (payload: Record<string, unknown>, ttlSeconds?: number) => Effect.Effect<string>;
  readonly verifyState: (sealed: string) => Effect.Effect<Record<string, unknown> | null>;
}

export class ExecutionService extends Context.Service<ExecutionService, ExecutionServiceShape>()(
  "dig/ExecutionService",
) {}

const CREDIT_UNITS = new Set(["ScrapeCreators credits", "Scrape.do credits", "Firecrawl credits", "credits"]);

export function makeWorkflowEngineLayer(): Layer.Layer<
  WorkflowEngine.WorkflowEngine | Digest.Digest | Mac.Mac | SecureRandom.SecureRandom,
  unknown,
  SqlClient.SqlClient
> {
  const randomLayer = SecureRandom.layerWebCrypto;
  const digestLayer = Digest.layerWebCrypto;
  const macLayer = Mac.layerWebCrypto.pipe(Layer.provide(randomLayer));
  const cryptoLayer = Layer.mergeAll(randomLayer, digestLayer, macLayer);

  // Process-local in-memory workflow engine: durable crash safety, atomic deduplication, and
  // read-only reconciliation live exclusively in our own `paid_call_ledger` table so secondary
  // CLI processes (`dig list|read|search|stats|setup`) never replay a live daemon's workflows
  // or persist unredacted args into `cluster_messages`.
  return Layer.mergeAll(cryptoLayer, WorkflowEngine.layerMemory);
}

export function makeExecutionLayer(
  plugins: readonly SourcePlugin[],
): Layer.Layer<
  ExecutionService,
  never,
  | ConfigService
  | LibraryService
  | SqlClient.SqlClient
  | ProgressHub
  | PaidHttp
  | FreeHttp
  | WorkflowEngine.WorkflowEngine
  | Mac.Mac
  | SecureRandom.SecureRandom
> {
  const pluginById = new Map(plugins.map((p) => [p.id, p]));
  const actionByPair = new Map<string, { plugin: SourcePlugin; action: AnyActionDefinition }>();
  for (const p of plugins) {
    for (const a of p.actions) {
      actionByPair.set(`${p.id}:${a.name}`, { plugin: p, action: a });
    }
  }

  return Layer.effect(
    ExecutionService,
    Effect.gen(function* () {
      const configSvc = yield* ConfigService;
      const librarySvc = yield* LibraryService;
      const sql = yield* SqlClient.SqlClient;
      const hub = yield* ProgressHub;
      const paidHttp = yield* PaidHttp;
      const freeHttp = yield* FreeHttp;
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const mac = yield* Mac.Mac;
      const rng = yield* SecureRandom.SecureRandom;

      const hmacKey = yield* mac.generateKey(Mac.hmacSha256).pipe(Effect.orDie);
      const controllers = new Map<string, AbortController>();
      const pendingPromises = new Map<string, Promise<void>>();

      const rowToJob = (row: Record<string, unknown>): LedgerJob => ({
        id: String(row.call_id),
        workflowExecutionId: row.workflow_execution_id ? String(row.workflow_execution_id) : null,
        dig: String(row.dig_handle),
        project: String(row.project),
        source: String(row.source),
        tool: String(row.tool),
        argsHash: String(row.args_hash),
        status:
          row.status === "dispatched" || row.status === "pending_approval"
            ? "working"
            : (String(row.status) as JobStatus),
        isPaid: Boolean(row.is_paid),
        isSlow: Boolean(row.is_slow),
        createdAt: String(row.created_at),
        lastUpdatedAt: String(row.last_updated_at),
        ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}),
        receiptId: row.receipt_id !== undefined ? (row.receipt_id ? String(row.receipt_id) : null) : undefined,
        ...(row.outcome_json ? { result: JSON.parse(String(row.outcome_json)) as CallResultContent } : {}),
        ...(row.error ? { error: String(row.error) } : {}),
      });

      const markOrphanedRowFailed = (row: Record<string, unknown>, reason: string) =>
        Effect.gen(function* () {
          const callId = String(row.call_id);
          const nowIso = new Date().toISOString();
          // Atomically claim the transition from 'dispatched' -> 'failed' first so boot recovery
          // and workflow replay can NEVER write duplicate receipts for the same crashed call.
          const claimed = yield* sql<{ call_id: string; receipt_id: string | null }>`
            UPDATE paid_call_ledger
            SET status = 'failed',
                error = ${reason},
                last_updated_at = ${nowIso},
                finished_at = ${nowIso}
            WHERE call_id = ${callId} AND status = 'dispatched'
            RETURNING call_id, receipt_id
          `.pipe(Effect.orElseSucceed(() => [] as { call_id: string; receipt_id: string | null }[]));
          if (claimed.length === 0) return;

          let receiptId = claimed[0].receipt_id ? String(claimed[0].receipt_id) : null;
          if (!receiptId) {
            const digResolved = yield* Effect.result(librarySvc.resolveHandle(String(row.dig_handle)));
            if (Result.isSuccess(digResolved)) {
              const args = (() => {
                try {
                  return JSON.parse(String(row.args_redacted_json)) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })();
              const declared = (() => {
                try {
                  return JSON.parse(String(row.declared_json)) as string[];
                } catch {
                  return [];
                }
              })();
              const createdMs = Date.parse(String(row.created_at));
              const isPaidRow = Boolean(row.is_paid);
              const recRes = yield* Effect.result(
                librarySvc.recordCall({
                  dig: digResolved.success,
                  tool: String(row.tool),
                  source: String(row.source),
                  args,
                  declared,
                  at: String(row.created_at),
                  ms: Number.isFinite(createdMs) ? Math.max(0, Date.now() - createdMs) : 0,
                  status: "failed",
                  cost: isPaidRow ? null : [],
                  responses: [],
                  error: reason,
                }),
              );
              if (Result.isSuccess(recRes)) {
                receiptId = recRes.success.id;
                yield* sql`
                  UPDATE paid_call_ledger
                  SET receipt_id = ${receiptId}
                  WHERE call_id = ${callId} AND receipt_id IS NULL
                `.pipe(Effect.ignore);
              }
            }
          }
        });

      const settleEarlyFailure = (callId: string, reason: string) =>
        Effect.gen(function* () {
          const nowIso = new Date().toISOString();
          yield* sql`
            UPDATE paid_call_ledger
            SET status = 'failed',
                error = ${reason},
                last_updated_at = ${nowIso},
                finished_at = ${nowIso}
            WHERE call_id = ${callId} AND status IN ('pending_approval', 'dispatched')
          `.pipe(Effect.ignore);
          yield* hub.finish(callId, "failed");
        });

      const makeRuntimeActionContext = (
        cfg: DigConfig,
        dig: ResolvedDig,
        callId: string,
        keep: KeepRaw,
        progress: (update: ToolProgress) => void,
        signal: AbortSignal,
      ): ActionContext => ({
        digId: dig.dig,
        project: dig.project,
        keep,
        progress,
        signal,
        stateDir: cfg.stateDir,
        library: cfg.library,
        xConfig: {
          model: cfg.x.model,
          depth: cfg.x.depth,
          webSearch: cfg.x.web_search,
          codeExecution: cfg.x.code_execution,
        },
        reportRemoteJobId: (remoteJobId: string) => {
          const trimmed = remoteJobId.trim();
          if (!trimmed) return;
          Effect.runFork(
            sql`
              UPDATE paid_call_ledger
              SET remote_job_id = ${trimmed}, last_updated_at = ${new Date().toISOString()}
              WHERE call_id = ${callId} AND status = 'dispatched'
            `.pipe(Effect.ignore),
          );
        },
      });

      /**
       * Register `ProviderCallWorkflow` handler with the in-memory `WorkflowEngine`.
       * Single `Activity` with `interruptRetryPolicy: Schedule.recurs(0)` and atomic
       * `BEGIN IMMEDIATE` claim in `paid_call_ledger`.
       */
      yield* engine.register(ProviderCallWorkflow, (payload) =>
        Activity.make({
          name: "ExecuteProviderOnce",
          success: ProviderCallResult,
          error: Schema.String,
          interruptRetryPolicy: Schedule.recurs(0),
          execute: Effect.gen(function* () {
            const pair = actionByPair.get(`${payload.sourceId}:${payload.actionName}`);
            if (!pair) {
              const msg = `Unknown action ${payload.sourceId}:${payload.actionName}`;
              yield* settleEarlyFailure(payload.callId, msg);
              return yield* Effect.fail(msg);
            }
            const { plugin, action } = pair;
            const args = JSON.parse(payload.argsJson) as Record<string, unknown>;
            const digRes = yield* Effect.result(librarySvc.resolveHandle(payload.digHandle));
            if (Result.isFailure(digRes)) {
              yield* settleEarlyFailure(payload.callId, digRes.failure.message);
              return yield* Effect.fail(digRes.failure.message);
            }
            const dig = digRes.success;
            const cfgRes = yield* Effect.result(configSvc.load());
            if (Result.isFailure(cfgRes)) {
              yield* settleEarlyFailure(payload.callId, cfgRes.failure.message);
              return yield* Effect.fail(cfgRes.failure.message);
            }
            const cfg = cfgRes.success;

            // ---- ATOMIC CHECK-AND-CLAIM INSIDE BEGIN IMMEDIATE TRANSACTION ----
            const claimRes = yield* Effect.result(
              sql.withTransaction(
                Effect.gen(function* () {
                  const rows = yield* sql<Record<string, unknown>>`
                    SELECT * FROM paid_call_ledger WHERE call_id = ${payload.callId}
                  `;
                  const existing = rows[0];
                  if (!existing) {
                    // NEVER dispatch if the pre-inserted ledger row is gone (swept or deleted).
                    return { action: "missing_row" as const };
                  }

                  const st = String(existing.status);
                  if (st === "completed" || st === "failed" || st === "cancelled") {
                    return {
                      action: "already_settled" as const,
                      result: {
                        callId: payload.callId,
                        status: st,
                        receiptId: existing.receipt_id ? String(existing.receipt_id) : null,
                        resultJson: existing.outcome_json ? String(existing.outcome_json) : null,
                        error: existing.error ? String(existing.error) : null,
                      },
                    };
                  }

                  if (st === "pending_approval") {
                    const now = new Date().toISOString();
                    yield* sql`
                      UPDATE paid_call_ledger
                      SET status = 'dispatched', dispatched_at = ${now}, last_updated_at = ${now}
                      WHERE call_id = ${payload.callId}
                    `;
                    return { action: "dispatch" as const };
                  }

                  // Already `dispatched`! A crash occurred mid-request. NEVER re-send HTTP!
                  return {
                    action: "crash_replay" as const,
                    row: existing,
                  };
                }),
              ),
            );
            if (Result.isFailure(claimRes)) {
              const msg = `Ledger transaction failed: ${String(claimRes.failure)}`;
              yield* settleEarlyFailure(payload.callId, msg);
              return yield* Effect.fail(msg);
            }
            const claim = claimRes.success;

            if (claim.action === "missing_row") {
              return {
                callId: payload.callId,
                status: "failed",
                receiptId: null,
                resultJson: null,
                error: "Ledger row no longer exists; refusing replay.",
              };
            }

            if (claim.action === "already_settled") {
              return claim.result;
            }

            if (claim.action === "crash_replay") {
              const remoteId = claim.row.remote_job_id ? String(claim.row.remote_job_id) : null;
              if (remoteId && action.reconcile) {
                const controller = new AbortController();
                const responses: RetainedResponse[] = [];
                const reconciled = yield* action
                  .reconcile(
                    remoteId,
                    args,
                    makeRuntimeActionContext(
                      cfg,
                      dig,
                      payload.callId,
                      (label, status, body, headers) => {
                        responses.push({ label, status, body, ...(headers ? { headers } : {}) });
                      },
                      () => {},
                      controller.signal,
                    ),
                  )
                  .pipe(
                    Effect.provideService(PaidHttp, paidHttp),
                    Effect.provideService(FreeHttp, freeHttp),
                  );
                if (reconciled) {
                  const finishedAt = new Date().toISOString();
                  const claimed = yield* sql<{ call_id: string }>`
                    UPDATE paid_call_ledger
                    SET status = 'completed', last_updated_at = ${finishedAt}, finished_at = ${finishedAt}
                    WHERE call_id = ${payload.callId} AND status = 'dispatched'
                    RETURNING call_id
                  `.pipe(Effect.orElseSucceed(() => [] as { call_id: string }[]));
                  if (claimed.length === 0) {
                    const settled = yield* getJob(payload.callId);
                    return {
                      callId: payload.callId,
                      status: settled?.status ?? "failed",
                      receiptId: settled?.receiptId ?? null,
                      resultJson: settled?.result ? JSON.stringify(settled.result) : null,
                      error: settled?.error ?? null,
                    };
                  }
                  const rec = yield* Effect.result(
                    librarySvc.recordCall({
                      dig,
                      tool: action.name,
                      source: plugin.id,
                      args,
                      at: String(claim.row.created_at),
                      ms: Math.max(0, Date.now() - Date.parse(String(claim.row.created_at))),
                      status: reconciled.status,
                      cost: reconciled.details?.cost ?? null,
                      knownCost: reconciled.details?.knownCost,
                      responses,
                    }),
                  );
                  const digCost = yield* Effect.result(librarySvc.digSpend(dig));
                  const formatted = formatToolResult({
                    sourceLabel: plugin.label,
                    actionName: action.name,
                    dig,
                    outcome: reconciled,
                    receipt: Result.isSuccess(rec) ? rec.success : null,
                    retentionError: Result.isFailure(rec) ? rec.failure.message : null,
                    digCost: Result.isSuccess(digCost) ? digCost.success : null,
                  });
                  yield* sql`
                    UPDATE paid_call_ledger
                    SET status = 'completed',
                        receipt_id = ${Result.isSuccess(rec) ? rec.success.id : null},
                        outcome_json = ${JSON.stringify(formatted)},
                        last_updated_at = ${finishedAt},
                        finished_at = ${finishedAt}
                    WHERE call_id = ${payload.callId}
                  `.pipe(Effect.ignore);
                  return {
                    callId: payload.callId,
                    status: "completed",
                    receiptId: Result.isSuccess(rec) ? rec.success.id : null,
                    resultJson: JSON.stringify(formatted),
                    error: null,
                  };
                }
              }

              yield* markOrphanedRowFailed(claim.row, STOPPED);
              const updated = yield* sql<Record<string, unknown>>`
                SELECT receipt_id FROM paid_call_ledger WHERE call_id = ${payload.callId}
              `.pipe(Effect.orElseSucceed(() => [] as Record<string, unknown>[]));
              return {
                callId: payload.callId,
                status: "failed",
                receiptId: updated[0]?.receipt_id ? String(updated[0].receipt_id) : null,
                resultJson: null,
                error: STOPPED,
              };
            }

            // ---- DISPATCH ONCE OUTSIDE SQLITE TRANSACTION ----
            const controller = controllers.get(payload.callId) ?? new AbortController();
            controllers.set(payload.callId, controller);
            const startedAt = new Date().toISOString();
            const beginMs = Date.now();
            const responses: RetainedResponse[] = [];

            yield* hub.register({
              callId: payload.callId,
              dig: dig.handle,
              project: dig.project,
              source: plugin.id,
              tool: action.name,
            });

            return yield* Effect.gen(function* () {
              const out = yield* executeAction(
                action,
                args,
                makeRuntimeActionContext(
                  cfg,
                  dig,
                  payload.callId,
                  (label, status, body, headers) => {
                    responses.push({ label, status, body, ...(headers ? { headers } : {}) });
                  },
                  (update) => {
                    Effect.runFork(hub.update(payload.callId, update));
                  },
                  controller.signal,
                ),
              ).pipe(
                Effect.provideService(PaidHttp, paidHttp),
                Effect.provideService(FreeHttp, freeHttp),
              );

              const failedCall = ["failed", "cancelled"].includes(out.status);
              const declared = Object.keys(
                (schemaToMcpJson(action.schema).properties as Record<string, unknown> | undefined) ?? {},
              );
              const recRes = yield* Effect.result(
                librarySvc.recordCall({
                  dig,
                  tool: action.name,
                  source: plugin.id,
                  args,
                  declared,
                  at: startedAt,
                  ms: Date.now() - beginMs,
                  status: out.status,
                  cost: out.details?.cost ?? null,
                  knownCost: out.details?.knownCost,
                  responses,
                  ...(failedCall ? { error: out.text.split("\n", 1)[0].slice(0, 300) } : {}),
                }),
              );

              const digCostRes = yield* Effect.result(librarySvc.digSpend(dig));
              const formatted = formatToolResult({
                sourceLabel: plugin.label,
                actionName: action.name,
                dig,
                outcome: out,
                receipt: Result.isSuccess(recRes) ? recRes.success : null,
                retentionError: Result.isFailure(recRes)
                  ? redactText(`Evidence receipt not saved: ${recRes.failure.message}`, knownSecrets())
                  : null,
                digCost: Result.isSuccess(digCostRes) ? digCostRes.success : null,
              });

              const finalStatus = out.status === "cancelled" ? "cancelled" : "completed";
              const finishedAt = new Date().toISOString();
              const receiptId = Result.isSuccess(recRes) ? recRes.success.id : null;
              yield* sql`
                UPDATE paid_call_ledger
                SET status = ${finalStatus},
                    receipt_id = ${receiptId},
                    cost_json = ${out.details?.cost === undefined ? null : JSON.stringify(out.details.cost)},
                    known_cost_json = ${out.details?.knownCost === undefined ? null : JSON.stringify(out.details.knownCost)},
                    outcome_json = ${JSON.stringify(formatted)},
                    last_updated_at = ${finishedAt},
                    finished_at = ${finishedAt}
                WHERE call_id = ${payload.callId} AND status = 'dispatched'
              `.pipe(Effect.orElseSucceed(() => []));

              yield* hub.finish(payload.callId, finalStatus);

              return {
                callId: payload.callId,
                status: finalStatus,
                receiptId,
                resultJson: JSON.stringify(formatted),
                error: null,
              };
            }).pipe(
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  controllers.delete(payload.callId);
                  if (exit._tag === "Failure") {
                    const currentRows = yield* sql<Record<string, unknown>>`
                      SELECT * FROM paid_call_ledger WHERE call_id = ${payload.callId}
                    `.pipe(Effect.orElseSucceed(() => [] as Record<string, unknown>[]));
                    const row = currentRows[0];
                    if (!row) {
                      yield* hub.finish(payload.callId, "failed");
                      return;
                    }
                    const curStatus = String(row.status);
                    if (curStatus === "dispatched") {
                      const remoteId = row.remote_job_id ? String(row.remote_job_id) : null;
                      const interrupted = Exit.hasInterrupts(exit);
                      if (interrupted && remoteId && action.reconcile) {
                        // Leave row `dispatched` with its remote_job_id so next daemon boot can reconcile read-only.
                        yield* hub.finish(payload.callId, "failed");
                        return;
                      }
                      yield* markOrphanedRowFailed(row, STOPPED);
                      yield* hub.finish(payload.callId, "failed");
                    } else if (curStatus === "pending_approval") {
                      const nowIso = new Date().toISOString();
                      yield* sql`
                        UPDATE paid_call_ledger
                        SET status = 'cancelled',
                            error = 'Cancelled before provider dispatch.',
                            last_updated_at = ${nowIso},
                            finished_at = ${nowIso}
                        WHERE call_id = ${payload.callId} AND status = 'pending_approval'
                      `.pipe(Effect.ignore);
                      yield* hub.finish(payload.callId, "cancelled");
                    }
                  }
                }),
              ),
            );
          }),
        }),
      );

      // ---- Service Operations ----------------------------------------------------------------------

      const recoverCrashedCalls = (): Effect.Effect<number> =>
        Effect.gen(function* () {
          // 1. Settle any stale pending_approval rows from a prior crash (never dispatched, no receipt).
          const nowIso = new Date().toISOString();
          yield* sql`
            UPDATE paid_call_ledger
            SET status = 'cancelled',
                error = 'Cancelled during startup recovery before provider dispatch.',
                last_updated_at = ${nowIso},
                finished_at = ${nowIso}
            WHERE status = 'pending_approval'
          `.pipe(Effect.ignore);

          // 2. Recover mid-flight dispatched rows: reconcile read-only if remote_job_id + reconcile exist, else mark failed.
          const rows = yield* sql<Record<string, unknown>>`
            SELECT * FROM paid_call_ledger WHERE status = 'dispatched'
          `.pipe(Effect.orElseSucceed(() => [] as Record<string, unknown>[]));
          const cfgRes = yield* Effect.result(configSvc.load());
          for (const row of rows) {
            const remoteId = row.remote_job_id ? String(row.remote_job_id) : null;
            const pair = actionByPair.get(`${String(row.source)}:${String(row.tool)}`);
            if (remoteId && pair?.action.reconcile && Result.isSuccess(cfgRes)) {
              const digRes = yield* Effect.result(librarySvc.resolveHandle(String(row.dig_handle)));
              if (Result.isSuccess(digRes)) {
                const responses: RetainedResponse[] = [];
                const args = (() => {
                  try {
                    return JSON.parse(String(row.args_redacted_json)) as Record<string, unknown>;
                  } catch {
                    return {};
                  }
                })();
                const recOut = yield* Effect.result(
                  pair.action
                    .reconcile(
                      remoteId,
                      args,
                      makeRuntimeActionContext(
                        cfgRes.success,
                        digRes.success,
                        String(row.call_id),
                        (label, status, body, headers) => {
                          responses.push({ label, status, body, ...(headers ? { headers } : {}) });
                        },
                        () => {},
                        new AbortController().signal,
                      ),
                    )
                    .pipe(
                      Effect.provideService(PaidHttp, paidHttp),
                      Effect.provideService(FreeHttp, freeHttp),
                    ),
                );
                if (Result.isSuccess(recOut) && recOut.success) {
                  const finishedAt = new Date().toISOString();
                  const claimed = yield* sql<{ call_id: string }>`
                    UPDATE paid_call_ledger
                    SET status = 'completed', last_updated_at = ${finishedAt}, finished_at = ${finishedAt}
                    WHERE call_id = ${String(row.call_id)} AND status = 'dispatched'
                    RETURNING call_id
                  `.pipe(Effect.orElseSucceed(() => [] as { call_id: string }[]));
                  if (claimed.length > 0) {
                    const rec = yield* Effect.result(
                      librarySvc.recordCall({
                        dig: digRes.success,
                        tool: pair.action.name,
                        source: pair.plugin.id,
                        args,
                        at: String(row.created_at),
                        ms: Math.max(0, Date.now() - Date.parse(String(row.created_at))),
                        status: recOut.success.status,
                        cost: recOut.success.details?.cost ?? null,
                        knownCost: recOut.success.details?.knownCost,
                        responses,
                      }),
                    );
                    const digCost = yield* Effect.result(librarySvc.digSpend(digRes.success));
                    const formatted = formatToolResult({
                      sourceLabel: pair.plugin.label,
                      actionName: pair.action.name,
                      dig: digRes.success,
                      outcome: recOut.success,
                      receipt: Result.isSuccess(rec) ? rec.success : null,
                      retentionError: Result.isFailure(rec) ? rec.failure.message : null,
                      digCost: Result.isSuccess(digCost) ? digCost.success : null,
                    });
                    yield* sql`
                      UPDATE paid_call_ledger
                      SET receipt_id = ${Result.isSuccess(rec) ? rec.success.id : null},
                          outcome_json = ${JSON.stringify(formatted)}
                      WHERE call_id = ${String(row.call_id)}
                    `.pipe(Effect.ignore);
                    continue;
                  }
                }
              }
            }
            yield* markOrphanedRowFailed(row, STOPPED);
          }
          return rows.length;
        });

      const sweep = (nowMs = Date.now()): Effect.Effect<void> =>
        Effect.gen(function* () {
          const cutoffIso = new Date(nowMs - KEEP_MS).toISOString();
          const nowIso = new Date(nowMs).toISOString();
          yield* sql`
            DELETE FROM paid_call_ledger
            WHERE status IN ('completed', 'failed', 'cancelled')
              AND COALESCE(finished_at, last_updated_at) < ${cutoffIso}
          `.pipe(Effect.ignore);
          yield* sql`DELETE FROM deferred_tokens WHERE expires_at < ${nowIso}`.pipe(Effect.ignore);
          yield* sql`DELETE FROM browser_sessions WHERE expires_at < ${nowIso}`.pipe(Effect.ignore);
        });

      const getSpendOverrides = (digHandle: string): Effect.Effect<DigSpendOverrides> =>
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
            SELECT * FROM dig_spend_overrides WHERE dig_handle = ${digHandle}
          `.pipe(Effect.orElseSucceed(() => [] as Record<string, unknown>[]));
          const r = rows[0];
          if (!r) {
            return {
              digHandle,
              raisedUsd: 0,
              raisedCredits: 0,
              raisedXPostReads: 0,
              raisedXAccountReads: 0,
              raisedUnknownCalls: 0,
              dontAsk: false,
              updatedAt: null,
            };
          }
          return {
            digHandle,
            raisedUsd: Number(r.raised_usd ?? 0),
            raisedCredits: Number(r.raised_credits ?? 0),
            raisedXPostReads: Number(r.raised_x_post_reads ?? 0),
            raisedXAccountReads: Number(r.raised_x_account_reads ?? 0),
            raisedUnknownCalls: Number(r.raised_unknown_calls ?? 0),
            dontAsk: Boolean(r.dont_ask),
            updatedAt: r.updated_at ? String(r.updated_at) : null,
          };
        });

      const applySpendOverride: ExecutionServiceShape["applySpendOverride"] = (digHandle, update) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const cur = yield* getSpendOverrides(digHandle);
              const next: DigSpendOverrides = {
                digHandle,
                raisedUsd: Math.max(cur.raisedUsd, update.raisedUsd ?? cur.raisedUsd),
                raisedCredits: Math.max(cur.raisedCredits, update.raisedCredits ?? cur.raisedCredits),
                raisedXPostReads: Math.max(cur.raisedXPostReads, update.raisedXPostReads ?? cur.raisedXPostReads),
                raisedXAccountReads: Math.max(
                  cur.raisedXAccountReads,
                  update.raisedXAccountReads ?? cur.raisedXAccountReads,
                ),
                raisedUnknownCalls: Math.max(
                  cur.raisedUnknownCalls,
                  update.raisedUnknownCalls ?? cur.raisedUnknownCalls,
                ),
                dontAsk: update.dontAsk ?? cur.dontAsk,
                updatedAt: new Date().toISOString(),
              };
              yield* sql`
                INSERT OR REPLACE INTO dig_spend_overrides (
                  dig_handle, raised_usd, raised_credits, raised_x_post_reads,
                  raised_x_account_reads, raised_unknown_calls, dont_ask, updated_at
                ) VALUES (
                  ${next.digHandle}, ${next.raisedUsd}, ${next.raisedCredits},
                  ${next.raisedXPostReads}, ${next.raisedXAccountReads},
                  ${next.raisedUnknownCalls}, ${next.dontAsk ? 1 : 0}, ${next.updatedAt!}
                )
              `;
              return next;
            }),
          )
          .pipe(
            Effect.orElseSucceed(() => ({
              digHandle,
              raisedUsd: update.raisedUsd ?? 0,
              raisedCredits: update.raisedCredits ?? 0,
              raisedXPostReads: update.raisedXPostReads ?? 0,
              raisedXAccountReads: update.raisedXAccountReads ?? 0,
              raisedUnknownCalls: update.raisedUnknownCalls ?? 0,
              dontAsk: update.dontAsk ?? false,
              updatedAt: new Date().toISOString(),
            })),
          );

      const checkSpendGate: ExecutionServiceShape["checkSpendGate"] = ({
        config,
        dig,
        sourceLabel,
        actionName,
        args,
      }) =>
        Effect.gen(function* () {
          const { spend } = config;
          const anyCap =
            spend.dig_ceiling_usd !== null ||
            spend.ask_above_usd !== null ||
            spend.max_credits !== null ||
            spend.max_x_post_reads !== null ||
            spend.max_x_account_reads !== null ||
            spend.max_unknown_calls !== null;
          if (!anyCap) return { allow: true as const };

          const overrides = yield* getSpendOverrides(dig.handle);
          const summary = yield* librarySvc
            .digSpend(dig)
            .pipe(Effect.orElseSucceed(() => ({ calls: 0, byUnit: {} as Record<string, number>, unknownCalls: 0, freeCalls: 0 })));
          const bindFor = (kind: string, unit: string) =>
            createHash("sha256")
              .update(JSON.stringify([kind, unit, dig.handle, actionName, canonical(args)]))
              .digest("base64url");
          const subject = `${sourceLabel}'s ${actionName} action`;

          // 1. USD ceiling
          if (spend.dig_ceiling_usd !== null) {
            const spentUsd = summary.byUnit.USD ?? 0;
            const limitUsd = spend.dig_ceiling_usd + overrides.raisedUsd;
            if (spentUsd >= limitUsd) {
              const targetRaised = overrides.raisedUsd + spend.dig_ceiling_usd;
              const { USD: _u, ...otherUnits } = summary.byUnit;
              const others = costAmounts({ byUnit: otherUnits });
              const msg = `This dig has reached its USD spending ceiling (${formatUsd(spentUsd)} of $${limitUsd}${overrides.raisedUsd ? `, raised by $${overrides.raisedUsd}` : ""}).${others.length ? ` Other units: ${others.join(", ")}.` : ""}${summary.unknownCalls ? ` ${plural(summary.unknownCalls, "unknown-cost call")}.` : ""} Next call: ${subject}.`;
              return {
                allow: false as const,
                question: {
                  key: "ceiling" as const,
                  unit: "USD",
                  title: "Dig: spending ceiling reached",
                  message: `${msg} Raise the ceiling for this dig, or stop here?`,
                  bind: bindFor("ceiling", "USD"),
                  targetRaised,
                  choices: [
                    { value: "raise", title: `Raise the ceiling for this dig by $${spend.dig_ceiling_usd}` },
                    { value: "stop", title: "Stop here" },
                  ],
                },
                refusalText: `${msg} No request was sent. Raise or remove [spend] dig_ceiling_usd in config.toml.`,
              };
            }
          }

          // 2. Provider credits ceiling (ScrapeCreators / Scrape.do / Firecrawl)
          if (spend.max_credits !== null) {
            const spentCredits = Object.entries(summary.byUnit)
              .filter(([u]) => CREDIT_UNITS.has(u) || u.toLowerCase().includes("credit"))
              .reduce((sum, [, v]) => sum + v, 0);
            const limitCredits = spend.max_credits + overrides.raisedCredits;
            if (spentCredits >= limitCredits) {
              const targetRaised = overrides.raisedCredits + spend.max_credits;
              const msg = `This dig has reached its provider credit ceiling (${spentCredits} of ${limitCredits} credits). Next call: ${subject}.`;
              return {
                allow: false as const,
                question: {
                  key: "ceiling" as const,
                  unit: "credits",
                  title: "Dig: credit ceiling reached",
                  message: `${msg} Raise the credit ceiling for this dig, or stop here?`,
                  bind: bindFor("ceiling", "credits"),
                  targetRaised,
                  choices: [
                    { value: "raise", title: `Raise credit ceiling by ${spend.max_credits}` },
                    { value: "stop", title: "Stop here" },
                  ],
                },
                refusalText: `${msg} No request was sent. Adjust [spend] max_credits in config.toml.`,
              };
            }
          }

          // 3. X post reads ceiling
          if (spend.max_x_post_reads !== null) {
            const spentPosts = summary.byUnit["X post reads"] ?? 0;
            const limitPosts = spend.max_x_post_reads + overrides.raisedXPostReads;
            if (spentPosts >= limitPosts) {
              const targetRaised = overrides.raisedXPostReads + spend.max_x_post_reads;
              const msg = `This dig has reached its X post-read ceiling (${spentPosts} of ${limitPosts} X post reads). Next call: ${subject}.`;
              return {
                allow: false as const,
                question: {
                  key: "ceiling" as const,
                  unit: "X post reads",
                  title: "Dig: X post-read ceiling reached",
                  message: `${msg} Raise the limit for this dig, or stop here?`,
                  bind: bindFor("ceiling", "X post reads"),
                  targetRaised,
                  choices: [
                    { value: "raise", title: `Raise X post-read limit by ${spend.max_x_post_reads}` },
                    { value: "stop", title: "Stop here" },
                  ],
                },
                refusalText: `${msg} No request was sent. Adjust [spend] max_x_post_reads in config.toml.`,
              };
            }
          }

          // 4. X account reads ceiling
          if (spend.max_x_account_reads !== null) {
            const spentAccts = summary.byUnit["X account reads"] ?? 0;
            const limitAccts = spend.max_x_account_reads + overrides.raisedXAccountReads;
            if (spentAccts >= limitAccts) {
              const targetRaised = overrides.raisedXAccountReads + spend.max_x_account_reads;
              const msg = `This dig has reached its X account-read ceiling (${spentAccts} of ${limitAccts} X account reads). Next call: ${subject}.`;
              return {
                allow: false as const,
                question: {
                  key: "ceiling" as const,
                  unit: "X account reads",
                  title: "Dig: X account-read ceiling reached",
                  message: `${msg} Raise the limit for this dig, or stop here?`,
                  bind: bindFor("ceiling", "X account reads"),
                  targetRaised,
                  choices: [
                    { value: "raise", title: `Raise X account-read limit by ${spend.max_x_account_reads}` },
                    { value: "stop", title: "Stop here" },
                  ],
                },
                refusalText: `${msg} No request was sent. Adjust [spend] max_x_account_reads in config.toml.`,
              };
            }
          }

          // 5. Unknown-cost calls ceiling
          if (spend.max_unknown_calls !== null) {
            const limitUnknown = spend.max_unknown_calls + overrides.raisedUnknownCalls;
            if (summary.unknownCalls >= limitUnknown) {
              const targetRaised = overrides.raisedUnknownCalls + spend.max_unknown_calls;
              const msg = `This dig has reached its unknown-cost call ceiling (${summary.unknownCalls} of ${limitUnknown} calls). Next call: ${subject}.`;
              return {
                allow: false as const,
                question: {
                  key: "ceiling" as const,
                  unit: "unknown_calls",
                  title: "Dig: unknown-cost call ceiling reached",
                  message: `${msg} Raise the limit for this dig, or stop here?`,
                  bind: bindFor("ceiling", "unknown_calls"),
                  targetRaised,
                  choices: [
                    { value: "raise", title: `Allow ${spend.max_unknown_calls} more unknown-cost calls` },
                    { value: "stop", title: "Stop here" },
                  ],
                },
                refusalText: `${msg} No request was sent. Adjust [spend] max_unknown_calls in config.toml.`,
              };
            }
          }

          // 6. Per-call ask_above_usd check
          if (spend.ask_above_usd !== null && !overrides.dontAsk) {
            const history = yield* librarySvc.toolHistory(90).pipe(Effect.orElseSucceed(() => []));
            const row = history.find((h) => h.tool === actionName);
            const typical =
              !row || row.typicalCost === null
                ? null
                : row.typicalCost.find((c) => c.unit === "USD")?.amount ?? 0;
            if (typical === null || typical >= spend.ask_above_usd) {
              const costDesc =
                typical === null
                  ? "This library has no priced call of it yet, so its cost is unknown."
                  : `Its calls have typically cost ${formatUsd(typical)} (median of ${plural(row!.pricedCalls, "priced call")} in the last 90 days), at or above $${spend.ask_above_usd}.`;
              return {
                allow: false as const,
                question: {
                  key: "spend" as const,
                  unit: "USD",
                  title: "Dig: send a paid call?",
                  message: `Dig is about to send a paid request: ${subject}. ${costDesc}`,
                  bind: bindFor("spend", "USD"),
                  choices: [
                    { value: "send", title: "Send it" },
                    { value: "send-dig", title: "Send it, and don't ask again for this dig" },
                    { value: "stop", title: "Don't send it" },
                  ],
                },
                refusalText: `${subject} needs go-ahead (${costDesc}), but this client cannot ask. No request was sent.`,
              };
            }
          }

          return { allow: true as const };
        });

      const findReusableJob: ExecutionServiceShape["findReusableJob"] = (digHandle, actionName, hash, fresh) =>
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
            SELECT * FROM paid_call_ledger
            WHERE dig_handle = ${digHandle} AND tool = ${actionName} AND args_hash = ${hash}
            ORDER BY created_at DESC
            LIMIT 1
          `.pipe(Effect.orElseSucceed(() => [] as Record<string, unknown>[]));
          const row = rows[0];
          if (!row) return null;
          const job = rowToJob(row);
          if (job.status === "working") return job;
          if (!fresh && job.status !== "cancelled") {
            const finishedMs = Date.parse(job.finishedAt ?? job.lastUpdatedAt);
            if (Number.isFinite(finishedMs) && Date.now() - finishedMs <= REUSE_MS) return job;
          }
          return null;
        });

      const getJob = (callId: string): Effect.Effect<LedgerJob | null> =>
        Effect.gen(function* () {
          if (!/^job-[A-Za-z0-9_-]{16,40}$/.test(callId)) return null;
          const rows = yield* sql<Record<string, unknown>>`
            SELECT * FROM paid_call_ledger WHERE call_id = ${callId}
          `.pipe(Effect.orElseSucceed(() => [] as Record<string, unknown>[]));
          return rows[0] ? rowToJob(rows[0]) : null;
        });

      const runningJobs = (): Effect.Effect<readonly LedgerJob[]> =>
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
            SELECT * FROM paid_call_ledger
            WHERE status IN ('pending_approval', 'dispatched')
            ORDER BY created_at ASC
          `.pipe(Effect.orElseSucceed(() => [] as Record<string, unknown>[]));
          return rows.map(rowToJob);
        });

      const dispatchCall: ExecutionServiceShape["dispatchCall"] = ({
        plugin,
        action,
        dig,
        args,
        fresh = false,
        waitMs,
        onProgress,
        signal,
      }) =>
        Effect.gen(function* () {
          const parsed = decodeActionArgs(action, args);
          if (!parsed.ok) return yield* Effect.fail(new RefusalError({ message: parsed.error }));
          const validArgs = parsed.args as Record<string, unknown>;
          const isPaid = !isUnpaidCall(action, validArgs);
          const isSlow = Boolean(action.slow);
          const hash = argsHash(validArgs);

          // Fast + free calls bypass durable job ledger and run directly tied to the request signal.
          if (!isPaid && !isSlow) {
            const callId = `job-${toBase64Url(yield* rng.randomBytes(16))}`;
            const startedAt = new Date().toISOString();
            const beginMs = Date.now();
            const responses: RetainedResponse[] = [];
            const controller = new AbortController();
            if (signal) {
              if (signal.aborted) controller.abort();
              else signal.addEventListener("abort", () => controller.abort(), { once: true });
            }
            const inlineCfg = yield* configSvc.load().pipe(Effect.orElseSucceed(() => undefined));
            const out = yield* executeAction(
              action,
              validArgs,
              inlineCfg
                ? makeRuntimeActionContext(
                    inlineCfg,
                    dig,
                    callId,
                    (label, status, body, headers) => {
                      responses.push({ label, status, body, ...(headers ? { headers } : {}) });
                    },
                    (u) => onProgress?.({ ...u, at: new Date().toISOString() }),
                    controller.signal,
                  )
                : {
                    digId: dig.dig,
                    project: dig.project,
                    keep: (label, status, body, headers) => {
                      responses.push({ label, status, body, ...(headers ? { headers } : {}) });
                    },
                    progress: (u) => onProgress?.({ ...u, at: new Date().toISOString() }),
                    signal: controller.signal,
                  },
            ).pipe(
              Effect.provideService(PaidHttp, paidHttp),
              Effect.provideService(FreeHttp, freeHttp),
            );
            const failedCall = ["failed", "cancelled"].includes(out.status);
            const recRes = yield* Effect.result(
              librarySvc.recordCall({
                dig,
                tool: action.name,
                source: plugin.id,
                args: validArgs,
                declared: Object.keys(
                  (schemaToMcpJson(action.schema).properties as Record<string, unknown> | undefined) ?? {},
                ),
                at: startedAt,
                ms: Date.now() - beginMs,
                status: out.status,
                cost: out.details?.cost ?? [],
                knownCost: out.details?.knownCost,
                responses,
                ...(failedCall ? { error: out.text.split("\n", 1)[0].slice(0, 300) } : {}),
              }),
            );
            const digCostRes = yield* Effect.result(librarySvc.digSpend(dig));
            const formatted = formatToolResult({
              sourceLabel: plugin.label,
              actionName: action.name,
              dig,
              outcome: out,
              receipt: Result.isSuccess(recRes) ? recRes.success : null,
              retentionError: Result.isFailure(recRes) ? recRes.failure.message : null,
              digCost: Result.isSuccess(digCostRes) ? digCostRes.success : null,
            });
            const now = new Date().toISOString();
            return {
              job: {
                id: callId,
                workflowExecutionId: null,
                dig: dig.handle,
                project: dig.project,
                source: plugin.id,
                tool: action.name,
                argsHash: hash,
                status: out.status === "cancelled" ? "cancelled" : "completed",
                isPaid: false,
                isSlow: false,
                createdAt: startedAt,
                lastUpdatedAt: now,
                finishedAt: now,
                receiptId: Result.isSuccess(recRes) ? recRes.success.id : null,
                result: formatted,
              },
              reused: false,
              stillWorking: false,
            };
          }

          // Atomically check for an active/reusable job OR insert a fresh pending_approval row inside
          // one BEGIN IMMEDIATE transaction. Identical concurrent calls (even `fresh: true`) ALWAYS attach!
          const candidateId = `job-${toBase64Url(yield* rng.randomBytes(16))}`;
          const now = new Date().toISOString();
          const decision = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<Record<string, unknown>>`
                  SELECT * FROM paid_call_ledger
                  WHERE dig_handle = ${dig.handle} AND tool = ${action.name} AND args_hash = ${hash}
                  ORDER BY created_at DESC
                  LIMIT 1
                `;
                const row = rows[0];
                if (row) {
                  const job = rowToJob(row);
                  if (job.status === "working") {
                    return { kind: "attach" as const, callId: job.id };
                  }
                  if (!fresh && job.status !== "cancelled") {
                    const finishedMs = Date.parse(job.finishedAt ?? job.lastUpdatedAt);
                    if (Number.isFinite(finishedMs) && Date.now() - finishedMs <= REUSE_MS) {
                      return { kind: "reuse" as const, job };
                    }
                  }
                }
                yield* sql`
                  INSERT INTO paid_call_ledger (
                    call_id, dig_handle, project, source, tool, args_hash,
                    args_redacted_json, declared_json, is_paid, is_slow,
                    status, created_at, last_updated_at
                  ) VALUES (
                    ${candidateId}, ${dig.handle}, ${dig.project}, ${plugin.id}, ${action.name},
                    ${hash}, ${JSON.stringify(redactRecord(validArgs, knownSecrets()))},
                    ${JSON.stringify(Object.keys((schemaToMcpJson(action.schema).properties as object | undefined) ?? {}))},
                    ${isPaid ? 1 : 0}, ${isSlow ? 1 : 0},
                    'pending_approval', ${now}, ${now}
                  )
                `;
                return { kind: "created" as const, callId: candidateId };
              }),
            )
            .pipe(
              Effect.mapError((e) => new RefusalError({ message: `Could not claim job ledger row: ${String(e)}` })),
            );

          if (decision.kind === "reuse") {
            return { job: decision.job, reused: true, stillWorking: false };
          }

          const callId = decision.callId;
          if (decision.kind === "created") {
            const wfPayload = {
              callId,
              digHandle: dig.handle,
              sourceId: plugin.id,
              actionName: action.name,
              argsJson: JSON.stringify(validArgs),
              isPaid,
              isSlow,
            };
            const execRes = yield* Effect.result(
              ProviderCallWorkflow.execute(wfPayload, { discard: true }).pipe(
                Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
              ),
            );
            if (Result.isFailure(execRes)) {
              yield* settleEarlyFailure(callId, `Workflow launch failed: ${String(execRes.failure)}`);
              return yield* Effect.fail(new RefusalError({ message: `Workflow launch failed: ${String(execRes.failure)}` }));
            }
            yield* sql`
              UPDATE paid_call_ledger SET workflow_execution_id = ${execRes.success} WHERE call_id = ${callId}
            `.pipe(Effect.ignore);

            const waiter = (async () => {
              while (true) {
                const row = await Effect.runPromise(getJob(callId));
                if (!row || row.status !== "working") break;
                await new Promise((r) => setTimeout(r, 40));
              }
            })();
            waiter.finally(() => pendingPromises.delete(callId));
            pendingPromises.set(callId, waiter);
          }

          const unsubscribe = onProgress ? hub.subscribeCall(callId, onProgress) : undefined;
          const effectiveWait = waitMs ?? (isSlow ? inlineWaitMs() : Infinity);
          yield* Effect.gen(function* () {
            if (effectiveWait <= 0) return;
            const waiter = pendingPromises.get(callId);
            if (waiter) {
              if (effectiveWait === Infinity) {
                yield* Effect.promise(() => waiter);
              } else {
                yield* Effect.promise(
                  () =>
                    new Promise<void>((resolveWait) => {
                      const timer = setTimeout(resolveWait, effectiveWait);
                      void waiter.then(() => {
                        clearTimeout(timer);
                        resolveWait();
                      });
                    }),
                );
              }
            } else {
              const deadline = effectiveWait === Infinity ? Infinity : Date.now() + effectiveWait;
              while (Date.now() < deadline) {
                const cur = yield* getJob(callId);
                if (!cur || cur.status !== "working") break;
                yield* Effect.sleep("50 millis");
              }
            }
          }).pipe(Effect.ensuring(Effect.sync(() => unsubscribe?.())));

          const latest = yield* getJob(callId);
          if (!latest) {
            return yield* Effect.fail(new RefusalError({ message: `Job ${callId} was lost` }));
          }
          const stillWorking = latest.status === "working";
          return { job: latest, reused: decision.kind === "attach", stillWorking };
        });

      const cancelJob = (callId: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const controller = controllers.get(callId);
          if (controller) {
            controller.abort();
            return true;
          }
          const rows = yield* sql<Record<string, unknown>>`
            SELECT status FROM paid_call_ledger WHERE call_id = ${callId}
          `.pipe(Effect.orElseSucceed(() => [] as Record<string, unknown>[]));
          const status = rows[0]?.status ? String(rows[0].status) : null;
          if (status === "pending_approval") {
            const nowIso = new Date().toISOString();
            yield* sql`
              UPDATE paid_call_ledger
              SET status = 'cancelled',
                  error = 'Cancelled before provider dispatch.',
                  last_updated_at = ${nowIso},
                  finished_at = ${nowIso}
              WHERE call_id = ${callId} AND status = 'pending_approval'
            `.pipe(Effect.ignore);
            yield* hub.finish(callId, "cancelled");
            return true;
          }
          return false;
        });

      const createOpaqueCode: ExecutionServiceShape["createOpaqueCode"] = ({
        kind,
        payload,
        ttlMs,
        deferredToken,
      }) =>
        Effect.gen(function* () {
          const code = toBase64Url(yield* rng.randomBytes(24));
          const now = new Date();
          const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
          yield* sql`
            INSERT INTO deferred_tokens (code, kind, deferred_token, payload_json, used, created_at, expires_at)
            VALUES (${code}, ${kind}, ${deferredToken ?? null}, ${JSON.stringify(payload)}, 0, ${now.toISOString()}, ${expiresAt})
          `.pipe(Effect.orDie);
          return { code, expiresAt };
        });

      const readOpaqueCode = (code: string): Effect.Effect<DeferredTokenRecord | null> =>
        Effect.gen(function* () {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(code)) return null;
          const rows = yield* sql<Record<string, unknown>>`
            SELECT * FROM deferred_tokens WHERE code = ${code}
          `.pipe(Effect.orElseSucceed(() => [] as Record<string, unknown>[]));
          const r = rows[0];
          if (!r) return null;
          return {
            code: String(r.code),
            kind: String(r.kind) as DeferredTokenRecord["kind"],
            deferredToken: r.deferred_token ? String(r.deferred_token) : null,
            payload: JSON.parse(String(r.payload_json)) as Record<string, unknown>,
            used: Boolean(r.used),
            result: r.result_json ? (JSON.parse(String(r.result_json)) as Record<string, unknown>) : null,
            createdAt: String(r.created_at),
            expiresAt: String(r.expires_at),
          };
        });

      const redeemOpaqueCode: ExecutionServiceShape["redeemOpaqueCode"] = (code, result) =>
        Effect.gen(function* () {
          const nowIso = new Date().toISOString();
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<Record<string, unknown>>`
                  SELECT * FROM deferred_tokens WHERE code = ${code}
                `;
                const r = rows[0];
                if (!r || Boolean(r.used) || String(r.expires_at) < nowIso) return null;
                yield* sql`
                  UPDATE deferred_tokens
                  SET used = 1, result_json = ${result ? JSON.stringify(result) : null}
                  WHERE code = ${code}
                `;
                return {
                  code: String(r.code),
                  kind: String(r.kind) as DeferredTokenRecord["kind"],
                  deferredToken: r.deferred_token ? String(r.deferred_token) : null,
                  payload: JSON.parse(String(r.payload_json)) as Record<string, unknown>,
                  used: true,
                  result: result ?? null,
                  createdAt: String(r.created_at),
                  expiresAt: String(r.expires_at),
                };
              }),
            )
            .pipe(Effect.orElseSucceed(() => null));
        });

      const hasPendingTokens = (): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const nowIso = new Date().toISOString();
          const rows = yield* sql<{ n: number }>`
            SELECT COUNT(*) AS n FROM deferred_tokens WHERE used = 0 AND expires_at > ${nowIso}
          `.pipe(Effect.orElseSucceed(() => [{ n: 0 }]));
          return Number(rows[0]?.n ?? 0) > 0;
        });

      const sealState = (payload: Record<string, unknown>, ttlSeconds = 3600): Effect.Effect<string> =>
        Effect.gen(function* () {
          const body = Buffer.from(
            JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
            "utf8",
          );
          const tag = yield* mac.sign(hmacKey, body).pipe(Effect.orDie);
          return `${toBase64Url(body)}.${toBase64Url(tag)}`;
        });

      const verifyState = (sealed: string): Effect.Effect<Record<string, unknown> | null> =>
        Effect.gen(function* () {
          const dot = sealed.indexOf(".");
          if (dot <= 0) return null;
          const bodyBytes = Buffer.from(sealed.slice(0, dot), "base64url");
          const tagBytes = Buffer.from(sealed.slice(dot + 1), "base64url");
          const ok = yield* mac.verify(hmacKey, tagBytes, bodyBytes).pipe(Effect.orElseSucceed(() => false));
          if (!ok) return null;
          try {
            const parsed = JSON.parse(bodyBytes.toString("utf8")) as Record<string, unknown>;
            if (typeof parsed.exp === "number" && parsed.exp < Math.floor(Date.now() / 1000)) return null;
            return parsed;
          } catch {
            return null;
          }
        });

      const listPendingApprovals = (): Effect.Effect<readonly PendingApproval[]> =>
        Effect.gen(function* () {
          const nowIso = new Date().toISOString();
          const rows = yield* sql<Record<string, unknown>>`
            SELECT code, payload_json, created_at, expires_at
            FROM deferred_tokens
            WHERE kind = 'spend_approval' AND used = 0 AND expires_at > ${nowIso}
            ORDER BY created_at DESC
          `.pipe(Effect.orElseSucceed(() => [] as Record<string, unknown>[]));
          const out: PendingApproval[] = [];
          for (const r of rows) {
            try {
              const payload = JSON.parse(String(r.payload_json)) as Record<string, unknown>;
              out.push({
                code: String(r.code),
                dig: typeof payload.digHandle === "string" ? payload.digHandle : "",
                tool: typeof payload.actionName === "string" ? payload.actionName : "",
                source: typeof payload.sourceLabel === "string" ? payload.sourceLabel : "",
                title: typeof payload.title === "string" ? payload.title : "Spend approval required",
                message: typeof payload.message === "string" ? payload.message : "",
                createdAt: String(r.created_at),
                expiresAt: String(r.expires_at),
              });
            } catch {
              // Skip malformed row
            }
          }
          return out;
        });

      return ExecutionService.of({
        recoverCrashedCalls,
        sweep,
        checkSpendGate,
        applySpendOverride,
        getSpendOverrides,
        findReusableJob,
        getJob,
        runningJobs,
        dispatchCall,
        cancelJob,
        listPendingApprovals,
        createOpaqueCode,
        readOpaqueCode,
        redeemOpaqueCode,
        hasPendingTokens,
        sealState,
        verifyState,
      });
    }),
  );
}
