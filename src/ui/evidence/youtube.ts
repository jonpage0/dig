import { compact, duration, isoDuration, num, plural, shortDate } from "../format.ts";
import {
  arr,
  attempted,
  excerpt,
  failedCall,
  noItems,
  nonEmpty,
  numv,
  obj,
  objs,
  query,
  scope,
  str,
  type EvidenceCall,
  type EvidenceItem,
  type EvidenceResult,
} from "./read.ts";

const WATCH_URL = "https://www.youtube.com/watch?v=";
const COMMENT_EXCERPT = 200;

interface VideoEntry {
  readonly id: string;
  readonly title?: string;
  readonly channel?: string;
  readonly views?: number;
  readonly length?: string;
  readonly published?: string;
}

function merge(videos: Map<string, VideoEntry>, v: VideoEntry): void {
  const e = videos.get(v.id);
  videos.set(v.id, {
    id: v.id,
    title: v.title ?? e?.title,
    channel: v.channel ?? e?.channel,
    views: v.views ?? e?.views,
    length: v.length ?? e?.length,
    published: v.published ?? e?.published,
  });
}

function readItem(item: Record<string, unknown>, videos: Map<string, VideoEntry>): void {
  const snippet = obj(item.snippet);
  const id = str(obj(item.id)?.videoId) ?? (snippet ? str(item.id) : undefined);
  if (id && snippet) {
    const details = obj(item.contentDetails);
    merge(videos, {
      id,
      title: str(snippet.title),
      channel: str(snippet.channelTitle),
      published: str(snippet.publishedAt),
      views: numv(obj(item.statistics)?.viewCount),
      length: details ? isoDuration(str(details.duration) ?? "") : undefined,
    });
    return;
  }
  const ytId = str(item.id);
  if (ytId && str(item.title) && ("view_count" in item || "channel" in item || "uploader" in item)) {
    const seconds = numv(item.duration);
    const uploaded = str(item.upload_date);
    merge(videos, {
      id: ytId,
      title: str(item.title),
      channel: str(item.channel) ?? str(item.uploader),
      views: numv(item.view_count),
      length: seconds === undefined ? undefined : duration(seconds * 1000),
      published:
        uploaded && /^\d{8}$/.test(uploaded)
          ? `${uploaded.slice(0, 4)}-${uploaded.slice(4, 6)}-${uploaded.slice(6)}`
          : undefined,
    });
  }
}

function readVideoCall(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  const a = call.args;
  const failed = failedCall(call);
  const found = responseBodies.map(obj).filter((x): x is Record<string, unknown> => Boolean(x));
  if (call.tool === "youtube_transcript") {
    const b = found.find((x) => "transcript" in x);
    return {
      action: [
        attempted(call.status, "read the transcript of", "read the transcript of"),
        str(a.video) ?? "a video",
        ...scope([str(a.language), a.originalAudio === true ? "original audio" : undefined]),
      ],
      result:
        failed || !b
          ? undefined
          : Array.isArray(b.transcript)
            ? plural(b.transcript.length, "segment")
            : "no transcript returned",
      items: [],
    };
  }
  const status = str([...found].reverse().find((x) => str(x.status))?.status);
  const action =
    call.tool === "youtube_analyze"
      ? [
          attempted(
            call.status,
            a.previousInteractionId
              ? `followed up on YouTube analysis ${str(a.previousInteractionId)} with`
              : `asked Gemini about ${plural(arr(a.videos).length, "video")}:`,
            "ask Gemini about YouTube videos:",
          ),
          ...query(str(a.question)),
        ]
      : [
          attempted(
            call.status,
            a.action === "cancel" ? "asked to cancel YouTube analysis" : "checked YouTube analysis",
            a.action === "cancel" ? "cancel YouTube analysis" : "check YouTube analysis",
          ),
          str(a.interactionId) ?? "?",
        ];
  return { action, result: failed || !status ? undefined : `status ${status}`, items: [] };
}

function readComments(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  const rows = new Map<string, EvidenceItem>();
  for (const c of responseBodies.flatMap((b) => objs(obj(b)?.comments))) {
    const content = str(c.content);
    if (!content) continue;
    const key = str(c.id) ?? content;
    const at = str(c.publishedTime);
    const likes = numv(obj(c.engagement)?.likes);
    if (!rows.has(key)) {
      rows.set(key, {
        kind: "comment",
        key,
        title: excerpt(content, COMMENT_EXCERPT),
        url: str(obj(c.author)?.channelUrl),
        meta: nonEmpty([
          str(obj(c.author)?.name),
          at ? shortDate(at) : str(c.publishedTimeText),
          likes === undefined ? undefined : `${compact(likes)} likes`,
        ]),
      });
    }
  }
  const items = [...rows.values()];
  const a = call.args;
  return {
    action: [
      attempted(call.status, "read the comments on", "read the comments on"),
      str(a.url) ?? "a video",
      ...scope([str(a.order), str(a.cursor) ? "a later page" : undefined]),
    ],
    result: failedCall(call) ? undefined : items.length ? plural(items.length, "comment") : noItems(call),
    items,
  };
}

export function readYoutube(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  if (call.tool === "youtube_comments") return readComments(call, responseBodies);
  if (
    call.tool === "youtube_transcript" ||
    call.tool === "youtube_analyze" ||
    call.tool === "youtube_analysis_status"
  ) {
    return readVideoCall(call, responseBodies);
  }
  const videos = new Map<string, VideoEntry>();
  for (const body of responseBodies) {
    const b = obj(body);
    for (const item of b ? objs(b.items) : objs(body)) readItem(item, videos);
    if (b) readItem(b, videos);
  }
  const list = [...videos.values()].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const a = call.args;
  const days = numv(a.days);
  const limit = numv(a.limit);
  return {
    action: [
      "searched YouTube for",
      ...query(str(a.query)),
      ...scope([
        days ? `last ${plural(days, "day")}` : undefined,
        limit ? `up to ${num(limit)}` : undefined,
        a.transcripts === false ? "no transcripts" : undefined,
      ]),
    ],
    result: failedCall(call) ? undefined : list.length ? plural(list.length, "video") : noItems(call),
    items: list.map((v) => ({
      kind: "video",
      key: v.id,
      title: v.title ?? v.id,
      url: `${WATCH_URL}${encodeURIComponent(v.id)}`,
      meta: nonEmpty([
        v.channel,
        v.views === undefined ? undefined : `${compact(v.views)} views`,
        v.length,
        v.published ? shortDate(v.published) : undefined,
      ]),
    })),
  };
}
