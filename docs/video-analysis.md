# Glimpse video inspection

Dig’s optional Video analysis tool (`video`, with one action, `video_analyze`) uses Elorian Glimpse to inspect what happens on screen and when. Ask for it in the conversation (“use Dig’s video-analyze method”); it runs under a dig like any call, and no source report is required. It can also complement a transcript or inspect media found by an appropriate source method. Its interpretation is not independent corroboration of the same video.

For broader understanding of a supplied public YouTube video, start with the [YouTube video method](youtube-video.md), whose standard provider is Gemini 3.8 Flash. Prefer Gemini 4 Argon next when harder reasoning is needed. Choose Glimpse directly for a specific visual question, such as a mechanism changing state or a brief action, or when it is your explicit provider choice. This is a choice of useful methods, not a requirement to pay for each one.

Turn on **Video analysis** (ask your assistant, or under **Sources & tools → Shared tools** in Dig's views), then enter `ELORIAN_API_KEY` on the key page the `keys` tool opens, or add it to Dig’s private `keys.env`. [Elorian’s console](https://platform.elorian.ai/settings/keys) provides keys and credits; its [API reference](https://platform.elorian.ai/settings/docs) requires sign-in. Each account pays Elorian directly.

| Input | Behavior |
| --- | --- |
| YouTube watch, shorts or youtu.be URL | Installed yt-dlp downloads a selected interval; ffmpeg prepares it and Elorian receives the clip. No browser cookies or sign-in. |
| Absolute local MP4, MOV or WebM inside the dig's project folder | ffprobe checks it and ffmpeg prepares the selected interval before upload. Symlinks must also resolve inside the project. |
| Direct HTTPS video-file URL | Elorian fetches the supplied media. It must be a video file, not a social post or HTML page. |
| Existing Elorian `file://file-ID` | Analyze a previously uploaded file on the same account. This is a provider identifier, not a local path. |

For YouTube and local files, `startSeconds` defaults to zero and `endSeconds` to 120 seconds later, capped to the video’s duration. Each interval is at most 120 seconds. These paths require ffmpeg and ffprobe; YouTube also requires yt-dlp. Dig does not install these programs automatically. Prepared clips fit within 640 × 360 and 64 MiB; local input files are also capped at 64 MiB. Direct URLs and existing file IDs cannot be trimmed with these arguments and remain subject to Elorian’s current limits.

A useful prompt is: “Use Glimpse to inspect seconds 35–55. What action changes the mechanism? Give the original video URL, clip-relative and original-video timestamps, and distinguish visible evidence from inference.” Use the actual clip range in the call. A time parameter in a YouTube URL is not a clip selector. A call names the dig handle, `action: "video_analyze"` and the video, interval and question in `args`; the receipt is filed under that dig.

`high` is the default effort. `xhigh` and `max` allow more provider work when a question warrants it. The default initial sampling request is two frames per second; the returned effective sampling and frame count describe what the provider received. This does not guarantee that brief events were seen. The answer-token limit is not a ceiling on internal reasoning or total spend. Web and reverse-image searches stay disabled.

The result reports:

- the original reference and selected source interval, alongside prepared clip duration;
- the model’s timestamped interpretation;
- frame, duration and audio-transcription provenance;
- truncated or otherwise incomplete coverage and answers;
- prompt, cache and completion/reasoning token usage.

Automatic speech recognition can mishear words even when its status is successful. Check exact quotations against captions or the original audio. Missing or failed transcription is a coverage limit, and a provider’s “silence” assessment is not proof that every sound was absent. Generated timestamps are approximate evidence pointers, not editing measurements.

Dig retains its ordinary receipt and, when enabled, original JSON responses. It removes temporary local media. Uploaded clips stay at Elorian until the expiration returned by its file endpoint; they are not deleted by local scratch cleanup. Generated provider image artifacts are not downloaded, and media bytes are not copied into the research library. A source report can cite the analysis receipt and raw response while retaining the actual source identity.

Elorian’s observed response reports tokens without an authoritative per-call dollar charge. Dig therefore shows the call’s billed cost as unknown; it does not substitute a token-price estimate. Because the cost is never priced in dollars, Dig asks before each call when `ask_above_usd` is set (unless you answered “don’t ask again” for the dig).

## A slow call

An analysis can take minutes, so it runs as a job in Dig's service, not in the connection. A host that supports MCP tasks follows it as a task. In any other host, if it is still running after 40 seconds the result names the job, and the assistant asks the `job` tool for the result instead of calling again; a repeated identical call attaches to the running job, and one within ten minutes of its end returns its result, so neither pays twice. A dropped connection does not stop the job. `job` with `cancel: true` (or the host's task cancellation) stops it and asks Elorian to stop the run; Dig cannot prove the cancellation if that request fails. If the service stops while the job runs, the job is marked failed on the next start with its cost unknown, and it is not sent again.
