/**
 * Wayback Machine: the captures the Internet Archive holds for a web address, and the text of one capture.
 *
 *   - Captures: the CDX server, https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server
 *   - Nearest capture: the availability API, https://archive.org/help/wayback_api.php
 *   - A capture as captured (no banner, no rewritten links): https://web.archive.org/web/<timestamp>id_/<original>
 *
 * Free and keyless. Dig requests only archive.org and web.archive.org: the address being researched is never fetched,
 * and redirects are followed by hand only within web.archive.org.
 */
import { USER_AGENT } from "../../version.mjs"
import { keptJson, keptText } from "../http.js"
import { failed, free, outcome } from "../outcome.js"
import type { ToolContext, ToolSpec } from "../types.js"

const ARCHIVE = "https://web.archive.org"
const MATCHES = ["exact", "prefix", "host", "domain"]
const MATCH_TEXT: Record<string, string> = { exact: "this exact address", prefix: "addresses under this prefix", host: "this host", domain: "this domain and its subdomains" }
const FIELDS = ["timestamp", "original", "mimetype", "statuscode", "length"]
const MAX_REDIRECTS = 3
/** As dataforseo_docs_read, the other character-paged read: 40,000 characters by default, at most 100,000. */
const READ_LIMIT = 40_000, READ_MAX = 100_000
const DAY = 86_400_000

const request = (url: URL | string, ctx: ToolContext) => fetch(url, { redirect: "manual", signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(60_000)]), headers: { "User-Agent": USER_AGENT } })

/** An http(s) web address, `https://` added to a bare host; anything else is refused before any request. */
export function webAddress(value: unknown): URL {
  const text = String(value ?? "").trim()
  let url: URL | undefined
  try { url = new URL(/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) ? text : `https://${text}`) } catch {}
  if (!url || !/^https?:$/.test(url.protocol) || !url.hostname.includes(".") || url.username || url.password) throw new Error("url must be an http(s) web address, such as example.com/page or https://example.com/page")
  return url
}

/** A 14-digit capture timestamp as epoch milliseconds, or undefined when it is not a real UTC time. */
function stamp(ts: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts)
  if (!m) return undefined
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  const at = Date.UTC(y, mo - 1, d, h, mi, s), date = new Date(at)
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && h < 24 && mi < 60 && s < 60 ? at : undefined
}
const readable = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)} UTC`

/** `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (or, for a read, a 14-digit timestamp): the archive's digits and the UTC period they cover. */
function period(value: unknown, name: string, exact = false): { digits: string; start: number; end: number } {
  const text = String(value).trim()
  if (exact && /^\d{14}$/.test(text)) {
    const at = stamp(text)
    if (at === undefined) throw new Error(`${name} ${text} is not a real time`)
    return { digits: text, start: at, end: at + 1000 }
  }
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text)
  if (!m) throw new Error(`${name} must be YYYY, YYYY-MM or YYYY-MM-DD${exact ? ", or a 14-digit capture timestamp" : ""}`)
  const y = Number(m[1]), mo = m[2] ? Number(m[2]) : 1, d = m[3] ? Number(m[3]) : 1
  const start = Date.UTC(y, mo - 1, d), date = new Date(start)
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) throw new Error(`${name} ${text} is not a real date`)
  const end = m[3] ? Date.UTC(y, mo - 1, d + 1) : m[2] ? Date.UTC(y, mo, 1) : Date.UTC(y + 1, 0, 1)
  return { digits: text.replaceAll("-", ""), start, end }
}

