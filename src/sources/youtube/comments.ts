/**
 * One page of a YouTube video's comments through ScrapeCreators (tool `youtube_comments`), one request per call.
 */
import { Effect, Schema } from "effect";
import {
  defineAction,
  failed,
  outcome,
  type ActionOutcome,
  type OutcomeStatus,
} from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import {
  asNumber,
  asRecord,
  asString,
  continuesAfter,
  expectArray,
  failText,
  fmtNum,
  isoDate,
  knownCharge,
  MISSING_SCRAPECREATORS_KEY,
  provenanceLine,
  scrapecreatorsBilling,
  scrapecreatorsHeaders,
  scrapecreatorsRequest,
  validateEnum,
} from "../shared/scrapecreators.ts";
import { youtubeVideoId } from "./transcript.ts";

const ORDER_VALUES = ["top", "newest"] as const;
const PATH = "/v1/youtube/video/comments";
const WATCH_URL = "https://www.youtube.com/watch?v=";
const LABEL = "ScrapeCreators YouTube comments";
const OUTPUT_LIMIT = 60_000;
const TRUNCATION_NOTE =
  "The complete response is this call's original response when raw retention is on; read it with library_read using the receipt's raw file.";
const SAMPLE_NOTE =
  "One provider page is a sample in YouTube's ordering, not a cross-section: top comments are the most liked, newest the latest. Quote a comment with its author and date; a page of comments is not a measure of what viewers think.";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function commentLines(comment: Record<string, unknown>, index: number): string[] {
  const author = asRecord(comment.author) ?? {};
  const engagement = asRecord(comment.engagement) ?? {};
  const date = isoDate(comment.publishedTime);
  const relative = asString(comment.publishedTimeText);
  const likes = asNumber(engagement.likes);
  const replies = asNumber(engagement.replies);
  const replyLevel = asNumber(comment.replyLevel);
  const facts = [
    asString(author.name) ?? "(author not returned)",
    date
      ? `${date}${relative ? ` (about; YouTube shows "${relative}")` : ""}`
      : relative
        ? `YouTube shows "${relative}"`
        : "date not returned",
    likes === null ? "likes not returned" : `${fmtNum(likes)} ${likes === 1 ? "like" : "likes"}`,
    replies === null ? "replies not returned" : plural(replies, "reply", "replies"),
    author.isCreator === true && "written by the channel owner",
    author.isVerified === true && "verified author",
    replyLevel !== null && replyLevel > 0 && "a reply",
  ].filter((fact): fact is string => typeof fact === "string");
  const text = String(comment.content);
  return [`${index + 1}. ${facts.join(" — ")}`, ...text.split("\n").map((line) => (line.trim() ? `   ${line}` : ""))];
}

