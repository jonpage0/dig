/**
 * X images: the pictures in X posts, returned to the model as images it can look at. Each link is one the X tools print
 * after "Media:" (a photo, or a video's preview image), on X's public image host, pbs.twimg.com.
 *
 * No X API request, no key and no charge. Each picture is one request to pbs.twimg.com: never retried, never
 * redirected, with the shared User-Agent. Observed behaviour of the host: a photo (`/media/<id>.<ext>`) is served in
 * X's sized variants through the `name` query parameter (small, medium, large), a link without `name` is served at
 * medium and an unknown `name` is a 404; a video's preview image (`amplify_video_thumb`, `ext_tw_video_thumb`) has one
 * size and ignores `name`. So every request sets `name` to the size asked for.
 *
 * The pictures are not retained (the library holds JSON and Markdown): one note per picture, with the link, the media
 * type and the size in bytes, stands in their place, as wayback_read does for a capture it does not keep.
 */
import { USER_AGENT } from "../../version.mjs"
import { failed, free, outcome, type ToolOutcome } from "../outcome.js"
import type { ToolSpec } from "../types.js"

const HOST = "pbs.twimg.com"
const SIZES = ["small", "medium", "large"]
const MAX_IMAGES = 4
const MAX_BYTES = 4 * 1024 * 1024
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]
const TIMEOUT_MS = 60_000
const ACCEPTED = `images must be 1 to ${MAX_IMAGES} X image links on https://${HOST}, as x_post, x_search_posts and the other X tools print them after "Media:" (a photo's link, or a video's preview link)`

/** An X image link, refused before any request when it is not https on exactly pbs.twimg.com, without credentials or a port. */
function imageLink(value: unknown): URL {
  const text = String(value ?? "").trim()
  let url: URL | undefined
  try { url = new URL(text) } catch {}
  const why = !url ? "is not a link" : url.protocol !== "https:" ? "is not https" : url.hostname !== HOST ? `is on ${url.hostname}, not ${HOST}` : url.username || url.password ? "carries credentials" : url.port ? "carries a port" : ""
  if (why) throw new Error(`${ACCEPTED}; ${JSON.stringify(text.slice(0, 200))} ${why}`)
  return url!
}

/** The body, read to its end unless it passes the size limit (then null). */
async function bounded(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []; let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  const out = new Uint8Array(total); let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength }
  return out
}

const bytes = (n: number) => `${n.toLocaleString("en-US")} bytes`

export const images = free({
  returnsImages: true,
  description:
    `Look at the pictures in X posts. Give 1 to ${MAX_IMAGES} image links as x_post, x_search_posts and the other X tools print them after "Media:" (https://${HOST}/..., a photo's link or a video's preview link): each picture is fetched from X's image host and returned to you as an image, in the order given, after a text naming each link, whether it is shown, its media type and its size in bytes. ` +
    "size picks X's own sized variant of a photo: small, medium (default) or large; a video's preview image comes in one size. A picture that is redirected, is not a JPEG, PNG, WebP or GIF image, or is larger than 4 MB is not shown, with the reason. " +
    "Makes no X API request; no key and no charge. The pictures are not kept: a note of each one's link, media type and size stands in their place. What you say a picture shows is your own reading of it. For what a video shows, use xsearch.",
  async execute(args, ctx): Promise<ToolOutcome> {
    let links: URL[], size: string
    try {
      const asked = args.images
      if (!Array.isArray(asked) || asked.length < 1 || asked.length > MAX_IMAGES) throw new Error(`${ACCEPTED}; ${Array.isArray(asked) ? `${asked.length} were given` : "none was given"}`)
      size = args.size ?? "medium"
      if (!SIZES.includes(size)) throw new Error(`size must be ${SIZES.join(", ")} (X's own sized variants of a photo); ${JSON.stringify(String(size).slice(0, 40))} is not one`)
      links = asked.map(imageLink)
    } catch (error) {
      return failed(`X images refused before any request: ${error instanceof Error ? error.message : "unknown error"}`)
    }
    const lines: string[] = [], shown: { data: string; mimeType: string }[] = []
    for (const [i, link] of links.entries()) {
      link.searchParams.set("name", size)
      // One note per picture, in place of its bytes: the link, the media type and the size in bytes, and whether it was shown.
      const note = (status: number | string, type: string, length: number | null, result: string) => {
        ctx.keep(`image ${i + 1}`, status, `[picture not retained] ${link.href} · ${type || "no media type"} · ${length === null ? "size unknown" : bytes(length)} · ${result}`)
        lines.push(`${i + 1}. ${link.href} · ${result} · ${type || "no media type"} · ${length === null ? "size unknown" : bytes(length)}`)
      }
      let response: Response
      try {
        response = await fetch(link, { redirect: "manual", signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(TIMEOUT_MS)]), headers: { "User-Agent": USER_AGENT } })
      } catch (error) {
        ctx.abort.throwIfAborted()
        note("no response", "", null, `not shown: ${error instanceof Error && error.name === "TimeoutError" ? `no response within ${TIMEOUT_MS / 1000} seconds` : "the host could not be reached"}`)
        continue
      }
      const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
      const declared = Number(response.headers.get("content-length") ?? NaN)
      const length = Number.isSafeInteger(declared) && declared >= 0 ? declared : null
      const location = response.headers.get("location")
      const refuse = response.status >= 300 && response.status < 400
        ? `not shown: the host redirected it (HTTP ${response.status}${location ? ` to ${(() => { try { return new URL(location, link).host } catch { return "an unreadable address" } })()}` : ""}), and Dig follows no redirect`
        : !response.ok ? `not shown: the host answered HTTP ${response.status}`
          : !TYPES.includes(type) ? `not shown: not a JPEG, PNG, WebP or GIF image`
            : length !== null && length > MAX_BYTES ? "not shown: larger than 4 MB" : ""
      if (refuse) { await response.body?.cancel().catch(() => {}); note(response.status, type, length, refuse); continue }
      let body: Uint8Array | null
      try { body = await bounded(response) } catch {
        ctx.abort.throwIfAborted()
        note(response.status, type, length, "not shown: the picture did not arrive in full")
        continue
      }
      if (body === null) { note(response.status, type, length, "not shown: larger than 4 MB"); continue }
      if (!body.byteLength) { note(response.status, type, 0, "not shown: the host sent an empty response"); continue }
      note(response.status, type, body.byteLength, "shown")
      shown.push({ data: Buffer.from(body).toString("base64"), mimeType: type })
    }
    const status = shown.length === links.length ? "success" : shown.length ? "partial" : "failed"
    const head = status === "failed"
      ? `ERROR: ${links.length === 1 ? "The picture asked for could not be shown" : `None of the ${links.length} pictures asked for could be shown`} (X's image host, ${HOST}, size ${size}).`
      : `Pictures from X's image host (${HOST}), size ${size}: ${shown.length} of ${links.length} shown, in the order asked.`
    const close = status === "failed" ? [] : ["", "What you see is each picture as X serves it now. What you say a picture shows is your own reading of it: label it as such in a report, and quote any text in the picture exactly."]
    return { ...outcome(status, [head, "", ...lines, ...close].join("\n")), ...(shown.length && status !== "failed" ? { images: shown } : {}) }
  },
} satisfies ToolSpec)
