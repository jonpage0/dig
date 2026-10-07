/**
 * Cost shapes providers report and call receipts record, as the approved
 * library contract defines them. JSON-serializable.
 */

export interface CostAmount {
	amount: number;
	/** The provider's own unit: "USD", "credits", … Never converted. */
	unit: string;
}
/** `null`: unknown or unreported. `[]`: recorded no provider charge (reported zero or explicit no-charge policy). */
export type Cost = CostAmount[] | null;
/** Complete total, or an unknown total with an optional positive observed subtotal. */
export type ReceiptCost =
	| { cost: CostAmount[]; knownCost?: never }
	| { cost: null; knownCost?: CostAmount[] };

export interface CostSummary {
	/** Provider-reported totals and partial subtotals, summed once per exact unit. */
	byUnit: Record<string, number>;
	/** Calls whose cost is unknown; never counted as zero. */
	unknownCalls: number;
	/** Calls recording no provider charge, not a reconciled cash bill. */
	freeCalls: number;
}
