import assert from "node:assert/strict";
import { test } from "node:test";
import { knownSecrets, redactText } from "./secrets.js";

test("a credential is redacted in the spellings a URL query gives it, as when a response echoes the request URL", () => {
	const secret = "sd+key/with@chars and space";
	const secrets = knownSecrets({ SCRAPE_DO_API_KEY: secret });
	const url = new URL("https://api.scrape.do/plugin/amazon/search");
	url.searchParams.set("token", secret);
	const echoed = `requested ${url.href}; also ${encodeURIComponent(secret)}; also ${secret}`;
	assert.equal(redactText(echoed, secrets), "requested https://api.scrape.do/plugin/amazon/search?token=[redacted]; also [redacted]; also [redacted]");
});
