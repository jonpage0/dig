import type { Cost, CostAmount, CostSummary, ReceiptCost } from "./types.js";

/**
 * A provider cost in its original units. Invalid amounts or units make the
 * whole observation unknown. Valid zero entries are omitted; duplicate units
 * are combined without converting them.
 */
export function parseCost(value: unknown): Cost {
	if (!Array.isArray(value)) return null;
	const valid = value.every(
		(item: Partial<CostAmount> | null) =>
			!!item && typeof item.amount === "number" && Number.isFinite(item.amount) && item.amount >= 0 &&
			typeof item.unit === "string" && item.unit.trim().length > 0,
	);
	if (!valid) return null;
	const byUnit = new Map<string, number>();
	for (const { amount, unit } of value as CostAmount[]) {
		const sum = (byUnit.get(unit) ?? 0) + amount;
		if (!Number.isFinite(sum)) return null;
		if (sum > 0) byUnit.set(unit, sum);
	}
	return [...byUnit].map(([unit, amount]) => ({ amount, unit }));
}

/** Enforce the approved receipt union before persisting or admitting billing evidence. */
export function receiptCost(value: { cost: unknown; knownCost?: unknown }): ReceiptCost {
	if (value.cost !== null) {
		if (value.knownCost !== undefined) throw new Error("knownCost requires an unknown total");
		const cost = parseCost(value.cost);
		if (cost === null) throw new Error("Invalid provider cost");
		return { cost };
	}
	if (value.knownCost === undefined) return { cost: null };
	const knownCost = parseCost(value.knownCost);
	if (!knownCost?.length || !Array.isArray(value.knownCost) ||
		knownCost.length !== value.knownCost.length ||
		value.knownCost.some(item => item.amount <= 0)) {
		throw new Error("knownCost must contain positive amounts with unique units");
	}
	return { cost: null, knownCost };
}

/**
 * Sum call costs honestly: known amounts per unit, unknown (`null`) and free
 * (`[]`) calls counted separately, never folded into a total. No node
 * imports, so the dashboard's browser code can use it too.
 */
export function costSummary(calls: readonly ReceiptCost[]): CostSummary {
	const summary: CostSummary = { byUnit: {}, unknownCalls: 0, freeCalls: 0 };
	for (const call of calls) {
		let pricing: ReceiptCost;
		try { pricing = receiptCost(call); } catch { pricing = { cost: null }; }
		if (pricing.cost === null) summary.unknownCalls += 1;
		else if (pricing.cost.length === 0) summary.freeCalls += 1;
		for (const { amount, unit } of pricing.cost ?? pricing.knownCost ?? []) {
			// defineProperty also treats names such as "__proto__" as units, not object internals.
			const previous = Object.hasOwn(summary.byUnit, unit) ? summary.byUnit[unit] : 0;
			Object.defineProperty(summary.byUnit, unit, { value: previous + amount, enumerable: true, configurable: true });
		}
	}
	return summary;
}
