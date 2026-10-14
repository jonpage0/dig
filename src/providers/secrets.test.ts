import assert from "node:assert/strict";
import { test } from "node:test";
import { knownSecrets, redactText } from "./secrets.js";

/** Percent escapes written with lowercase hex digits, as some servers echo them. */
const lowercaseEscapes = (text: string) => text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());

test("a credential is redacted in the spellings a URL query gives it, as when a response echoes the request URL", () => {
	const secret = "sd+key/with@chars and space";
	const secrets = knownSecrets({ SCRAPE_DO_API_KEY: secret });
	const url = new URL("https://api.scrape.do/plugin/amazon/search");
	url.searchParams.set("token", secret);
	const echoed = `requested ${url.href}; also ${encodeURIComponent(secret)}; also ${secret}`;
	assert.equal(redactText(echoed, secrets), "requested https://api.scrape.do/plugin/amazon/search?token=[redacted]; also [redacted]; also [redacted]");
});

test("percent escapes with lowercase hex, form encoding and mixed spellings are redacted; the credential's own characters match exactly", () => {
	const secret = "Review/key+PRIVATE sample";
	const secrets = knownSecrets({ SCRAPE_DO_API_KEY: secret });
	const form = new URLSearchParams({ v: secret }).toString().slice(2);
	for (const spelling of [
		lowercaseEscapes(encodeURIComponent(secret)),
		lowercaseEscapes(form),
		"Review%2Fkey%2bPRIVATE+sample",
		"Review/key%2BPRIVATE%20sample",
	])
		assert.equal(redactText(`echo ${spelling} end`, secrets), "echo [redacted] end");
	assert.equal(redactText("review/key+private sample", secrets), "review/key+private sample");

	// A credential that itself contains an escape-like sequence keeps its own characters case-sensitive.
	const literal = "abc%2Fdefgh";
	const own = knownSecrets({ SCRAPE_DO_API_KEY: literal });
	assert.equal(
		redactText(`${literal} ${lowercaseEscapes(encodeURIComponent(literal))} abc%2fdefgh abc%252fdefgh`, own),
		"[redacted] [redacted] abc%2fdefgh abc%252fdefgh",
	);
});

test("a credential is redacted when any of its characters, unreserved ones included, is written as its UTF-8 bytes percent-encoded", () => {
	const secret = "Review/key+PRIVATE sample-é€";
	const secrets = knownSecrets({ SCRAPE_DO_API_KEY: secret });
	/** Every UTF-8 byte of `text` as `%xx`, in the given hex case. */
	const everyByte = (text: string, hex: (escape: string) => string) =>
		[...new TextEncoder().encode(text)].map((byte) => hex(`%${byte.toString(16).padStart(2, "0")}`)).join("");
	for (const spelling of [
		everyByte(secret, (escape) => escape),
		everyByte(secret, (escape) => escape.toUpperCase()),
		// Mixed freely: some characters as written, some escaped in either case, the space as form encoding's `+`.
		`R${everyByte("ev", (escape) => escape)}iew%2fkey+%50RIVATE+${everyByte("sample", (escape) => escape.toUpperCase())}-%C3%a9${everyByte("€", (escape) => escape)}`,
	])
		assert.equal(redactText(`echo ${spelling} end`, secrets), "echo [redacted] end");
	// Escapes decode to bytes, not letters of either case: a different-case spelling is a different value.
	for (const other of [everyByte("review/key+PRIVATE sample-é€", (escape) => escape), "Review/key+PRIVATE sample-É€", "plain text with % and + signs"])
		assert.equal(redactText(other, secrets), other);
});

test("a credential's `%` is matched encoded before written, so an encoded `%25` leaves no `25` behind", () => {
	const secrets = knownSecrets({ SCRAPE_DO_API_KEY: "TerminalPercent%" });
	assert.equal(redactText("a TerminalPercent%25 b", secrets), "a [redacted] b");
	assert.equal(redactText("a TerminalPercent% b", secrets), "a [redacted] b");
	const inner = knownSecrets({ SCRAPE_DO_API_KEY: "Inner%Percent" });
	assert.equal(redactText("a Inner%25Percent b Inner%Percent", inner), "a [redacted] b [redacted]");
});
