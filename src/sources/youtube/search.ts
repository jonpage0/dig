import { execFile as execFileCb } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import TOML from "@iarna/toml";
import { Effect, Result, Schema } from "effect";
import { configPath, stateDirectory } from "../../core/config.ts";
import { freeRequest, type FreeHttp, type KeepRaw } from "../../core/http.ts";
import {
  defineAction,
  failed,
  outcome,
  type ActionContext,
} from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import { findExecutable } from "../shared/executables.ts";

const execFile = promisify(execFileCb);

/** Dig's own Node, enabled for yt-dlp beside its default Deno, which it still prefers when installed. */
const JS_RUNTIME = ["--js-runtimes", `node:${process.execPath}`] as const;
/** English caption tracks asked of yt-dlp: the plain code and the regional codes uploaders use. */
const CAPTION_LANGS = "en,en-US,en-GB,en-CA,en-AU";
/** At most this many yt-dlp processes run at once. */
const YTDLP_CONCURRENCY = 3;

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
  captions: string | null;
}

interface SearchResult {
  readonly videos: YouTubeVideo[];
  readonly mode: "API" | "yt-dlp";
  readonly warnings: string[];
}

interface Caption {
  readonly text: string;
  readonly kind: string;
}

export function youtubeLibraryDir(libraryOverride?: string): string {
  if (libraryOverride) return libraryOverride;
  const state = stateDirectory();
  try {
    const parsed = TOML.parse(readFileSync(configPath(state), "utf8")) as Record<string, unknown>;
    if (typeof parsed.library === "string" && parsed.library.trim()) {
      const expanded = parsed.library.replace(/^~(?=\/|$)/, homedir());
      if (isAbsolute(expanded)) return resolve(expanded);
    }
  } catch {
    // Missing or unreadable config falls back to state library.
  }
  return join(state, "library");
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
    captions: null,
  };
}

function metric(value: unknown): number | null {
  if ((typeof value !== "string" && typeof value !== "number") || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isValidYouTubeVideoId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);
}

function parseDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
}

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
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function totalMetric(videos: readonly YouTubeVideo[], field: "views" | "likes"): string {
  return videos.every((v) => v[field] !== null)
    ? formatNumber(videos.reduce((n, v) => n + v[field]!, 0))
    : "unavailable (incomplete metrics)";
}

function redact(text: string): string {
  return redactText(text, knownSecrets()).replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]");
}

/**
 * Saves a transcript file in the library once, for yt-dlp captions and `youtube_transcript` alike.
 * Redacts all known credentials before writing to disk. Keeps any existing file unchanged.
 */
