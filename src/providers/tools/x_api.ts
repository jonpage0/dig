/**
 * X's own API (X API v2, pay-per-use), read with the app's Bearer Token from X_BEARER_TOKEN: posts by link with their
 * thread, replies, quote posts and reposters; recent and full-archive search and counts; accounts by handle with their
 * recent posts and mentions; X News stories; trends, Spaces, Communities and List timelines. Read-only public data.
 *
 * Optional sign-in: with the app's Consumer Key and Secret and an Access Token and Secret for the user's own account
 * (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET), requests are signed as that account
 * (OAuth 1.0a, x_oauth.ts) for exactly four reads, which X serves only in user context: people search, Communities
 * search, the account's bookmarks and its liked posts. Every other read uses the app token.
 *
 * Parameter and field names follow X's API reference (OpenAPI 2.170 on docs.x.com, which X's own XDK 0.6 sends):
 * `post.fields`, `note_post`, `referenced_posts`, `edit_history_post_ids`, `repost_count` and `includes.posts`. X's
 * data dictionary still shows the earlier spellings (`tweet.fields`, `note_tweet`, `referenced_tweets`,
 * `retweet_count`, `includes.tweets`), so responses are read in either.
 *
 * X reports no per-call charge, so these tools declare no billing policy and every receipt records the cost as
 * unknown. Requests are never retried and never follow a redirect, and full-archive requests share one pacing gate in
 * the server process. Every response's problems are classified where it arrives (xGet), keeping problems that name a
 * missing, protected or suspended resource apart from the rest. A lookup by id or handle takes a requested item named
 * that way as the item's answer; every other read treats no data beside any problem as a failed read. Other problems
 * fail a response without data and make a response with data partial. When x_post names one post and the X API cannot
 * serve it (no token, or an authentication, payment, rate-limit, server or network failure that names no resource),
 * that post is read through TikHub's fetch_tweet_detail instead and labelled "via TikHub".
 * TikHub stands in where X's API cannot: x_post's single-post fallback, Communities search without sign-in, and a
 * Community's posts (x_community), each labelled "via TikHub".
 *
 * Environment variables:
 *   - X_BEARER_TOKEN (X API app-only Bearer Token)
 *   - X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET (optional; sign-in as the user)
 *   - TIKHUB_API_KEY (optional; the TikHub reads above)
 *   - TIKHUB_BASE_URL (optional; defaults to https://api.tikhub.io)
 */
import { abortableDelay, keptText } from "../http.js"
import { failed, outcome, type OutcomeStatus, type ToolOutcome } from "../outcome.js"
import { knownSecrets, redactValue } from "../secrets.js"
import type { ToolContext, ToolSpec } from "../types.js"
import { oauthHeader, signedQuery, USER_KEY_NAMES, type UserKeys } from "./x_oauth.js"

/** Cancellation plus the raw-response capture of the tool call. */
type CallContext = Pick<ToolContext, "abort" | "keep">
type Json = Record<string, unknown>

const API_BASE = "https://api.x.com"
const KEY = "X_BEARER_TOKEN"
const TIMEOUT_MS = 60_000
/** The model-facing text is cut here; the complete response stays in the call's retained original. */
const OUTPUT_LIMIT = 60_000
const MAX_ERROR_CHARS = 300
/** Recent search covers the last seven days; an older conversation needs full-archive search. */
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Full-archive search allows one request per second; the slack keeps consecutive requests under it. */
const ARCHIVE_INTERVAL_MS = 1_100
/**
 * Full-archive search and counts default `start_time` to 30 days ago. The archive starts in March 2006, so an archive
 * read without its own start time sends this one, and the archive means the whole archive.
 */
const ARCHIVE_START = "2006-03-21T00:00:00Z"
/**
 * Ids from before X's snowflake ids (November 2010) were sequential, so their snowflake decoding lands in the first
 * day after the snowflake epoch. A post whose decoded time falls there gets the archive's own start instead.
 */
const SNOWFLAKE_FIRST_DAY_MS = 24 * 60 * 60 * 1000
/**
 * Search pages hold 10 to 100 posts here: recent search allows at most 100, and full-archive search returns at most 100
 * per page when context annotations are requested.
 */
const SEARCH_PAGE = { min: 10, max: 100 }
/** Enough pages for the largest limit, so a run of empty pages that keep a next token still ends. */
const MAX_SEARCH_PAGES = 50
/** Count pages followed before reporting that more buckets remain. */
const MAX_COUNT_PAGES = 10
/** Minimum page sizes X accepts: a user's posts and mentions 5, quote posts and Communities 10. */
const TIMELINE_MIN = 5
const QUOTES_MIN = 10
const COMMUNITIES_MIN = 10
/** A conversation read (thread) takes one full page. */
const THREAD_PAGE = 100
const TRENDS_MAX = 50
/** x_search_posts' largest limit (its schema's maximum), which a conversation read's continuation asks for. */
const SEARCH_LIMIT_MAX = 500
/** Defaults where the approved arguments leave the count open. */
const SEARCH_LIMIT = 25
const EXPLORE_LIMIT = 25
const TRENDS_LIMIT = 20
const PEOPLE_SEARCH_RESULTS = 25
const WORLDWIDE_WOEID = 1

// Fields for public app-only reads: each reference list without the user-context metrics (non_public, organic,
// promoted), the authenticated user's relationship fields, the Community Notes program fields, the promoted-only
// `scopes` and the deprecated `source`. User fields also leave out `parody`, `subscriber_count` and
// `verified_followers_count`, which X refuses an app-only token on account lookups (not-authorized-for-field).
const POST_FIELDS = [
	"article", "article_title", "attachments", "card_uri", "community_id", "context_annotations", "conversation_id",
	"created_at", "display_text_range", "edit_controls", "entities", "geo", "id", "lang", "media_metadata", "note_post",
	"paid_partnership", "possibly_sensitive", "public_metrics", "reply_settings", "text", "withheld",
]
const POST_EXPANSIONS = [
	"article.cover_media", "article.media_entities", "attachments.media_keys", "attachments.media_source_tweet",
	"attachments.poll_ids", "author_id", "edit_history_post_ids", "geo.place_id", "in_reply_to_user_id", "referenced_posts",
]
const USER_FIELDS = [
	"created_at", "description", "entities", "id", "is_identity_verified", "location", "name", "profile_banner_url",
	"profile_image_url", "protected", "public_metrics", "url", "username", "verified", "verified_type", "withheld",
]
const USER_EXPANSIONS = ["affiliation", "most_recent_post_id", "pinned_post_id"]
const MEDIA_FIELDS = ["alt_text", "duration_ms", "height", "media_key", "preview_image_url", "public_metrics", "type", "url", "variants", "width"]
const POLL_FIELDS = ["duration_minutes", "end_datetime", "id", "options", "voting_status"]
const PLACE_FIELDS = ["contained_within", "country", "country_code", "full_name", "geo", "id", "name", "place_type"]
const SPACE_FIELDS = ["created_at", "ended_at", "id", "is_ticketed", "lang", "participant_count", "scheduled_start", "started_at", "state", "subscriber_count", "title", "updated_at"]
const SPACE_EXPANSIONS = ["creator_id", "host_ids", "invited_user_ids", "speaker_ids", "topic_ids"]
const TOPIC_FIELDS = ["description", "id", "name"]
const COMMUNITY_FIELDS = ["access", "created_at", "description", "id", "join_policy", "member_count", "name"]
const NEWS_FIELDS = ["category", "cluster_posts_results", "contexts", "disclaimer", "hook", "id", "keywords", "name", "summary", "updated_at"]
const TREND_FIELDS = ["trend_name", "tweet_count"]

const POST_PARAMS = {
	"post.fields": POST_FIELDS.join(","),
	expansions: POST_EXPANSIONS.join(","),
	"user.fields": USER_FIELDS.join(","),
	"media.fields": MEDIA_FIELDS.join(","),
	"poll.fields": POLL_FIELDS.join(","),
	"place.fields": PLACE_FIELDS.join(","),
}
const USER_PARAMS = {
	"user.fields": USER_FIELDS.join(","),
	expansions: USER_EXPANSIONS.join(","),
	"post.fields": POST_FIELDS.join(","),
}

const TRUNCATION_NOTE = "The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file."
const ZERO_NOTE = "List lines leave out counts of zero."

// ---------------------------------------------------------------------------
// Untrusted JSON accessors
// ---------------------------------------------------------------------------

const rec = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null)
const recs = (value: unknown): Json[] => (Array.isArray(value) ? value.flatMap((item): Json[] => { const record = rec(item); return record ? [record] : [] }) : [])
/** A nonblank string exactly as X sent it. */
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null)
const num = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
	return null
}
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const count = (value: number, one: string, many: string) => `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const bearerToken = () => process.env[KEY]?.trim() || null
const missingKey = `${KEY} is not set in Dig's keys.env. The user creates an app at console.x.com and adds its Bearer Token outside the chat (Dig Settings → Edit keys.env), or copies one Codex's environment already has (Dig Settings → X → Use existing key).`
/** The four sign-in keys from keys.env, or the names that are missing. */
function userKeys(): UserKeys | { missing: string[] } {
	const [consumerKey, consumerSecret, accessToken, accessTokenSecret] = USER_KEY_NAMES.map((name) => process.env[name]?.trim() ?? "")
	const missing = USER_KEY_NAMES.filter((name) => !process.env[name]?.trim())
	return missing.length ? { missing } : { consumerKey, consumerSecret, accessToken, accessTokenSecret }
}
const andList = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)
/** Why a read that X serves only to a signed-in account cannot run, naming the missing sign-in keys. */
const missingUserKeys = (what: string, missing: string[]) =>
	`${what} needs X sign-in, and ${andList(missing)} ${missing.length === 1 ? "is" : "are"} not set in Dig's keys.env. Sign-in takes four keys from the X app's Keys and tokens page at console.x.com: its Consumer Key and Secret (X_CONSUMER_KEY, X_CONSUMER_SECRET) and an Access Token and Secret for the user's own account (X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET). The user adds them outside the chat (Dig Settings → Edit keys.env); signed-in reads act as that account.`

/** X ids are snowflakes: milliseconds since this epoch, shifted left 22 bits. */
const SNOWFLAKE_EPOCH = 1288834974657n
function snowflakeTime(id: string): number | null {
	try {
		return Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH)
	} catch {
		return null
	}
}
const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`
function stamp(createdAt: unknown, id: string | null): string | null {
	const at = str(createdAt)
	if (at && !Number.isNaN(Date.parse(at))) return utc(new Date(at).toISOString())
	const ms = id ? snowflakeTime(id) : null
	return ms === null ? null : utc(new Date(ms).toISOString())
}

/** The text with the truncation note when it passes the output limit. */
function bounded(text: string): string {
	return text.length > OUTPUT_LIMIT
		? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${text.length} characters. ${TRUNCATION_NOTE}]`
		: text
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Why a request failed. The first five are the X failures x_post's single-post fallback answers. */
type FailureKind = "auth" | "payment" | "rate" | "server" | "network" | "redirect" | "request"
const FALLBACK_KINDS: ReadonlySet<FailureKind> = new Set(["auth", "payment", "rate", "server", "network"])
/**
 * A failed request. `resource` holds every problem in the body that names a missing, protected or suspended resource,
 * whatever else is beside it; `problem` names the body's other problems.
 */
type Failure = { ok: false; kind: FailureKind; status: number | null; message: string; problem: string | null; resource: Json[] }
/**
 * A 2xx answer. `problem` names the problems X reported beside the data that name no resource (they make the call
 * partial); `resources` holds the problems naming a missing, protected or suspended resource, for the caller to place.
 */
type Answer = { ok: true; status: number; body: Json; problem: string | null; resources: Json[] }
type Params = Record<string, string | number | undefined>
/** How a request authenticates: the app's Bearer Token, or the signed-in account's keys (OAuth 1.0a). */
type Auth = string | UserKeys
/** What the refusal of a request names as the credential X refused. */
const credentialOf = (auth: Auth) => (typeof auth === "string" ? KEY : `the X sign-in keys (${USER_KEY_NAMES.join(", ")})`)

/** X's problem (`title`, `detail`) or legacy (`errors[].message`) wording, bounded. */
function problemText(body: Json | null): string | null {
	if (!body) return null
	const problem = [...new Set([str(body.title), str(body.detail)].filter(Boolean))].join(": ")
	const legacy = recs(body.errors).map((error) => str(error.message) ?? [str(error.title), str(error.detail)].filter(Boolean).join(": ")).filter(Boolean).join("; ")
	const text = problem || legacy || str(body.reason) || str(body.error)
	return text ? text.slice(0, MAX_ERROR_CHARS) : null
}

/** Problem types that say a named post, account or other resource is missing, protected or unavailable (suspended). */
const RESOURCE_PROBLEMS = new Set(["resource-not-found", "not-authorized-for-resource", "resource-unavailable"])
/** `resource-not-found` from `https://api.x.com/2/problems/resource-not-found` (or X's older api.twitter.com spelling). */
const problemType = (problem: Json) => str(problem.type)?.match(/\/problems\/([a-z-]+)$/)?.[1] ?? null
/**
 * A problem about one named resource rather than the request: a resource type above, or an untyped problem naming its
 * resource as X's lookup guide shows, unless it says 500 or more (then it is an operational failure).
 */
function isResourceProblem(problem: Json): boolean {
	const type = problemType(problem)
	if (type) return RESOURCE_PROBLEMS.has(type)
	const status = num(problem.status)
	return Boolean(str(problem.resource_type) && (str(problem.resource_id) ?? str(problem.value))) && !(status !== null && status >= 500)
}
/** Whether a problem names this id or handle (`resource_id`, or `value` for a handle). */
const namesResource = (problem: Json, id: string) => [problem.resource_id, problem.value].some((value) => String(value ?? "").toLowerCase() === id.toLowerCase())
/** A failed response's problems: its `errors`, or the body itself when it is one problem. */
function problemsOf(body: Json | null): Json[] {
	if (!body) return []
	const listed = recs(body.errors)
	return listed.length ? listed : str(body.type) || str(body.title) || str(body.detail) ? [body] : []
}
const problemList = (problems: Json[]) => problems.map((problem) => problemText(problem) ?? problemType(problem) ?? "an unnamed problem").join("; ")
/** How request-level problems fail a request, read like the HTTP status each stands for. */
function problemKind(problems: Json[]): FailureKind {
	for (const problem of problems) {
		const type = problemType(problem)
		const status = num(problem.status)
		if (type === "internal-error" || (status !== null && status >= 500)) return "server"
		if (type === "rate-limit-exceeded" || status === 429) return "rate"
		if (type === "usage-capped" || status === 402) return "payment"
		if (type === "client-forbidden" || status === 401 || status === 403) return "auth"
	}
	return "request"
}

function resetTime(response: Response): string | null {
	const seconds = num(response.headers.get("x-rate-limit-reset"))
	return seconds === null ? null : new Date(seconds * 1000).toISOString()
}