function buildResult(
  status: OutcomeStatus,
  lines: readonly string[],
  details: Record<string, unknown>,
  tail?: string,
): ActionOutcome {
  const text = lines.join("\n");
  const truncated = text.length > OUTPUT_LIMIT;
  const body = truncated
    ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} of ${text.length} characters. ${TRUNCATION_NOTE}]`
    : text;
  return outcome(
    truncated && status === "success" ? "partial" : status,
    tail ? `${body}\n\n${tail}` : body,
    { provider: "scrapecreators", ...details, truncated },
  );
}

const YouTubeCommentsSchema = Schema.Struct({
  url: Schema.String.annotate({ description: "YouTube video or Short URL, or the 11-character video ID." }),
  order: Schema.optionalKey(
    Schema.Literals(ORDER_VALUES).annotate({
      description:
        "Comment order: top (YouTube's most liked first) or newest. Omitted sends none and takes the provider's default.",
    }),
  ),
  cursor: Schema.optionalKey(
    Schema.String.annotate({
      description: "The cursor a previous page returned, with the same url and order; omit for the first page.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description:
        "Show at most this many of the returned comments. The request is unchanged and the whole page is paid for; the cursor still continues after every returned comment.",
    }),
  ),
});

export const youtubeCommentsAction = defineAction({
  name: "youtube_comments",
  description:
    "Read one page of comments on a public YouTube video or Short through ScrapeCreators, one request per call. " +
    "order: top or newest; pass the returned cursor, with the same url and order, for the next page. " +
    "Each comment is shown in full with its author, date, likes, reply count and whether the channel owner wrote it. " +
    "The whole returned page is shown unless limit narrows the display. A page is a sample in YouTube's ordering, not a measure of what viewers think. " +
    "Requires SCRAPECREATORS_API_KEY; 1 credit per request.",
  schema: YouTubeCommentsSchema,
  billing: scrapecreatorsBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const headers = scrapecreatorsHeaders();
      if (!headers) return failed(MISSING_SCRAPECREATORS_KEY);

      let id: string;
      try {
        id = youtubeVideoId(args.url, "url");
      } catch (error) {
        return failed(
          redactText(error instanceof Error ? error.message : "url must be a valid YouTube video ID or URL", knownSecrets()),
        );
      }

      const invalidOrder = validateEnum("order", args.order, ORDER_VALUES);
      if (invalidOrder) return failed(invalidOrder);
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
        return failed("limit must be a positive whole number.");
      }

      const cursor = args.cursor?.trim() || undefined;
      const video = `${WATCH_URL}${id}`;

      const response = yield* scrapecreatorsRequest(
        PATH,
        { url: video, order: args.order, continuationToken: cursor },
        headers,
        ctx,
        LABEL,
      );
      if (!response.ok) {
        return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
      }

      const payload = response.payload;
      const listed = expectArray(payload, "comments", LABEL);
      if (!listed.ok) return failed(listed.error);

      const readable: Array<Record<string, unknown>> = [];
      let unreadable = 0;
      for (const entry of listed.items) {
        const comment = asRecord(entry);
        if (comment && typeof comment.content === "string") readable.push(comment);
        else unreadable += 1;
      }
      if (!readable.length && unreadable) {
        return failed(
          `${LABEL} returned an unexpected payload: none of the ${plural(unreadable, "entry", "entries")} carried comment text (content)`,
        );
      }

      const shown = args.limit === undefined ? readable : readable.slice(0, args.limit);
      const next = asString(payload.continuationToken);

      const lines = [
        `YouTube comments: ${video}`,
        `Order: ${args.order ?? "provider default (no order sent; ScrapeCreators documents top and newest)"} | ${
          cursor ? "continuation page" : "first page"
        }`,
        provenanceLine(payload, response.charges),
        `Comments returned: ${readable.length}${
          shown.length < readable.length ? ` | ${shown.length} shown of ${readable.length} returned (limit=${args.limit})` : ""
        }`,
      ];
      if (unreadable) {
        lines.push(
          `Unreadable entries: ${plural(unreadable, "returned entry", "returned entries")} carried no comment text and ${
            unreadable === 1 ? "was" : "were"
          } skipped; see the retained original.`,
        );
      }

      const details: Record<string, unknown> = {
        video_id: id,
        order: args.order ?? null,
        returned: readable.length,
        shown: shown.length,
        unreadable,
        cursor: next,
        comment_ids: shown.map((c) => asString(c.id)).filter((v): v is string => v !== null),
        credits_charged: knownCharge(response.charges),
      };

      if (!readable.length) {
        lines.push(
          "",
          "YouTube returned no comments for this video and order. Comments may be turned off, or the page may be past the provider's reachable depth; this does not show that nobody commented.",
        );
        return buildResult("empty", lines, details);
      }

      lines.push(SAMPLE_NOTE);
      for (const [index, comment] of shown.entries()) {
        lines.push("", ...commentLines(comment, index));
      }
      const tail = next
        ? `Next page: pass cursor="${next}" with the same url and order${continuesAfter(shown.length, readable.length, "comments")}.`
        : "Next page: no continuation returned; the provider gave no further page.";

      return buildResult(unreadable ? "partial" : "success", lines, details, tail);
    }),
});
