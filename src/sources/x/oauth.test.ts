import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { oauthHeader, percent, signatureBase, signedQuery } from "./oauth.ts";

// X's published OAuth 1.0a worked example keys (non-production documentation values).
const keys = {
  consumerKey: "xvz1evFS4wEEPTGEFPHBog", // gitleaks:allow
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", // gitleaks:allow
  accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", // gitleaks:allow
  accessTokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE", // gitleaks:allow
};
const url = new URL("https://api.x.com/1.1/statuses/update.json?include_entities=true");
const body = { status: "Hello Ladies + Gentlemen, a signed OAuth request!" };
const nonce = "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg";
const timestamp = 1318622958;

describe("x oauth 1.0a signing", () => {
  it("matches X's worked example signature base and Authorization header exactly", () => {
    const oauth = {
      oauth_consumer_key: keys.consumerKey,
      oauth_nonce: nonce,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: String(timestamp),
      oauth_token: keys.accessToken,
      oauth_version: "1.0",
    };
    assert.equal(
      signatureBase("POST", url, oauth, body),
      "POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
    );
    assert.equal(
      oauthHeader("POST", url, keys, { nonce, timestamp, body }),
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"', // gitleaks:allow
    );
  });

  it("percent-encodes per RFC 3986 without turning spaces into +", () => {
    assert.equal(percent("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
    assert.equal(percent("An encoded string!"), "An%20encoded%20string%21");
    assert.equal(percent("Dogs, Cats & Mice"), "Dogs%2C%20Cats%20%26%20Mice");
    assert.equal(percent("☃"), "%E2%98%83");
    assert.equal(percent("-._~*'()"), "-._~%2A%27%28%29");
    assert.equal(
      signedQuery(new URL("https://api.x.com/2/users/search?query=maker+one&user.fields=a,b")).search,
      "?query=maker%20one&user.fields=a%2Cb",
    );
  });

  it("generates a fresh nonce and current timestamp per call", () => {
    const first = oauthHeader("GET", new URL("https://api.x.com/2/users/me"), keys);
    const second = oauthHeader("GET", new URL("https://api.x.com/2/users/me"), keys);
    const field = (header: string, name: string) => header.match(new RegExp(`${name}="([^"]*)"`))?.[1];
    assert.notEqual(field(first, "oauth_nonce"), field(second, "oauth_nonce"));
    assert.ok(Math.abs(Number(field(first, "oauth_timestamp")) - Date.now() / 1000) < 5);
  });
});
