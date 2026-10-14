import { MODULES, type DigModule } from "./modules.js";

/**
 * Credential values Dig must never return, save or record. Provider bodies are
 * redacted as they arrive (`redactProviderText`, JSON decoded first, in http.ts
 * and the few tools that read their own), so no tool can cut a credential short
 * before redaction sees it; the native tool
 * boundary (src/server.mjs) redacts every one of them again from tool results,
 * from what library tools write, and from call receipts and raw responses.
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

/**
 * Every credential value in play: the set value of each credential name in
 * the source catalog, plus registered values. Read at call time, so keys
 * loaded from keys.env after startup count. Longest first, so a value that
 * contains another is replaced whole. `redactText` owns their spellings.
 */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
	const values = new Set(registered);
	for (const name of CREDENTIAL_ENV) {
		const value = env[name]?.trim();
		if (value && value.length >= MIN_SECRET_LENGTH) values.add(value);
	}
	return [...values].sort((a, b) => b.length - a.length);
}

/** Text matched literally by a regular expression. */
const literal = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
const utf8 = new TextEncoder();
/** `%XX` for one byte, its hex digits in either case. */
const byteEscape = (byte: number) =>
	`%${byte.toString(16).toUpperCase().padStart(2, "0").replace(/[A-F]/g, (digit) => `[${digit}${digit.toLowerCase()}]`)}`;
/**
 * One character of a credential: the pattern for its spellings, and the most characters one of them takes. A spelling
 * is the character as written, or its UTF-8 bytes percent-encoded with their hex digits in either case, and a space
 * also as form encoding's `+`. This covers what `encodeURIComponent`, form encoding and any encoder that escapes more
 * (unreserved letters and digits included) produce. Encoded spellings come first, so the longest one wins where a
 * written character begins its own encoding (`%` and `%25`) and no `25` is left behind. A lone surrogate has no UTF-8
 * encoding; it appears only as written.
 */
function characterSpellings(character: string): { pattern: string; length: number } {
	const spellings: string[] = [];
	let length = character.length;
	if (character.isWellFormed()) {
		const bytes = [...utf8.encode(character)];
		spellings.push(bytes.map(byteEscape).join(""));
		length = Math.max(length, 3 * bytes.length);
	}
	if (character === " ") spellings.push("\\+");
	spellings.push(literal(character));
	return { pattern: `(?:${spellings.join("|")})`, length };
}
/** A credential's spellings: one pattern matching any of them, character by character, and the longest one's length. */
interface Spellings {
	pattern: RegExp;
	reach: number;
}
const spellingsBySecret = new Map<string, Spellings>();
function secretSpellings(secret: string): Spellings {
	let found = spellingsBySecret.get(secret);
	if (!found) {
		const characters = [...secret].map(characterSpellings);
		found = {
			pattern: new RegExp(characters.map((character) => character.pattern).join(""), "g"),
			reach: characters.reduce((sum, character) => sum + character.length, 0),
		};
		spellingsBySecret.set(secret, found);
	}
	return found;
}

/**
 * `text` with `secret`'s spellings replaced near every `%` or `+`. Every spelling but the literal one holds one, and
 * none is longer than `reach`, so the pattern runs only on the stretches within that distance of one; elsewhere it
 * could find only the literal spelling, which the caller replaces afterwards. Long text with few escapes then costs no
 * more than a literal search, however much of it begins like the secret.
 */
function redactEncoded(text: string, secret: string): string {
	const { pattern, reach } = secretSpellings(secret);
	if (text.length <= reach) return text.replace(pattern, REDACTED);
	const marks = /[%+]/g;
	let redacted = "";
	let done = 0;
	for (let mark = marks.exec(text); mark; ) {
		const start = Math.max(done, mark.index - reach + 1);
		let end = mark.index + reach;
		// Stretches that overlap are searched as one.
		for (mark = marks.exec(text); mark && mark.index - reach + 1 < end; mark = marks.exec(text)) end = mark.index + reach;
		end = Math.min(end, text.length);
		redacted += text.slice(done, start) + text.slice(start, end).replace(pattern, REDACTED);
		done = end;
	}
	return done === 0 ? text : redacted + text.slice(done);
}

/**
 * `text` with each secret replaced as written and in every spelling URL encoding gives it, because Scrape.do and
 * Just One take their token in a query parameter and a response can echo the request URL: any of its characters
 * percent-encoded (each UTF-8 byte as `%XX`, hex digits in either case) and a space as `+`, whole or mixed. This reads
 * the text as it stands; provider text that may be JSON goes through `redactProviderText`, which decodes it first.
 */
export function redactText(text: string, secrets: readonly string[]): string {
	// Replacing a secret never adds a `%` or a `+`, so text without one can hold only literal spellings throughout.
	const escaped = /[%+]/.test(text);
	let clean = text;
	for (const secret of secrets) {
		// Encoded spellings first: the written one of a secret ending in `%` is a prefix of its encoded `%25` spelling.
		if (escaped) clean = redactEncoded(clean, secret);
		clean = clean.replaceAll(secret, REDACTED);
	}
	return clean;
}

/**
 * Every string inside plain objects and arrays, member names included, redacted; other values are returned as they
 * are. A value in which nothing changes is returned itself, so a caller can tell whether anything was redacted.
 */
export function redactValue(value: unknown, secrets: readonly string[]): unknown {
	if (!secrets.length) return value;
	if (typeof value === "string") return redactText(value, secrets);
	if (Array.isArray(value)) {
		const items = value.map((item) => redactValue(item, secrets));
		return items.some((item, index) => item !== value[index]) ? items : value;
	}
	if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
		const entries = Object.entries(value);
		const clean = entries.map(([name, item]) => [redactText(name, secrets), redactValue(item, secrets)] as const);
		return clean.some(([name, item], index) => name !== entries[index][0] || item !== entries[index][1]) ? Object.fromEntries(clean) : value;
	}
	return value;
}

export function redactRecord(record: object, secrets: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).map(([name, item]) => [redactText(name, secrets), redactValue(item, secrets)]),
	);
}

/** Provider text redacted (`redactProviderText`), and its decoded value when it is JSON. */
export type RedactedProviderText = { text: string; json: true; value: unknown } | { text: string; json: false };

/**
 * Provider text as it enters Dig, redacted by what it means. JSON is decoded first and its strings, member names
 * included, are redacted (`redactValue`): a JSON escape (`\/`, `\u0061`) can neither hide a credential nor be broken
 * by a replacement and turn valid JSON invalid. When nothing changes the text is returned byte-for-byte; otherwise it is
 * the redacted value serialized again. Any other text is redacted as it stands (`redactText`). Numbers are values, not
 * text, and are left as they are.
 */
export function redactProviderText(text: string, secrets: readonly string[], parse: (text: string) => unknown = JSON.parse): RedactedProviderText {
	let decoded: unknown;
	try {
		decoded = parse(text);
	} catch {
		return { text: redactText(text, secrets), json: false };
	}
	const value = redactValue(decoded, secrets);
	return { text: value === decoded ? text : JSON.stringify(value), json: true, value };
}
