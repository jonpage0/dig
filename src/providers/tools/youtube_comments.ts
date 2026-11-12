/**
 * One page of a YouTube video's comments through ScrapeCreators (tool `youtube_comments`), one request per call.
 *
 * Endpoint contract follows https://docs.scrapecreators.com/v1/youtube/video/comments.md (read 2026-11-10):
 * GET /v1/youtube/video/comments (url, order top|newest, continuationToken) → comments[] with id, content,
 * publishedTimeText, publishedTime (a best-effort ISO time computed from YouTube's relative label), replyLevel,
 * author {name, channelId, isVerified, isCreator, channelUrl}, engagement {likes, replies}; and the next page's
 * continuationToken. The docs put the reachable depth at about 1,000 top or 7,000 newest comments.
 *
 * The whole returned page is shown unless `limit` narrows it; the request is never narrowed. Comment text is shown in
 * full; the whole output is cut at OUTPUT_LIMIT with a pointer to the retained original.
 */
import type { OutcomeStatus } from "../outcome.js"
import { knownSecrets, redactText } from "../secrets.js"
import type { ToolContext, ToolSpec } from "../types.js"
import {
  MISSING_KEY_ERROR,
  asNumber,
  asRecord,
  asString,
  continuesAfter,
  creditMetered,
  expectArray,
  failText,
  fmtNum,
  isoDate,
  knownCharge,
  provenanceLine,
  scrapecreatorsHeaders,
  scrapecreatorsRequest,
  validateEnum,
} from "./scrapecreators.js"
import { youtubeVideoId } from "./youtube_transcript.js"

interface CommentsArgs {
  url?: string
  order?: string
  cursor?: string
  limit?: number
}

const ORDER_VALUES = ["top", "newest"] as const
const PATH = "/v1/youtube/video/comments"
const WATCH_URL = "https://www.youtube.com/watch?v="
const LABEL = "ScrapeCreators YouTube comments"
/** The model-facing text is cut here; the complete response stays in the call's retained original. */
const OUTPUT_LIMIT = 60_000
const TRUNCATION_NOTE = "The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file."
const SAMPLE_NOTE =
  "One provider page is a sample in YouTube's ordering, not a cross-section: top comments are the most liked, newest the latest. Quote a comment with its author and date; a page of comments is not a measure of what viewers think."

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

function commentLines(comment: Record<string, unknown>, index: number): string[] {
  const author = asRecord(comment.author) ?? {}
  const engagement = asRecord(comment.engagement) ?? {}
  const date = isoDate(comment.publishedTime)
  const relative = asString(comment.publishedTimeText)
  const likes = asNumber(engagement.likes)
  const replies = asNumber(engagement.replies)
  const facts = [
    asString(author.name) ?? "(author not returned)",
    date ? `${date}${relative ? ` (about; YouTube shows "${relative}")` : ""}` : relative ? `YouTube shows "${relative}"` : "date not returned",
    likes === null ? "likes not returned" : `${fmtNum(likes)} ${likes === 1 ? "like" : "likes"}`,
    replies === null ? "replies not returned" : plural(replies, "reply", "replies"),
    author.isCreator === true && "written by the channel owner",
    author.isVerified === true && "verified author",
    asNumber(comment.replyLevel) !== null && asNumber(comment.replyLevel)! > 0 && "a reply",
  ].filter((fact): fact is string => typeof fact === "string")
  const text = String(comment.content)
  return [`${index + 1}. ${facts.join(" — ")}`, ...text.split("\n").map((line) => (line.trim() ? `   ${line}` : ""))]
}

