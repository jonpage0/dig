/**
 * OAuth 1.0a user-context signing for the X API (RFC 5849, HMAC-SHA1), as X's "Creating a signature" and "Authorizing a
 * request" guides describe it: every query (and form body) parameter and the oauth_* parameters, each percent-encoded
 * per RFC 3986, sorted by encoded name and value and joined into the parameter string; the signature base string is
 * the method, the encoded base URL (without query) and the encoded parameter string, joined by "&"; the signing key is
 * the encoded consumer secret and the encoded token secret, joined by "&". The result goes in the Authorization header
 * only, never in the URL.
 */
import { createHmac, randomBytes } from "node:crypto"

/** The four keys.env names that sign requests as the user's own X account. */
export const USER_KEY_NAMES = ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"] as const

/** The X app's Consumer Key and Secret and an Access Token and Secret for the user's own account. */
export interface UserKeys {
	consumerKey: string
	consumerSecret: string
	accessToken: string
	accessTokenSecret: string
}

/** RFC 3986 percent-encoding: everything but letters, digits and `-._~`, as uppercase %XX of each UTF-8 byte. */
export const percent = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** Fixed nonce and timestamp, for checking a signature against a published example. */
export interface SigningOptions {
	nonce?: string
	timestamp?: number
	/** Form-encoded body parameters, which are signed as well (X's example signs a POST body). */
	body?: Record<string, string>
}

/** The signature base string of a request: method, encoded base URL and encoded sorted parameters. */
export function signatureBase(method: string, url: URL, oauth: Record<string, string>, body: Record<string, string> = {}): string {
	const pairs = [...url.searchParams, ...Object.entries(body), ...Object.entries(oauth)].map(([name, value]) => [percent(name), percent(value)])
	pairs.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
	const parameters = pairs.map(([name, value]) => `${name}=${value}`).join("&")
	return [method.toUpperCase(), percent(`${url.protocol}//${url.host}${url.pathname}`), percent(parameters)].join("&")
}

/** The request's `Authorization: OAuth …` header value, signed with the user's keys. */
export function oauthHeader(method: string, url: URL, keys: UserKeys, options: SigningOptions = {}): string {
	const oauth: Record<string, string> = {
		oauth_consumer_key: keys.consumerKey,
		oauth_nonce: options.nonce ?? randomBytes(32).toString("base64").replace(/\W/g, ""),
		oauth_signature_method: "HMAC-SHA1",
		oauth_timestamp: String(options.timestamp ?? Math.floor(Date.now() / 1000)),
		oauth_token: keys.accessToken,
		oauth_version: "1.0",
	}
	const key = `${percent(keys.consumerSecret)}&${percent(keys.accessTokenSecret)}`
	const signature = createHmac("sha1", key).update(signatureBase(method, url, oauth, options.body)).digest("base64")
	const header: Record<string, string> = { ...oauth, oauth_signature: signature }
	return `OAuth ${Object.keys(header).sort().map((name) => `${percent(name)}="${percent(header[name])}"`).join(", ")}`
}

/** A URL whose query is percent-encoded as it is signed (spaces as %20, never "+"), so X reads the values that were signed. */
export function signedQuery(url: URL): URL {
	const query = [...url.searchParams].map(([name, value]) => `${percent(name)}=${percent(value)}`).join("&")
	const signed = new URL(url)
	signed.search = query
	return signed
}
