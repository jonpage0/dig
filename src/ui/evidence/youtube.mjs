// YouTube: Data API search and video details, or yt-dlp JSON. Transcripts live in the library, not in the raw response.
// Adapted from Dig's dashboard/ui/evidence/youtube.ts (MIT, same author).
import { compact, duration, isoDuration, num, plural, shortDate } from '../format.mjs';
import { arr, attempted, excerpt, failedCall, noItems, numv, obj, objs, query, scope, str } from './read.mjs';

const WATCH_URL = 'https://www.youtube.com/watch?v=';

/** Search results and video details describe the same video; keep every field either one had. */
function merge(videos, v) {
  const e = videos.get(v.id);
  videos.set(v.id, { id: v.id, title: v.title ?? e?.title, channel: v.channel ?? e?.channel, views: v.views ?? e?.views, length: v.length ?? e?.length, published: v.published ?? e?.published });
}
function readItem(item, videos) {
  // Data API: search items (id.videoId) and video items (id + statistics)
  const snippet = obj(item.snippet);
  const id = str(obj(item.id)?.videoId) ?? (snippet ? str(item.id) : undefined);
  if (id && snippet) {
    const details = obj(item.contentDetails);
    merge(videos, { id, title: str(snippet.title), channel: str(snippet.channelTitle), published: str(snippet.publishedAt), views: numv(obj(item.statistics)?.viewCount), length: details ? isoDuration(str(details.duration) ?? '') : undefined });
    return;
  }
  // yt-dlp JSON
  const ytId = str(item.id);
  if (ytId && str(item.title) && ('view_count' in item || 'channel' in item || 'uploader' in item)) {
    const seconds = numv(item.duration); const uploaded = str(item.upload_date);
    merge(videos, { id: ytId, title: str(item.title), channel: str(item.channel) ?? str(item.uploader), views: numv(item.view_count), length: seconds === undefined ? undefined : duration(seconds * 1000), published: uploaded && /^\d{8}$/.test(uploaded) ? `${uploaded.slice(0, 4)}-${uploaded.slice(4, 6)}-${uploaded.slice(6)}` : undefined });
  }
}

/** youtube_transcript reads one video's hosted transcript; youtube_analyze and youtube_analysis_status ask Gemini about videos. None of them searches. */
function readVideoCall(call, bodies) {
  const a = call.args; const failed = failedCall(call); const found = bodies.map(obj).filter(Boolean);
  if (call.tool === 'youtube_transcript') {
    const b = found.find(x => 'transcript' in x);
    return {
      action: [attempted(call.status, 'read the transcript of', 'read the transcript of'), str(a.video) ?? 'a video', ...scope([str(a.language), a.originalAudio === true ? 'original audio' : undefined])],
      result: failed || !b ? undefined : Array.isArray(b.transcript) ? plural(b.transcript.length, 'segment') : 'no transcript returned',
      items: [],
    };
  }
  const status = str(found.findLast(x => str(x.status))?.status);
  const action = call.tool === 'youtube_analyze'
    ? [attempted(call.status, a.previousInteractionId ? `followed up on YouTube analysis ${str(a.previousInteractionId)} with` : `asked Gemini about ${plural(arr(a.videos).length, 'video')}:`, 'ask Gemini about YouTube videos:'), ...query(str(a.question))]
    : [attempted(call.status, a.action === 'cancel' ? 'asked to cancel YouTube analysis' : 'checked YouTube analysis', a.action === 'cancel' ? 'cancel YouTube analysis' : 'check YouTube analysis'), str(a.interactionId) ?? '?'];
  return { action, result: failed || !status ? undefined : `status ${status}`, items: [] };
}

// youtube_comments in src/providers/tools/youtube_comments.ts: one row per returned comment, with its author, date and likes.
const COMMENT_EXCERPT = 200;
function readComments(call, bodies) {
  const rows = new Map();
  for (const c of bodies.flatMap(b => objs(obj(b)?.comments))) {
    const content = str(c.content); if (!content) continue;
    const key = str(c.id) ?? content; const at = str(c.publishedTime); const likes = numv(obj(c.engagement)?.likes);
    if (!rows.has(key)) rows.set(key, { kind: 'comment', key, title: excerpt(content, COMMENT_EXCERPT), url: str(obj(c.author)?.channelUrl), meta: [str(obj(c.author)?.name), at ? shortDate(at) : str(c.publishedTimeText), likes === undefined ? undefined : `${compact(likes)} likes`].filter(Boolean) });
  }
  const items = [...rows.values()]; const a = call.args;
  return {
    action: [attempted(call.status, 'read the comments on', 'read the comments on'), str(a.url) ?? 'a video', ...scope([str(a.order), str(a.cursor) ? 'a later page' : undefined])],
    result: failedCall(call) ? undefined : items.length ? plural(items.length, 'comment') : noItems(call),
    items,
  };
}

export function readYoutube(call, bodies) {
  if (call.tool === 'youtube_comments') return readComments(call, bodies);
  if (['youtube_transcript', 'youtube_analyze', 'youtube_analysis_status'].includes(call.tool)) return readVideoCall(call, bodies);
  const videos = new Map();
  for (const body of bodies) {
    const b = obj(body);
    for (const item of b ? objs(b.items) : objs(body)) readItem(item, videos);
    if (b) readItem(b, videos);
  }
  const list = [...videos.values()].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const a = call.args;
  return {
    action: ['searched YouTube for', ...query(str(a.query)), ...scope([numv(a.days) ? `last ${plural(numv(a.days), 'day')}` : undefined, numv(a.limit) ? `up to ${num(numv(a.limit))}` : undefined, a.transcripts === false ? 'no transcripts' : undefined])],
    result: failedCall(call) ? undefined : list.length ? plural(list.length, 'video') : noItems(call),
    items: list.map(v => ({ kind: 'video', key: v.id, title: v.title ?? v.id, url: `${WATCH_URL}${encodeURIComponent(v.id)}`, meta: [v.channel, v.views === undefined ? undefined : `${compact(v.views)} views`, v.length, v.published ? shortDate(v.published) : undefined].filter(Boolean) })),
  };
}