/** `tail` (the next-page line) is kept after a cut, so a shortened page still says how to continue. */
function result(status: OutcomeStatus, lines: string[], details: Record<string, unknown>, tail?: string) {
  const text = lines.join("\n")
  const truncated = text.length > OUTPUT_LIMIT
  const body = truncated ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${text.length} characters. ${TRUNCATION_NOTE}]` : text
  return {
    // Text cut by Dig's own limit is part of the answer not delivered: partial.
    status: truncated && status === "success" ? "partial" as const : status,
    text: tail ? `${body}\n\n${tail}` : body,
    details: { provider: "scrapecreators", ...details, truncated },
  }
}

/** One page of a video's comments in top or newest order, with the continuation for the next. */
export const comments = creditMetered({
  description:
    "Read one page of comments on a public YouTube video or Short through ScrapeCreators, one request per call. " +
    "order: top or newest; pass the returned cursor, with the same url and order, for the next page. " +
    "Each comment is shown in full with its author, date, likes, reply count and whether the channel owner wrote it. " +
    "The whole returned page is shown unless limit narrows the display. A page is a sample in YouTube's ordering, not a measure of what viewers think. " +
    "Requires SCRAPECREATORS_API_KEY; 1 credit per request.",
  async execute(args: CommentsArgs, ctx: ToolContext) {
    const headers = scrapecreatorsHeaders()
    if (!headers) return `ERROR: ${MISSING_KEY_ERROR}`
    let id: string
    try {
      id = youtubeVideoId(args.url, "url")
    } catch (error) {
      return `ERROR: ${redactText(error instanceof Error ? error.message : "url must be a valid YouTube video ID or URL", knownSecrets())}`
    }
    const invalid = validateEnum("order", args.order, ORDER_VALUES)
    if (invalid) return `ERROR: ${invalid}`
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) return "ERROR: limit must be a positive whole number."
    const cursor = args.cursor?.trim() || undefined
    const video = `${WATCH_URL}${id}`

    const response = await scrapecreatorsRequest(PATH, { url: video, order: args.order, continuationToken: cursor }, headers, ctx, LABEL)
    if (!response.ok) return failText(response)
    const payload = response.payload
    const listed = expectArray(payload, "comments", LABEL)
    if (!listed.ok) return `ERROR: ${listed.error}`
    const readable: Array<Record<string, unknown>> = []
    let unreadable = 0
    for (const entry of listed.items) {
      const comment = asRecord(entry)
      if (comment && typeof comment.content === "string") readable.push(comment)
      else unreadable += 1
    }
    if (!readable.length && unreadable) return `ERROR: ${LABEL} returned an unexpected payload: none of the ${plural(unreadable, "entry", "entries")} carried comment text (content)`
    const shown = args.limit === undefined ? readable : readable.slice(0, args.limit)
    const next = asString(payload.continuationToken)

    const lines = [
      `YouTube comments: ${video}`,
      `Order: ${args.order ?? "provider default (no order sent; ScrapeCreators documents top and newest)"} | ${cursor ? "continuation page" : "first page"}`,
      provenanceLine(payload, response.charges),
      `Comments returned: ${readable.length}${shown.length < readable.length ? ` | ${shown.length} shown of ${readable.length} returned (limit=${args.limit})` : ""}`,
    ]
    if (unreadable) lines.push(`Unreadable entries: ${plural(unreadable, "returned entry", "returned entries")} carried no comment text and ${unreadable === 1 ? "was" : "were"} skipped; see the retained original.`)
    const details = {
      video_id: id,
      order: args.order ?? null,
      returned: readable.length,
      shown: shown.length,
      unreadable,
      cursor: next,
      comment_ids: shown.map((comment) => asString(comment.id)).filter((value): value is string => value !== null),
      credits_charged: knownCharge(response.charges),
    }
    if (!readable.length) {
      lines.push("", "YouTube returned no comments for this video and order. Comments may be turned off, or the page may be past the provider's reachable depth; this does not show that nobody commented.")
      return result("empty", lines, details)
    }
    lines.push(SAMPLE_NOTE)
    for (const [index, comment] of shown.entries()) lines.push("", ...commentLines(comment, index))
    const tail = next
      ? `Next page: pass cursor="${next}" with the same url and order${continuesAfter(shown.length, readable.length, "comments")}.`
      : "Next page: no continuation returned; the provider gave no further page."
    return result(unreadable ? "partial" : "success", lines, details, tail)
  },
} satisfies ToolSpec)
