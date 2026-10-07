import type { KeepRaw, ToolSpec } from "../types.js";
import { failed, free, outcome } from "../outcome.js";
import { keptJson, keptText } from "../http.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../runtime-config.js";
import { findExecutable } from "../executables.js";

const execFile = promisify(execFileCb);
interface YouTubeVideo {
  id: string;
  title: string;
  url: string;
  channel: string;
  date: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  duration: number | null;
  description: string;
  transcriptFile: string | null;
  transcriptWords: number;
}
interface SearchResult {
  videos: YouTubeVideo[];
  mode: "API" | "yt-dlp";
  warnings: string[];
}
function emptyVideo(id: string): YouTubeVideo {
  return {
    id,
    title: "Title unavailable",
    url: `https://www.youtube.com/watch?v=${id}`,
    channel: "unavailable",
    date: null,
    views: null,
    likes: null,
    comments: null,
    duration: null,
    description: "",
    transcriptFile: null,
    transcriptWords: 0,
  };
}
function metric(value: unknown): number | null {
  if ((typeof value !== "string" && typeof value !== "number") || value === "")
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function isValidYouTubeVideoId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);
}
function parseDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m
    ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
    : null;
}
function total(videos: YouTubeVideo[], field: "views" | "likes"): string {
  return videos.every((v) => v[field] !== null)
    ? formatNumber(videos.reduce((n, v) => n + v[field]!, 0))
    : "unavailable (incomplete metrics)";
}

