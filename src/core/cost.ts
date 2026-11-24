/**
 * Honest provider cost accounting: known amounts per unit, unknown (`null`) and
 * free (`[]`) kept distinct and never coerced or converted across units.
 * Zero Node imports so both backend services and browser UI can share it.
 */

export interface CostAmount {
  readonly amount: number;
  readonly unit: string;
}

/** `[]` = free, non-empty = complete cost in original units, `null` = unknown. */
export type Cost = readonly CostAmount[] | null;

export interface ReceiptCost {
  readonly cost: Cost;
  /** Positive observed partial cost when `cost === null` (e.g. partial multi-request run). */
  readonly knownCost?: readonly CostAmount[];
}

export interface CostSummary {
  readonly byUnit: Record<string, number>;
  readonly unknownCalls: number;
  readonly freeCalls: number;
}

function parseCost(value: unknown): Cost {
  if (!Array.isArray(value)) return null;
  const valid = value.every(
    (item: Partial<CostAmount> | null) =>
      !!item &&
      typeof item.amount === "number" &&
      Number.isFinite(item.amount) &&
      item.amount >= 0 &&
      typeof item.unit === "string" &&
      item.unit.trim().length > 0,
  );
  if (!valid) return null;
  const byUnit = new Map<string, number>();
  for (const { amount, unit } of value as readonly CostAmount[]) {
    const sum = (byUnit.get(unit) ?? 0) + amount;
    if (!Number.isFinite(sum)) return null;
    if (sum > 0) byUnit.set(unit, sum);
  }
  return [...byUnit].map(([unit, amount]) => ({ amount, unit }));
}

/** Enforce the receipt cost union before persisting or admitting billing evidence. */
export function receiptCost(value: { cost: unknown; knownCost?: unknown }): ReceiptCost {
  if (value.cost !== null) {
    if (value.knownCost !== undefined) throw new Error("knownCost requires an unknown total");
    const cost = parseCost(value.cost);
    if (cost === null) throw new Error("Invalid provider cost");
    return { cost };
  }
  if (value.knownCost === undefined) return { cost: null };
  const knownCost = parseCost(value.knownCost);
  if (
    !knownCost?.length ||
    !Array.isArray(value.knownCost) ||
    knownCost.length !== value.knownCost.length ||
    value.knownCost.some((item) => (item as CostAmount).amount <= 0)
  ) {
    throw new Error("knownCost must contain positive amounts with unique units");
  }
  return { cost: null, knownCost };
}

/** Sum call costs honestly across units without converting or dropping unknowns. */
export function costSummary(calls: readonly ReceiptCost[]): CostSummary {
  const byUnit: Record<string, number> = {};
  let unknownCalls = 0;
  let freeCalls = 0;
  for (const call of calls) {
    let pricing: ReceiptCost;
    try {
      pricing = receiptCost(call);
    } catch {
      pricing = { cost: null };
    }
    if (pricing.cost === null) unknownCalls += 1;
    else if (pricing.cost.length === 0) freeCalls += 1;
    for (const { amount, unit } of pricing.cost ?? pricing.knownCost ?? []) {
      const previous = Object.hasOwn(byUnit, unit) ? byUnit[unit] : 0;
      Object.defineProperty(byUnit, unit, {
        value: previous + amount,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return { byUnit, unknownCalls, freeCalls };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

export function formatUsd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3).replace(/0$/, "")}`;
  return `$${amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function costAmounts(summary: Pick<CostSummary, "byUnit">): string[] {
  const entries = Object.entries(summary.byUnit).filter(([, v]) => Number.isFinite(v) && v > 0);
  entries.sort(([a], [b]) => (a === "USD" ? -1 : b === "USD" ? 1 : a.localeCompare(b)));
  return entries.map(([unit, amount]) => {
    if (unit === "USD") return formatUsd(amount);
    const rounded = Number.isInteger(amount) ? amount.toLocaleString("en-US") : amount.toFixed(2).replace(/\.?0+$/, "");
    return `${rounded} ${unit}`;
  });
}

export function costShort(summary: CostSummary, totalCalls: number): string {
  const parts = costAmounts(summary);
  if (parts.length && summary.unknownCalls === 0) return parts.join(" + ");
  if (parts.length && summary.unknownCalls > 0) {
    return `${parts.join(" + ")} + ${plural(summary.unknownCalls, "unknown-cost call")}`;
  }
  if (summary.unknownCalls > 0) return "unknown";
  if (totalCalls === 0) return "none";
  return "free";
}

export function costTotal(summary: CostSummary, totalCalls: number): string {
  const parts = costAmounts(summary);
  const segments: string[] = [];
  if (parts.length) segments.push(`Provider-reported cost: ${parts.join(" + ")}`);
  if (summary.unknownCalls > 0) {
    segments.push(`${plural(summary.unknownCalls, "call")} with unknown cost`);
  }
  if (!segments.length) return totalCalls > 0 ? "free" : "none";
  return segments.join("; ");
}
