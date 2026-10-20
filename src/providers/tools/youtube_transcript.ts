import { mkdirSync, lstatSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../runtime-config.js"
import { outcome } from "../outcome.js"
import { requestJson } from "../http.js"
import { creditMetered, scrapecreatorsHeaders, MISSING_KEY_ERROR } from "./scrapecreators.js"
import { knownSecrets, redactText } from "../secrets.js"
import type { ToolSpec } from "../types.js"

export const transcript = creditMetered({
  description: "Fetch a timestamped YouTube transcript through ScrapeCreators and save it in the existing transcript library. Paid, explicit fallback when yt-dlp captions are unavailable. Supports requested language, original audio and provider cache. Existing transcript files are never replaced.",
  async execute(args, ctx) {
    try {
      let id = String(args.video ?? "").trim()
      if (id.startsWith("https://")) {
        const url = new URL(id)
        if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) id = url.pathname === "/watch" ? url.searchParams.get("v") ?? "" : /^\/(?:shorts|live)\/([^/]+)$/.exec(url.pathname)?.[1] ?? ""
        else if (url.hostname === "youtu.be") id = url.pathname.slice(1)
        else throw new Error("video must be a YouTube URL or video ID")
      }
      if (!/^[\w-]{11}$/.test(id)) throw new Error("video must be a valid YouTube video ID or URL")
      const language = args.language
      if (language !== undefined && (typeof language !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language))) throw new Error("language must be a language code such as en or en-US")
      if (args.cacheMaxAge !== undefined && !["1d", "3d", "7d", "14d", "30d"].includes(args.cacheMaxAge)) throw new Error("Unsupported cacheMaxAge")
      const headers = scrapecreatorsHeaders()
      if (!headers) return `ERROR: ${MISSING_KEY_ERROR}`
      const url = new URL("https://api.scrapecreators.com/v1/youtube/video/transcript")
      url.searchParams.set("url", `https://www.youtube.com/watch?v=${id}`)
      if (language) url.searchParams.set("language", language)
      if (args.originalAudio === true) url.searchParams.set("original_audio", "true")
      if (args.cacheMaxAge) url.searchParams.set("cache_max_age", args.cacheMaxAge)
      const response = await requestJson({ url, headers, signal: ctx.abort, retries: 0, timeoutMs: 60000, provider: "ScrapeCreators", keep: ctx.keep, label: `YouTube transcript ${id}` })
      const body = response.payload as any
      if (response.status !== 200 || !body || body.success !== true) throw new Error(`Transcript request failed (HTTP ${response.status})`)
      if (body.videoId !== id) throw new Error("Transcript response did not identify the requested video")
      if (body.transcript === null) return outcome("empty", `No captions matching the requested language policy were returned for https://www.youtube.com/watch?v=${id}. This does not establish that the video has no other captions.`)
      if (!Array.isArray(body.transcript)) throw new Error("Transcript response omitted its segment array")
      if (!body.transcript.length) return outcome("empty", `No transcript segments returned for ${id}.`)
      const segments = body.transcript.map((segment: any) => {
        const start = Number(segment.startMs), end = Number(segment.endMs)
        if (typeof segment.text !== "string" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) throw new Error("Transcript contains an invalid segment")
        return `[${start}–${end} ms] ${segment.text}`
      })
      const directory = join(loadConfig().library, "youtube-transcripts")
      mkdirSync(directory, { recursive: true })
      const file = join(directory, `${id}-scrapecreators-${args.originalAudio ? "original" : language ?? "auto"}.md`)
      const content = redactText([`# YouTube transcript ${id}`, `Source: https://www.youtube.com/watch?v=${id}`, "Provider: ScrapeCreators", `Language: ${body.language ?? "not reported"}`, `Requested language: ${language ?? "automatic"}; original audio only: ${args.originalAudio === true}`, `Retrieved: ${new Date().toISOString()}`, "", "## Full Transcript", "", ...segments].join("\n\n"), knownSecrets())
      let reused = false
      try { writeFileSync(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (!lstatSync(file).isFile()) throw new Error("Existing transcript is not a regular file"); reused = true }
      // Read the preserved file so output describes the file the caller will inspect.
      return outcome("success", `Transcript: ${file}\n${reused ? "The existing saved transcript was kept; this request's current response is retained separately." : "Saved timestamped transcript."}\nLanguage returned by this request: ${body.language ?? "unknown"}\nRead the saved file before quoting it.`, { transcriptFile: file })
    } catch (error) {
      ctx.abort.throwIfAborted()
      return `ERROR: ${redactText(error instanceof Error ? error.message : "Transcript retrieval failed", knownSecrets())}`
    }
  },
} satisfies ToolSpec)