// The YouTube Data API (keyed or not) and yt-dlp charge nothing: every call is free.
export default free({
  description:
    "Search YouTube videos and optionally save full transcripts. Uses the YouTube Data API when keyed, with an explicit yt-dlp fallback. Returns provenance, unknown metrics, coverage warnings and transcript paths; read transcripts before attributing claims.",
  async execute(args, context) {
    const signal = context.abort;
    signal.throwIfAborted();
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const limit = args.limit ?? 15,
      days = args.days ?? 30,
      doTranscripts = args.transcripts ?? true;
    if (
      !query ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 25 ||
      !Number.isFinite(days) ||
      days < 0
    )
      return failed("query, limit (1–25) and nonnegative days are required");
    try {
      const apiKey = process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY;
      const search = apiKey
        ? await searchViaAPI(query, limit, days, apiKey, signal, context.keep)
        : await searchViaYtdlp(query, limit, days, signal, context.keep);
      signal.throwIfAborted();
      const { videos, warnings } = search;
      if (!videos.length)
        return outcome(
          warnings.length ? "partial" : "empty",
          `No YouTube results found for "${query}".${warnings.map((w) => `\nWarning: ${w}`).join("")}`,
          { mode: search.mode, warnings },
        );
      if (doTranscripts) {
        // Transcripts are shared across projects: one file per video in the library.
        const transcriptDir = join(loadConfig().library, "youtube-transcripts");
        const needFetch: YouTubeVideo[] = [];
        for (const video of videos) {
          signal.throwIfAborted();
          const existing = join(transcriptDir, `${video.id}.md`);
          if (existsSync(existing)) {
            video.transcriptFile = existing;
            video.transcriptWords = readFileSync(existing, "utf8").split(
              /\s+/,
            ).length;
          } else needFetch.push(video);
        }
        const executable = findExecutable("yt-dlp");
        if (needFetch.length && !executable)
          warnings.push(
            "yt-dlp is unavailable; new transcripts were not fetched. Install yt-dlp (https://github.com/yt-dlp/yt-dlp) where Codex can find it, such as /opt/homebrew/bin, /usr/local/bin or ~/.local/bin.",
          );
        else if (needFetch.length && executable) {
          signal.throwIfAborted();
          const tempDir = mkdtempSync(join(tmpdir(), "dig-youtube-"));
          try {
            // Wait for every cancelled child to exit before deleting its scratch directory.
            const fetched = await Promise.allSettled(
              needFetch.map((v) =>
                fetchTranscript(executable, v.id, tempDir, signal, context.keep),
              ),
            );
            signal.throwIfAborted();
            for (let i = 0; i < needFetch.length; i++) {
              signal.throwIfAborted();
              const video = needFetch[i];
              const result = fetched[i];
              const text = result.status === "fulfilled" ? result.value : null;
              if (!text) {
                warnings.push(
                  `Transcript unavailable for ${video.id}; no claim about why captions are missing.`,
                );
                continue;
              }
              const content = [
                `# ${video.title}`,
                "",
                `- **Channel**: ${video.channel}`,
                `- **URL**: ${video.url}`,
                `- **Date**: ${video.date ?? "unknown"}`,
                `- **Views**: ${formatNumber(video.views)}`,
                `- **Likes**: ${formatNumber(video.likes)}`,
                "",
                "---",
                "",
                "## Full Transcript",
                "",
                text,
              ].join("\n");
              signal.throwIfAborted();
              mkdirSync(transcriptDir, { recursive: true });
              const file = join(transcriptDir, `${video.id}.md`);
              try {
                writeFileSync(file, content, { encoding: "utf8", flag: "wx" });
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
              }
              video.transcriptFile = file;
              video.transcriptWords = readFileSync(file, "utf8").split(
                /\s+/,
              ).length;
            }
          } finally {
            rmSync(tempDir, { recursive: true, force: true });
          }
        }
      }
      signal.throwIfAborted();
      const text = [
        `YouTube results for "${query}" (${videos.length} videos, search via ${search.mode}):`,
        `Total: ${total(videos, "views")} views | ${total(videos, "likes")} likes${doTranscripts ? ` | Transcripts saved: ${videos.filter((v) => v.transcriptFile).length}` : ""}`,
        ...warnings.map((w) => `Warning: ${w}`),
        "",
        ...videos.map((v) =>
          [
            `**${v.title}**`,
            `  Channel: ${v.channel} | Views: ${formatNumber(v.views)} | Likes: ${formatNumber(v.likes)}${v.date ? ` | Date: ${v.date}` : ""}${v.duration ? ` | Duration: ${formatDuration(v.duration)}` : ""}`,
            `  URL: ${v.url}`,
            v.transcriptFile
              ? `  Transcript: ${v.transcriptFile} (${v.transcriptWords} words)`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ].join("\n\n");
      return outcome(warnings.length ? "partial" : "success", text, {
        mode: search.mode,
        warnings,
        videoCount: videos.length,
      });
    } catch (error) {
      signal.throwIfAborted();
      return failed(
        `YouTube search failed: ${error instanceof Error ? redact(error.message) : "unknown error"}`,
      );
    }
  },
} satisfies ToolSpec);

function redact(text: string): string {
  const key = process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY;
  return (key ? text.replaceAll(key, "[redacted]") : text).replace(
    /([?&]key=)[^&\s]+/gi,
    "$1[redacted]",
  );
}
async function searchViaAPI(
  query: string,
  limit: number,
  days: number,
  apiKey: string,
  signal: AbortSignal,
  keep: KeepRaw,
): Promise<SearchResult> {
  const warnings: string[] = [];
  async function get(path: string, params: Record<string, string>) {
    signal.throwIfAborted();
    const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    url.search = new URLSearchParams({ ...params, key: apiKey }).toString();
    const response = await fetch(url, { signal });
    signal.throwIfAborted();
    return response;
  }
  async function items(response: Response, label: string): Promise<any[]> {
    if (!response.ok) {
      await keptText(response, keep, label).catch(() => "");
      throw new Error(`${label} returned HTTP ${response.status}`);
    }
    const body = (await keptJson(response, keep, label)) as any;
    signal.throwIfAborted();
    if (
      !body ||
      typeof body !== "object" ||
      body.error ||
      !Array.isArray(body.items)
    )
      throw new Error(`${label} returned malformed items, not an empty search`);
    return body.items;
  }
  const params = {
    part: "snippet",
    type: "video",
    q: query,
    maxResults: String(limit),
    order: "relevance",
  };
  const response = await get("search", {
    ...params,
    publishedAfter: new Date(Date.now() - days * 86400_000).toISOString(),
  });
  if (response.status === 403 || response.status === 429) {
    await keptText(response, keep, "YouTube search").catch(() => "");
    const fallback = await searchViaYtdlp(query, limit, days, signal, keep);
    fallback.warnings.unshift(
      `YouTube API returned HTTP ${response.status}; used yt-dlp search.`,
    );
    return fallback;
  }
  let results = await items(response, "YouTube search");
  if (!results.length) {
    results = await items(await get("search", params), "YouTube search retry");
    if (results.length)
      warnings.push(
        "No matches in the requested date window; showing all-date search results.",
      );
  }
  if (!results.length) return { videos: [], mode: "API", warnings };
  const candidates = new Map<string, YouTubeVideo>();
  for (const item of results) {
    if (!isValidYouTubeVideoId(item?.id?.videoId))
      throw new Error("YouTube search returned an unreadable video identifier");
    const v = emptyVideo(item.id.videoId);
    const sn = item.snippet;
    if (typeof sn?.title === "string") v.title = sn.title;
    if (typeof sn?.channelTitle === "string") v.channel = sn.channelTitle;
    if (typeof sn?.publishedAt === "string")
      v.date = sn.publishedAt.split("T")[0];
    candidates.set(v.id, v);
  }
  try {
    const details = await items(
      await get("videos", {
        part: "snippet,statistics,contentDetails",
        id: [...candidates.keys()].join(","),
      }),
      "YouTube video details",
    );
    const seen = new Set<string>();
    for (const item of details) {
      const v = candidates.get(item?.id);
      if (!v) continue;
      seen.add(v.id);
      if (typeof item.snippet?.title === "string") v.title = item.snippet.title;
      if (typeof item.snippet?.channelTitle === "string")
        v.channel = item.snippet.channelTitle;
      if (typeof item.snippet?.publishedAt === "string")
        v.date = item.snippet.publishedAt.split("T")[0];
      v.views = metric(item.statistics?.viewCount);
      v.likes = metric(item.statistics?.likeCount);
      v.comments = metric(item.statistics?.commentCount);
      v.duration = parseDuration(item.contentDetails?.duration);
    }
    if (seen.size < candidates.size)
      warnings.push(
        "Details omitted some discovered videos; their metrics remain unavailable.",
      );
  } catch (error) {
    signal.throwIfAborted();
    warnings.push(
      `${error instanceof Error ? error.message : "Details failed"}; retaining discovered video links with unavailable metrics.`,
    );
  }
  if (
    [...candidates.values()].some((v) => v.views === null || v.likes === null)
  )
    warnings.push(
      "Some engagement metrics are unavailable; totals are incomplete.",
    );
  return {
    videos: [...candidates.values()].sort(
      (a, b) => (b.views ?? -1) - (a.views ?? -1),
    ),
    mode: "API",
    warnings,
  };
}

async function searchViaYtdlp(
  query: string,
  limit: number,
  days: number,
  signal: AbortSignal,
  keep: KeepRaw,
): Promise<SearchResult> {
  const executable = findExecutable("yt-dlp");
  if (!executable)
    throw new Error(
      "yt-dlp is required for keyless YouTube search. Install yt-dlp (https://github.com/yt-dlp/yt-dlp) where Codex can find it, such as /opt/homebrew/bin, /usr/local/bin or ~/.local/bin.",
    );
  signal.throwIfAborted();
  let stdout: string;
  let exitStatus: number | string = 0;
  const warnings: string[] = [];
  try {
    ({ stdout } = await execFile(
      executable,
      [
        "--ignore-config",
        "--no-cookies-from-browser",
        `ytsearch${limit}:${query}`,
        "--dump-json",
        "--no-warnings",
        "--no-download",
      ],
      { signal, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (error) {
    signal.throwIfAborted();
    const partial = (error as { stdout?: string }).stdout;
    if (!partial) throw new Error("yt-dlp search failed");
    stdout = partial;
    exitStatus = "partial";
    warnings.push("yt-dlp exited unsuccessfully; results are partial.");
  }
  signal.throwIfAborted();
  keep(
    "yt-dlp search",
    exitStatus,
    stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return line;
        }
      }),
  );
  const videos: YouTubeVideo[] = [];
  let unreadable = 0;
  for (const line of stdout.split("\n").filter((x) => x.trim())) {
    try {
      const item = JSON.parse(line);
      if (!isValidYouTubeVideoId(item.id)) throw new Error();
      const v = emptyVideo(item.id);
      v.title = item.title || v.title;
      v.channel = item.channel || item.uploader || v.channel;
      if (
        typeof item.upload_date === "string" &&
        /^\d{8}$/.test(item.upload_date)
      )
        v.date = `${item.upload_date.slice(0, 4)}-${item.upload_date.slice(4, 6)}-${item.upload_date.slice(6)}`;
      v.views = metric(item.view_count);
      v.likes = metric(item.like_count);
      v.comments = metric(item.comment_count);
      v.duration = metric(item.duration);
      videos.push(v);
    } catch {
      unreadable++;
    }
  }
  if (unreadable && !videos.length)
    throw new Error("yt-dlp returned unreadable records, not an empty search");
  if (unreadable)
    warnings.push(`${unreadable} unreadable yt-dlp records omitted.`);
  const cutoff = new Date(Date.now() - days * 86400_000)
    .toISOString()
    .split("T")[0];
  const recent = videos.filter((v) => v.date && v.date >= cutoff);
  const selected = recent.length >= 3 ? recent : videos;
  if (selected.some((v) => !v.date || v.date < cutoff))
    warnings.push(
      "Too few dated recent results; showing videos outside the requested date window.",
    );
  if (selected.some((v) => v.views === null || v.likes === null))
    warnings.push(
      "Some engagement metrics are unavailable; totals are incomplete.",
    );
  return {
    videos: selected.sort((a, b) => (b.views ?? -1) - (a.views ?? -1)),
    mode: "yt-dlp",
    warnings,
  };
}
async function fetchTranscript(
  executable: string,
  videoId: string,
  tempDir: string,
  signal: AbortSignal,
  keep: KeepRaw,
): Promise<string | null> {
  signal.throwIfAborted();
  try {
    await execFile(
      executable,
      [
        "--ignore-config",
        "--no-cookies-from-browser",
        "--write-auto-subs",
        "--sub-lang",
        "en",
        "--sub-format",
        "vtt",
        "--skip-download",
        "--no-warnings",
        "-o",
        join(tempDir, "%(id)s"),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { signal, timeout: 30_000 },
    );
  } catch {
    signal.throwIfAborted();
    return null;
  }
  signal.throwIfAborted();
  const file = readdirSync(tempDir).find(
    (f) => f.startsWith(videoId + ".") && f.endsWith(".vtt"),
  );
  if (!file) return null;
  const vtt = readFileSync(join(tempDir, file), "utf8");
  keep(`yt-dlp subtitles ${videoId}`, 0, vtt);
  return cleanVtt(vtt);
}
/** Convert VTT subtitle format to clean plaintext — preserves FULL transcript, no truncation */
export function cleanVtt(vtt: string): string {
  // The header is WEBVTT and any lines up to the first blank one (YouTube adds Kind: and Language:).
  let text = vtt.replace(/^\uFEFF?WEBVTT[^\n]*(?:\n[^\n]+)*\n\n/, "");
  text = text.replace(
    /\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}.*\n/g,
    "",
  );
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/^\d+\s*$/gm, "");
  // YouTube's automatic captions roll: each cue repeats the line before it, so a line equal to the previous kept
  // line is that overlap and is dropped. A sentence said again later stays; only an immediate repeat is merged.
  const unique: string[] = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (stripped && stripped !== unique[unique.length - 1]) unique.push(stripped);
  }
  // Return the FULL transcript — no word cap. The agent decides what to use.
  // Join into paragraphs (~500 chars each) so the Read tool doesn't truncate
  // long lines. YouTube auto-captions don't have paragraph structure, so we
  // create breaks every ~10 sentences (roughly every 500 chars at a sentence end).
  const raw = unique.join(" ").replace(/\s+/g, " ").trim();
  const sentences = raw.split(/(?<=[.!?])\s+/);
  const paragraphs: string[] = [];
  let current: string[] = [];
  let charCount = 0;
  for (const sentence of sentences) {
    current.push(sentence);
    charCount += sentence.length;
    if (charCount >= 500) {
      paragraphs.push(current.join(" "));
      current = [];
      charCount = 0;
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n\n");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatNumber(n: number | null): string {
  if (n === null) return "unavailable";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