function statusFailure(response: Response, body: Json | null, label: string, auth: Auth): Pick<Failure, "kind" | "status" | "message"> {
	const status = response.status
	const said = problemText(body)
	const detail = said ? `: ${said}` : ""
	if (status >= 300 && status < 400) {
		const location = response.headers.get("location")
		return { kind: "redirect", status, message: `X API ${label} answered HTTP ${status}${location ? ` with a redirect to ${location}` : ""}. Dig does not follow redirects for X API requests.` }
	}
	if (status === 429) {
		const reset = resetTime(response)
		return { kind: "rate", status, message: `X API rate limit reached (HTTP 429) for ${label}${detail}. ${reset ? `The limit resets at ${reset} (x-rate-limit-reset).` : "X did not say when the limit resets."} Dig does not wait or retry.` }
	}
	if (status === 401 || status === 403) return { kind: "auth", status, message: `X API refused ${label} with ${credentialOf(auth)} (HTTP ${status})${detail}` }
	if (status === 402) return { kind: "payment", status, message: `X API ${label} needs credits in the X developer account (HTTP 402)${detail}` }
	if (status >= 500) return { kind: "server", status, message: `X API ${label} failed with HTTP ${status}${detail}` }
	return { kind: "request", status, message: `X API ${label} returned HTTP ${status}${detail}` }
}

/** A non-2xx answer, its resource problems kept apart from the rest: a protected post's 403 answers for that post as well as refusing. */
function failure(response: Response, body: Json | null, label: string, auth: Auth): Failure {
	const problems = problemsOf(body)
	const others = problems.filter((problem) => !isResourceProblem(problem))
	return { ok: false, ...statusFailure(response, body, label, auth), problem: others.length ? problemList(others) : null, resource: problems.filter(isResourceProblem) }
}

/**
 * One GET against the X API, never retried and never redirected, with the app's Bearer Token or, for the four reads X
 * serves only to a signed-in account, an OAuth 1.0a signature over the request (its query percent-encoded as signed).
 * The response body (or transport error) is kept for the call's raw file; the parsed body is redacted before anything
 * formats it, so an echoed credential cannot survive escaping or truncation. A 2xx body's `errors` are classified here:
 * problems naming a missing, protected or suspended resource go to the caller as `resources`; any other problem fails
 * the request when X returned no data, and otherwise travels with the data as `problem`.
 */
async function xGet(path: string, params: Params, label: string, ctx: CallContext, auth: Auth): Promise<Answer | Failure> {
	let url = new URL(path, API_BASE)
	for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(name, String(value))
	if (typeof auth !== "string") url = signedQuery(url)
	ctx.abort.throwIfAborted()
	let response: Response
	let text: string
	try {
		response = await fetch(url, {
			headers: { authorization: typeof auth === "string" ? `Bearer ${auth}` : oauthHeader("GET", url, auth), accept: "application/json" },
			redirect: "manual",
			signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(TIMEOUT_MS)]),
		})
	} catch (error) {
		ctx.keep(label, "error", message(error))
		ctx.abort.throwIfAborted()
		return { ok: false, kind: "network", status: null, message: `X API ${label} could not be reached: ${message(error)}`, problem: null, resource: [] }
	}
	try {
		text = await keptText(response, ctx.keep, label)
	} catch (error) {
		ctx.abort.throwIfAborted()
		return { ok: false, kind: "network", status: response.status, message: `X API ${label} broke off while answering: ${message(error)}`, problem: null, resource: [] }
	}
	ctx.abort.throwIfAborted()
	let parsed: unknown = null
	try {
		parsed = text ? JSON.parse(text) : null
	} catch {}
	const body = rec(redactValue(parsed, knownSecrets()))
	if (response.status < 200 || response.status >= 300) return failure(response, body, label, auth)
	if (!body) return { ok: false, kind: "server", status: response.status, message: `X API ${label} answered HTTP ${response.status} without a JSON object`, problem: null, resource: [] }
	const errors = recs(body.errors)
	const resources = errors.filter(isResourceProblem)
	const others = errors.filter((problem) => !isResourceProblem(problem))
	if (!others.length) return { ok: true, status: response.status, body, problem: null, resources }
	const said = `X API ${label} reported ${problemList(others)}`
	// Problems without data are a failed request, never an empty result.
	if (!dataItems(body).length) return { ok: false, kind: problemKind(others), status: response.status, message: `${said}, and returned no data`, problem: problemList(others), resource: resources }
	return { ok: true, status: response.status, body, problem: said, resources }
}

/**
 * A read other than a lookup by id or handle: a search or count page, quote posts, reposters, an account's posts or
 * mentions, people or News search, trends, Spaces, Communities. No data beside any problem, even one naming a resource,
 * fails the read; it is never zero results. With data, problems naming a resource are about expansions (a referenced
 * post, an author) and are left out.
 */
async function xRead(path: string, params: Params, label: string, ctx: CallContext, auth: Auth): Promise<Answer | Failure> {
	const answer = await xGet(path, params, label, ctx, auth)
	if (!answer.ok || !answer.resources.length || dataItems(answer.body).length) return answer
	return { ok: false, kind: "request", status: answer.status, message: `X API ${label} reported ${problemList(answer.resources)}, and returned no data`, problem: null, resource: answer.resources }
}

/** The signed-in account: its id, which the bookmark and like endpoints take, and its handle. */
type SignedIn = { ok: true; id: string; handle: string | null }
// One /2/users/me per access token in this server process; a lookup in flight is shared, a failed one is not kept.
const signedInAccounts = new Map<string, Promise<SignedIn | Failure>>()
/** Who the sign-in keys act as, asked of X once per access token; the response is kept with the call that asked. */
async function signedInAccount(keys: UserKeys, ctx: CallContext): Promise<SignedIn | Failure> {
	const known = signedInAccounts.get(keys.accessToken)
	if (known) {
		const answer = await known.catch(() => null)
		if (answer?.ok) return answer
	}
	const lookup = (async (): Promise<SignedIn | Failure> => {
		const answer = await xGet("/2/users/me", { "user.fields": "id,name,username" }, "signed-in account", ctx, keys)
		if (!answer.ok) return answer
		const id = str(rec(answer.body.data)?.id)
		if (!id) return { ok: false, kind: "server", status: answer.status, message: "X API signed-in account answered without the account's id", problem: null, resource: [] }
		return { ok: true, id, handle: str(rec(answer.body.data)?.username) }
	})()
	signedInAccounts.set(keys.accessToken, lookup)
	const answer = await lookup.catch((error: unknown) => {
		signedInAccounts.delete(keys.accessToken)
		throw error
	})
	if (!answer.ok) signedInAccounts.delete(keys.accessToken)
	return answer
}

// One gate for every full-archive request in this server process: X allows one per second per app, across calls.
let archiveQueue: Promise<void> = Promise.resolve()
let lastArchiveRequest = 0
/** Waits for this process's next full-archive request slot, a little over a second after the previous one. */
function archiveTurn(signal: AbortSignal): Promise<void> {
	const turn = archiveQueue.then(async () => {
		const wait = lastArchiveRequest + ARCHIVE_INTERVAL_MS - Date.now()
		if (wait > 0) await abortableDelay(wait, signal)
		lastArchiveRequest = Date.now()
	})
	archiveQueue = turn.catch(() => {})
	return turn
}

/** An ISO time to the second, as X's start_time and end_time take it. */
const isoSecond = (ms: number) => `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`

/** A start time at or before a conversation's root post: its snowflake time to the second, or the archive's start for a pre-snowflake id. */
function conversationStart(root: string): string {
	const ms = snowflakeTime(root)
	if (ms === null || ms < Number(SNOWFLAKE_EPOCH) + SNOWFLAKE_FIRST_DAY_MS) return ARCHIVE_START
	return isoSecond(ms)
}

// ---------------------------------------------------------------------------
// Response objects
// ---------------------------------------------------------------------------

/** Expanded objects from every response of one call, by id (media by media key). */
interface Includes {
	users: Map<string, Json>
	posts: Map<string, Json>
	media: Map<string, Json>
	polls: Map<string, Json>
	places: Map<string, Json>
	topics: Map<string, Json>
}
const newIncludes = (): Includes => ({ users: new Map(), posts: new Map(), media: new Map(), polls: new Map(), places: new Map(), topics: new Map() })
function addIncludes(into: Includes, body: Json): void {
	const inc = rec(body.includes)
	if (!inc) return
	const put = (map: Map<string, Json>, items: Json[], key: string) => {
		for (const item of items) {
			const id = str(item[key])
			if (id) map.set(id, item)
		}
	}
	put(into.users, recs(inc.users), "id")
	put(into.posts, [...recs(inc.posts), ...recs(inc.tweets)], "id")
	put(into.media, recs(inc.media), "media_key")
	put(into.polls, recs(inc.polls), "id")
	put(into.places, recs(inc.places), "id")
	put(into.topics, recs(inc.topics), "id")
}
/** `data` as a list: list endpoints send an array, lookups by one id an object. */
const dataItems = (body: Json): Json[] => {
	const single = rec(body.data)
	return Array.isArray(body.data) ? recs(body.data) : single ? [single] : []
}
const nextToken = (body: Json) => str(rec(body.meta)?.next_token)

/** The full text: a long post's note text, else its text, verbatim. */
const fullText = (post: Json) => str(rec(post.note_post)?.text) ?? str(rec(post.note_tweet)?.text) ?? str(post.text) ?? ""
const textEntities = (post: Json) => rec(rec(post.note_post)?.entities) ?? rec(rec(post.note_tweet)?.entities) ?? rec(post.entities)
const references = (post: Json) => recs(post.referenced_posts ?? post.referenced_tweets)
const editHistory = (post: Json) => strings(post.edit_history_post_ids ?? post.edit_history_tweet_ids)
const authorOf = (post: Json, inc: Includes) => inc.users.get(String(post.author_id ?? "")) ?? null
const handleOf = (user: Json | null) => str(user?.username)
const permalink = (id: string, handle: string | null) => `https://x.com/${handle ?? "i"}/status/${id}`
const postLink = (post: Json, inc: Includes) => permalink(String(post.id), handleOf(authorOf(post, inc)))

function verifiedText(user: Json): string | null {
	if (user.verified !== true) return null
	const kind = str(user.verified_type)
	return kind && kind !== "none" ? `verified ${kind}` : "verified"
}

/** `@pvncher (eric provencher, 44,680 followers, verified blue)`; the author id when X expanded no user. */
function byline(user: Json | null, authorId?: unknown): string {
	if (!user) return authorId ? `author ${String(authorId)}` : "unknown author"
	const followers = num(rec(user.public_metrics)?.followers_count)
	const about = [str(user.name), followers === null ? null : count(followers, "follower", "followers"), verifiedText(user), user.protected === true ? "protected" : null].filter((part): part is string => part !== null)
	const who = handleOf(user) ? `@${handleOf(user)}` : `user ${String(user.id ?? "")}`
	return about.length ? `${who} (${about.join(", ")})` : who
}

/** Public counts; `skipZero` leaves reported zeros out for list lines. */
function metrics(post: Json, skipZero = false): string[] {
	const m = rec(post.public_metrics)
	if (!m) return []
	const parts: string[] = []
	const add = (value: unknown, one: string, many: string) => {
		const n = num(value)
		if (n !== null && !(skipZero && n === 0)) parts.push(count(n, one, many))
	}
	add(m.reply_count, "reply", "replies")
	add(m.repost_count ?? m.retweet_count, "repost", "reposts")
	add(m.quote_count, "quote", "quotes")
	add(m.like_count, "like", "likes")
	add(m.bookmark_count, "bookmark", "bookmarks")
	add(m.impression_count, "impression", "impressions")
	return parts
}

function mediaLines(post: Json, inc: Includes): string[] {
	return strings(rec(post.attachments)?.media_keys).map((key) => {
		const media = inc.media.get(key)
		if (!media) return `Media: ${key} (not expanded by X)`
		const mp4 = recs(media.variants)
			.filter((variant) => variant.content_type === "video/mp4" && str(variant.url))
			.sort((a, b) => (num(b.bit_rate) ?? 0) - (num(a.bit_rate) ?? 0))[0]
		const url = str(mp4?.url) ?? str(media.url) ?? str(media.preview_image_url)
		const duration = num(media.duration_ms)
		const views = num(rec(media.public_metrics)?.view_count)
		const notes = [
			duration === null ? null : `${(duration / 1000).toFixed(1)} s`,
			views === null ? null : count(views, "view", "views"),
			mp4 && str(media.preview_image_url) ? `preview ${media.preview_image_url}` : null,
			str(media.alt_text) ? `alt text: ${media.alt_text}` : null,
		].filter(Boolean)
		return `Media: ${str(media.type) ?? "media"} ${url ?? "(no URL returned)"}${notes.length ? ` (${notes.join("; ")})` : ""}`
	})
}

function pollLines(post: Json, inc: Includes): string[] {
	return strings(rec(post.attachments)?.poll_ids).flatMap((id) => {
		const poll = inc.polls.get(id)
		if (!poll) return [`Poll: ${id} (not expanded by X)`]
		const end = str(poll.end_datetime)
		const about = [str(poll.voting_status), end ? `${poll.voting_status === "closed" ? "ended" : "ends"} ${stamp(end, null)}` : null, num(poll.duration_minutes) === null ? null : `${poll.duration_minutes} minutes`].filter(Boolean)
		const options = recs(poll.options).map((option) => `${option.position ?? "?"}. ${String(option.label ?? "")} — ${count(num(option.votes) ?? 0, "vote", "votes")}`)
		return [`Poll${about.length ? ` (${about.join(", ")})` : ""}: ${options.join("; ")}`]
	})
}

function placeLines(post: Json, inc: Includes): string[] {
	const geo = rec(post.geo)
	if (!geo) return []
	const lines: string[] = []
	const place = inc.places.get(String(geo.place_id ?? ""))
	if (place) lines.push(`Place: ${str(place.full_name) ?? str(place.name) ?? place.id} (${[str(place.place_type), str(place.country)].filter(Boolean).join(", ")})`)
	const point = rec(geo.coordinates)
	if (point && Array.isArray(point.coordinates)) lines.push(`Point (longitude, latitude): ${point.coordinates.join(", ")}`)
	return lines
}

/** Links in the text, each as the address it stands for, with its title when X has one; media links are left out. */
function linkLines(post: Json): string[] {
	return recs(textEntities(post)?.urls)
		.filter((link) => !str(link.media_key))
		.flatMap((link) => {
			const address = str(link.unwound_url) ?? str(link.expanded_url) ?? str(link.url)
			return address ? [`Link: ${address}${str(link.title) ? ` — ${link.title}` : ""}`] : []
		})
}

function contextLine(post: Json): string | null {
	const pairs = new Set(recs(post.context_annotations).map((annotation) => `${str(rec(annotation.domain)?.name)?.trim() ?? "?"}: ${str(rec(annotation.entity)?.name)?.trim() ?? "?"}`))
	return pairs.size ? `Context annotations: ${[...pairs].join("; ")}` : null
}

