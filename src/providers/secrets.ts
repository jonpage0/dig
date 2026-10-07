import { MODULES, type DigModule } from "./modules.js";

/**
 * Credential values Dig must never return, save or record. The native tool
 * boundary (src/server.mjs) redacts every one of them from tool results, from
 * what library tools write, and from call receipts and raw responses.
 */

const REDACTED = "[redacted]";
/** Shorter values are too likely to occur by chance in ordinary text. */
const MIN_SECRET_LENGTH = 8;

const registered = new Set<string>();
/**
 * Catalog environment names that hold credentials: `…_KEY`, `…_TOKEN`,
 * `…_SECRET`, `…_PASSWORD`. Base URLs, timeouts, contact emails and API
 * logins are settings, and redacting them everywhere would corrupt ordinary
 * text in saved evidence. The Papers bridge, the one provider that echoes the
 * Unpaywall contact email, scrubs it from its own output (paper_search.ts).
 */
const CREDENTIAL_ENV = [
	...new Set((MODULES as readonly DigModule[]).flatMap((m) => m.env ?? [])),
].filter((name) => /_(KEY|TOKEN|SECRET|PASSWORD)$/.test(name));

/** A credential obtained outside the environment (e.g. `gh auth token`); redacted everywhere from now on. */
export function registerSecret(value: string): void {
	const secret = value.trim();
	if (secret.length >= MIN_SECRET_LENGTH) registered.add(secret);
}

/** Values passed to `registerSecret`. */
export function registeredSecrets(): ReadonlySet<string> {
	return registered;
}

/**
 * Every credential value in play: the set value of each credential name in
 * the source catalog, plus registered values. Read at call time, so keys
 * loaded from keys.env after startup count. Each value also counts in the
 * spellings URL encoding gives it, because Scrape.do and Just One take their
 * token in a query parameter and a response can echo the request URL. Longest
 * first, so a value that contains another is replaced whole.
 */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
	const values = new Set<string>();
	const add = (value: string) => {
		values.add(value);
		values.add(encodeURIComponent(value));
		values.add(new URLSearchParams({ v: value }).toString().slice(2));
	};
	for (const value of registered) add(value);
	for (const name of CREDENTIAL_ENV) {
		const value = env[name]?.trim();
		if (value && value.length >= MIN_SECRET_LENGTH) add(value);
	}
	return [...values].sort((a, b) => b.length - a.length);
}

export function redactText(text: string, secrets: readonly string[]): string {
	let clean = text;
	for (const secret of secrets) if (clean.includes(secret)) clean = clean.replaceAll(secret, REDACTED);
	return clean;
}

/** Every string inside plain objects and arrays, member names included, redacted; other values are returned as they are. */
export function redactValue(value: unknown, secrets: readonly string[]): unknown {
	if (!secrets.length) return value;
	if (typeof value === "string") return redactText(value, secrets);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
	if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
		return redactRecord(value, secrets);
	return value;
}

export function redactRecord(record: object, secrets: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).map(([name, item]) => [redactText(name, secrets), redactValue(item, secrets)]),
	);
}
