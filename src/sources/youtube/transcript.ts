import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { defineAction, failed, outcome } from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import {
  asRecord,
  CACHE_MAX_AGE_VALUES,
  failText,
  MISSING_SCRAPECREATORS_KEY,
  scrapecreatorsBilling,
  scrapecreatorsHeaders,
  scrapecreatorsRequest,
} from "../shared/scrapecreators.ts";
import { saveTranscript, youtubeLibraryDir } from "./search.ts";

/** The 11-character id of a YouTube video, Short or live link, or of a bare id; `name` is the argument named in the error. */
export function youtubeVideoId(value: unknown, name: string): string {
  let id = String(value ?? "").trim();
  if (id.startsWith("https://")) {
    const url = new URL(id);
    if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
      id =
        url.pathname === "/watch"
          ? url.searchParams.get("v") ?? ""
          : /^\/(?:shorts|live)\/([^/]+)$/.exec(url.pathname)?.[1] ?? "";
    } else if (url.hostname === "youtu.be") {
      id = url.pathname.slice(1);
    } else {
      throw new Error(`${name} must be a YouTube URL or video ID`);
    }
  }
  if (!/^[\w-]{11}$/.test(id)) {
    throw new Error(`${name} must be a valid YouTube video ID or URL`);
  }
  return id;
}

const YouTubeTranscriptSchema = Schema.Struct({
  video: Schema.String.annotate({ description: "YouTube URL or 11-character video ID." }),
  language: Schema.optionalKey(Schema.String.annotate({ description: "Requested language code (e.g. en, en-US)." })),
  originalAudio: Schema.optionalKey(Schema.Boolean.annotate({ description: "Request original-audio captions only." })),
  cacheMaxAge: Schema.optionalKey(
    Schema.Literals(CACHE_MAX_AGE_VALUES).annotate({
      description: "Provider cache age; omitted means live retrieval.",
    }),
  ),
});

export const youtubeTranscriptAction = defineAction({
  name: "youtube_transcript",
  description:
    "Fetch a timestamped YouTube transcript through ScrapeCreators and save it in the existing transcript library. Paid, explicit fallback when yt-dlp captions are unavailable. Supports requested language, original audio and provider cache. Existing transcript files are never replaced.",
  schema: YouTubeTranscriptSchema,
  billing: scrapecreatorsBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");

      let id: string;
      try {
        id = youtubeVideoId(args.video, "video");
      } catch (error) {
        return failed(
          redactText(error instanceof Error ? error.message : "video must be a valid YouTube video ID or URL", knownSecrets()),
        );
      }

      const language = args.language;
      if (language !== undefined && (typeof language !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language))) {
        return failed("language must be a language code such as en or en-US");
      }
      if (
        args.cacheMaxAge !== undefined &&
        !(CACHE_MAX_AGE_VALUES as readonly string[]).includes(args.cacheMaxAge)
      ) {
        return failed("Unsupported cacheMaxAge");
      }

      const headers = scrapecreatorsHeaders();
      if (!headers) return failed(MISSING_SCRAPECREATORS_KEY);

      const response = yield* scrapecreatorsRequest(
        "/v1/youtube/video/transcript",
        {
          url: `https://www.youtube.com/watch?v=${id}`,
          ...(language ? { language } : {}),
          ...(args.originalAudio === true ? { original_audio: "true" } : {}),
          ...(args.cacheMaxAge ? { cache_max_age: args.cacheMaxAge } : {}),
        },
        headers,
        ctx,
        `YouTube transcript ${id}`,
      );

      if (!response.ok) {
        return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
      }

      const body = response.payload;
      if (body.success !== true) {
        return failed(`Transcript request failed (HTTP ${response.status})`);
      }
      if (body.videoId !== id) {
        return failed("Transcript response did not identify the requested video");
      }
      if (body.transcript === null) {
        return outcome(
          "empty",
          `No captions matching the requested language policy were returned for https://www.youtube.com/watch?v=${id}. This does not establish that the video has no other captions.`,
        );
      }
      if (!Array.isArray(body.transcript)) {
        return failed("Transcript response omitted its segment array");
      }
      if (!body.transcript.length) {
        return outcome("empty", `No transcript segments returned for ${id}.`);
      }

      const segments: string[] = [];
      for (const item of body.transcript) {
        const segment = asRecord(item);
        const start = Number(segment?.startMs);
        const end = Number(segment?.endMs);
        if (!segment || typeof segment.text !== "string" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
          return failed("Transcript contains an invalid segment");
        }
        segments.push(`[${start}–${end} ms] ${segment.text}`);
      }

      const directory = join(youtubeLibraryDir(ctx.library), "youtube-transcripts");
      mkdirSync(directory, { recursive: true });
      const file = join(
        directory,
        `${id}-scrapecreators-${args.originalAudio ? `original${language ? `-${language}` : ""}` : language ?? "auto"}.md`,
      );
      const returnedLang = typeof body.language === "string" ? body.language : undefined;
      const content = [
        `# YouTube transcript ${id}`,
        `Source: https://www.youtube.com/watch?v=${id}`,
        "Provider: ScrapeCreators",
        `Language: ${returnedLang ?? "not reported"}`,
        `Requested language: ${language ?? "automatic"}; original audio only: ${args.originalAudio === true}`,
        `Retrieved: ${new Date().toISOString()}`,
        "",
        "## Full Transcript",
        "",
        ...segments,
      ].join("\n\n");

      const reused = !saveTranscript(file, content, 0o600);
      if (reused && !lstatSync(file).isFile()) {
        return failed("Existing transcript is not a regular file");
      }

      return outcome(
        "success",
        `Transcript: ${file}\n${
          reused
            ? "The existing saved transcript was kept; this request's current response is retained separately."
            : "Saved timestamped transcript."
        }\nLanguage returned by this request: ${returnedLang ?? "unknown"}\nRead the saved file before quoting it.`,
        { transcriptFile: file },
      );
    }),
});