/** An X Article's text fields, whatever X names them; nested media and entities stay in the retained original. */
function articleLines(post: Json): string[] {
	const article = rec(post.article)
	const fields = Object.entries(article ?? {}).flatMap(([key, value]) => (str(value) ? [`${key}: ${value}`] : []))
	const title = str(article?.title) ? null : (str(post.article_title) ?? str(rec(post.article_title)?.title))
	if (!fields.length && !title) return []
	return ["X Article:", ...(title ? [`title: ${title}`] : []), ...fields]
}

const quoteBlock = (lines: string[]) => lines.map((line) => `> ${line}`)

/** A repost's reference type: `retweeted` in X's reference, `reposted` as X sends it. */
const REPOST_TYPES = new Set(["retweeted", "reposted"])
const referenceVerb = (type: unknown) =>
	type === "quoted" ? "Quoting" : REPOST_TYPES.has(String(type)) ? "Reposting" : type === "replied_to" ? "Replying to" : "Referencing"

/**
 * A referenced post (the post replied to, quoted or reposted), from the expansions when X sent it. A repost's own text
 * is X's shortened "RT @handle: …" copy, so even a list line carries the original's full text.
 */
function referenceLines(post: Json, inc: Includes, full: boolean): string[] {
	const lines: string[] = []
	for (const reference of references(post)) {
		const id = str(reference.id)
		if (!id) continue
		const target = inc.posts.get(id)
		const author = target ? authorOf(target, inc) : reference.type === "replied_to" ? inc.users.get(String(post.in_reply_to_user_id ?? "")) ?? null : null
		const verb = referenceVerb(reference.type)
		const link = permalink(id, handleOf(author))
		const original = target ? quoteBlock([...fullText(target).split("\n"), ...mediaLines(target, inc), ...linkLines(target)]) : []
		if (!full || !target) {
			lines.push(`${verb} ${author ? `@${handleOf(author)}` : "a post"}: ${link}${target || !full ? "" : " (not expanded by X)"}`)
			if (verb === "Reposting") lines.push(...original)
			continue
		}
		lines.push("", `${verb} ${byline(author, target.author_id)} · ${[stamp(target.created_at, id), ...metrics(target)].filter(Boolean).join(" · ")}`, link, ...original)
	}
	return lines
}

/** Earlier versions X expanded from the edit history, oldest first. */
function editLines(post: Json, inc: Includes): string[] {
	const versions = editHistory(post)
	if (versions.length < 2) return []
	const earlier = versions.flatMap((id) => {
		const version = id === post.id ? undefined : inc.posts.get(id)
		return version ? [{ id, version }] : []
	})
	return [
		`Edit history: ${versions.length} versions (${versions.join(", ")}); this is ${post.id}.`,
		...earlier.flatMap(({ id, version }) => [`Earlier version ${id}:`, ...quoteBlock(fullText(version).split("\n"))]),
	]
}

/** A Community's page, which x_community reads by link or id. */
const communityLink = (id: string) => `https://x.com/i/communities/${id}`
const communityLines = (post: Json) => (str(post.community_id) ? [`Community: ${communityLink(String(post.community_id))}`] : [])

/** A requested post in full: who, when, every public count, the text verbatim and everything X returned around it. */
function formatPost(post: Json, inc: Includes): string[] {
	const id = String(post.id)
	const author = authorOf(post, inc)
	const facts = [
		stamp(post.created_at, id),
		str(post.lang) ? `language ${post.lang}` : null,
		...metrics(post),
	].filter(Boolean)
	const flags = [
		post.possibly_sensitive === true ? "possibly sensitive" : null,
		post.paid_partnership === true ? "disclosed paid partnership" : null,
		str(post.reply_settings) && post.reply_settings !== "everyone" ? `replies limited to ${post.reply_settings}` : null,
		strings(rec(post.withheld)?.country_codes).length ? `withheld in ${strings(rec(post.withheld)?.country_codes).join(", ")}` : null,
	].filter(Boolean)
	const context = contextLine(post)
	return [
		`X post by ${byline(author, post.author_id)}`,
		permalink(id, handleOf(author)),
		facts.join(" · "),
		...(flags.length ? [`Flags: ${flags.join("; ")}`] : []),
		...editLines(post, inc),
		...communityLines(post),
		"",
		fullText(post) || "(no text)",
		...withGap([...articleLines(post), ...mediaLines(post, inc), ...pollLines(post, inc), ...placeLines(post, inc), ...linkLines(post), ...(context ? [context] : [])]),
		...referenceLines(post, inc, true),
	]
}

const withGap = (lines: string[]) => (lines.length ? ["", ...lines] : [])

/** A post as a list item: one line of who, when and nonzero counts, then its text, media, links and references. */
function formatListPost(post: Json, inc: Includes): string[] {
	const id = String(post.id)
	const author = authorOf(post, inc)
	const head = [byline(author, post.author_id), stamp(post.created_at, id), ...metrics(post, true), postLink(post, inc)].filter(Boolean).join(" · ")
	const body = [...(fullText(post) || "(no text)").split("\n"), ...communityLines(post), ...mediaLines(post, inc), ...pollLines(post, inc), ...linkLines(post), ...referenceLines(post, inc, false)]
	return [`- ${head}`, ...body.map((line) => `  ${line}`)]
}

function userUrl(user: Json): string | null {
	const expanded = recs(rec(rec(user.entities)?.url)?.urls).map((link) => str(link.expanded_url)).find(Boolean)
	return expanded ?? str(user.url)
}

/** An account's profile: name, handle, bio, location, link, join date, verification and public counts. */
function formatUser(user: Json): string[] {
	const handle = handleOf(user)
	const m = rec(user.public_metrics)
	const flags = [verifiedText(user), user.is_identity_verified === true ? "ID verified" : null, user.protected === true ? "protected" : null].filter(Boolean)
	const counts: string[] = []
	const add = (value: unknown, one: string, many: string) => {
		const n = num(value)
		if (n !== null) counts.push(count(n, one, many))
	}
	add(m?.followers_count, "follower", "followers")
	add(m?.following_count, "following", "following")
	add(m?.post_count ?? m?.tweet_count, "post", "posts")
	add(m?.listed_count, "list", "lists")
	add(m?.like_count, "like given", "likes given")
	add(m?.media_count, "media item", "media items")
	const pinned = str(user.pinned_post_id) ?? str(user.pinned_tweet_id)
	const withheld = strings(rec(user.withheld)?.country_codes)
	const joined = str(user.created_at)
	return [
		`${handle ? `@${handle}` : `user ${String(user.id ?? "")}`} — ${str(user.name) ?? "(no name)"}${flags.length ? ` (${flags.join(", ")})` : ""}`,
		...(handle ? [`https://x.com/${handle}`] : []),
		...(str(user.description) ? [`Bio: ${user.description}`] : []),
		[str(user.location) ? `Location: ${user.location}` : null, userUrl(user) ? `Link: ${userUrl(user)}` : null, joined ? `Joined ${joined.slice(0, 10)}` : null].filter(Boolean).join(" · "),
		counts.join(" · "),
		...(pinned ? [`Pinned post: ${permalink(pinned, handle)}`] : []),
		...(withheld.length ? [`Withheld in: ${withheld.join(", ")}`] : []),
	].filter((line) => line !== "")
}

const userLine = (user: Json) => `- ${byline(user)}${handleOf(user) ? ` · https://x.com/${handleOf(user)}` : ""}`

type Missing = { id: string; reason: string }
/** Whether X answered for this requested id or handle with a problem naming it missing, protected or suspended. */
const answered = (resources: Json[], id: string) => resources.some((problem) => namesResource(problem, id))
/** Requested ids or handles X did not return, each with X's own reason when one of its resource problems names it. */
function missingOf(requested: string[], returned: Set<string>, resources: Json[]): Missing[] {
	return requested.filter((id) => !returned.has(id.toLowerCase())).map((id) => {
		const problem = resources.find((candidate) => namesResource(candidate, id))
		return { id, reason: problem ? (problemText(problem) ?? problemType(problem) ?? "X named it without a reason") : "X returned neither it nor an error naming it" }
	})
}

/**
 * Status of a lookup over requested items. A requested item X names missing, protected or suspended is answered; one
 * with neither data nor that answer is a failure. None returned is empty only when X answered for every one.
 */
function lookupStatus(returned: number, missing: Missing[], resources: Json[], partFailures: number): OutcomeStatus {
	if (!returned) return missing.every((item) => answered(resources, item.id)) ? "empty" : "failed"
	return missing.length || partFailures ? "partial" : "success"
}

/** Why a post lookup that named a resource problem without answering for every requested post was not read through TikHub. */
const withheld = (resources: Json[], posts: number) =>
	`X refused or withheld ${posts === 1 ? "the post" : "posts"} (${problemList(resources)}), so ${posts === 1 ? "it was" : "they were"} not read elsewhere.`

/**
 * A lookup X refused while naming missing, protected or suspended resources: empty when they answer for every requested
 * item, else failed with X's message, `note` and what X named.
 */
function refusedLookup(requested: string[], refusal: Failure, nouns: [string, string], mark: string, note: string | null): { status: OutcomeStatus; text: string; missing: Missing[] } {
	const missing = missingOf(requested, new Set(), refusal.resource)
	const notReturned = missing.map((item) => `Not returned: ${mark}${item.id} — ${item.reason}`)
	if (missing.every((item) => answered(refusal.resource, item.id)))
		return { status: "empty", missing, text: [`X API: ${count(0, ...nouns)} of ${requested.length} requested.`, ...notReturned, ...(refusal.problem ? [`X also reported: ${refusal.problem}`] : [])].join("\n") }
	return { status: "failed", missing, text: [`ERROR: ${refusal.message}`, ...(note ? [note] : []), ...notReturned].join("\n") }
}

/** A lookup's 2xx answer without data: empty when X named every requested item missing, protected or suspended, else failed. */
function noneReturned(requested: string[], resources: Json[], nouns: [string, string], mark: string): { status: OutcomeStatus; text: string; missing: Missing[] } {
	const missing = missingOf(requested, new Set(), resources)
	const status = lookupStatus(0, missing, resources, 0)
	const lines = [
		`${status === "failed" ? "ERROR: " : ""}X API: ${count(0, ...nouns)} of ${requested.length} requested.`,
		...missing.map((item) => `Not returned: ${mark}${item.id} — ${item.reason}`),
		...(status === "failed" && resources.length ? [`X reported: ${problemList(resources)}`] : []),
	]
	return { status, missing, text: lines.join("\n") }
}

/** A result whose response also reported a problem beside its data: partial, naming the problem under the first line. */
function withProblem(problem: string | null, text: string, details: Record<string, unknown>): ToolOutcome {
	if (!problem) return outcome("success", bounded(text), details)
	const [first, ...rest] = text.split("\n")
	return outcome("partial", bounded([first, `Partial: ${problem}`, ...rest].join("\n")), details)
}

// ---------------------------------------------------------------------------
// Links and identifiers
// ---------------------------------------------------------------------------

const POST_HOSTS = new Set(["x.com", "twitter.com"])
const NUMERIC_ID = /^\d{1,19}$/

function urlOf(value: string): URL | null {
	try {
		return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)
	} catch {
		return null
	}
}

/** The post id in an x.com or twitter.com status link, or a bare numeric id; null otherwise. */
export function postId(input: string): string | null {
	const value = input.trim()
	if (NUMERIC_ID.test(value)) return value
	const url = urlOf(value)
	if (!url || !POST_HOSTS.has(url.hostname.toLowerCase().replace(/^(?:www|mobile)\./, ""))) return null
	return url.pathname.match(/\/status(?:es)?\/(\d{1,19})(?:\/|$)/)?.[1] ?? null
}

