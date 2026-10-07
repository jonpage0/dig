import type { KeepRaw, RetainedResponse } from "./types.js";

export interface JsonRequestPolicy {
	url: URL | string;
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: unknown;
	signal: AbortSignal;
	timeoutMs?: number;
	retries?: number;
	retryStatuses?: readonly number[];
	provider: string;
	/** Receives every attempt's response (or transport error) for the call's raw file. */
	keep: KeepRaw;
	/** Raw-file label for this request; defaults to `provider`. */
	label?: string;
	/** Preserve provider-specific JSON values (such as identifiers beyond 2^53). */
	parseJson?: (text: string) => unknown;
}

export interface JsonRequestResult {
	payload: unknown;
	status: number;
	attempts: number;
	durationMs: number;
	requestId?: string;
}

const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504] as const;

function retryDelayMs(response: Response | undefined, attempt: number): number {
	const retryAfter = response?.headers.get("retry-after")?.trim();
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);
		const date = Date.parse(retryAfter);
		if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
	}
	return Math.min(500 * 2 ** attempt, 4_000);
}

/** Waits `ms`, rejecting at once when `signal` aborts. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Request aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function requestId(response: Response): string | undefined {
	for (const name of ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"]) {
		const value = response.headers.get(name)?.trim();
		if (value) return value;
	}
	return undefined;
}

function billingHeaders(response: Response): RetainedResponse["headers"] {
	const cost = response.headers.get("scrape.do-request-cost");
	return cost === null ? undefined : { "scrape.do-request-cost": cost };
}

function capture(keep: KeepRaw, label: string, response: Response, body: unknown, headers: RetainedResponse["headers"]): void {
	if (headers) keep(label, response.status, body, headers);
	else keep(label, response.status, body);
}

async function responseText(response: Response, keep: KeepRaw, label: string, headers: RetainedResponse["headers"]): Promise<string> {
	try { return await response.text(); }
	catch (error) {
		capture(keep, label, response, "", headers);
		throw error;
	}
}

/**
 * `response.json()` that also keeps the body for the call's raw file: parsed
 * JSON, or the text when it does not parse (and then throws like `json()`).
 */
export async function keptJson(response: Response, keep: KeepRaw, label: string): Promise<unknown> {
	const headers = billingHeaders(response);
	const text = await responseText(response, keep, label, headers);
	let payload: unknown;
	try { payload = JSON.parse(text); }
	catch (error) {
		capture(keep, label, response, text, headers);
		throw error;
	}
	capture(keep, label, response, payload, headers);
	return payload;
}

/** `response.text()` that also keeps the body (parsed when it is JSON) for the call's raw file. */
export async function keptText(response: Response, keep: KeepRaw, label: string): Promise<string> {
	const headers = billingHeaders(response);
	const text = await responseText(response, keep, label, headers);
	let body: unknown = text;
	try { body = JSON.parse(text); } catch {}
	capture(keep, label, response, body, headers);
	return text;
}

function parse(text: string, parseJson: (text: string) => unknown): unknown {
	try {
		return parseJson(text);
	} catch {
		return null;
	}
}

export async function requestJson(policy: JsonRequestPolicy): Promise<JsonRequestResult> {
	const startedAt = performance.now();
	const retries = Math.max(0, policy.retries ?? 2);
	const retryStatuses = new Set(policy.retryStatuses ?? DEFAULT_RETRY_STATUSES);
	const label = policy.label ?? policy.provider;
	let lastError: unknown;

	for (let attempt = 0; attempt <= retries; attempt++) {
		if (policy.signal.aborted) throw policy.signal.reason ?? new Error(`${policy.provider} request aborted`);
		let response: Response | undefined;
		let captured = false;
		try {
			response = await fetch(policy.url, {
				method: policy.method ?? "GET",
				headers: policy.headers,
				body: policy.body === undefined ? undefined : JSON.stringify(policy.body),
				signal: AbortSignal.any([
					policy.signal,
					AbortSignal.timeout(policy.timeoutMs ?? 60_000),
				]),
			});
			const headers = billingHeaders(response);
			const text = await response.text().catch(() => "");
			const payload = text ? parse(text, policy.parseJson ?? JSON.parse) : null;
			captured = true;
			capture(policy.keep, label, response, payload ?? text, headers);
			policy.signal.throwIfAborted();
			if (!retryStatuses.has(response.status) || attempt === retries) {
				return {
					payload,
					status: response.status,
					attempts: attempt + 1,
					durationMs: Math.round(performance.now() - startedAt),
					requestId: requestId(response),
				};
			}
			lastError = new Error(`${policy.provider} returned retryable HTTP ${response.status}`);
		} catch (error) {
			if (!captured) policy.keep(label, "error", error instanceof Error ? error.message : String(error));
			if (policy.signal.aborted) throw policy.signal.reason ?? error;
			lastError = error;
			if (attempt === retries) throw error;
		}
		await abortableDelay(retryDelayMs(response, attempt), policy.signal);
	}

	throw lastError instanceof Error ? lastError : new Error(`${policy.provider} request failed`);
}