function size(length: string): string {
  const n = Number(length)
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(n)) return "size not recorded"
  return `${n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`} stored`
}

export const snapshots = free({
  description:
    "List the captures the Internet Archive's Wayback Machine holds for a web address, oldest first, from its CDX server: each capture's time (UTC), HTTP status, media type, stored size (the archive's compressed record, not the page's size) and the address that opens it. " +
    "Narrow by from/to dates; match the exact address (default), every address under a path prefix, a host or a whole domain. " +
    "By default a capture identical to the one before is left out, so the list shows when the content changed. " +
    "When there are more captures, the text gives the resumeKey for the next page. Free; no account or key.",
  async execute(args, ctx) {
    try {
      const url = webAddress(args.url)
      const match = args.match ?? "exact", limit = args.limit ?? 20, changesOnly = args.changesOnly ?? true
      if (!MATCHES.includes(match)) throw new Error(`match must be one of ${MATCHES.join(", ")}`)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be a whole number from 1 to 100")
      const from = args.from === undefined ? undefined : period(args.from, "from")
      const to = args.to === undefined ? undefined : period(args.to, "to")
      if (from && to && from.start >= to.end) throw new Error("from must not be after to")
      const resumeKey = args.resumeKey === undefined ? undefined : String(args.resumeKey).trim()
      if (resumeKey === "") throw new Error("resumeKey must be the key a previous wayback_snapshots call printed")
      const query = new URLSearchParams({ url: url.href, output: "json", fl: FIELDS.join(","), limit: String(limit), showResumeKey: "true" })
      if (match !== "exact") query.set("matchType", match)
      if (from) query.set("from", from.digits)
      if (to) query.set("to", to.digits)
      if (changesOnly) query.set("collapse", "digest")
      if (resumeKey) query.set("resumeKey", resumeKey)
      const response = await request(`${ARCHIVE}/cdx/search/cdx?${query}`, ctx)
      if (!response.ok) { await keptText(response, ctx.keep, "captures"); return failed(`The Wayback Machine's capture index returned HTTP ${response.status}`) }
      const rows = await keptJson(response, ctx.keep, "captures")
      ctx.abort.throwIfAborted()
      const range = [from ? `from ${args.from}` : "", to ? `to ${args.to}` : ""].filter(Boolean).join(" ")
      if (!Array.isArray(rows)) throw new Error("the capture index returned an unexpected response")
      if (!rows.length) return outcome("empty", `The Wayback Machine has no capture of ${url.href}${range ? ` ${range}` : ""} (${MATCH_TEXT[match]}).`)
      const [head, ...rest] = rows
      if (!Array.isArray(head) || head.join(",") !== FIELDS.join(",")) throw new Error("the capture index returned an unexpected header")
      const captures: string[][] = []
      let next: string | undefined
      for (let i = 0; i < rest.length; i++) {
        const row = rest[i]
        if (Array.isArray(row) && row.length === 0) { next = rest[i + 1]?.[0]; if (typeof next !== "string" || !next) throw new Error("the capture index returned an unreadable resume key"); break }
        if (!Array.isArray(row) || row.length !== FIELDS.length || row.some(field => typeof field !== "string") || stamp(row[0]) === undefined) throw new Error("the capture index returned a malformed capture")
        captures.push(row)
      }
      const scope = [MATCH_TEXT[match], range, changesOnly ? "identical consecutive captures left out" : "every capture"].filter(Boolean).join(", ")
      const more = next ? `More captures: call wayback_snapshots again with the same arguments and resumeKey "${next}".` : resumeKey ? "No further captures." : "These are all the captures."
      if (!captures.length) return outcome("empty", `The Wayback Machine has no further captures of ${url.href} (${scope}).`)
      const lines = captures.map(([ts, original, type, status, length]) => `- ${readable(ts)} · HTTP ${status} · ${type} · ${size(length)} · ${ARCHIVE}/web/${ts}/${original}`)
      return outcome("success", `Wayback Machine captures of ${url.href} (${scope}): ${captures.length} shown, oldest first${resumeKey ? ", continuing an earlier list" : ""}.\n\n${lines.join("\n")}\n\n${more}`, { captures: captures.length, ...(next ? { resumeKey: next } : {}) })
    } catch (error) {
      ctx.abort.throwIfAborted()
      return failed(`Wayback Machine captures failed: ${error instanceof Error ? error.message : "unknown error"}`)
    }
  },
} satisfies ToolSpec)