/** A List id, or the id in an x.com or twitter.com List link. */
function listId(input: string): string | null {
	const value = input.trim()
	if (NUMERIC_ID.test(value)) return value
	const url = urlOf(value)
	if (!url || !POST_HOSTS.has(url.hostname.toLowerCase().replace(/^(?:www|mobile)\./, ""))) return null
	return url.pathname.match(/\/lists\/(\d{1,19})(?:\/|$)/)?.[1] ?? null
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/
/** People search accepts letters, digits, underscores, apostrophes and spaces, up to 50 characters. */
const PEOPLE_QUERY = /^[A-Za-z0-9_' ]{1,50}$/

// ---------------------------------------------------------------------------
// Post pages
// ---------------------------------------------------------------------------

/**
 * Where the reading stopped. `more` says X had more; `capped` that the page safety limit stopped it before `limit`;
 * `error` that a page failed, or reported a problem beside its posts, so later matches may be missing.
 */
type SearchPages = { posts: Json[]; pages: number; more: boolean; capped: boolean; error: string | null }

/** A paged post read: search (`next_token`) or a timeline such as bookmarks and likes (`pagination_token`). */
type Paging = {
	path: string
	params: Params
	limit: number
	label: string
	cursor: "next_token" | "pagination_token"
	/** The page sizes X accepts here. */
	size: { min: number; max: number }
	/** Full-archive search: each page waits for the process's archive slot. */
	archive?: boolean
}

/**
 * Pages until `limit` posts, X's last page, a failed page or the page safety limit. Each page is its own retained
 * response.
 */
async function readPages(paging: Paging, inc: Includes, ctx: CallContext, auth: Auth): Promise<SearchPages> {
	const { limit, label } = paging
	const posts: Json[] = []
	const seen = new Set<string>()
	let cursor: string | null = null
	let pages = 0
	for (;;) {
		if (paging.archive) await archiveTurn(ctx.abort)
		pages += 1
		const answer = await xRead(
			paging.path,
			{ ...POST_PARAMS, ...paging.params, max_results: clamp(limit - posts.length, paging.size.min, paging.size.max), [paging.cursor]: cursor ?? undefined },
			pages === 1 ? label : `${label}, page ${pages}`,
			ctx,
			auth,
		)
		if (!answer.ok) return { posts, pages, more: true, capped: false, error: answer.message }
		addIncludes(inc, answer.body)
		for (const post of dataItems(answer.body)) {
			const id = str(post.id)
			if (!id || seen.has(id)) continue
			seen.add(id)
			posts.push(post)
		}
		cursor = nextToken(answer.body)
		// A page that reported a problem beside its posts is never taken for the last page: the reading stops, naming it.
		if (answer.problem) return { posts: posts.slice(0, limit), pages, more: true, capped: false, error: answer.problem }
		if (!cursor || posts.length >= limit) return { posts: posts.slice(0, limit), pages, more: Boolean(cursor) || posts.length > limit, capped: false, error: null }
		if (pages >= MAX_SEARCH_PAGES) return { posts, pages, more: true, capped: true, error: null }
	}
}

/** Recent or full-archive search pages; full-archive pages wait for the process's archive slot, a second apart. */
function searchPages(endpoint: "recent" | "all", params: Params, limit: number, label: string, inc: Includes, ctx: CallContext, token: string): Promise<SearchPages> {
	return readPages({ path: `/2/tweets/search/${endpoint}`, params, limit, label, cursor: "next_token", size: SEARCH_PAGE, archive: endpoint === "all" }, inc, ctx, token)
}

// ---------------------------------------------------------------------------
// TikHub: x_post's single-post fallback, Communities search without sign-in, a Community's details and posts
// ---------------------------------------------------------------------------

/** Read per request, so a TIKHUB_BASE_URL loaded from keys.env after startup applies. */
const tikhubBaseUrl = () => process.env.TIKHUB_BASE_URL?.trim() || "https://api.tikhub.io"
const tikhubKey = () => process.env.TIKHUB_API_KEY?.trim() || null
const TIKHUB_LABEL = "fetch_tweet_detail via TikHub"

type TikhubMedia = { kind: string; url: string }
/** One post as TikHub's fetch_tweet_detail returns it (shape observed live on 2026-10-05). */
type TikhubPost = {
	id: string
	handle: string | null
	name: string | null
	followers: number | null
	verified: boolean
	createdAt: string | null
	text: string
	replies: number | null
	reposts: number | null
	quotes: number | null
	likes: number | null
	bookmarks: number | null
	views: number | null
	replyToId: string | null
	replyToHandle: string | null
	media: TikhubMedia[]
	quoted: TikhubPost | null
}

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec"
/** `Mon Oct 05 19:00:46 +0000 2026` as ISO; the id's own timestamp when that does not parse. */
function tikhubTime(createdAt: unknown, id: string): string | null {
	const match = typeof createdAt === "string" ? createdAt.match(/^\w{3} (\w{3}) (\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (\d{4})$/) : null
	const month = match ? MONTHS.indexOf(match[1]) : -1
	if (match && month >= 0 && month % 3 === 0) {
		const date = new Date(`${match[6]}-${String(month / 3 + 1).padStart(2, "0")}-${match[2]}T${match[3]}${match[4]}:${match[5]}`)
		if (!Number.isNaN(date.getTime())) return date.toISOString()
	}
	const ms = snowflakeTime(id)
	return ms === null ? null : new Date(ms).toISOString()
}

/** Media as `{photo: [...], video: [...]}` (or a list carrying `type`); a video links its highest-bitrate MP4. */
function tikhubMedia(value: unknown): TikhubMedia[] {
	const groups: Array<[string, unknown[]]> = Array.isArray(value)
		? value.map((item) => [str(rec(item)?.type) ?? "media", [item]])
		: Object.entries(rec(value) ?? {}).map(([kind, items]) => [kind, Array.isArray(items) ? items : []])
	const media: TikhubMedia[] = []
	for (const [kind, items] of groups) {
		for (const item of recs(items)) {
			const mp4 = recs(item.variants)
				.filter((variant) => variant.content_type === "video/mp4" && str(variant.url))
				.sort((a, b) => (num(b.bitrate) ?? 0) - (num(a.bitrate) ?? 0))[0]
			const url = str(mp4?.url) ?? str(item.media_url_https) ?? str(item.url)
			if (url) media.push({ kind, url })
		}
	}
	return media
}

/** The text with each t.co link replaced by the address it stands for, when the post's entities say. */
function expandLinks(text: string, entities: unknown): string {
	let expanded = text
	for (const link of recs(rec(entities)?.urls)) {
		const short = str(link.url)
		const long = str(link.expanded_url)
		if (short && long) expanded = expanded.replaceAll(short, long)
	}
	return expanded
}

function tikhubPost(raw: unknown): TikhubPost | null {
	const record = rec(raw)
	if (!record) return null
	const id = str(record.id) ?? str(record.tweet_id)
	if (!id || !/^\d+$/.test(id)) return null
	const author = rec(record.author) ?? rec(record.user_info)
	const quoted = rec(record.quoted)
	return {
		id,
		handle: str(author?.screen_name) ?? str(record.screen_name),
		name: str(author?.name),
		followers: num(author?.followers_count) ?? num(author?.sub_count),
		verified: author?.blue_verified === true || author?.verified === true,
		createdAt: tikhubTime(record.created_at, id),
		text: expandLinks(str(record.text) ?? str(record.display_text) ?? "", record.entities),
		replies: num(record.replies),
		reposts: num(record.retweets),
		quotes: num(record.quotes),
		likes: num(record.likes) ?? num(record.favorites),
		bookmarks: num(record.bookmarks),
		views: num(record.views),
		replyToId: str(record.in_reply_to_status_id_str) ?? str(record.reply_to),
		replyToHandle: str(record.in_reply_to_screen_name),
		media: tikhubMedia(record.media),
		quoted: quoted ? tikhubPost(quoted) : null,
	}
}

function tikhubByline(post: TikhubPost): string {
	const about = [post.name, post.followers === null ? null : count(post.followers, "follower", "followers"), post.verified ? "verified" : null].filter((part): part is string => part !== null)
	const who = post.handle ? `@${post.handle}` : "unknown author"
	return about.length ? `${who} (${about.join(", ")})` : who
}

/** When, then each count TikHub reported; `skipZero` leaves zeros out, as X API list lines do. */
function tikhubFacts(post: TikhubPost, skipZero = false): string {
	const parts: string[] = []
	const add = (value: number | null, one: string, many: string) => {
		if (value !== null && !(skipZero && value === 0)) parts.push(count(value, one, many))
	}
	add(post.replies, "reply", "replies")
	add(post.reposts, "repost", "reposts")
	add(post.quotes, "quote", "quotes")
	add(post.likes, "like", "likes")
	add(post.bookmarks, "bookmark", "bookmarks")
	add(post.views, "view", "views")
	return [post.createdAt ? utc(post.createdAt) : null, ...parts].filter(Boolean).join(" · ")
}

function formatTikhubPost(post: TikhubPost): string[] {
	const media = (item: TikhubPost) => item.media.map((entry) => `Media: ${entry.kind} ${entry.url}`)
	const lines = [`X post by ${tikhubByline(post)}`, permalink(post.id, post.handle), tikhubFacts(post)]
	if (post.replyToId) lines.push(`Replying to ${post.replyToHandle ? `@${post.replyToHandle}` : "a post"}: ${permalink(post.replyToId, post.replyToHandle)}`)
	lines.push("", post.text || "(no text)", ...withGap(media(post)))
	if (post.quoted) {
		const quoted = post.quoted
		lines.push("", `Quoting ${tikhubByline(quoted)} · ${tikhubFacts(quoted)}`, permalink(quoted.id, quoted.handle), ...quoteBlock([...(quoted.text || "(no text)").split("\n"), ...media(quoted)]))
	}
	return lines
}

/** A TikHub post as a list item, like an X API list post: who, when, counts and link, then its exact text, media and the post it quotes. */
function formatTikhubListPost(post: TikhubPost): string[] {
	const media = (item: TikhubPost) => item.media.map((entry) => `Media: ${entry.kind} ${entry.url}`)
	const body = [...(post.text || "(no text)").split("\n"), ...media(post)]
	if (post.replyToId) body.push(`Replying to ${post.replyToHandle ? `@${post.replyToHandle}` : "a post"}: ${permalink(post.replyToId, post.replyToHandle)}`)
	if (post.quoted) body.push(`Quoting ${post.quoted.handle ? `@${post.quoted.handle}` : "a post"}: ${permalink(post.quoted.id, post.quoted.handle)}`, ...quoteBlock([...(post.quoted.text || "(no text)").split("\n"), ...media(post.quoted)]))
	return [`- ${[tikhubByline(post), tikhubFacts(post, true), permalink(post.id, post.handle)].filter(Boolean).join(" · ")}`, ...body.map((line) => `  ${line}`)]
}

/**
 * One GET of a TikHub Twitter web endpoint, never retried and never redirected, kept under `label`; TikHub's envelope
 * is `{code: 200, data}` on success.
 */
async function tikhubGet(endpoint: string, params: Params, label: string, apiKey: string, ctx: CallContext): Promise<{ data: Json } | { error: string }> {
	const url = new URL(`/api/v1/twitter/web/${endpoint}`, tikhubBaseUrl())
	for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(name, String(value))
	ctx.abort.throwIfAborted()
	let response: Response
	let text: string
	try {
		response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, redirect: "manual", signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(TIMEOUT_MS)]) })
	} catch (error) {
		ctx.keep(label, "error", message(error))
		ctx.abort.throwIfAborted()
		return { error: `TikHub could not be reached: ${message(error)}` }
	}
	try {
		text = await keptText(response, ctx.keep, label)
	} catch (error) {
		ctx.abort.throwIfAborted()
		return { error: `TikHub broke off while answering: ${message(error)}` }
	}
	ctx.abort.throwIfAborted()
	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get("location")
		return { error: `TikHub ${endpoint} answered HTTP ${response.status}${location ? ` with a redirect to ${location}` : ""}; Dig does not follow redirects` }
	}
	let parsed: unknown = null
	try {
		parsed = text ? JSON.parse(text) : null
	} catch {}
	const body = rec(redactValue(parsed, knownSecrets()))
	if (response.status === 200 && body && num(body.code) === 200) {
		const data = rec(body.data)
		return data ? { data } : { error: `TikHub ${endpoint} returned no data` }
	}
	const said = str(rec(body?.detail)?.message) ?? str(body?.detail) ?? str(body?.message)
	return { error: `TikHub ${endpoint} returned HTTP ${response.status}${said ? `: ${said.slice(0, MAX_ERROR_CHARS).replace(/[.\s]+$/, "")}` : ""}` }
}

type Extras = { thread: boolean; replies: number; quotes: number; reposters: number }
const anyExtras = (extras: Extras) => extras.thread || extras.replies > 0 || extras.quotes > 0 || extras.reposters > 0

/** Reads one post through TikHub because the X API could not (`reason`), labelled "via TikHub". */
async function tikhubFallback(id: string, reason: string, extras: Extras, ctx: CallContext): Promise<ToolOutcome> {
	const apiKey = tikhubKey()
	if (!apiKey) return failed(`X post ${id} could not be read: ${reason}. The TikHub fallback needs TIKHUB_API_KEY, which is not set in Dig's keys.env either.`)
	const detail = await tikhubGet("fetch_tweet_detail", { tweet_id: id }, TIKHUB_LABEL, apiKey, ctx)
	if ("error" in detail) return failed(`X post ${id} could not be read through the X API (${reason}) or TikHub (${detail.error}).`)
	// Only TikHub's own copy of the requested post, with its text or media, counts as reading it.
	const post = tikhubPost(detail.data)
	if (!post || post.id !== id || (!post.text && !post.media.length))
		return failed(`X post ${id} could not be read through the X API (${reason}), and TikHub fetch_tweet_detail did not return that post with its text or media.`)
	const unserved = anyExtras(extras)
	const lines = [
		`X post ${id} via TikHub: the X API could not serve it (${reason}).`,
		...(unserved ? ["The thread, replies, quote posts and reposters need the X API; TikHub read only the post."] : []),
		"",
		...formatTikhubPost(post),
	]
	return outcome(unserved ? "partial" : "success", bounded(lines.join("\n")), { provider: "tikhub", via: "TikHub", requested: [id], returned: [post.id], author: post.handle, xApiFailure: reason })
}

// ---------------------------------------------------------------------------
// x_post
// ---------------------------------------------------------------------------

type Section = { lines: string[]; failure: string | null }

/** When a post was created, in milliseconds: its created_at, else its snowflake id's time. */
function postTime(post: Json): number | null {
	const at = Date.parse(String(post.created_at ?? ""))
	return Number.isNaN(at) ? snowflakeTime(String(post.id)) : at
}

/** The author's thread, replies, quote posts and reposters of one returned post, as requested. */
async function postNeighbourhood(post: Json, extras: Extras, inc: Includes, ctx: CallContext, token: string, requested: Set<string>): Promise<Section[]> {
	const id = String(post.id)
	const author = authorOf(post, inc)
	const from = handleOf(author) ?? str(post.author_id)
	const root = str(post.conversation_id) ?? id
	const rootTime = snowflakeTime(root)
	const endpoint = rootTime !== null && Date.now() - rootTime < RECENT_WINDOW_MS ? "recent" : "all"
	// Full-archive search defaults to the last 30 days; an older conversation is read from its root post on.
	const start = endpoint === "all" ? conversationStart(root) : undefined
	const where = endpoint === "recent" ? "recent search" : `full-archive search from ${start}`
	// Reading on searches again up to the oldest post read. X's end_time is exclusive and to the second, so the search
	// ends one second after that post's second and may repeat posts from that second.
	const readOn = (query: string, posts: Json[]) => {
		const times = posts.flatMap((item) => postTime(item) ?? [])
		const oldest = times.length ? Math.min(...times) : null
		const args = [`query "${query}"`, ...(start ? ["archive true", `start_time ${start}`] : []), ...(oldest === null ? [] : [`end_time ${isoSecond(oldest + 1000)}`]), `limit ${SEARCH_LIMIT_MAX}`]
		const call = `x_search_posts with ${args.slice(0, -1).join(", ")} and ${args.at(-1)}`
		return oldest === null ? call : `${call}; it may repeat posts from ${isoSecond(oldest)}, the second of the oldest post read here`
	}
	const coverage = (result: SearchPages, what: string, query: string) =>
		result.more && !result.error ? [`Coverage incomplete: X has more ${what} than the ${count(result.posts.length, "post", "posts")} read here; read on with ${readOn(query, result.posts)}.`] : []
	// A failed page, or the page safety limit stopping the reading before what was asked for, makes the call partial.
	const shortfall = (result: SearchPages, what: string) =>
		result.error ?? (result.capped ? `the rest of ${what}: the search stopped at its ${MAX_SEARCH_PAGES}-page safety limit after ${count(result.posts.length, "post", "posts")}` : null)
	const sections: Section[] = []
	const listed = new Set<string>([...requested, root])

	if (extras.thread) {
		const query = `conversation_id:${root} from:${from}`
		const result: SearchPages = from
			? await searchPages(endpoint, { query, sort_order: "recency", start_time: start }, THREAD_PAGE, `thread of ${id}`, inc, ctx, token)
			: { posts: [], pages: 0, more: false, capped: false, error: `thread of ${id}: X returned no author for this post, so its thread cannot be searched` }
		const thread = result.posts.filter((item) => !requested.has(String(item.id))).sort(byId)
		for (const item of thread) listed.add(String(item.id))
		sections.push({
			lines: [`Thread: ${count(thread.length, "post", "posts")} by ${from ? `@${from}` : "the author"} in conversation ${root} (${where}), oldest first.${thread.length ? ` ${ZERO_NOTE}` : ""}`, ...coverage(result, "of this thread", query), ...thread.flatMap((item) => formatListPost(item, inc))],
			failure: shortfall(result, `the thread of ${id}`),
		})
	}
	if (extras.replies > 0) {
		const query = `conversation_id:${root}${extras.thread && from ? ` -from:${from}` : ""}`
		const result = await searchPages(endpoint, { query, sort_order: "recency", start_time: start }, extras.replies, `replies to ${id}`, inc, ctx, token)
		const replies = result.posts.filter((item) => !listed.has(String(item.id))).slice(0, extras.replies)
		sections.push({
			lines: [`Replies: ${count(replies.length, "post", "posts")} from conversation ${root}${extras.thread ? ", besides the author's thread" : ""} (${where}, newest first).${replies.length ? ` ${ZERO_NOTE}` : ""}`, ...coverage(result, "replies in this conversation", query), ...replies.flatMap((item) => formatListPost(item, inc))],
			failure: shortfall(result, `the replies to ${id}`),
		})
	}
	if (extras.quotes > 0) {
		const answer = await xRead(`/2/tweets/${id}/quote_tweets`, { ...POST_PARAMS, max_results: clamp(extras.quotes, QUOTES_MIN, SEARCH_PAGE.max) }, `quote posts of ${id}`, ctx, token)
		if (answer.ok) addIncludes(inc, answer.body)
		const quotes = answer.ok ? dataItems(answer.body).slice(0, extras.quotes) : []
		sections.push({
			lines: [`Quote posts: ${count(quotes.length, "post", "posts")}${answer.ok && nextToken(answer.body) ? " (X has more)" : ""}.${quotes.length ? ` ${ZERO_NOTE}` : ""}`, ...quotes.flatMap((item) => formatListPost(item, inc))],
			failure: answer.ok ? answer.problem : answer.message,
		})
	}
	if (extras.reposters > 0) {
		const answer = await xRead(`/2/tweets/${id}/retweeted_by`, { ...USER_PARAMS, max_results: extras.reposters }, `reposters of ${id}`, ctx, token)
		if (answer.ok) addIncludes(inc, answer.body)
		const users = answer.ok ? dataItems(answer.body).slice(0, extras.reposters) : []
		sections.push({
			lines: [`Reposted by: ${count(users.length, "account", "accounts")}${answer.ok && nextToken(answer.body) ? " (X has more)" : ""}.`, ...users.map(userLine)],
			failure: answer.ok ? answer.problem : answer.message,
		})
	}
	return sections
}

