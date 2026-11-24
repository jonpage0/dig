import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import {
  executeAction,
  type ActionContext,
  type AnyActionDefinition,
  type ToolProgress,
} from "../../core/plugin.ts";
import youtubeSource, {
  buildYouTubeRequest,
  cleanVtt,
  youtubeAction,
  youtubeAnalysisStatusAction,
  youtubeAnalyzeAction,
  youtubeCommentsAction,
  youtubeInput,
  youtubeLibraryDir,
  youtubeTranscriptAction,
} from "./index.ts";

interface RecordedCall {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
}

function makeLayer(
  handler: (call: RecordedCall) => Response | Error,
  calls: RecordedCall[],
) {
  const base = HttpClient.make((req) =>
    Effect.gen(function* () {
      const bodyText =
        req.body._tag === "Uint8Array"
          ? new TextDecoder().decode(req.body.body)
          : req.body._tag === "Raw" && typeof req.body.body === "string"
            ? req.body.body
            : "";
      const call: RecordedCall = {
        url: new URL(req.url),
        method: req.method,
        headers: { ...req.headers },
        bodyText,
      };
      calls.push(call);
      const reply = handler(call);
      if (reply instanceof Error) {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: req,
              description: reply.message,
              cause: reply,
            }),
          }),
        );
      }
      return HttpClientResponse.fromWeb(req, reply);
    }),
  );
  return Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
  );
}