export const read = free({
  description:
    "Read what a web page said on a date, from the Internet Archive's Wayback Machine. Finds the capture nearest the date (without a date, the newest capture) through the archive's availability API, confirming against its capture index before saying there is none, then reads the page exactly as captured, without the archive's banner, as readable text. " +
    "The text names the capture's time (UTC), how many days it is from the date asked for, the address that opens the capture and the original address. " +
    "Reads HTML and plain-text captures; a PDF or image capture is named but not read. Use offset to continue a long page. Also recovers a page behind a dead link. Free; no account or key.",
  async execute(args, ctx) {
    try {
      const url = webAddress(args.url)
      const asked = args.date === undefined ? undefined : period(args.date, "date", true)
      const offset = args.offset ?? 0, limit = args.limit ?? READ_LIMIT
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > READ_MAX) throw new Error(`offset must be a whole number from 0 and limit from 1 to ${READ_MAX}`)
      const query = new URLSearchParams({ url: url.href })
      if (asked) query.set("timestamp", asked.digits)
      const lookup = await request(`https://archive.org/wayback/available?${query}`, ctx)
      if (!lookup.ok) { await keptText(lookup, ctx.keep, "availability"); return failed(`The Wayback Machine's availability lookup returned HTTP ${lookup.status}`) }
      const found = (await keptJson(lookup, ctx.keep, "availability")) as any
      if (!found || typeof found !== "object" || !found.archived_snapshots || typeof found.archived_snapshots !== "object") throw new Error("the availability lookup returned an unexpected response")
      const closest = found.archived_snapshots.closest
      let listed: string[] | null = null
      if (closest && closest.available !== false) {
        listed = /^https?:\/\/web\.archive\.org\/web\/(\d{14})\/(.+)$/.exec(String(closest.url ?? ""))
        if (!listed) throw new Error("the availability lookup returned a capture address Dig cannot read")
      } else {
        // The availability lookup sometimes answers with no capture for a page the archive holds (seen on a live
        // call), so its empty answer is confirmed against the capture index before it is reported: the capture nearest
        // the date, or the newest, among those that returned the page.
        const index = new URLSearchParams({ url: url.href, output: "json", fl: "timestamp,original", filter: "statuscode:200", limit: asked ? "1" : "-1" })
        if (asked) { index.set("closest", asked.digits); index.set("sort", "closest") }
        const confirm = await request(`${ARCHIVE}/cdx/search/cdx?${index}`, ctx)
        if (!confirm.ok) { await keptText(confirm, ctx.keep, "capture index"); return failed(`The Wayback Machine's availability lookup named no capture, and its capture index, asked to confirm, returned HTTP ${confirm.status}. This is not evidence that the archive holds no capture.`) }
        const rows = await keptJson(confirm, ctx.keep, "capture index")
        if (!Array.isArray(rows)) throw new Error("the capture index returned an unexpected response")
        const row = rows[1]
        if (!Array.isArray(row) || !/^\d{14}$/.test(String(row[0])) || typeof row[1] !== "string" || !row[1]) return outcome("empty", `The Wayback Machine has no capture of ${url.href} that it can show: it holds none, or the site has asked to be excluded.`)
        listed = ["", String(row[0]), row[1]]
      }
      let target = new URL(`${ARCHIVE}/web/${listed[1]}id_/${listed[2]}`)
      let response: Response
      for (let hop = 0; ; hop++) {
        ctx.abort.throwIfAborted()
        const label = `capture ${/^\/web\/(\d{1,14})/.exec(target.pathname)?.[1] ?? hop}`
        response = await request(target, ctx)
        const location = response.headers.get("location")
        if (response.status < 300 || response.status >= 400 || !location) break
        await keptText(response, ctx.keep, label)
        const next = new URL(location, target)
        if (next.hostname !== "web.archive.org" || !/^https?:$/.test(next.protocol)) return failed(`The archive redirected the capture to another host (${next.host}); Dig follows redirects only within web.archive.org`)
        if (hop >= MAX_REDIRECTS) return failed(`The archive redirected the capture more than ${MAX_REDIRECTS} times`)
        next.protocol = "https:"
        target = next
      }
      const label = `capture ${/^\/web\/(\d{1,14})/.exec(target.pathname)?.[1] ?? "page"}`
      // A replayed capture carries Memento-Datetime, whatever status the page answered when captured; anything else is the archive's own error.
      if (!response.headers.has("memento-datetime") && !response.ok) { await keptText(response, ctx.keep, label); return failed(`The Wayback Machine returned HTTP ${response.status} for the capture`) }
      const final = /^\/web\/(\d{14})id_\/(.+)$/.exec(`${target.pathname}${target.search}`)
      const at = final ? stamp(final[1]) : undefined
      if (!final || at === undefined) { await keptText(response, ctx.keep, label); throw new Error("the archive answered from an address that names no capture") }
      const [, ts, original] = final
      const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
      const head = [
        `Captured ${readable(ts)}${response.status === 200 ? "" : `; the page answered HTTP ${response.status} when captured`}; ${type || "no media type given"}.`,
        ...(asked ? [`Asked for ${args.date}: ${distance(at, asked)}.`] : []),
        `Capture: ${ARCHIVE}/web/${ts}/${original}`,
        `Original: ${original}`,
        ...(original !== listed[2] ? [`The archive redirected the capture of ${listed[2]} here.`] : []),
      ]
      if (type && !/^text\//.test(type) && type !== "application/xhtml+xml") {
        ctx.keep(label, response.status, `[${type} capture not retained: Dig reads only HTML and text captures]`)
        await response.body?.cancel()
        return outcome("partial", `# ${original}\n\n${head.join("\n")}\n\nDig reads only HTML and text captures, and this capture is ${type}; open it at the capture address.`)
      }
      const body = await decoded(response, ctx, label)
      const html = type === "text/html" || type === "application/xhtml+xml" || (!type && /<(?:!doctype html|html|body)\b/i.test(body))
      const page = html ? pageText(body) : { title: "", text: body }
      const name = page.title || original
      if (!page.text.trim()) return outcome("empty", `# ${name}\n\n${head.join("\n")}\n\nThe capture has no readable text. Pages built by scripts in the browser often capture this way: the archive keeps the page as the server sent it, before any script ran.`)
      if (offset > 0 && offset >= page.text.length) throw new Error(`offset ${offset} is past the end of the text (${page.text.length} characters)`)
      const slice = page.text.slice(offset, offset + limit), end = offset + slice.length
      const more = end < page.text.length ? end : null
      return outcome(
        "success",
        `# ${name}\n\n${head.join("\n")}\nCharacters ${offset}–${end} of ${page.text.length}${more === null ? ", complete" : ""}.\n\n${slice}${more === null ? "" : `\n\nThe text continues: call wayback_read with url "${url.href}", date "${ts}" and offset ${more}.`}`,
        { capture: `${ARCHIVE}/web/${ts}/${original}`, totalCharacters: page.text.length, nextOffset: more },
      )
    } catch (error) {
      ctx.abort.throwIfAborted()
      return failed(`Wayback Machine read failed: ${error instanceof Error ? error.message : "unknown error"}`)
    }
  },
} satisfies ToolSpec)