/** Chronological order: ids are snowflakes, so a larger id is a later post. */
function byId(a: Json, b: Json): number {
	const x = BigInt(String(a.id))
	const y = BigInt(String(b.id))
	return x < y ? -1 : x > y ? 1 : 0
}

export const post: ToolSpec = {
	description:
		"Read X posts by link or id through the X API: each post's exact full text (long posts and X Article text included), author (name, handle, verified status, followers), time, permalink, public counts (likes, reposts, replies, quotes, bookmarks, impressions), media, poll, the post it quotes or replies to, edit history, language, links and context annotations. " +
		"Optionally each post's thread by its author, replies from its conversation, quote posts and reposters (conversation reads use recent search for conversations under 7 days old, and full-archive search from the conversation's first post for older ones; when X has more than was read, the result says so and gives the x_search_posts call that reads on from the oldest post read). " +
		"Requires X_BEARER_TOKEN; when one post is requested and the X API cannot serve it (token missing, auth, credits, rate limit, server or network failure), the post is read through TikHub (TIKHUB_API_KEY) and labelled via TikHub. X saying the post is missing, protected or suspended is reported, never read through TikHub. X reports no per-call charge, so the cost is recorded as unknown.",
	async execute(args, context) {
		const inputs: string[] = Array.isArray(args.posts) ? args.posts.map(String) : []
		const invalid = inputs.filter((input) => !postId(input))
		if (!inputs.length) return failed("posts needs 1 to 100 X post links or numeric post ids.")
		if (invalid.length) return failed(`Not an X post link or numeric post id: ${invalid.map((input) => `"${input}"`).join(", ")}. Use https://x.com/<handle>/status/<id> or the id itself.`)
		const ids = [...new Set(inputs.flatMap((input) => postId(input) ?? []))]
		const extras: Extras = { thread: args.thread === true, replies: Number(args.replies ?? 0), quotes: Number(args.quotes ?? 0), reposters: Number(args.reposters ?? 0) }
		const token = bearerToken()
		if (!token) {
			if (ids.length === 1) return tikhubFallback(ids[0], `${KEY} is not set in Dig's keys.env`, extras, context)
			return failed(`${missingKey} TikHub stands in only for a single post.`)
		}
		const lookup = await xGet("/2/tweets", { ...POST_PARAMS, ids: ids.join(",") }, "post lookup", context, token)
		if (!lookup.ok) {
			// X naming a post missing, protected or suspended vetoes the fallback, whatever else it reported beside it.
			if (lookup.resource.length) {
				const refused = refusedLookup(ids, lookup, ["post", "posts"], "", withheld(lookup.resource, ids.length))
				return outcome(refused.status, refused.text, { provider: "x-api", requested: ids, returned: [], missing: refused.missing, failures: refused.status === "failed" ? [lookup.message] : [] })
			}
			if (ids.length === 1 && FALLBACK_KINDS.has(lookup.kind)) return tikhubFallback(ids[0], lookup.message, extras, context)
			return failed(lookup.message)
		}
		const inc = newIncludes()
		addIncludes(inc, lookup.body)
		const found = dataItems(lookup.body)
		// A post X returns as its latest edit still answers a request for an earlier version.
		const returned = new Set(found.flatMap((item) => [String(item.id), ...editHistory(item)]))
		const missing = missingOf(ids, returned, lookup.resources)
		const requested = new Set(ids)
		const blocks: string[][] = []
		const failures: string[] = lookup.problem ? [lookup.problem] : []
		for (const item of found) {
			const sections = anyExtras(extras) ? await postNeighbourhood(item, extras, inc, context, token, requested) : []
			failures.push(...sections.flatMap((section) => section.failure ?? []))
			blocks.push([...formatPost(item, inc), ...sections.flatMap((section) => ["", ...section.lines, ...(section.failure ? [`Not read: ${section.failure}`] : [])])])
		}
		const status = lookupStatus(ids.length - missing.length, missing, lookup.resources, failures.length)
		const head = `${status === "failed" ? "ERROR: " : ""}X API: ${count(ids.length - missing.length, "post", "posts")} of ${ids.length} requested.`
		const lines = [
			head,
			...missing.map((item) => `Not returned: ${item.id} — ${item.reason}`),
			// X returned nothing without answering for every post; a resource problem it did name still keeps them from TikHub.
			...(status === "failed" && lookup.resources.length ? [withheld(lookup.resources, ids.length)] : []),
			...(failures.length ? [`Some requested reads failed: ${failures.join(" | ")}`] : []),
			...blocks.flatMap((block) => ["", "---", "", ...block]),
		]
		return outcome(status, bounded(lines.join("\n")), {
			provider: "x-api",
			requested: ids,
			returned: found.map((item) => String(item.id)),
			missing,
			failures,
		})
	},
}

// ---------------------------------------------------------------------------
// x_search_posts
// ---------------------------------------------------------------------------

function timeWindow(start: string | null, end: string | null): string | null {
	return start || end ? `${start ? `from ${start}` : ""}${start && end ? " " : ""}${end ? `to ${end}` : ""}` : null
}
/** The start time a search or count sends: the caller's, else the archive's own start for the full archive (X's default there is 30 days ago). */
const startTime = (args: { start_time?: unknown }, archive: boolean) => str(args.start_time) ?? (archive ? ARCHIVE_START : null)

export const search_posts: ToolSpec = {
	description:
		"Search X posts with X's own search syntax (every operator passes through: from:, to:, conversation_id:, is:reply, has:media, lang:, min_likes: and the rest). archive false searches the last 7 days; true searches the full archive, from 2006-03-21 unless start_time says otherwise (X's own default there is the last 30 days), at one request per second, so pages are spaced. " +
		"Pages internally up to limit (default 25, max 500; at most 50 pages), each page kept as its own original response; returns each post with author, time, permalink, nonzero public counts and full text. Requires X_BEARER_TOKEN. X reports no per-call charge, so the cost is recorded as unknown.",
	async execute(args, context) {
		const token = bearerToken()
		if (!token) return failed(missingKey)
		const query = String(args.query ?? "").trim()
		if (!query) return failed("query is required: X search syntax, as on x.com search.")
		const archive = args.archive === true
		const limit = Number(args.limit ?? SEARCH_LIMIT)
		const sort = args.sort === "relevancy" ? "relevancy" : "recency"
		const inc = newIncludes()
		const start = startTime(args, archive)
		const result = await searchPages(archive ? "all" : "recent", { query, sort_order: sort, start_time: start ?? undefined, end_time: str(args.end_time) ?? undefined }, limit, archive ? "full-archive search" : "recent search", inc, context, token)
		const scope = [archive ? "full archive" : "last 7 days", timeWindow(start, str(args.end_time)), sort === "relevancy" ? "most relevant first" : "newest first"].filter(Boolean).join(", ")
		const reachedLimit = result.more && !result.error && !result.capped
		const head = `X search for "${query}" (${scope}): ${count(result.posts.length, "post", "posts")} over ${count(result.pages, "page", "pages")}${reachedLimit ? `; X has more beyond limit ${limit}` : ""}.`
		const details = { endpoint: archive ? "/2/tweets/search/all" : "/2/tweets/search/recent", pages: result.pages, returned: result.posts.length, more: result.more, capped: result.capped }
		if (result.error && !result.posts.length) return outcome("failed", `ERROR: ${result.error}\n${head}`, details)
		const lines = [
			head,
			...(result.error ? [`Page ${result.pages} failed or reported a problem, so later matches may be missing: ${result.error}`] : []),
			...(result.capped ? [`Stopped at the ${MAX_SEARCH_PAGES}-page safety limit with ${result.posts.length} of the ${limit} posts asked for; X has more. Narrow the window with start_time and end_time to read further.`] : []),
			...(result.posts.length ? ["", ZERO_NOTE, ...result.posts.flatMap((item) => formatListPost(item, inc))] : ["", "X found no posts matching this query."]),
		]
		const status: OutcomeStatus = result.error || result.capped ? "partial" : result.posts.length ? "success" : "empty"
		return outcome(status, bounded(lines.join("\n")), details)
	},
}

// ---------------------------------------------------------------------------
// x_count_posts
// ---------------------------------------------------------------------------

const GRANULARITIES = ["minute", "hour", "day"] as const
type Granularity = (typeof GRANULARITIES)[number]

export const count_posts: ToolSpec = {
	description:
		"Count X posts matching a query (X search syntax) per minute, hour or day (default day), without reading them: archive false counts the last 7 days, true the full archive, from 2006-03-21 unless start_time says otherwise (X's own default there is the last 30 days). Returns each bucket's count and the total. Requires X_BEARER_TOKEN. X reports no per-call charge, so the cost is recorded as unknown.",
	async execute(args, context) {
		const token = bearerToken()
		if (!token) return failed(missingKey)
		const query = String(args.query ?? "").trim()
		if (!query) return failed("query is required: X search syntax, as on x.com search.")
		const archive = args.archive === true
		const granularity: Granularity = GRANULARITIES.includes(args.granularity) ? args.granularity : "day"
		const endpoint = archive ? "/2/tweets/counts/all" : "/2/tweets/counts/recent"
		const start = startTime(args, archive)
		const buckets: Array<{ start: string; end: string; count: number }> = []
		let reportedTotal: number | null = 0
		let pageToken: string | null = null
		let pages = 0
		let error: string | null = null
		do {
			pages += 1
			const answer = await xRead(endpoint, { query, granularity, start_time: start ?? undefined, end_time: str(args.end_time) ?? undefined, next_token: pageToken ?? undefined }, pages === 1 ? "post counts" : `post counts, page ${pages}`, context, token)
			if (!answer.ok) {
				error = answer.message
				break
			}
			for (const bucket of dataItems(answer.body)) {
				const value = num(bucket.post_count ?? bucket.tweet_count)
				const start = str(bucket.start)
				if (start && value !== null) buckets.push({ start, end: String(bucket.end ?? ""), count: value })
			}
			const pageTotal = num(rec(answer.body.meta)?.total_post_count ?? rec(answer.body.meta)?.total_tweet_count)
			reportedTotal = reportedTotal === null || pageTotal === null ? null : reportedTotal + pageTotal
			pageToken = nextToken(answer.body)
			// A page that reported a problem beside its buckets is never taken for the last page.
			if (answer.problem) {
				error = answer.problem
				break
			}
		} while (pageToken && pages < MAX_COUNT_PAGES)
		const summed = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
		const total = reportedTotal ?? summed
		const details = { endpoint, granularity, pages, buckets: buckets.length, total, more: Boolean(pageToken) }
		const scope = [archive ? "full archive" : "last 7 days", timeWindow(start, str(args.end_time)), `per ${granularity}`].filter(Boolean).join(", ")
		const head = `X post counts for "${query}" (${scope}): ${count(total, "post", "posts")} in ${count(buckets.length, "bucket", "buckets")}.`
		if (error && !buckets.length) return outcome("failed", `ERROR: ${error}\n${head}`, details)
		const label = (bucketStart: string) => (granularity === "day" ? bucketStart.slice(0, 10) : utc(bucketStart))
		const lines = [
			head,
			...(error ? [`Page ${pages} failed or reported a problem, so later buckets may be missing and the total may be incomplete: ${error}`] : []),
			...(pageToken && !error ? [`Stopped after ${count(pages, "page", "pages")}; X has more buckets, so the total is incomplete. Narrow the window or count per hour or day.`] : []),
			"",
			...buckets.map((bucket) => `${label(bucket.start)}: ${bucket.count.toLocaleString("en-US")}`),
		]
		const status: OutcomeStatus = error || pageToken ? "partial" : total > 0 ? "success" : "empty"
		return outcome(status, bounded(lines.join("\n")), details)
	},
}

// ---------------------------------------------------------------------------
// x_users
// ---------------------------------------------------------------------------

/** One account's recent posts or mentions, as requested. */
async function userTimeline(user: Json, kind: "tweets" | "mentions", wanted: number, inc: Includes, ctx: CallContext, token: string): Promise<Section> {
	const handle = handleOf(user) ?? String(user.id)
	const label = kind === "tweets" ? `posts by @${handle}` : `mentions of @${handle}`
	const answer = await xRead(`/2/users/${user.id}/${kind}`, { ...POST_PARAMS, max_results: clamp(wanted, TIMELINE_MIN, SEARCH_PAGE.max) }, label, ctx, token)
	if (answer.ok) addIncludes(inc, answer.body)
	const posts = answer.ok ? dataItems(answer.body).slice(0, wanted) : []
	return {
		lines: [`${kind === "tweets" ? "Recent posts" : "Recent mentions"}: ${count(posts.length, "post", "posts")}.${posts.length ? ` ${ZERO_NOTE}` : ""}`, ...posts.flatMap((item) => formatListPost(item, inc))],
		failure: answer.ok ? answer.problem : answer.message,
	}
}

