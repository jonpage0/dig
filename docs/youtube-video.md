# YouTube video understanding

Dig’s optional YouTube video method analyzes selected public YouTube videos and saves a complete source report with timestamped findings. **Gemini 3.8 Flash is the standard provider. Gemini 4 Argon is the next choice for harder reasoning.** Use the separate [Glimpse tool](video-analysis.md) when a focused visual need warrants it, or when you explicitly choose that provider. A useful answer does not require running every model.

For discovery and claims that captions can establish, the existing `$dig:youtube` transcript method remains available. For deeper analysis of a supplied video, ask:

> Use $dig:youtube-video to explain this demonstration. Start with Flash. Identify the video URL and original-video timestamp for every important observation, distinguish what is shown from what is said, and save the report.

Questions stay in the host conversation. The YouTube card describes the capabilities and setup; it has no separate video-entry or search form.

## Setup

Enable **YouTube** on **Sources & tools**, then add `GEMINI_API_KEY` to Dig’s private `keys.env` using **Edit keys.env**. Get the key from [Google AI Studio](https://aistudio.google.com/apikey). Never paste it into chat.

This is separate from `OPENCODE_RESEARCH_GOOGLE_API_KEY`, the optional Google Cloud key for YouTube Data API search metadata. Dig accepts only `GEMINI_API_KEY` for Gemini. The video-understanding route needs no local yt-dlp, ffmpeg or ffprobe. A missing Gemini key does not disable existing discovery or transcript routes.

The tools are `youtube_analyze` and `youtube_analysis_status`. The `youtube-video` method uses them to write a standard report under the YouTube source. The tools can also answer directly without creating a dig or report; direct calls still take an explicit absolute `project` for their retained evidence.

## Select videos and inspection controls

The first `youtube_analyze` request needs a `question` and `videos`, an array of one to ten video inputs. Each input has its own controls:

| Input field | Meaning |
| --- | --- |
| `url` | A public YouTube watch, shorts, `/live/` or youtu.be video URL, or an exact 11-character video ID. Local files, arbitrary media hosts and playlists are not inputs to this route. |
| `processing` | `static` by default, with the selected sampling controls; `agentic` lets Google choose what to inspect. This is provider processing, not another Dig worker. |
| `startSeconds`, `endSeconds` | An optional interval for static mode; the end must be later than the start. A URL’s `t=` parameter does not select the interval. |
| `fps` | Optional static sampling between 0.01 and 30 frames per second. Omission uses Google’s default. |
| `resolution` | Optional `low`, `medium`, `high` or `ultra_high` media resolution. |

Agentic processing rejects explicit interval and FPS controls. A supported URL format does not establish that its video is public or readable. Prefer a relevant interval when it answers the question, and a whole video when its full arc matters. Higher sampling or resolution uses more provider context and does not guarantee that every event was understood.

The provider model is `gemini-3.8-flash` by default; choose `gemini-4-argon` explicitly for Argon. This choice is separate from the Codex worker model suggested in Dig’s settings. `thinking` defaults to `low` and can request `minimal`, `low`, `medium` or `high`; Google can reject unsupported model/option combinations. `maxTokens` defaults to 4096 and accepts 128–16384. It is an output limit, not a spending cap.

`responseSchema` requests JSON-shaped findings using Google’s supported JSON Schema subset. Dig returns parsed output in `structuredAnswer`, without repeating the full JSON in the prose text. A valid structure does not establish that its claims or timestamps are correct.

## Grounding and evidence

`webSearch` and `urlContext` are off by default. Choose them explicitly when external verification belongs in the question. Google Search can add web grounding; URL context makes reference URLs available to the provider. **Enabling a provider tool does not prove Google used it.** Inspect returned steps and citation annotations before saying that a search ran or a reference page was read. External grounding citations remain separate from video evidence.

Code execution is unavailable for the direct YouTube route. Google rejected the video input as unsupported for code execution, and Dig does not expose a `codeExecution` option.

Every important observation should name its **video URL and original-video timestamp**. With several video inputs, keep each timeline separate and verify cited intervals independently. A live multi-video response treated the second input’s timestamps as part of a concatenated timeline; a successful call therefore does not establish correct timestamp attribution. Mark an unchecked time as approximate or unverified rather than presenting it as an exact location.

Keep visible observations, speech claims and inference separate. For an exact quotation, check a caption/transcript artifact or the original audio and state how it was obtained. Two models describing the same footage are not independent corroboration. Incomplete processing, unreadable details and unavailable videos remain explicit coverage limits.

## Follow-ups, background work and cancellation

For a follow-up, pass the returned interaction ID as `previousInteractionId` with a new `question`. `videos` can be omitted to reuse stored context; retain the original scope and video references. A follow-up can explicitly choose Argon when a Flash answer leaves a harder question unresolved.

The default call waits for Google’s analysis for up to 480 seconds. If it is still running, Dig returns a partial result with its interaction ID and running status. `background: true` returns the ID promptly while Google continues.

Continue with `youtube_analysis_status`:

- `interactionId`: the exact ID returned for this task and account.
- `action: "get"`: read the result; this is the default.
- `waitSeconds`: optionally wait from 0 to 120 seconds on a get.
- `action: "cancel"`: request cancellation; do not combine it with a wait.

Status reads do not launch generation again. Preserve an unfinished interaction’s ID instead of starting another analysis because it is slow. An intentionally returned background interaction continues running. Interrupting a foreground waiter requests cancellation when its started interaction is known; a connection failure can leave cancellation unconfirmed. Dig has no separate persistent job store, and Google’s interaction availability follows its account retention.

## Storage and cost

Google interaction storage defaults to `store: true` for follow-up context, polling and background results. To opt out of that provider history, set `store: false` on a foreground first request without `previousInteractionId`. Google requires storage when continuing a previous interaction. A completed request without provider storage can return no interaction ID; that is expected, and there is no provider-history resume or follow-up mechanism for it.

Dig’s retention is separate: ordinary receipts retain the call and its outcome, and original responses are saved when raw retention is enabled and storage succeeds. A missing raw reference or `retentionError` is an evidence gap. This route sends Google the selected public video references and the question; it does not upload local project media.

Google reports token usage without an authoritative per-call dollar charge, so Dig records the cost as unknown. The usage returned by status reads is cumulative for that interaction, not a fresh amount to add to the previous read. It can include tool-use prompts and thinking. Repeated status calls are distinct Dig receipts, but their repeated token totals must not be presented as repeated inference or estimated cash charges.

## Verification limits

Live checks on October 20, 2026 confirmed a static 30-second interval with one frame per second, high resolution and structured JSON output; a stored follow-up switching to Argon; and a request with two video inputs plus web search and URL context enabled. The multi-video response showed Google Search execution and usable citation annotations, but no URL-context execution. A separate five-second clip request with `urlContext: true` and `store: false` completed with URL-context call/result steps, a successful page read and citations; it returned no interaction ID.

These checks establish those observed routes, not the whole matrix of models, processing modes, resolutions and optional grounding. In particular, the multi-video timestamp error above remains a reason to check attribution against each original video. Dig reports provider refusals and incomplete output instead of silently changing the model or retrying the analysis.