/** How far a capture is from the period asked for, in whole days. */
function distance(at: number, asked: { start: number; end: number }): string {
  if (at >= asked.start && at < asked.end) return asked.end - asked.start === 1000 ? "this is that capture" : "the capture falls within it"
  const ms = at < asked.start ? asked.start - at : at - asked.end + 1, days = Math.round(ms / DAY)
  return `the nearest capture is ${days < 1 ? "less than a day" : days === 1 ? "1 day" : `${days.toLocaleString("en-US")} days`} ${at < asked.start ? "before" : "after"} it`
}

/** The body decoded by its declared character set (the header's, else the page's own meta tag; UTF-8 otherwise), then kept. */
async function decoded(response: Response, ctx: ToolContext, label: string): Promise<string> {
  let bytes: Uint8Array
  try { bytes = new Uint8Array(await response.arrayBuffer()) }
  catch (error) { ctx.keep(label, response.status, "", undefined, true); throw error }
  const declared = /charset=["']?([\w.:-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1] ?? /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 4096)))?.[1]
  let decoder: TextDecoder
  try { decoder = new TextDecoder(declared ?? "utf-8") } catch { decoder = new TextDecoder() }
  return keptText(new Response(decoder.decode(bytes), { status: response.status, headers: { "content-type": "text/plain; charset=utf-8" } }), ctx.keep, label)
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", euro: "€", pound: "£", cent: "¢", sect: "§", para: "¶", shy: "" }
/** Numeric and common named character references, in one pass so an escaped reference stays literal; unknown names stay as written. */
function entities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? whole
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

const BLOCK = "address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul"
/** A page's title and readable text: scripts, styles, templates, SVG and comments dropped; block ends and <br> as line breaks; link text kept. */
export function pageText(html: string): { title: string; text: string } {
  const clean = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/<(script|style|noscript|template|svg)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
  const title = entities(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(clean)?.[1].replace(/<[^>]*>/g, "") ?? "").replace(/\s+/g, " ").trim()
  const text = entities(clean
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "")
    .replace(/\s+/g, " ")
    .replace(new RegExp(`<\\/?(?:${BLOCK})\\b[^>]*>|<br\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, ""))
  return { title, text: text.split("\n").map(line => line.replace(/[ \t ]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim() }
}
