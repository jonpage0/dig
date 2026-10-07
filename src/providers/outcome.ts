import type { ReceiptCost } from "./library/types.js";
import { receiptCost } from "./library/cost.js";
import type {
  SourceToolResult,
  ToolContext,
  RetainedResponse,
  ToolSpec,
} from "./types.js";

export type OutcomeStatus =
  | "success"
  | "empty"
  | "partial"
  | "failed"
  | "cancelled"
  | "skipped";
export interface ToolOutcome {
  status: OutcomeStatus;
  text: string;
  details?: Record<string, unknown>;
}
export function outcome(
  status: OutcomeStatus,
  text: string,
  details?: Record<string, unknown>,
): ToolOutcome {
  return { status, text, ...(details ? { details } : {}) };
}

/** The provider's existing no-charge policy, finalized even on failure/cancellation. */
export function free(spec: ToolSpec): ToolSpec {
  return { ...spec, billing: "free" };
}
/** Declare a single-unit charge reader; executeSource owns accumulation and finalization. */
export function metered(
  spec: ToolSpec,
  unit: string,
  charge: (body: unknown, status: number | string, headers: RetainedResponse["headers"], args: any) => number | null,
): ToolSpec {
  return {
    ...spec,
    billing: {
      charge(response, args) {
        const amount = charge(response.body, response.status, response.headers, args);
        return amount === null ? { cost: null } : { cost: [{ amount, unit }] };
      },
    },
  };
}
export function failed(text: string): ToolOutcome {
  return outcome("failed", text.startsWith("ERROR:") ? text : `ERROR: ${text}`);
}

/** Compatibility is confined here; host adapters consume only explicit outcomes.
 * New/updated providers set status directly, so quoted source text cannot turn a
 * successful response into an error merely by starting with "ERROR:".
 */
export function normalizeOutcome(result: SourceToolResult): ToolOutcome {
  if (typeof result !== "string" && result.status) return result as ToolOutcome;
  const text = typeof result === "string" ? result : result.text;
  const details = typeof result === "string" ? undefined : result.details;
  const recorded = details?.status;
  const status: OutcomeStatus =
    text.startsWith("ERROR:") || /^Status: failed(?:\r?\n|$)/.test(text)
      ? "failed"
      : /^Status: skipped(?:\r?\n|$)/.test(text)
        ? "skipped"
        : ["empty", "partial", "failed", "cancelled", "skipped"].includes(
              String(recorded),
            )
          ? (recorded as OutcomeStatus)
          : "success";
  return outcome(status, text, details);
}
export async function executeSource(
  spec: ToolSpec,
  args: unknown,
  context: ToolContext,
): Promise<ToolOutcome> {
  if (context.abort.aborted)
    return outcome("cancelled", "Research call cancelled", { cost: [] });
  const totals = new Map<string, number>();
  let observations = 0;
  let incomplete = false;
  let threw = false;
  let result: ToolOutcome;
  let billing = spec.billing;
  if (billing && billing !== "free") {
    try {
      if (billing.noCharge?.(args)) billing = "free";
    } catch {
      // Invalid selections do not establish no-charge; execution owns its normal argument error.
    }
  }
  const captured: ToolContext = {
    ...context,
    keep(label, status, body, headers) {
      if (billing && billing !== "free") {
        observations += 1;
        try {
          const pricing = receiptCost(billing.charge({ label, status, body, ...(headers ? { headers } : {}) }, args));
          if (pricing.cost === null) incomplete = true;
          for (const { amount, unit } of pricing.cost ?? pricing.knownCost ?? []) {
            const total = (totals.get(unit) ?? 0) + amount;
            if (Number.isFinite(total)) totals.set(unit, total);
            else incomplete = true;
          }
        } catch {
          // Unusable billing is unknown. It must never turn into a request retry.
          incomplete = true;
        }
      }
      if (headers) context.keep(label, status, body, headers);
      else context.keep(label, status, body);
    },
  };
  try {
    result = normalizeOutcome(await spec.execute(args, captured));
  } catch {
    threw = true;
    // Arbitrary exceptions may include authenticated URLs; keep the final error generic.
    result = failed("Research tool failed unexpectedly");
  }
  if (context.abort.aborted) result = outcome("cancelled", "Research call cancelled");
  const amounts = [...totals].map(([unit, amount]) => ({ amount, unit }));
  const partial = threw || context.abort.aborted || incomplete || observations === 0;
  const pricing: ReceiptCost = billing === "free"
    ? { cost: [] }
    : partial
      ? { cost: null, ...(amounts.length ? { knownCost: amounts } : {}) }
      : { cost: amounts };
  const { cost: _cost, knownCost: _knownCost, ...details } = result.details ?? {};
  return { ...result, details: { ...details, ...pricing } };
}
export function hostResult(result: ToolOutcome, name: string) {
  const isError = result.status === "failed" || result.status === "cancelled";
  return {
    content: [{ type: "text" as const, text: result.text }],
    details: {
      ...result.details,
      status: result.status,
      ok: !isError,
      tool: name,
    },
    ...(isError ? { isError: true } : {}),
  };
}
