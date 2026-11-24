import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { executeAction, type ActionContext, type ToolProgress } from "../../core/plugin.ts";
import videoSource, {
  videoAnalyzeAction,
  videoCoverage,
  videoOptions,
  youtubeVideoId,
} from "./index.ts";

const VIDEO = "https://media.example.org/demo.mp4";
const ARGS = { video: VIDEO, question: "What changes between the opening and closing scene?" };

interface RecordedCall {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyTag: string;
  readonly bodyText: string;
}

const provenance = () => ({
  frames: 24,
  video_seconds: 12,
  truncated: false,
  trace_truncated: false,
  audio_processed: true,
  asr: { status: "ok" },
});

const completion = (extra: Record<string, unknown> = {}) => ({
  model: "glimpse",
  choices: [{ finish_reason: "stop", message: { content: "At 00:02 the door opens; at 00:08 it closes." } }],
  usage: { prompt_tokens: 220, completion_tokens: 42, total_tokens: 262, elorian: provenance() },
  ...extra,
});

const completed = (value = completion()) => ({ id: "run_offline1", status: "completed", completion: value });

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
        bodyTag: req.body._tag,
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

describe("videoSource", () => {
  const originalKey = process.env.ELORIAN_API_KEY;
  const originalPath = process.env.PATH;
  const originalState = process.env.DIG_STATE_DIR;
  let root: string;
  let calls: RecordedCall[];
  let retained: Array<{ label: string; status: number | string; body: unknown }>;
  let progressEvents: ToolProgress[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dig-video-2-"));
    process.env.DIG_STATE_DIR = join(root, "state");
    process.env.ELORIAN_API_KEY = "elorian-offline-synthetic-key";
    calls = [];
    retained = [];
    progressEvents = [];
  });

  afterEach(async () => {
    for (const [name, value] of [
      ["ELORIAN_API_KEY", originalKey],
      ["PATH", originalPath],
      ["DIG_STATE_DIR", originalState],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const run = (
    handler: (call: RecordedCall) => Response | Error,
    args: Record<string, unknown> = ARGS,
    signal = new AbortController().signal,
  ) => {
    const ctx: ActionContext = {
      digId: "video-test",
      project: root,
      signal,
      progress: (p) => progressEvents.push(p),
      keep: (label, status, body) => retained.push({ label, status, body }),
    };
    return Effect.runPromise(
      executeAction(videoAnalyzeAction, args as never, ctx).pipe(Effect.provide(makeLayer(handler, calls))),
    );
  };

  it("exports plugin metadata with kind='tool', helperSkill='video-analyze', and slow action", () => {
    assert.equal(videoSource.id, "video");
    assert.equal(videoSource.kind, "tool");
    assert.equal(videoSource.group, "tools");
    assert.equal(videoSource.helperSkill, "video-analyze");
    assert.equal(videoAnalyzeAction.slow, true);
    assert.deepEqual(videoSource.keys, ["ELORIAN_API_KEY"]);
  });

  it("validates options, YouTube URL forms, and coverage warnings", () => {
    assert.deepEqual(videoOptions({ video: ` ${VIDEO} `, question: " Observe the door. " }), {
      video: VIDEO,
      question: "Observe the door.",
      effort: "high",
      fps: 2,
      maxTokens: 1600,
      start: 0,
      end: 120,
      explicitClip: false,
    });
    assert.equal(videoOptions({ ...ARGS, startSeconds: 300 }).end, 420);
    for (const extra of [
      { video: "" },
      { question: " " },
      { effort: "low" },
      { fps: 0 },
      { fps: 9 },
      { maxTokens: 127 },
      { maxTokens: 4097 },
      { startSeconds: -1 },
      { startSeconds: 30, endSeconds: 30 },
      { startSeconds: 0, endSeconds: 121 },
    ]) {
      assert.throws(() => videoOptions({ ...ARGS, ...extra }));
    }

    const vid = "aB_cD-eF123";
    for (const url of [
      `https://youtube.com/watch?v=${vid}`,
      `https://www.youtube.com/watch?v=${vid}&t=20`,
      `https://m.youtube.com/watch?v=${vid}`,
      `https://youtu.be/${vid}`,
      `https://www.youtube.com/shorts/${vid}`,
      `https://www.youtube.com/live/${vid}`,
    ]) {
      assert.equal(youtubeVideoId(url), vid);
    }
    for (const url of [
      `http://youtube.com/watch?v=${vid}`,
      `https://youtube.com.evil.test/watch?v=${vid}`,
      `https://user:pass@youtube.com/watch?v=${vid}`,
      `https://youtube.com/playlist?list=123`,
    ]) {
      assert.equal(youtubeVideoId(url), null);
    }

    assert.equal(videoCoverage(completion()).partial, false);
    assert.equal(videoCoverage(completion({ usage: { elorian: { ...provenance(), truncated: true } } })).partial, true);
  });

  it("analyzes a direct HTTPS video over PaidHttp, emits progress, reports unknown cost, and never retries errors", async () => {
    const ok = await run((call) => {
      assert.equal(call.url.pathname, "/v1/chat/completions");
      assert.equal(call.headers.authorization, "Bearer elorian-offline-synthetic-key");
      const body = JSON.parse(call.bodyText) as { model: string; background: boolean };
      assert.equal(body.model, "glimpse");
      assert.equal(body.background, true);
      return Response.json(completed());
    });
    assert.equal(ok.status, "success", ok.text);
    assert.equal(ok.details?.cost, null);
    assert.equal(ok.details?.runId, "run_offline1");
    assert.match(ok.text, /At 00:02 the door opens/);
    assert.ok(progressEvents.length >= 2, "must emit live progress updates");

    calls = [];
    const failedRes = await run(() => new Error("connection reset"));
    assert.equal(failedRes.status, "failed");
    assert.equal(calls.length, 1, "PaidHttp must never retry Elorian requests");
    assert.equal(failedRes.details?.cost, null);
  });

  it("cancels an active provider run when caller aborts during polling", async () => {
    const abort = new AbortController();
    const res = await run(
      (call) => {
        if (call.url.pathname === "/v1/chat/completions") {
          setTimeout(() => abort.abort(), 30);
          return Response.json({ id: "run_cancel_me", status: "queued" });
        }
        if (call.url.pathname === "/v1/runs/run_cancel_me/cancel") {
          return Response.json({ id: "run_cancel_me", status: "cancelled" });
        }
        return Response.json({ id: "run_cancel_me", status: "in_progress" });
      },
      ARGS,
      abort.signal,
    );
    assert.equal(res.status, "cancelled");
    assert.ok(calls.some((c) => c.url.pathname === "/v1/runs/run_cancel_me/cancel" && c.method === "POST"));
    assert.equal(res.details?.cost, null);
  });

  it("uploads a prepared local project clip via multipart FormData over PaidHttp and refuses paths escaping project", async () => {
    if (process.platform === "win32") return;

    const outside = await mkdtemp(join(tmpdir(), "dig-video-outside-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const probe = `#!${process.execPath}
process.stdout.write(JSON.stringify({ format: { duration: 10 }, streams: [{ codec_type: "video", width: 320, height: 180 }, { codec_type: "audio" }] }));
`;
      const prepare = `#!${process.execPath}
require("node:fs").writeFileSync(process.argv.at(-1), "synthetic-mp4-bytes");
`;
      await writeFile(join(bin, "ffprobe"), probe, { mode: 0o700 });
      await writeFile(join(bin, "ffmpeg"), prepare, { mode: 0o700 });
      process.env.PATH = bin;

      const outsideFile = join(outside, "private.mp4");
      await writeFile(outsideFile, "secret");
      const escapedLink = join(root, "escaped.mp4");
      await symlink(outsideFile, escapedLink);

      for (const badPath of [outsideFile, escapedLink]) {
        const refused = await run(
          () => {
            throw new Error("must not call Elorian for outside path");
          },
          { ...ARGS, video: badPath },
        );
        assert.equal(refused.status, "failed");
        assert.match(refused.text, /inside the selected project/);
      }
      assert.equal(calls.length, 0);

      const localVideo = join(root, "demo.mp4");
      await writeFile(localVideo, "synthetic-original");
      const res = await run(
        (call) => {
          if (call.url.pathname === "/v1/files" && call.method === "POST") {
            assert.equal(call.bodyTag, "FormData");
            return Response.json({ id: "file-abc123", status: "ready" });
          }
          if (call.url.pathname === "/v1/chat/completions") {
            assert.match(call.bodyText, /file:\/\/file-abc123/);
            return Response.json(completed());
          }
          return new Response("not found", { status: 404 });
        },
        { ...ARGS, video: localVideo, startSeconds: 0, endSeconds: 10 },
      );
      assert.equal(res.status, "success", res.text);
      assert.equal(res.details?.uploadedFile, "file-abc123");
      assert.ok(progressEvents.some((p) => /Uploading prepared clip/.test(p.message)));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("fails before network when ELORIAN_API_KEY is missing or direct URL is invalid, and passes --js-runtimes to yt-dlp", async () => {
    for (const extra of [
      { video: "http://media.example.org/demo.mp4" },
      { video: "https://user:pass@media.example.org/demo.mp4" },
      { video: "https://youtube.com/playlist?list=123" },
      { startSeconds: 5 },
    ]) {
      const r = await run(
        () => {
          throw new Error("must not hit network");
        },
        { ...ARGS, ...extra },
      );
      assert.equal(r.status, "failed");
    }

    delete process.env.ELORIAN_API_KEY;
    const missing = await run(() => {
      throw new Error("must not hit network");
    });
    assert.equal(missing.status, "failed");
    assert.match(missing.text, /ELORIAN_API_KEY/);
    assert.equal(calls.length, 0);

    if (process.platform !== "win32") {
      process.env.ELORIAN_API_KEY = "elorian-offline-synthetic-key";
      const bin = join(root, "bin-yt");
      await mkdir(bin);
      const argvFile = join(root, "yt-args.json");
      await writeFile(
        join(bin, "yt-dlp"),
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n`,
        { mode: 0o700 },
      );
      for (const name of ["ffmpeg", "ffprobe"]) {
        await writeFile(join(bin, name), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      }
      process.env.PATH = bin;
      const ytFail = await run(
        () => {
          throw new Error("must not hit network");
        },
        { ...ARGS, video: "https://www.youtube.com/watch?v=aB_cD-eF123" },
      );
      assert.equal(ytFail.status, "failed");
      const argv = JSON.parse(await readFile(argvFile, "utf8")) as string[];
      assert.equal(argv[argv.indexOf("--js-runtimes") + 1], `node:${process.execPath}`);
      assert.ok(!argv.includes("--no-warnings"));
    }
  });
});
