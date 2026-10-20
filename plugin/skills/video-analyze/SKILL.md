---
name: video-analyze
description: Call Dig's standalone Elorian Glimpse tool to inspect a supplied video or focused interval for visual events, temporal order and demonstrations. Works directly in conversation without a dig or report, and alongside appropriate source research.
---

# Video analysis

Use this helper when what happens on screen matters to the question: actions, object changes, diagrams, demonstrations and event order. It exposes the ordinary MCP tool `video_analyze`, callable directly by the initiating thread. No `dig_start`, source worker or report is required. Captions remain useful for creator claims; a talking-head lecture answered by its transcript may need no paid visual call.

For deeper analysis of a supplied public YouTube video, the standard route is the `youtube-video` method with Gemini 3.8 Flash. Prefer Gemini 4 Argon next for harder reasoning. Use Glimpse directly when a concrete visual need calls for focused inspection, or when the user chooses Glimpse. Preserve explicit provider choices and spend limits; do not turn this guidance into a mandatory sequence of paid calls.

## Choose the evidence

Read `source_info` with `source: "video"`. It is a shared tool (`kind: "tool"`), with no research method or suggested worker. Use only this plugin's `video_analyze`. Respect its enabled state and the user's paid-provider scope. The user sets `ELORIAN_API_KEY` in Dig's private keys.env; never ask for or return its value.

Select a specific video and a concrete visual question. Pass the absolute `project`; `dig` is optional and is used only when grouping is already wanted. A source worker may use this helper when its source method explicitly allows the exception, on media from that assigned source. It does not become a second source worker and does not start another dig.

Inputs:

- **YouTube:** pass an exact HTTPS watch, shorts or youtu.be video URL. Dig uses installed `yt-dlp`, `ffmpeg` and `ffprobe` to prepare a bounded clip and upload it to Elorian. The default covers the first 120 seconds only. Use `startSeconds` and `endSeconds` to inspect the relevant interval, at most 120 seconds per call. URL `t=` is not a clip selector; pass seconds explicitly.
- **Local clip:** pass an absolute MP4, MOV or WebM path inside the selected project, including its resolved symlink target. The same clip bounds apply. Dig uploads the prepared media to Elorian; never select unrelated private files.
- **Direct media:** pass an HTTPS video-file URL, not a social post or webpage URL. Elorian fetches it; Dig cannot trim this input. A provider-issued `file://file-ID` from an earlier upload is also accepted and is not a local file path. Provider media limits apply. Prefer a short supplied clip.

A download, access gate or unsupported format can fail. Stop and describe that gap. Do not introduce cookies, sign-in, another paid service or repeated attempts to force it to work. A missing local tool is a prerequisite, not proof that a video is missing. No executable is installed automatically.

## Ask and interpret

Use `effort: "high"` for an ordinary first inspection; `xhigh` or `max` only when the harder question warrants their extra work within the user's scope. `fps` requests initial sampling (default 2); actual sampling may differ and rapid actions can fall between frames. `maxTokens` caps the final answer, not internal reasoning or total spend. Keep the question focused and ask for a concise answer.

Ask for timestamped observations and uncertainty. For example: “Between source seconds 35 and 55, what action changes the mechanism? Give clip-relative and original-video timestamps and distinguish observation from inference.” Dig supplies the original clip offset to the model. Generated timestamps are still claims to check against the clip; they are not exact edit points.

Read the full returned text and coverage metadata:

- `frames`, `video_seconds`, effective frame rate and truncation describe the provider's media coverage, not proof it reasoned correctly about every frame.
- `asr` describes automatic speech recognition. `ok` means transcription ran, not that every word is correct. A failed or skipped transcription cannot establish what was said. Even `silence` is a provider assessment.
- A shortened answer, missing frame provenance or incomplete audio/trace is surfaced explicitly. Keep that limit in the answer or report. A successful HTTP response alone is insufficient.
- Separate **visible observation**, **transcribed speech**, and **model inference**. Caption claims and Glimpse's interpretation of the same video are not two independent corroborating sources. Never claim direct human review of media that only the provider inspected.

The tool uses Elorian's own video/code workflow but disables its web and visual search. It starts one run, waits within the tool call, and asks Elorian to cancel when the waiter is interrupted. It never automatically retries analysis. A host crash does not provide durable job recovery. Local scratch media is removed; uploaded files remain at Elorian until the expiry returned in the upload response. Raw retention keeps responses and preparation metadata, not the media bytes or generated image artifacts.

## Retain and report honestly

A call retains the existing Dig receipt and provider responses when `keep_raw` permits. Read relevant originals through `library_read`, following pagination, before using them for a load-bearing conclusion. A missing `raw` reference or `retentionError` is a retention gap.

Elorian reports prompt, cached and completion/reasoning tokens. Show these as usage if useful. Dig does not turn token rates into a provider-reported dollar charge: the receipt's cost remains unknown. Do not silently equate unknown with free.

Keep the original video/post URL, inspected interval, analysis call ID and raw reference in the source report's evidence section. Save under the actual research source (YouTube, X, and so on). There is no `research_save` source named `video`; this helper creates no report or transcript file. Standalone use can answer inline with the call receipt. In a grouped dig, shared-tool calls contribute to its usage even when a source report does not claim them.