describe("youtubeSource", () => {
  const envKeys = [
    "PATH",
    "DIG_STATE_DIR",
    "OPENCODE_RESEARCH_GOOGLE_API_KEY",
    "SCRAPECREATORS_API_KEY",
    "GEMINI_API_KEY",
  ] as const;
  const saved = new Map<string, string | undefined>(envKeys.map((k) => [k, process.env[k]]));

  let root: string;
  let calls: RecordedCall[];
  let retained: Array<{ label: string; status: number | string; body: unknown }>;
  let progressEvents: ToolProgress[];

  beforeEach(() => {
    for (const k of envKeys) {
      if (k !== "PATH") delete process.env[k];
    }
    root = mkdtempSync(join(tmpdir(), "dig-yt-2-"));
    process.env.DIG_STATE_DIR = join(root, "state");
    calls = [];
    retained = [];
    progressEvents = [];
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const run = <A extends AnyActionDefinition>(
    action: A,
    args: unknown,
    handler: (call: RecordedCall) => Response | Error = () => {
      throw new Error("unexpected HTTP");
    },
    signal = new AbortController().signal,
  ) => {
    const ctx: ActionContext = {
      digId: "yt-test",
      project: root,
      signal,
      progress: (p) => progressEvents.push(p),
      keep: (label, status, body) => retained.push({ label, status, body }),
    };
    return Effect.runPromise(
      executeAction(action, args as never, ctx).pipe(Effect.provide(makeLayer(handler, calls))),
    );
  };

  it("exports plugin metadata with 5 actions and cleans rolling VTT captions", () => {
    assert.equal(youtubeSource.id, "youtube");
    assert.equal(youtubeSource.group, "video");
    assert.equal(youtubeSource.logo, "youtube");
    assert.deepEqual(youtubeSource.skills, ["youtube", "youtube-video"]);
    assert.deepEqual(youtubeSource.helpers, ["youtube-summarizer"]);
    assert.deepEqual(
      youtubeSource.actions.map((a) => a.name),
      ["youtube", "youtube_transcript", "youtube_comments", "youtube_analyze", "youtube_analysis_status"],
    );
    assert.equal(youtubeAction.slow, true);
    assert.equal(youtubeAnalyzeAction.slow, true);
    assert.equal(youtubeAnalysisStatusAction.slow, true);

    const rolling = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "00:00:00.160 --> 00:00:02.869 align:start position:0%",
      "The<00:00:00.480><c> answer</c><00:00:00.800><c> is</c><00:00:01.120><c> yes.</c>",
      "",
      "00:00:02.869 --> 00:00:02.879 align:start position:0%",
      "The answer is yes.",
      "",
      "00:00:02.879 --> 00:00:05.150 align:start position:0%",
      "The answer is yes.",
      "Here is why.",
      "",
      "00:01:00.000 --> 00:01:02.000 align:start position:0%",
      "Here is why.",
      "The answer is yes.",
    ].join("\n");
    assert.equal(cleanVtt(rolling), "The answer is yes. Here is why. The answer is yes.");
  });

  it("youtube searches via Data API, saves redacted transcripts via yt-dlp preferring uploaded captions, and emits progress", async () => {
    if (process.platform === "win32") return;
    const secret = "Transcript/Key+PRIVATE-sample-7";
    process.env.SCRAPECREATORS_API_KEY = secret;
    process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY = "fixture-google-key";

    const bin = join(root, "bin");
    const vid = "uploadedCap";
    const captions = `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nUploaded words with ${secret}.\n`;
    const autoCaptions = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAutomatic words.\n";
    writeFileSync(join(root, "dummy"), "");
    const fs = await import("node:fs");
    fs.mkdirSync(bin);
    writeFileSync(
      join(bin, "yt-dlp"),
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        'const out = args[args.indexOf("-o") + 1];',
        'const id = new URL(args.at(-1)).searchParams.get("v");',
        'const base = out.replace("%(id)s", id);',
        'fs.writeFileSync(base + ".info.json", JSON.stringify({ subtitles: { "en-US": [] } }));',
        `fs.writeFileSync(base + ".en-US.vtt", ${JSON.stringify(captions)});`,
        `fs.writeFileSync(base + ".en.vtt", ${JSON.stringify(autoCaptions)});`,
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${delimiter}${saved.get("PATH") ?? ""}`;

    const res = await run(youtubeAction, { query: "test", limit: 1, transcripts: true }, (call) => {
      if (call.url.pathname.endsWith("/search")) {
        return Response.json({
          items: [{ id: { videoId: vid }, snippet: { title: `Talk ${secret}`, channelTitle: "Chan", publishedAt: "2026-11-01T00:00:00Z" } }],
        });
      }
      if (call.url.pathname.endsWith("/videos")) {
        return Response.json({
          items: [{ id: vid, statistics: { viewCount: "1200", likeCount: "40" }, contentDetails: { duration: "PT5M10S" } }],
        });
      }
      return new Response("not found", { status: 404 });
    });

    assert.equal(res.status, "success", res.text);
    assert.deepEqual(res.details?.cost, []);
    assert.match(res.text, /from uploaded English captions \(en-US\)/);
    assert.ok(progressEvents.length >= 3, "youtube search + transcript fetch must emit progress");

    const file = join(youtubeLibraryDir(), "youtube-transcripts", `${vid}.md`);
    const savedText = readFileSync(file, "utf8");
    assert.match(savedText, /Uploaded words/);
    assert.doesNotMatch(savedText, /Automatic words/);
    assert.ok(!savedText.includes(secret), "credentials must be redacted before writing transcripts");
  });

  it("youtube_transcript saves distinct language/originalAudio filenames write-once and bills ScrapeCreators credits", async () => {
    process.env.SCRAPECREATORS_API_KEY = "sc-fixture-key";
    let words = "Original words";
    const handler = (call: RecordedCall) => {
      const lang = call.url.searchParams.get("language");
      return Response.json({
        success: true,
        videoId: "abcdefghijk",
        language: lang ?? "English",
        credits_charged: 1,
        transcript: [{ startMs: "1", endMs: "200", text: `${words} in ${lang ?? "default"}` }],
      });
    };

    const fr = await run(youtubeTranscriptAction, { video: "abcdefghijk", originalAudio: true, language: "fr" }, handler);
    assert.equal(fr.status, "success", fr.text);
    assert.deepEqual(fr.details?.cost, [{ amount: 1, unit: "credits" }]);
    const frFile = fr.details?.transcriptFile as string;
    assert.equal(basename(frFile), "abcdefghijk-scrapecreators-original-fr.md");
    assert.match(readFileSync(frFile, "utf8"), /\[1–200 ms\] Original words in fr/);

    // Second fetch never overwrites existing file
    words = "Replacement words";
    const frAgain = await run(youtubeTranscriptAction, { video: "abcdefghijk", originalAudio: true, language: "fr" }, handler);
    assert.equal(frAgain.status, "success");
    assert.doesNotMatch(readFileSync(frFile, "utf8"), /Replacement words/);

    const de = await run(youtubeTranscriptAction, { video: "abcdefghijk", originalAudio: true, language: "de" }, handler);
    assert.equal(basename(de.details?.transcriptFile as string), "abcdefghijk-scrapecreators-original-de.md");

    const auto = await run(youtubeTranscriptAction, { video: "abcdefghijk" }, handler);
    assert.equal(basename(auto.details?.transcriptFile as string), "abcdefghijk-scrapecreators-auto.md");

    // Null transcript -> empty, 0 credits -> []
    const absent = await run(youtubeTranscriptAction, { video: "abcdefghijk", language: "es" }, () =>
      Response.json({ success: true, videoId: "abcdefghijk", transcript: null, credits_charged: 0 }),
    );
    assert.equal(absent.status, "empty");
    assert.deepEqual(absent.details?.cost, []);
  });

  it("youtube_comments formats pages, narrows display limit, redacts errors, and never retries", async () => {
    process.env.SCRAPECREATORS_API_KEY = "sc-test-key-0231";
    const c1 = {
      id: "c1",
      content: "Great breakdown!",
      publishedTimeText: "2 days ago",
      publishedTime: "2025-01-23T23:14:02.948Z",
      replyLevel: 0,
      author: { name: "@Alice", isVerified: false, isCreator: false },
      engagement: { likes: 110, replies: 5 },
    };
    const c2 = {
      ...c1,
      id: "c2",
      content: "Thanks for watching.",
      author: { name: "@Creator", isVerified: true, isCreator: true },
      engagement: { likes: 1, replies: 0 },
    };

    const page = await run(
      youtubeCommentsAction,
      { url: "https://youtube.com/shorts/dQw4w9WgXcQ", order: "top", cursor: "tok1", limit: 1 },
      (call) => {
        assert.equal(call.headers["x-api-key"], "sc-test-key-0231");
        assert.equal(call.url.searchParams.get("url"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        assert.equal(call.url.searchParams.get("order"), "top");
        assert.equal(call.url.searchParams.get("continuationToken"), "tok1");
        return Response.json({
          success: true,
          credits_charged: 1,
          comments: [c1, c2],
          continuationToken: "next-tok",
        });
      },
    );
    assert.equal(page.status, "success", page.text);
    assert.deepEqual(page.details?.cost, [{ amount: 1, unit: "credits" }]);
    assert.match(page.text, /Comments returned: 2 \| 1 shown of 2 returned \(limit=1\)/);
    assert.doesNotMatch(page.text, /@Creator/);
    assert.match(page.text, /Next page: pass cursor="next-tok"/);

    calls = [];
    const errRes = await run(youtubeCommentsAction, { url: "dQw4w9WgXcQ" }, () =>
      Response.json({ success: false, error: "Insufficient credits for sc-test-key-0231" }, { status: 402 }),
    );
    assert.equal(errRes.status, "failed");
    assert.equal(calls.length, 1);
    assert.equal(errRes.details?.cost, null);
    assert.ok(!errRes.text.includes("sc-test-key-0231"));
  });

  it("youtube_analyze & youtube_analysis_status validate inputs, support structured JSON, status/cancel, progress, and never retry", async () => {
    process.env.GEMINI_API_KEY = "gemini-offline-synthetic-key";
    const id = "aB_cD-eF123";
    const watchUrl = `https://www.youtube.com/watch?v=${id}`;

    assert.deepEqual(youtubeInput({ url: id }), { type: "video", uri: watchUrl, processing: { type: "static" } });
    assert.throws(() => youtubeInput({ url: "https://youtube.com/playlist?list=PL123" }));
    assert.throws(() => youtubeInput({ url: id, processing: "agentic", fps: 2 }));

    const built = buildYouTubeRequest({
      question: "Compare both",
      videos: [
        { url: id, startSeconds: 1, endSeconds: 20, fps: 2, resolution: "high" },
        { url: id, processing: "agentic", resolution: "ultra_high" },
      ],
    });
    assert.equal(built.model, "gemini-3.8-flash");
    assert.equal(built.input.length, 3);

    const usage = { total_input_tokens: 400, total_output_tokens: 80, total_tokens: 480 };
    const completedPayload = (extra: Record<string, unknown> = {}) => ({
      id: "interaction_fixture",
      status: "completed",
      model: "gemini-3.8-flash",
      usage,
      steps: [
        { type: "processing_call" },
        { type: "processing_result" },
        {
          type: "model_output",
          content: [{ type: "text", text: '{"observations":["door closes"]}', mime_type: "application/json" }],
        },
      ],
      ...extra,
    });

    const structured = await run(
      youtubeAnalyzeAction,
      {
        question: "Extract JSON",
        videos: [{ url: id, processing: "agentic" }],
        responseSchema: { type: "object" },
      },
      (call) => {
        assert.equal(call.headers["x-goog-api-key"], "gemini-offline-synthetic-key");
        return Response.json(completedPayload());
      },
    );
    assert.equal(structured.status, "success", structured.text);
    assert.equal(structured.details?.cost, null);
    assert.equal(structured.details?.processingObserved, true);
    assert.deepEqual(structured.details?.structuredAnswer, { observations: ["door closes"] });
    assert.ok(progressEvents.length >= 2);

    // Status get & cancel
    const got = await run(youtubeAnalysisStatusAction, { interactionId: "interaction_fixture" }, (call) => {
      assert.equal(call.method, "GET");
      assert.ok(call.url.pathname.endsWith("/interactions/interaction_fixture"));
      return Response.json(completedPayload());
    });
    assert.equal(got.status, "success");
    assert.equal(got.details?.cost, null);

    const cancelled = await run(
      youtubeAnalysisStatusAction,
      { interactionId: "interaction_fixture", action: "cancel" },
      (call) => {
        assert.equal(call.method, "POST");
        assert.ok(call.url.pathname.endsWith("/interactions/interaction_fixture/cancel"));
        return Response.json({ id: "interaction_fixture", status: "cancelled", usage });
      },
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.details?.cost, null);

    // HTTP error & transport failure never retry and redact key
    calls = [];
    const failedHttp = await run(
      youtubeAnalyzeAction,
      { question: "Check", videos: [{ url: id }] },
      () =>
        Response.json(
          { error: { status: "UNAVAILABLE", message: "Echo gemini-offline-synthetic-key" } },
          { status: 503 },
        ),
    );
    assert.equal(failedHttp.status, "failed");
    assert.equal(calls.length, 1);
    assert.equal(failedHttp.details?.cost, null);
    assert.ok(!failedHttp.text.includes("gemini-offline-synthetic-key"));

    // Abort during polling sends /cancel
    calls = [];
    const abort = new AbortController();
    const aborted = await run(
      youtubeAnalyzeAction,
      { question: "Check", videos: [{ url: id }] },
      (call) => {
        if (call.url.pathname.endsWith("/interactions") && call.method === "POST") {
          setTimeout(() => abort.abort(), 30);
          return Response.json({ id: "interaction_abort", status: "in_progress" });
        }
        if (call.url.pathname.endsWith("/interaction_abort/cancel")) {
          return Response.json({ id: "interaction_abort", status: "cancelled" });
        }
        return Response.json({ id: "interaction_abort", status: "in_progress" });
      },
      abort.signal,
    );
    assert.equal(aborted.status, "cancelled");
    assert.ok(calls.some((c) => c.url.pathname.endsWith("/interaction_abort/cancel") && c.method === "POST"));

    // background:true returns pending partial without polling or cancelling
    calls = [];
    const bg = await run(
      youtubeAnalyzeAction,
      { question: "Check bg", videos: [{ url: id }], background: true },
      () => Response.json({ id: "interaction_bg", status: "queued" }),
    );
    assert.equal(bg.status, "partial");
    assert.equal(bg.details?.interactionId, "interaction_bg");
    assert.equal(bg.details?.nextTool, "youtube_analysis_status");
    assert.equal(calls.length, 1);

    // Poll failure on a stored interaction leaves it running at Google (no /cancel) and returns resumable partial
    calls = [];
    const pollFail = await run(
      youtubeAnalyzeAction,
      { question: "Check poll fail", videos: [{ url: id }] },
      (call) => {
        if (call.method === "POST" && call.url.pathname.endsWith("/interactions")) {
          return Response.json({ id: "interaction_keep", status: "in_progress" });
        }
        return new Error("temporary network drop");
      },
    );
    assert.equal(pollFail.status, "partial");
    assert.equal(pollFail.details?.interactionId, "interaction_keep");
    assert.equal(pollFail.details?.nextTool, "youtube_analysis_status");
    assert.ok(!calls.some((c) => c.url.pathname.endsWith("/cancel")), "poll failure must not cancel running stored interaction");
  });
});