export const users: ToolSpec = {
	description:
		"Read X accounts through the X API, by handles (1-100, with or without @) or a people search query (letters, digits, underscores, apostrophes and spaces; 25 accounts). Profiles carry name, handle, bio, location, link, join date, verification and public counts; posts and mentions (0-100 each) add each account's most recent posts and posts mentioning it. " +
		"Handles, posts and mentions use X_BEARER_TOKEN. People search needs X sign-in (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET), because X serves it only to a signed-in account; it runs as that account. X reports no per-call charge, so the cost is recorded as unknown.",
	async execute(args, context) {
		const handles: string[] = Array.isArray(args.handles) ? args.handles.map((handle: unknown) => String(handle).trim().replace(/^@/, "")) : []
		const query = typeof args.query === "string" ? args.query.trim() : ""
		if (handles.length && query) return failed("Pass either handles or query, not both.")
		if (!handles.length && !query) return failed("Pass handles (1-100 X handles) or query (a people search).")
		const invalid = handles.filter((handle) => !HANDLE.test(handle))
		if (invalid.length) return failed(`Not an X handle: ${invalid.map((handle) => `"${handle}"`).join(", ")}. A handle has 1-15 letters, digits or underscores.`)
		if (query && !PEOPLE_QUERY.test(query)) return failed("People search accepts letters, digits, underscores, apostrophes and spaces, up to 50 characters.")
		const posts = Number(args.posts ?? 0)
		const mentions = Number(args.mentions ?? 0)
		const token = bearerToken()
		const needsToken = handles.length > 0 || posts > 0 || mentions > 0
		const keys = query ? userKeys() : null
		if (keys && "missing" in keys) return failed(`${missingUserKeys("People search", keys.missing)}${needsToken && !token ? ` Each account's posts and mentions also need ${KEY}.` : ""}`)
		if (needsToken && !token) return failed(missingKey)
		const wanted = [...new Map(handles.map((handle) => [handle.toLowerCase(), handle])).values()]
		const answer = keys
			? await xRead("/2/users/search", { ...USER_PARAMS, query, max_results: PEOPLE_SEARCH_RESULTS }, "people search", context, keys)
			: await xGet("/2/users/by", { ...USER_PARAMS, usernames: wanted.join(",") }, "account lookup", context, token ?? "")
		if (!answer.ok) {
			// X naming requested accounts missing, protected or suspended answers for them, whatever the HTTP status.
			if (handles.length && answer.resource.length) {
				const refused = refusedLookup(wanted, answer, ["account", "accounts"], "@", null)
				return outcome(refused.status, refused.text, { returned: [], missing: refused.missing, failures: refused.status === "failed" ? [answer.message] : [] })
			}
			return failed(answer.message)
		}
		const inc = newIncludes()
		addIncludes(inc, answer.body)
		const found = dataItems(answer.body)
		const missing = handles.length ? missingOf(wanted, new Set(found.map((user) => String(user.username ?? "").toLowerCase())), answer.resources) : []
		const failures: string[] = answer.problem ? [answer.problem] : []
		const blocks: string[][] = []
		for (const user of found) {
			const sections: Section[] = []
			if (posts > 0 && token) sections.push(await userTimeline(user, "tweets", posts, inc, context, token))
			if (mentions > 0 && token) sections.push(await userTimeline(user, "mentions", mentions, inc, context, token))
			failures.push(...sections.flatMap((section) => section.failure ?? []))
			blocks.push([...formatUser(user), ...sections.flatMap((section) => ["", ...section.lines, ...(section.failure ? [`Not read: ${section.failure}`] : [])])])
		}
		const status = handles.length ? lookupStatus(wanted.length - missing.length, missing, answer.resources, failures.length) : !found.length ? "empty" : failures.length ? "partial" : "success"
		const head = handles.length
			? `${status === "failed" ? "ERROR: " : ""}X API: ${count(wanted.length - missing.length, "account", "accounts")} of ${wanted.length} requested.`
			: `X people search for "${query}": ${count(found.length, "account", "accounts")}.`
		const lines = [
			head,
			...missing.map((item) => `Not returned: @${item.id} — ${item.reason}`),
			...(failures.length ? [`Some requested reads failed: ${failures.join(" | ")}`] : []),
			...(!found.length && !handles.length ? ["", "X found no accounts for this search."] : []),
			...blocks.flatMap((block) => ["", "---", "", ...block]),
		]
		return outcome(status, bounded(lines.join("\n")), { returned: found.map((user) => String(user.username ?? user.id)), missing, failures })
	},
}

// ---------------------------------------------------------------------------
// x_news
// ---------------------------------------------------------------------------

/** Every list of strings in a nested object, as `path: a, b` (`entities.organizations: Goldman Sachs`). */
function stringLists(value: unknown, path = ""): string[] {
	if (Array.isArray(value)) {
		const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
		return items.length ? [`${path || "values"}: ${items.join(", ")}`] : []
	}
	const record = rec(value)
	if (!record) return typeof value === "string" && value.trim() ? [`${path}: ${value}`] : []
	return Object.entries(record).flatMap(([key, item]) => stringLists(item, path ? `${path}.${key}` : key))
}

function formatStory(story: Json): string[] {
	const posts = recs(story.cluster_posts_results).flatMap((item) => str(item.post_id) ?? [])
	const updated = str(story.updated_at) ?? str(story.last_updated_at_ms)
	return [
		`X News story: ${str(story.name) ?? "(no name)"}`,
		[`id ${String(story.id ?? "?")}`, str(story.category), updated ? `updated ${updated}` : null].filter(Boolean).join(" · "),
		...(str(story.hook) ? [`Hook: ${story.hook}`] : []),
		...(str(story.summary) ? [`Summary: ${story.summary}`] : []),
		...stringLists(story.contexts).map((line) => `Context ${line}`),
		...stringLists(story.keywords, "keywords"),
		...(posts.length ? [`Posts in this story (${posts.length}):`, ...posts.map((id) => `- ${permalink(id, null)}`)] : []),
		...(str(story.disclaimer) ? [`Disclaimer: ${story.disclaimer}`] : []),
	]
}

export const news: ToolSpec = {
	description:
		"Read X's News stories through the X API: search by query (optional max_age_hours 1-720, default 168, and limit 1-100, default 10) or read one story by id. Each story has its name, summary, hook, category, contexts (entities, topics, tickers), keywords and links to the posts it clusters. Requires X_BEARER_TOKEN. X reports no per-call charge, so the cost is recorded as unknown.",
	async execute(args, context) {
		const query = typeof args.query === "string" ? args.query.trim() : ""
		const id = typeof args.id === "string" ? args.id.trim() : ""
		if (query && id) return failed("Pass either query or id, not both.")
		if (!query && !id) return failed("Pass query (a News search) or id (one story).")
		if (id && (args.max_age_hours !== undefined || args.limit !== undefined)) return failed("max_age_hours and limit apply to a News search by query, not to a story id.")
		if (id && !NUMERIC_ID.test(id)) return failed(`"${id}" is not an X News story id; ids are numeric.`)
		const token = bearerToken()
		if (!token) return failed(missingKey)
		const answer = id
			? await xGet(`/2/news/${id}`, { "news.fields": NEWS_FIELDS.join(",") }, `news story ${id}`, context, token)
			: await xRead("/2/news/search", { query, max_results: args.limit, max_age_hours: args.max_age_hours, "news.fields": NEWS_FIELDS.join(",") }, "news search", context, token)
		if (!answer.ok) {
			if (id && answer.resource.length) {
				const refused = refusedLookup([id], answer, ["News story", "News stories"], "", null)
				return outcome(refused.status, refused.text, { stories: 0 })
			}
			return failed(answer.message)
		}
		const stories = dataItems(answer.body)
		if (!stories.length) {
			if (!id) return outcome("empty", `X News found no stories for "${query}"${args.max_age_hours ? ` in the last ${args.max_age_hours} hours` : ""}.`, { stories: 0 })
			const none = noneReturned([id], answer.resources, ["News story", "News stories"], "")
			return outcome(none.status, none.text, { stories: 0 })
		}
		const head = id ? `X News story ${id}.` : `X News search for "${query}": ${count(stories.length, "story", "stories")}.`
		return withProblem(answer.problem, [head, ...stories.flatMap((story) => ["", "---", "", ...formatStory(story)])].join("\n"), { stories: stories.length })
	},
}

// ---------------------------------------------------------------------------
// x_explore
// ---------------------------------------------------------------------------

const KINDS = {
	trends: ["woeid", "limit"],
	spaces: ["query", "state", "limit"],
	communities: ["query", "limit"],
	list: ["list", "limit"],
} as const
type Kind = keyof typeof KINDS
const KIND_ARGS = ["woeid", "query", "state", "list", "limit"] as const
const SPACE_STATES = ["live", "scheduled", "all"] as const

function formatSpace(space: Json, inc: Includes): string[] {
	const hosts = strings(space.host_ids).map((id) => inc.users.get(id)).filter((user): user is Json => Boolean(user)).map((user) => `@${handleOf(user)}`)
	const topics = strings(space.topic_ids).map((id) => str(inc.topics.get(id)?.name)).filter(Boolean)
	const when = str(space.started_at) ? `started ${stamp(space.started_at, null)}` : str(space.scheduled_start) ? `scheduled for ${stamp(space.scheduled_start, null)}` : null
	const participants = num(space.participant_count)
	const reminders = num(space.subscriber_count)
	const facts = [
		str(space.state),
		when,
		participants === null ? null : count(participants, "participant", "participants"),
		reminders === null ? null : count(reminders, "reminder", "reminders"),
		space.is_ticketed === true ? "ticketed" : null,
		str(space.lang) ? `language ${space.lang}` : null,
	].filter(Boolean)
	return [
		`- ${str(space.title) ?? "(untitled Space)"} · ${facts.join(" · ")}`,
		...(hosts.length ? [`  Hosts: ${hosts.join(", ")}`] : []),
		...(topics.length ? [`  Topics: ${topics.join(", ")}`] : []),
		`  https://x.com/i/spaces/${String(space.id ?? "")}`,
	]
}

function formatCommunity(community: Json): string[] {
	const members = num(community.member_count)
	return [
		`- ${str(community.name) ?? "(unnamed Community)"} · ${[str(community.access), str(community.join_policy), members === null ? null : count(members, "member", "members"), str(community.created_at) ? `created ${String(community.created_at).slice(0, 10)}` : null].filter(Boolean).join(" · ")}`,
		`  ${communityLink(String(community.id ?? "?"))}`,
		...(str(community.description) ? [`  ${community.description}`] : []),
	]
}

/** A Community as TikHub's fetch_search_communities lists it: its id, name, member count, topic and NSFW flag. */
function formatTikhubCommunity(community: Json): string[] {
	const members = num(community.member_count)
	const topic = str(community.primary_topic) ?? str(rec(community.primary_topic)?.topic_name) ?? str(rec(community.primary_topic)?.name)
	const facts = [members === null ? null : count(members, "member", "members"), topic ? `topic ${topic}` : null, community.is_nsfw === true ? "marked NSFW" : null].filter(Boolean)
	return [`- ${str(community.name) ?? "(unnamed Community)"}${facts.length ? ` · ${facts.join(" · ")}` : ""}`, `  ${communityLink(String(community.community_id ?? community.id ?? "?"))}`]
}

/** TikHub pages followed for a Communities search or a Community's posts before reporting that it has more. */
const TIKHUB_PAGES = 30

/** Communities search through TikHub's fetch_search_communities, paged with next_cursor until `wanted` or no new Community. */
async function tikhubCommunitySearch(query: string, wanted: number, apiKey: string, ctx: CallContext): Promise<ToolOutcome> {
	const found: Json[] = []
	const seen = new Set<string>()
	let cursor: string | null = null
	let pages = 0
	let more = false
	let capped = false
	let error: string | null = null
	for (;;) {
		pages += 1
		const page = await tikhubGet("fetch_search_communities", { keyword: query, cursor: cursor ?? undefined }, `fetch_search_communities via TikHub${pages > 1 ? `, page ${pages}` : ""}`, apiKey, ctx)
		if ("error" in page) {
			error = page.error
			break
		}
		const before = found.length
		for (const community of recs(page.data.communities)) {
			const id = str(community.community_id) ?? str(community.id)
			if (!id || seen.has(id)) continue
			seen.add(id)
			found.push(community)
		}
		cursor = str(page.data.next_cursor) ?? str(page.data.cursor)
		if (found.length >= wanted) {
			more = Boolean(cursor) || found.length > wanted
			break
		}
		if (!cursor || found.length === before) break
		if (pages >= TIKHUB_PAGES) {
			more = true
			capped = true
			break
		}
	}
	const communities = found.slice(0, wanted)
	const head = `X Communities search for "${query}" via TikHub: ${count(communities.length, "Community", "Communities")}${more ? " (TikHub has more)" : ""}.`
	const details = { kind: "communities", items: communities.length, provider: "tikhub", via: "TikHub" }
	if (error && !communities.length) return outcome("failed", `ERROR: ${error}\n${head}`, details)
	if (!communities.length) return outcome("empty", `${head} TikHub found none.`, details)
	const cap = capped ? [`Stopped at the ${TIKHUB_PAGES}-page safety limit with ${count(communities.length, "Community", "Communities")} of the ${wanted} asked for; TikHub has more.`] : []
	const lines = [head, ...(error ? [`Page ${pages} failed, so later Communities may be missing: ${error}`] : []), ...cap, "", ...communities.flatMap(formatTikhubCommunity)]
	return outcome(error || capped ? "partial" : "success", bounded(lines.join("\n")), { ...details, capped })
}

export const explore: ToolSpec = {
	description:
		"Explore X through the X API by kind: trends (woeid, default 1 = worldwide; limit up to 50, default 20), spaces (query; state live, scheduled or all, default all; limit), communities (query; limit) or list (a List id or link; limit, default 25), each limit up to 100 and default 25 unless stated. " +
		"Arguments that do not belong to the kind are refused. Trends, Spaces and Lists use X_BEARER_TOKEN. Communities search runs signed in when X sign-in is set (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET), because X serves it only to a signed-in account; otherwise it is read through TikHub (TIKHUB_API_KEY) and labelled via TikHub. Each Community comes with its link, which x_community reads. X and TikHub report no per-call charge, so the cost is recorded as unknown.",
	async execute(args, context) {
		const kind: Kind = args.kind
		if (!Object.hasOwn(KINDS, kind)) return failed(`kind must be one of ${Object.keys(KINDS).join(", ")}.`)
		const allowed: readonly string[] = KINDS[kind]
		const stray = KIND_ARGS.filter((name) => args[name] !== undefined && !allowed.includes(name))
		if (stray.length) return failed(`kind "${kind}" takes ${allowed.join(", ")}; ${stray.join(" and ")} ${stray.length === 1 ? "belongs" : "belong"} to another kind.`)
		const query = typeof args.query === "string" ? args.query.trim() : ""
		if ((kind === "spaces" || kind === "communities") && !query) return failed(`kind "${kind}" needs query.`)
		const limit = args.limit === undefined ? null : Number(args.limit)
		if (kind === "trends" && limit !== null && limit > TRENDS_MAX) return failed(`X returns at most ${TRENDS_MAX} trends; pass limit 1-${TRENDS_MAX}.`)
		const list = kind === "list" ? listId(String(args.list ?? "")) : null
		if (kind === "list" && !list) return failed("list must be an X List id or link such as https://x.com/i/lists/<id>.")
		const inc = newIncludes()

		if (kind === "communities") {
			const wanted = limit ?? EXPLORE_LIMIT
			const keys = userKeys()
			if ("missing" in keys) {
				const apiKey = tikhubKey()
				if (!apiKey) return failed(`Communities search needs X sign-in or TikHub. ${missingUserKeys("X's Communities search", keys.missing)} Without sign-in, Dig reads Communities search through TikHub, which needs TIKHUB_API_KEY, and that is not set in Dig's keys.env either.`)
				return tikhubCommunitySearch(query, wanted, apiKey, context)
			}
			const answer = await xRead("/2/communities/search", { query, max_results: clamp(wanted, COMMUNITIES_MIN, SEARCH_PAGE.max), "community.fields": COMMUNITY_FIELDS.join(",") }, "Communities search", context, keys)
			if (!answer.ok) return failed(answer.message)
			const communities = dataItems(answer.body).slice(0, wanted)
			const head = `X Communities search for "${query}": ${count(communities.length, "Community", "Communities")}${nextToken(answer.body) ? " (X has more)" : ""}.`
			if (!communities.length) return outcome("empty", `${head} X found none.`, { kind, items: 0 })
			return withProblem(answer.problem, [head, "", ...communities.flatMap(formatCommunity)].join("\n"), { kind, items: communities.length })
		}
		const token = bearerToken()
		if (!token) return failed(missingKey)

		if (kind === "trends") {
			const woeid = Number(args.woeid ?? WORLDWIDE_WOEID)
			const answer = await xRead(`/2/trends/by/woeid/${woeid}`, { max_trends: limit ?? TRENDS_LIMIT, "trend.fields": TREND_FIELDS.join(",") }, `trends for WOEID ${woeid}`, context, token)
			if (!answer.ok) return failed(answer.message)
			const trends = dataItems(answer.body)
			const place = woeid === WORLDWIDE_WOEID ? "worldwide (WOEID 1)" : `WOEID ${woeid}`
			if (!trends.length) return outcome("empty", `X returned no trends for ${place}.`, { kind, items: 0 })
			const lines = trends.map((trend, index) => {
				const posts = num(trend.tweet_count ?? trend.post_count)
				return `${index + 1}. ${String(trend.trend_name ?? "(unnamed)")}${posts === null ? "" : ` — ${count(posts, "post", "posts")}`}`
			})
			return withProblem(answer.problem, [`X trends ${place}: ${count(trends.length, "trend", "trends")}.`, "", ...lines].join("\n"), { kind, items: trends.length })
		}
		if (kind === "spaces") {
			const state = SPACE_STATES.includes(args.state) ? args.state : "all"
			const answer = await xRead("/2/spaces/search", { query, state, max_results: limit ?? EXPLORE_LIMIT, "space.fields": SPACE_FIELDS.join(","), expansions: SPACE_EXPANSIONS.join(","), "user.fields": USER_FIELDS.join(","), "topic.fields": TOPIC_FIELDS.join(",") }, "Spaces search", context, token)
			if (!answer.ok) return failed(answer.message)
			addIncludes(inc, answer.body)
			const spaces = dataItems(answer.body)
			const head = `X Spaces search for "${query}" (${state}): ${count(spaces.length, "Space", "Spaces")}.`
			if (!spaces.length) return outcome("empty", `${head} X found none.`, { kind, items: 0 })
			return withProblem(answer.problem, [head, "", ...spaces.flatMap((space) => formatSpace(space, inc))].join("\n"), { kind, items: spaces.length })
		}
		const wanted = limit ?? EXPLORE_LIMIT
		const answer = await xGet(`/2/lists/${list}/tweets`, { ...POST_PARAMS, max_results: wanted }, `List ${list} posts`, context, token)
		if (!answer.ok) {
			// X naming the List missing, protected or suspended answers for it, whatever the HTTP status.
			if (answer.resource.length) {
				const refused = refusedLookup([String(list)], answer, ["List", "Lists"], "", null)
				return outcome(refused.status, refused.text, { kind, items: 0 })
			}
			return failed(answer.message)
		}
		addIncludes(inc, answer.body)
		const posts = dataItems(answer.body).slice(0, wanted)
		const head = `X List ${list} (https://x.com/i/lists/${list}): ${count(posts.length, "post", "posts")}, newest first${nextToken(answer.body) ? "; X has more" : ""}.`
		if (!posts.length) {
			// The List named missing, protected or suspended answers the read; no posts beside any other problem is a failed
			// read; no posts and no problem is a List without posts.
			if (answered(answer.resources, String(list))) {
				const none = noneReturned([String(list)], answer.resources, ["List", "Lists"], "")
				return outcome(none.status, none.text, { kind, items: 0 })
			}
			if (answer.resources.length) return failed(`X API List ${list} posts reported ${problemList(answer.resources)}, and returned no data`)
			return outcome("empty", `${head} X returned no posts.`, { kind, items: 0 })
		}
		return withProblem(answer.problem, [head, "", ZERO_NOTE, ...posts.flatMap((item) => formatListPost(item, inc))].join("\n"), { kind, items: posts.length })
	},
}

// ---------------------------------------------------------------------------
// x_bookmarks and x_likes (signed in)
// ---------------------------------------------------------------------------

/** Posts a bookmark or like read takes by default; the schema allows 1-800. */
const OWN_LIMIT = 50
/** Page sizes X accepts: bookmarks 1-100, liked posts 5-100. */
const BOOKMARKS_PAGE = { min: 1, max: 100 }
const LIKES_PAGE = { min: 5, max: 100 }
/** The post lookup takes 100 ids per request. */
const LOOKUP_IDS = 100
/** Folder listing pages followed (X documents paging for folders but returns them in one page today). */
const FOLDER_PAGES = 10
/** The most folders or folder post ids X returns per request. A full page without a next token may not be all there is. */
const FOLDER_PAGE_MAX = 100
const OWNED_READS = "X prices reads of the signed-in account's own bookmarks and liked posts as Owned Reads ($0.001 per resource, X changelog 2026-04-16); Dig still records the cost as unknown, because X reports no per-call charge."

/**
 * `match`'s words, each as a pattern that matches at the start of a word, case-insensitively: after the start of the
 * text or a character that is not a letter or digit (Unicode-aware). So "ai" matches "AI", "AI's" and "#AI" but not
 * "brainstorm" or "said", and "agent" matches "agents".
 */
const matchWords = (value: unknown) =>
	(typeof value === "string" ? value.toLowerCase().split(/\s+/).filter(Boolean) : []).map((word) => ({ word, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu") }))
type MatchWord = ReturnType<typeof matchWords>[number]
/** A post's text for `match`: its full and short text, author's handle and name, links' expanded addresses, and the text of a post it quotes or reposts. */
function matchText(post: Json, inc: Includes): string {
	const author = authorOf(post, inc)
	const links = (item: Json) => [...recs(textEntities(item)?.urls), ...recs(rec(item.entities)?.urls)].flatMap((link) => [str(link.expanded_url), str(link.unwound_url)].filter((value): value is string => value !== null))
	const carried = references(post)
		.filter((reference) => reference.type === "quoted" || REPOST_TYPES.has(String(reference.type)))
		.map((reference) => inc.posts.get(String(reference.id)))
		.filter((item): item is Json => item !== undefined)
	return [fullText(post), str(post.text), handleOf(author), str(author?.name), ...links(post), ...carried.flatMap((item) => [fullText(item), ...links(item)])].filter(Boolean).join("\n").toLowerCase()
}
const matches = (post: Json, inc: Includes, words: MatchWord[]) => {
	const text = matchText(post, inc)
	return words.every(({ pattern }) => pattern.test(text))
}

/**
 * What a bookmark, folder or like read found, for the shared result. `incomplete` says why coverage may be short;
 * `lookup` is a folder's post lookup status by the lookup rules (lookupStatus), and `also` what X reported beside a
 * refusal that answered for every post.
 */
type OwnRead = { title: string; noun: string; posts: Json[]; more: boolean; capped: boolean; pages: number; error: string | null; missing: Missing[]; failures: string[]; incomplete?: string[]; lookup?: OutcomeStatus; also?: string[] }

/**
 * The result of a bookmark, folder or like read: posts read and posts matching. Empty when none were read or none
 * matched (saying which); a failed later page, lookup or the page safety limit beside posts read makes it partial.
 */
function ownOutcome(read: OwnRead, words: MatchWord[], inc: Includes, details: Record<string, unknown>): ToolOutcome {
	const shown = words.length ? read.posts.filter((post) => matches(post, inc, words)) : read.posts
	const asked = words.map(({ word }) => word).join(" ")
	const matching = words.length ? `, ${count(shown.length, "post", "posts")} matching "${asked}"` : ""
	const head = `${read.title}: ${count(read.posts.length, "post", "posts")} read${matching}${read.more && !read.error ? "; X has more" : ""}.`
	const problems = [
		...(read.error ? [`Page ${read.pages} failed or reported a problem, so later posts may be missing: ${read.error}`] : []),
		...(read.capped ? [`Stopped at the ${MAX_SEARCH_PAGES}-page safety limit with ${count(read.posts.length, "post", "posts")} read.`] : []),
		...(read.failures.length ? [`Some requested reads failed: ${read.failures.join(" | ")}`] : []),
		...(read.incomplete ?? []),
	]
	const all = { ...details, read: read.posts.length, matching: shown.length, more: read.more, missing: read.missing, failures: read.failures }
	if (!read.posts.length && (read.error || read.failures.length)) return outcome("failed", [`ERROR: ${read.error ?? read.failures[0]}`, head, ...read.missing.map((item) => `Not returned: ${item.id} — ${item.reason}`)].join("\n"), all)
	const lines = [
		head,
		...read.missing.map((item) => `Not returned: ${item.id} — ${item.reason}`),
		...(read.also ?? []).map((problem) => `X also reported: ${problem}`),
		...problems,
		"",
		...(!read.posts.length ? [`X returned no ${read.noun}.`] : !shown.length ? [`None of the ${count(read.posts.length, "post", "posts")} read match "${asked}".`] : [ZERO_NOTE, ...shown.flatMap((post) => formatListPost(post, inc))]),
	]
	// A folder's post lookup follows the lookup rules: posts beside requested posts X did not return are partial.
	const status: OutcomeStatus = problems.length || read.lookup === "partial" ? "partial" : shown.length ? "success" : "empty"
	return outcome(status, bounded(lines.join("\n")), all)
}

/**
 * The signed-in account's bookmark folders, by X's paging. `full` says the last page held X's per-request maximum with
 * no next token, so the account may have folders X did not list; `problem` names a problem X reported beside the list,
 * which also ends the reading.
 */
async function bookmarkFolders(userId: string, keys: UserKeys, ctx: CallContext): Promise<{ ok: true; folders: Json[]; full: boolean; problem: string | null } | Failure> {
	const folders: Json[] = []
	let cursor: string | null = null
	let full = false
	for (let page = 1; page <= FOLDER_PAGES; page++) {
		const answer = await xRead(`/2/users/${userId}/bookmarks/folders`, { max_results: FOLDER_PAGE_MAX, pagination_token: cursor ?? undefined }, `bookmark folders${page > 1 ? `, page ${page}` : ""}`, ctx, keys)
		if (!answer.ok) return answer
		const listed = dataItems(answer.body)
		folders.push(...listed)
		if (answer.problem) return { ok: true, folders, full: false, problem: answer.problem }
		cursor = nextToken(answer.body)
		full = !cursor && listed.length >= FOLDER_PAGE_MAX
		if (!cursor) break
	}
	return { ok: true, folders, full, problem: null }
}

/**
 * A folder's post ids (X lists ids only), newest first as X orders them, up to `limit`. `full` says a page held X's
 * per-request maximum with no next token before `limit` was reached, so the folder may hold more.
 */
async function folderPostIds(userId: string, folderId: string, limit: number, keys: UserKeys, ctx: CallContext): Promise<{ ids: string[]; pages: number; more: boolean; full: boolean; error: string | null }> {
	const ids: string[] = []
	let cursor: string | null = null
	let pages = 0
	for (;;) {
		pages += 1
		const answer = await xRead(`/2/users/${userId}/bookmarks/folders/${folderId}`, { max_results: FOLDER_PAGE_MAX, pagination_token: cursor ?? undefined }, `bookmark folder ${folderId}${pages > 1 ? `, page ${pages}` : ""}`, ctx, keys)
		if (!answer.ok) return { ids, pages, more: true, full: false, error: answer.message }
		const listed = dataItems(answer.body)
		for (const item of listed) {
			const id = str(item.id)
			if (id && !ids.includes(id)) ids.push(id)
		}
		cursor = nextToken(answer.body)
		if (answer.problem) return { ids: ids.slice(0, limit), pages, more: true, full: false, error: answer.problem }
		const full = !cursor && listed.length >= FOLDER_PAGE_MAX && ids.length < limit
		if (!cursor || ids.length >= limit || pages >= MAX_SEARCH_PAGES) return { ids: ids.slice(0, limit), pages, more: Boolean(cursor) || ids.length > limit, full, error: null }
	}
}

/**
 * Posts by id through the multi-post lookup (app token), 100 per request, in the order given, by the lookup rules: a
 * requested post X names missing, protected or suspended is its answer, in a 2xx or a failed response (refusedLookup);
 * one X neither returned nor named, or a failed request that does not answer for every post, is a failure. `status` is
 * lookupStatus over the whole folder.
 */
async function lookupPosts(ids: string[], inc: Includes, ctx: CallContext, token: string): Promise<{ posts: Json[]; missing: Missing[]; failures: string[]; also: string[]; status: OutcomeStatus }> {
	const found = new Map<string, Json>()
	const missing: Missing[] = []
	const failures: string[] = []
	const also: string[] = []
	const resources: Json[] = []
	const chunks = Array.from({ length: Math.ceil(ids.length / LOOKUP_IDS) }, (_, i) => ids.slice(i * LOOKUP_IDS, (i + 1) * LOOKUP_IDS))
	for (const [index, chunk] of chunks.entries()) {
		const answer = await xGet("/2/tweets", { ...POST_PARAMS, ids: chunk.join(",") }, chunks.length > 1 ? `post lookup ${index + 1} of ${chunks.length}` : "post lookup", ctx, token)
		if (!answer.ok) {
			resources.push(...answer.resource)
			const refused = refusedLookup(chunk, answer, ["post", "posts"], "", null)
			if (refused.status === "empty") {
				missing.push(...refused.missing)
				if (answer.problem) also.push(answer.problem)
			} else {
				failures.push(answer.message)
				missing.push(...refused.missing.filter((item) => answered(answer.resource, item.id)))
			}
			continue
		}
		resources.push(...answer.resources)
		addIncludes(inc, answer.body)
		for (const post of dataItems(answer.body)) for (const id of [String(post.id), ...editHistory(post)]) found.set(id, post)
		if (answer.problem) failures.push(answer.problem)
		const unread = missingOf(chunk, new Set([...found.keys()].map((id) => id.toLowerCase())), answer.resources)
		missing.push(...unread)
		const unanswered = unread.filter((item) => !answered(answer.resources, item.id)).length
		if (unanswered) failures.push(`X returned neither ${count(unanswered, "post", "posts")} nor an error naming ${unanswered === 1 ? "it" : "them"}`)
	}
	const posts = [...new Set(ids.map((id) => found.get(id)).filter((post): post is Json => post !== undefined))]
	// A failed request leaves its unnamed posts out of `missing`, so with nothing returned it fails the lookup outright.
	const status = failures.length && !posts.length ? "failed" : lookupStatus(posts.length, missing, resources, failures.length)
	return { posts, missing, failures, also, status }
}

export const bookmarks: ToolSpec = {
	description:
		"Read the signed-in account's X bookmarks, newest first: limit posts (1-800, default 50), or those of one bookmark folder (folder: its name, matched case-insensitively, or its numeric id). match keeps only posts in which every one of its words starts a word (case-insensitive; \"ai\" matches AI, AI's and #AI but not brainstorm, \"agent\" matches agents) in their text, long-form text, author's handle or name, links' addresses, or the text of a post they quote or repost; X has no search inside bookmarks, so Dig filters what it read and says how many posts it read and how many match. " +
		`Needs X sign-in (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET) and reads as that account; a folder lists post ids only, so its posts are read through the post lookup with X_BEARER_TOKEN. ${OWNED_READS} A folder's posts are priced as ordinary post lookups.`,
	async execute(args, context) {
		const folder = typeof args.folder === "string" ? args.folder.trim() : ""
		const limit = Number(args.limit ?? OWN_LIMIT)
		const words = matchWords(args.match)
		const keys = userKeys()
		const token = bearerToken()
		if ("missing" in keys) return failed(`${missingUserKeys(folder ? "Reading a bookmark folder" : "Reading bookmarks", keys.missing)}${folder && !token ? ` A folder's posts are then read through the post lookup, which also needs ${KEY}.` : ""}`)
		if (folder && !token) return failed(`A bookmark folder lists post ids only, and Dig reads its posts through the post lookup, which needs ${KEY}. ${missingKey}`)
		const me = await signedInAccount(keys, context)
		if (!me.ok) return failed(me.message)
		const who = me.handle ? `@${me.handle}` : `account ${me.id}`
		const inc = newIncludes()
		if (!folder) {
			const result = await readPages({ path: `/2/users/${me.id}/bookmarks`, params: {}, limit, label: "bookmarks", cursor: "pagination_token", size: BOOKMARKS_PAGE }, inc, context, keys)
			return ownOutcome({ title: `X bookmarks of ${who}`, noun: "bookmarks", ...result, missing: [], failures: [] }, words, inc, { endpoint: "/2/users/:id/bookmarks" })
		}
		const listed = await bookmarkFolders(me.id, keys, context)
		if (!listed.ok) return failed(listed.message)
		const chosen = listed.folders.find((item) => str(item.id) === folder) ?? listed.folders.find((item) => String(item.name ?? "").toLowerCase() === folder.toLowerCase())
		const names = listed.folders.map((item) => `"${String(item.name ?? item.id)}"`)
		const shown = names.length ? `X listed ${count(names.length, "folder", "folders")}: ${names.join(", ")}.` : "X listed no bookmark folders."
		if (!chosen) {
			// A list X did not give whole cannot show that the folder is absent.
			if (listed.problem || listed.full) {
				const why = listed.problem ?? `X's folder list returned ${FOLDER_PAGE_MAX} folders, its maximum per request, and no way to read further`
				return failed(`Dig could not tell whether ${who} has a bookmark folder named or numbered "${folder}": the folder list was incomplete (${why}). ${shown}`)
			}
			return failed(`${who} has no bookmark folder named or numbered "${folder}". ${names.length ? `X lists ${count(names.length, "folder", "folders")}: ${names.join(", ")}.` : "X lists no bookmark folders for this account."}`)
		}
		const folderId = String(chosen.id)
		const name = str(chosen.name) ?? folderId
		const listing = await folderPostIds(me.id, folderId, limit, keys, context)
		const title = `X bookmarks of ${who}, folder "${name}"`
		if (listing.error && !listing.ids.length) return failed(listing.error)
		const looked = listing.ids.length ? await lookupPosts(listing.ids, inc, context, token ?? "") : { posts: [], missing: [], failures: [], also: [], status: "empty" as OutcomeStatus }
		const incomplete = [
			...(listed.problem ? [`The folder list reported a problem, though it listed this folder: ${listed.problem}`] : []),
			...(listing.full ? [`X's folder endpoint returned ${FOLDER_PAGE_MAX} post ids, its maximum per request, and no way to read further; the folder may hold more.`] : []),
		]
		return ownOutcome({ title, noun: "posts in this folder", posts: looked.posts, more: listing.more, capped: false, pages: listing.pages, error: listing.error, missing: looked.missing, failures: looked.failures, incomplete, lookup: looked.status, also: looked.also }, words, inc, { endpoint: "/2/users/:id/bookmarks/folders/:folder_id", folder: folderId, listed: listing.ids.length })
	},
}

export const likes: ToolSpec = {
	description:
		"Read the posts the signed-in X account has liked, newest first: limit posts (1-800, default 50). match keeps only posts in which every one of its words starts a word (case-insensitive; \"ai\" matches AI, AI's and #AI but not brainstorm, \"agent\" matches agents) in their text, long-form text, author's handle or name, links' addresses, or the text of a post they quote or repost; X has no search inside likes, so Dig filters what it read and says how many posts it read and how many match. " +
		`Needs X sign-in (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET) and reads as that account. ${OWNED_READS}`,
	async execute(args, context) {
		const limit = Number(args.limit ?? OWN_LIMIT)
		const words = matchWords(args.match)
		const keys = userKeys()
		if ("missing" in keys) return failed(missingUserKeys("Reading liked posts", keys.missing))
		const me = await signedInAccount(keys, context)
		if (!me.ok) return failed(me.message)
		const inc = newIncludes()
		const result = await readPages({ path: `/2/users/${me.id}/liked_tweets`, params: {}, limit, label: "liked posts", cursor: "pagination_token", size: LIKES_PAGE }, inc, context, keys)
		return ownOutcome({ title: `X posts liked by ${me.handle ? `@${me.handle}` : `account ${me.id}`}`, noun: "liked posts", ...result, missing: [], failures: [] }, words, inc, { endpoint: "/2/users/:id/liked_tweets" })
	},
}

// ---------------------------------------------------------------------------
// x_community
// ---------------------------------------------------------------------------

const COMMUNITY_POSTS = 25

/** A Community id, or the id in an x.com or twitter.com Community link. */
function communityId(input: string): string | null {
	const value = input.trim()
	if (NUMERIC_ID.test(value)) return value
	const url = urlOf(value)
	if (!url || !POST_HOSTS.has(url.hostname.toLowerCase().replace(/^(?:www|mobile)\./, ""))) return null
	return url.pathname.match(/\/i\/communities\/(\d{1,19})(?:\/|$)/)?.[1] ?? null
}

/** A Community's details as X's Community lookup returns them. */
function communityDetails(community: Json): string[] {
	const members = num(community.member_count)
	return [
		[str(community.access), str(community.join_policy) ? `join policy ${community.join_policy}` : null, members === null ? null : count(members, "member", "members"), str(community.created_at) ? `created ${String(community.created_at).slice(0, 10)}` : null].filter(Boolean).join(" · "),
		...(str(community.description) ? [`Description: ${community.description}`] : []),
	].filter((line) => line !== "")
}

/** A Community's details as TikHub's fetch_community_info returns them; its `status` is TikHub's join status, not the read's. */
function tikhubCommunityDetails(community: Json): string[] {
	const members = num(community.member_count)
	const created = num(community.created_at)
	const topic = str(community.primary_topic) ?? str(rec(community.primary_topic)?.topic_name) ?? str(rec(community.primary_topic)?.name)
	const rules = recs(community.rules).map((rule, index) => `${index + 1}. ${[str(rule.name), str(rule.description)].filter(Boolean).join(": ")}`)
	return [
		[members === null ? null : count(members, "member", "members"), created === null ? null : `created ${new Date(created).toISOString().slice(0, 10)}`, topic ? `topic ${topic}` : null, community.is_nsfw === true ? "marked NSFW" : null].filter(Boolean).join(" · "),
		...(str(community.description) ? [`Description: ${community.description}`] : []),
		...(rules.length ? ["Rules:", ...rules] : []),
	].filter((line) => line !== "")
}

/**
 * A Community's posts through TikHub's fetch_community_timeline, paged with its cursor until `wanted`, no cursor or no
 * new post; `capped` says the page safety limit stopped it before `wanted`.
 */
async function tikhubCommunityPosts(id: string, wanted: number, ranking: string, apiKey: string, ctx: CallContext): Promise<{ posts: TikhubPost[]; pages: number; more: boolean; capped: boolean; error: string | null }> {
	const posts: TikhubPost[] = []
	const seen = new Set<string>()
	let cursor: string | null = null
	let pages = 0
	for (;;) {
		pages += 1
		const page = await tikhubGet("fetch_community_timeline", { community_id: id, ranking, cursor: cursor ?? undefined }, `fetch_community_timeline via TikHub${pages > 1 ? `, page ${pages}` : ""}`, apiKey, ctx)
		if ("error" in page) return { posts: posts.slice(0, wanted), pages, more: true, capped: false, error: page.error }
		const before = posts.length
		for (const item of recs(page.data.timeline)) {
			const post = tikhubPost(item)
			if (!post || seen.has(post.id)) continue
			seen.add(post.id)
			posts.push(post)
		}
		cursor = str(page.data.cursor) ?? str(page.data.next_cursor)
		if (posts.length >= wanted) return { posts: posts.slice(0, wanted), pages, more: Boolean(cursor) || posts.length > wanted, capped: false, error: null }
		if (!cursor || posts.length === before) return { posts, pages, more: false, capped: false, error: null }
		if (pages >= TIKHUB_PAGES) return { posts, pages, more: true, capped: true, error: null }
	}
}

export const community: ToolSpec = {
	description:
		"Read one X Community by id or link (https://x.com/i/communities/<id>, as posts and Communities searches show it): its details (name, description, members, access and join policy, or TikHub's topic and rules) and up to posts of its posts (0-500, default 25; 0 reads details only). sort recent (default) reads TikHub's Recency ranking and shows the posts read newest first by their own time; TikHub's ranking is not strictly by time, so a newer post may sit on a later page. sort relevant reads TikHub's Relevance ranking and keeps its order. " +
		"Details come from X's Community lookup with X_BEARER_TOKEN, or through TikHub (TIKHUB_API_KEY) without it. X's API has no Community timeline for an app, so the posts are always read through TikHub, labelled via TikHub; without TIKHUB_API_KEY the call returns the details and says the posts need it. Members are not read. X and TikHub report no per-call charge, so the cost is recorded as unknown.",
	async execute(args, context) {
		const id = communityId(String(args.community ?? ""))
		if (!id) return failed("community must be an X Community id or link such as https://x.com/i/communities/<id>.")
		const wanted = Number(args.posts ?? COMMUNITY_POSTS)
		const recent = args.sort !== "relevant"
		const token = bearerToken()
		const apiKey = tikhubKey()
		if (!token && !apiKey) return failed(`x_community reads a Community's details with ${KEY} or through TikHub, and its posts through TikHub; neither ${KEY} nor TIKHUB_API_KEY is set in Dig's keys.env.`)
		const failures: string[] = []
		let name: string | null = null
		let details: string[] = []
		let source: string | null = null
		if (token) {
			const answer = await xGet(`/2/communities/${id}`, { "community.fields": COMMUNITY_FIELDS.join(",") }, `Community ${id}`, context, token)
			// X naming the Community missing, protected or suspended answers for it; it is not read elsewhere.
			if (!answer.ok && answer.resource.length) {
				const refused = refusedLookup([id], answer, ["Community", "Communities"], "", null)
				return outcome(refused.status, refused.text, { community: id, posts: 0 })
			}
			const data = answer.ok ? rec(answer.body.data) : null
			if (answer.ok && !data) {
				const none = noneReturned([id], answer.resources, ["Community", "Communities"], "")
				return outcome(none.status, none.text, { community: id, posts: 0 })
			}
			if (!answer.ok) failures.push(answer.message)
			else if (data) {
				name = str(data.name)
				details = communityDetails(data)
				source = "X API"
				if (answer.problem) failures.push(answer.problem)
			}
		} else if (apiKey) {
			const info = await tikhubGet("fetch_community_info", { community_id: id }, "fetch_community_info via TikHub", apiKey, context)
			if ("error" in info) failures.push(info.error)
			else if (!str(info.data.name)) failures.push(`TikHub fetch_community_info returned no Community ${id}`)
			else {
				name = str(info.data.name)
				details = tikhubCommunityDetails(info.data)
				source = "TikHub"
			}
		}
		let postLines: string[] = []
		let postsRead = 0
		if (wanted > 0) {
			if (!apiKey) failures.push("the Community's posts: Dig reads them through TikHub, which needs TIKHUB_API_KEY, and it is not set in Dig's keys.env")
			else {
				const result = await tikhubCommunityPosts(id, wanted, recent ? "Recency" : "Relevance", apiKey, context)
				postsRead = result.posts.length
				if (result.error) failures.push(result.error)
				// The page safety limit stopping the reading before `posts` is a shortfall, named, and makes the call partial.
				if (result.capped) failures.push(`the rest of the Community's posts: TikHub paging stopped at its ${TIKHUB_PAGES}-page safety limit after ${count(postsRead, "post", "posts")} of the ${wanted} asked for`)
				// TikHub's Recency ranking is not time order (live pages mix days), so recent shows the posts read by their own time.
				const shown = recent ? result.posts.map((post, index) => ({ post, index, at: Date.parse(post.createdAt ?? "") })).sort((a, b) => (Number.isNaN(b.at) ? -1 : Number.isNaN(a.at) ? 1 : b.at - a.at) || a.index - b.index).map(({ post }) => post) : result.posts
				const order = recent
					? `${count(postsRead, "post", "posts")} read through TikHub's Recency ranking, shown newest first${result.more ? "; TikHub has more" : ""}. TikHub's ranking is not strictly by time, so a newer post may sit on a later page.`
					: `${count(postsRead, "post", "posts")} read in TikHub's Relevance ranking, in its order${result.more ? "; TikHub has more" : ""}.`
				postLines = [
					`Posts via TikHub: ${order}`,
					...(result.error && postsRead ? [`Page ${result.pages} failed, so later posts may be missing: ${result.error}`] : []),
					...(postsRead ? [ZERO_NOTE, ...shown.flatMap(formatTikhubListPost)] : result.error ? [] : ["TikHub returned no posts for this Community."]),
				]
			}
		}
		const head = `X Community ${id}${name ? ` "${name}"` : ""} (${communityLink(id)}): ${source ? `details ${source === "TikHub" ? "via TikHub" : "from the X API"}` : "details not read"}${wanted > 0 ? `, ${count(postsRead, "post", "posts")} via TikHub` : ""}.`
		const lines = [head, ...(failures.length ? [`Not read: ${failures.join(" | ")}`] : []), ...withGap(details), ...withGap(postLines)]
		const result = { community: id, details: source, posts: postsRead, ...(source === "TikHub" || postsRead ? { via: "TikHub" } : {}) }
		if (failures.length && !source && !postsRead) return outcome("failed", bounded([`ERROR: ${failures[0]}`, ...lines].join("\n")), result)
		return outcome(failures.length ? "partial" : "success", bounded(lines.join("\n")), result)
	},
}
