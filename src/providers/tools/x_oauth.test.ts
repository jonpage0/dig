import { test } from "node:test";
import { expect } from "expect";
import { oauthHeader, percent, signatureBase, signedQuery } from "./x_oauth.js";

// The worked example in X's "Creating a signature" and "Authorizing a request" guides
// (docs.x.com/fundamentals/authentication/oauth-1-0a/…, read 2026-10-06). X publishes these keys and marks them
// invalid for real requests.
const keys = {
	consumerKey: "xvz1evFS4wEEPTGEFPHBog", // gitleaks:allow (X's published example key)
	consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", // gitleaks:allow
	accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", // gitleaks:allow
	accessTokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE", // gitleaks:allow
};
const url = new URL("https://api.x.com/1.1/statuses/update.json?include_entities=true");
const body = { status: "Hello Ladies + Gentlemen, a signed OAuth request!" };
const nonce = "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg";
const timestamp = 1318622958;

test("signs X's worked example exactly: its signature base string, then its signature in the Authorization header", () => {
	const oauth = { oauth_consumer_key: keys.consumerKey, oauth_nonce: nonce, oauth_signature_method: "HMAC-SHA1", oauth_timestamp: String(timestamp), oauth_token: keys.accessToken, oauth_version: "1.0" };
	expect(signatureBase("POST", url, oauth, body)).toBe(
		"POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
	);
	// X's guide gives the signature Ls93hJiZbQ3akF3HF3x1Bz8/zU4= for this base string and signing key.
	expect(oauthHeader("POST", url, keys, { nonce, timestamp, body })).toBe(
		'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"', // gitleaks:allow (X's published example)
	);
});

test("percent-encodes as RFC 3986 and X's examples require, never with + for a space", () => {
	expect(percent("Ladies + Gentlemen")).toBe("Ladies%20%2B%20Gentlemen");
	expect(percent("An encoded string!")).toBe("An%20encoded%20string%21");
	expect(percent("Dogs, Cats & Mice")).toBe("Dogs%2C%20Cats%20%26%20Mice");
	expect(percent("☃")).toBe("%E2%98%83");
	expect(percent("-._~*'()")).toBe("-._~%2A%27%28%29");
	expect(signedQuery(new URL("https://api.x.com/2/users/search?query=maker+one&user.fields=a,b")).search).toBe("?query=maker%20one&user.fields=a%2Cb");
});

test("every request gets a fresh nonce and the current time", () => {
	const first = oauthHeader("GET", new URL("https://api.x.com/2/users/me"), keys);
	const second = oauthHeader("GET", new URL("https://api.x.com/2/users/me"), keys);
	const field = (header: string, name: string) => header.match(new RegExp(`${name}="([^"]*)"`))?.[1];
	expect(field(first, "oauth_nonce")).not.toBe(field(second, "oauth_nonce"));
	expect(Math.abs(Number(field(first, "oauth_timestamp")) - Date.now() / 1000)).toBeLessThan(5);
});
