import type { ReceiptCost } from "./library/types.js";

export interface RetainedResponse {
	label: string;
	status: number | string;
	body: unknown;
	/** Deliberately narrow: never retain arbitrary response headers. */
	headers?: { "scrape.do-request-cost": string };
}

/**
 * Records one provider response for the call's raw file: per request or
 * attempt, parsed JSON when possible, text otherwise. Never pass request
 * headers or credentials.
 */
export type KeepRaw = (label: string, status: number | string, body: unknown, headers?: RetainedResponse["headers"]) => void;

export interface ToolContext {
	sessionID: string;
	directory: string;
	worktree: string;
	abort: AbortSignal;
	keep: KeepRaw;
}

export interface SourceToolOutput {
	status?: import("./outcome.js").OutcomeStatus;
	text: string;
	/** Finalized by executeSource: complete `cost`, or null with an optional positive `knownCost` subtotal. */
	details?: Record<string, unknown>;
}

export type SourceToolResult = string | SourceToolOutput;

export interface ToolSpec {
	description: string;
	/** Provider evidence only. Missing policy means unknown, never implicitly free. */
	billing?: "free" | {
		charge: (response: RetainedResponse, args: any) => ReceiptCost;
		/** An explicit no-charge policy for this source selection, independent of execution outcome. */
		noCharge?: (args: any) => boolean;
	};
	// biome-ignore lint/suspicious/noExplicitAny: arguments are validated against the shared TypeBox registry before dispatch.
	execute: (args: any, ctx: ToolContext) => Promise<SourceToolResult>;
}