export function saveTranscript(file: string, content: string, mode?: number): boolean {
  try {
    writeFileSync(file, redactText(content, knownSecrets()), {
      encoding: "utf8",
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

/** Convert VTT subtitle format to clean plaintext — preserves FULL transcript, no truncation. */
export function cleanVtt(vtt: string): string {
  let text = vtt.replace(/^\uFEFF?WEBVTT[^\n]*(?:\n[^\n]+)*\n\n/, "");
  text = text.replace(/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}.*\n/g, "");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/^\d+\s*$/gm, "");
  const unique: string[] = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (stripped && stripped !== unique[unique.length - 1]) unique.push(stripped);
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function searchViaAPI(
  query: string,
  limit: number,
  days: number,
  apiKey: string,
  ctx: Pick<ActionContext, "signal" | "keep">,
): Effect.Effect<SearchResult, Error, FreeHttp> {
  return Effect.gen(function* () {
    const warnings: string[] = [];

    const apiGet = (path: string, params: Record<string, string>, label: string) =>
      Effect.gen(function* () {
        if (ctx.signal.aborted) return yield* Effect.fail(new Error("YouTube search cancelled"));
        const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
        url.search = new URLSearchParams({ ...params, key: apiKey }).toString();
        const res = yield* Effect.result(
          freeRequest({
            url: url.href,
            method: "GET",
            timeoutMs: 60_000,
            signal: ctx.signal,
            label,
            keep: ctx.keep,
          }),
        );
        if (Result.isFailure(res)) {
          return yield* Effect.fail(
            new Error(res.failure instanceof Error ? res.failure.message : `${label} failed`),
          );
        }
        return res.success;
      });

    const extractItems = (
      res: { readonly status: number; readonly isJson: boolean; readonly payload: unknown },
      label: string,
    ): Effect.Effect<readonly Record<string, unknown>[], Error> => {
      if (res.status < 200 || res.status >= 300) {
        return Effect.fail(new Error(`${label} returned HTTP ${res.status}`));
      }
      if (!res.isJson || !isRecord(res.payload) || res.payload.error || !Array.isArray(res.payload.items)) {
        return Effect.fail(new Error(`${label} returned malformed items, not an empty search`));
      }
      return Effect.succeed(res.payload.items as readonly Record<string, unknown>[]);
    };

    const params = {
      part: "snippet",
      type: "video",
      q: query,
      maxResults: String(limit),
      order: "relevance",
    };

    const initial = yield* apiGet(
      "search",
      {
        ...params,
        publishedAfter: new Date(Date.now() - days * 86_400_000).toISOString(),
      },
      "YouTube search",
    );

    if (initial.status === 403 || initial.status === 429) {
      const fallback = yield* Effect.tryPromise({
        try: () => searchViaYtdlp(query, limit, days, ctx.signal, ctx.keep),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      });
      fallback.warnings.unshift(`YouTube API returned HTTP ${initial.status}; used yt-dlp search.`);
      return fallback;
    }

    let results = yield* extractItems(initial, "YouTube search");
    if (!results.length) {
      const retryRes = yield* apiGet("search", params, "YouTube search retry");
      results = yield* extractItems(retryRes, "YouTube search retry");
      if (results.length) {
        warnings.push("No matches in the requested date window; showing all-date search results.");
      }
    }
    if (!results.length) return { videos: [], mode: "API" as const, warnings };

    const candidates = new Map<string, YouTubeVideo>();
    for (const item of results) {
      const idObj = isRecord(item.id) ? item.id : null;
      const vid = idObj?.videoId;
      if (!isValidYouTubeVideoId(vid)) {
        return yield* Effect.fail(new Error("YouTube search returned an unreadable video identifier"));
      }
      const v = emptyVideo(vid);
      const sn = isRecord(item.snippet) ? item.snippet : null;
      if (typeof sn?.title === "string") v.title = sn.title;
      if (typeof sn?.channelTitle === "string") v.channel = sn.channelTitle;
      if (typeof sn?.publishedAt === "string") v.date = sn.publishedAt.split("T")[0];
      candidates.set(v.id, v);
    }

    const detailsRes = yield* Effect.result(
      Effect.gen(function* () {
        const raw = yield* apiGet(
          "videos",
          {
            part: "snippet,statistics,contentDetails",
            id: [...candidates.keys()].join(","),
          },
          "YouTube video details",
        );
        return yield* extractItems(raw, "YouTube video details");
      }),
    );

    if (Result.isSuccess(detailsRes)) {
      const seen = new Set<string>();
      for (const item of detailsRes.success) {
        const id = typeof item.id === "string" ? item.id : "";
        const v = candidates.get(id);
        if (!v) continue;
        seen.add(v.id);
        const sn = isRecord(item.snippet) ? item.snippet : null;
        const stats = isRecord(item.statistics) ? item.statistics : null;
        const cd = isRecord(item.contentDetails) ? item.contentDetails : null;
        if (typeof sn?.title === "string") v.title = sn.title;
        if (typeof sn?.channelTitle === "string") v.channel = sn.channelTitle;
        if (typeof sn?.publishedAt === "string") v.date = sn.publishedAt.split("T")[0];
        v.views = metric(stats?.viewCount);
        v.likes = metric(stats?.likeCount);
        v.comments = metric(stats?.commentCount);
        v.duration = parseDuration(cd?.duration);
      }
      if (seen.size < candidates.size) {
        warnings.push("Details omitted some discovered videos; their metrics remain unavailable.");
      }
    } else {
      if (ctx.signal.aborted) return yield* Effect.fail(detailsRes.failure);
      warnings.push(
        `${detailsRes.failure.message || "Details failed"}; retaining discovered video links with unavailable metrics.`,
      );
    }

    if ([...candidates.values()].some((v) => v.views === null || v.likes === null)) {
      warnings.push("Some engagement metrics are unavailable; totals are incomplete.");
    }

    return {
      videos: [...candidates.values()].sort((a, b) => (b.views ?? -1) - (a.views ?? -1)),
      mode: "API" as const,
      warnings,
    };
  });
}

async function searchViaYtdlp(
  query: string,
  limit: number,
  days: number,
  signal: AbortSignal,
  keep: KeepRaw,
): Promise<SearchResult> {
  const executable = findExecutable("yt-dlp");
  if (!executable) {
    throw new Error(
      "yt-dlp is required for keyless YouTube search. Install yt-dlp (https://github.com/yt-dlp/yt-dlp) where Dig's service can find it, such as /opt/homebrew/bin, /usr/local/bin or ~/.local/bin.",
    );
  }
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
        ...JS_RUNTIME,
        `ytsearch${limit}:${query}`,
        "--dump-json",
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
      const item = JSON.parse(line) as Record<string, unknown>;
      if (!isValidYouTubeVideoId(item.id)) throw new Error();
      const v = emptyVideo(item.id);
      if (typeof item.title === "string" && item.title) v.title = item.title;
      const channel =
        (typeof item.channel === "string" && item.channel) ||
        (typeof item.uploader === "string" && item.uploader);
      if (channel) v.channel = channel;
      if (typeof item.upload_date === "string" && /^\d{8}$/.test(item.upload_date)) {
        v.date = `${item.upload_date.slice(0, 4)}-${item.upload_date.slice(4, 6)}-${item.upload_date.slice(6)}`;
      }
      v.views = metric(item.view_count);
      v.likes = metric(item.like_count);
      v.comments = metric(item.comment_count);
      v.duration = metric(item.duration);
      videos.push(v);
    } catch {
      unreadable++;
    }
  }
  if (unreadable && !videos.length) {
    throw new Error("yt-dlp returned unreadable records, not an empty search");
  }
  if (unreadable) warnings.push(`${unreadable} unreadable yt-dlp records omitted.`);

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];
  const recent = videos.filter((v) => v.date && v.date >= cutoff);
  const selected = recent.length >= 3 ? recent : videos;
  if (selected.some((v) => !v.date || v.date < cutoff)) {
    warnings.push("Too few dated recent results; showing videos outside the requested date window.");
  }
  if (selected.some((v) => v.views === null || v.likes === null)) {
    warnings.push("Some engagement metrics are unavailable; totals are incomplete.");
  }
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
): Promise<Caption | null> {
  signal.throwIfAborted();
  try {
    await execFile(
      executable,
      [
        "--ignore-config",
        "--no-cookies-from-browser",
        ...JS_RUNTIME,
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        CAPTION_LANGS,
        "--sub-format",
        "vtt",
        "--write-info-json",
        "--skip-download",
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
  let uploaded: Set<string> | null = null;
  try {
    const info = JSON.parse(readFileSync(join(tempDir, `${videoId}.info.json`), "utf8")) as {
      subtitles?: unknown;
    };
    if (info.subtitles && typeof info.subtitles === "object") {
      uploaded = new Set(Object.keys(info.subtitles as Record<string, unknown>));
    }
  } catch {
    uploaded = null;
  }
  const rank = (lang: string) => (uploaded?.has(lang) ? 0 : 2) + (lang === "en" ? 0 : 1);
  const tracks = readdirSync(tempDir)
    .filter((f) => f.startsWith(`${videoId}.`) && f.endsWith(".vtt"))
    .map((f) => ({ f, lang: f.slice(videoId.length + 1, -4) }))
    .sort((a, b) => rank(a.lang) - rank(b.lang) || a.lang.localeCompare(b.lang));
  const track = tracks[0];
  if (!track) return null;
  const vtt = readFileSync(join(tempDir, track.f), "utf8");
  keep(`yt-dlp subtitles ${videoId}`, 0, vtt);
  return {
    text: cleanVtt(vtt),
    kind: `${uploaded ? (uploaded.has(track.lang) ? "uploaded " : "automatic ") : ""}English captions (${track.lang})`,
  };
}

const YouTubeSearchSchema = Schema.Struct({
  query: Schema.String.annotate({ description: "YouTube search query." }),
  days: Schema.optionalKey(Schema.Finite.annotate({ description: "Prefer videos from the last N days." })),
  limit: Schema.optionalKey(Schema.Finite.annotate({ description: "Max videos (default: 15, max: 25)." })),
  transcripts: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Fetch and save full transcripts via yt-dlp." }),
  ),
});

export const youtubeAction = defineAction({
  name: "youtube",
  description:
    "Search YouTube videos and optionally save full transcripts. Uses the YouTube Data API when keyed, with an explicit yt-dlp fallback. Returns provenance, unknown metrics, coverage warnings and transcript paths; read transcripts before attributing claims.",
  schema: YouTubeSearchSchema,
  slow: true,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const signal = ctx.signal;
      if (signal.aborted) return outcome("cancelled", "Research call cancelled");

      const query = typeof args.query === "string" ? args.query.trim() : "";
      const limit = args.limit ?? 15;
      const days = args.days ?? 30;
      const doTranscripts = args.transcripts ?? true;
      if (
        !query ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 25 ||
        !Number.isFinite(days) ||
        days < 0
      ) {
        return failed("query, limit (1–25) and nonnegative days are required");
      }

      const apiKey = process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY?.trim();
      ctx.progress({
        progress: 1,
        total: 3,
        message: `Searching YouTube (${apiKey ? "Data API" : "yt-dlp"}) for "${query}"...`,
      });

      const searchRes = yield* Effect.result(
        apiKey
          ? searchViaAPI(query, limit, days, apiKey, ctx)
          : Effect.tryPromise({
              try: () => searchViaYtdlp(query, limit, days, signal, ctx.keep),
              catch: (e) => (e instanceof Error ? e : new Error("unknown error")),
            }),
      );

      if (signal.aborted) return outcome("cancelled", "Research call cancelled");
      if (Result.isFailure(searchRes)) {
        return failed(`YouTube search failed: ${redact(searchRes.failure.message || "unknown error")}`);
      }

      const search = searchRes.success;
      const { videos, warnings } = search;
      if (!videos.length) {
        return outcome(
          warnings.length ? "partial" : "empty",
          `No YouTube results found for "${query}".${warnings.map((w) => `\nWarning: ${w}`).join("")}`,
          { mode: search.mode, warnings },
        );
      }

      if (doTranscripts) {
        const transcriptDir = join(youtubeLibraryDir(ctx.library), "youtube-transcripts");
        const needFetch: YouTubeVideo[] = [];
        for (const video of videos) {
          if (signal.aborted) return outcome("cancelled", "Research call cancelled");
          const existing = join(transcriptDir, `${video.id}.md`);
          if (existsSync(existing)) {
            video.transcriptFile = existing;
            video.transcriptWords = readFileSync(existing, "utf8").split(/\s+/).length;
          } else {
            needFetch.push(video);
          }
        }

        const executable = findExecutable("yt-dlp");
        if (needFetch.length && !executable) {
          warnings.push(
            "yt-dlp is unavailable; new transcripts were not fetched. Install yt-dlp (https://github.com/yt-dlp/yt-dlp) where Dig's service can find it, such as /opt/homebrew/bin, /usr/local/bin or ~/.local/bin.",
          );
        } else if (needFetch.length && executable) {
          ctx.progress({
            progress: 2,
            total: 3,
            message: `Found ${videos.length} videos; fetching ${needFetch.length} transcript${needFetch.length === 1 ? "" : "s"} via yt-dlp...`,
          });

          const fetchRes = yield* Effect.result(
            Effect.tryPromise({
              try: async () => {
                signal.throwIfAborted();
                const tempDir = mkdtempSync(join(tmpdir(), "dig-youtube-"));
                try {
                  const fetched: Array<PromiseSettledResult<Caption | null>> = [];
                  let next = 0;
                  let doneCount = 0;
                  await Promise.all(
                    Array.from({ length: Math.min(YTDLP_CONCURRENCY, needFetch.length) }, async () => {
                      while (next < needFetch.length && !signal.aborted) {
                        const i = next++;
                        fetched[i] = await fetchTranscript(
                          executable,
                          needFetch[i].id,
                          tempDir,
                          signal,
                          ctx.keep,
                        ).then(
                          (value) => ({ status: "fulfilled", value }) as const,
                          (reason) => ({ status: "rejected", reason }) as const,
                        );
                        doneCount += 1;
                        if (!signal.aborted) {
                          ctx.progress({
                            progress: doneCount,
                            total: needFetch.length,
                            message: `Fetched transcript ${doneCount}/${needFetch.length} (${needFetch[i].id})`,
                          });
                        }
                      }
                    }),
                  );
                  signal.throwIfAborted();
                  for (let i = 0; i < needFetch.length; i++) {
                    signal.throwIfAborted();
                    const video = needFetch[i];
                    const result = fetched[i];
                    const caption = result?.status === "fulfilled" ? result.value : null;
                    if (!caption?.text) {
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
                      caption.text,
                    ].join("\n");
                    signal.throwIfAborted();
                    mkdirSync(transcriptDir, { recursive: true });
                    const file = join(transcriptDir, `${video.id}.md`);
                    saveTranscript(file, content);
                    video.transcriptFile = file;
                    video.captions = caption.kind;
                    video.transcriptWords = readFileSync(file, "utf8").split(/\s+/).length;
                  }
                } finally {
                  rmSync(tempDir, { recursive: true, force: true });
                }
              },
              catch: (e) => (e instanceof Error ? e : new Error("unknown error")),
            }),
          );

          if (signal.aborted) return outcome("cancelled", "Research call cancelled");
          if (Result.isFailure(fetchRes)) {
            return failed(`YouTube search failed: ${redact(fetchRes.failure.message || "unknown error")}`);
          }
        }
      }

      if (signal.aborted) return outcome("cancelled", "Research call cancelled");
      ctx.progress({ progress: 3, total: 3, message: `YouTube search complete (${videos.length} videos)` });

      const text = [
        `YouTube results for "${query}" (${videos.length} videos, search via ${search.mode}):`,
        `Total: ${totalMetric(videos, "views")} views | ${totalMetric(videos, "likes")} likes${
          doTranscripts ? ` | Transcripts saved: ${videos.filter((v) => v.transcriptFile).length}` : ""
        }`,
        "Public views count playback starts, including autoplay, under YouTube’s August 27, 2026 definition. They are not engaged views.",
        ...warnings.map((w) => `Warning: ${w}`),
        "",
        ...videos.map((v) =>
          [
            `**${v.title}**`,
            `  Channel: ${v.channel} | Views: ${formatNumber(v.views)} | Likes: ${formatNumber(v.likes)}${
              v.date ? ` | Date: ${v.date}` : ""
            }${v.duration ? ` | Duration: ${formatDuration(v.duration)}` : ""}`,
            `  URL: ${v.url}`,
            v.transcriptFile
              ? `  Transcript: ${v.transcriptFile} (${v.transcriptWords} words${v.captions ? `, from ${v.captions}` : ""})`
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
    }),
});
