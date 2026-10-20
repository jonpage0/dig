import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSource } from "../outcome.js";
import { findExecutable } from "../executables.js";
import type { RetainedResponse, ToolContext } from "../types.js";
import { runVideoProcess, video_analyze, videoCoverage, videoOptions, youtubeVideoId } from "./video_analyze.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.ELORIAN_API_KEY;
const originalPath = process.env.PATH;
const originalState = process.env.DIG_STATE_DIR;
const VIDEO = "https://media.example.org/demo.mp4";
const ARGS = { video: VIDEO, question: "What changes between the opening and closing scene?" };
let root: string;
let retained: RetainedResponse[];
let calls: { url: URL; init: RequestInit }[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dig-video-provider-"));
  process.env.DIG_STATE_DIR = join(root, "state");
  process.env.ELORIAN_API_KEY = "elorian-offline-synthetic-key";
  retained = [];
  calls = [];
  globalThis.fetch = (async () => { throw new Error("Unexpected network request in offline video test"); }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of [["ELORIAN_API_KEY", originalKey], ["PATH", originalPath], ["DIG_STATE_DIR", originalState]]) {
    if (value === undefined) delete process.env[name!];
    else process.env[name!] = value;
  }
  await rm(root, { recursive: true, force: true });
});

function context(signal = new AbortController().signal): ToolContext {
  return {
    directory: root, worktree: root, sessionID: "video-offline-test", abort: signal,
    keep: (label, status, body, headers) => retained.push({ label, status, body, ...(headers ? { headers } : {}) }),
  };
}
function mockFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}
const provenance = () => ({ frames: 24, video_seconds: 12, truncated: false, trace_truncated: false, audio_processed: true, asr: { status: "ok" } });
const completion = (extra: Record<string, unknown> = {}) => ({
  model: "glimpse", choices: [{ finish_reason: "stop", message: { content: "At 00:02 the door opens; at 00:08 it closes." } }],
  usage: { prompt_tokens: 220, completion_tokens: 42, total_tokens: 262, elorian: provenance() }, ...extra,
});
const completed = (value = completion()) => ({ id: "run_offline1", status: "completed", completion: value });
const run = (args = ARGS, signal?: AbortSignal) => executeSource(video_analyze, args, context(signal));

test("video options trim inputs, set bounded defaults and reject unsupported or unbounded values", () => {
  assert.deepEqual(videoOptions({ video: ` ${VIDEO} `, question: " Observe the door. " }), {
    video: VIDEO, question: "Observe the door.", effort: "high", fps: 2, maxTokens: 1600, start: 0, end: 120, explicitClip: false,
  });
  assert.equal(videoOptions({ ...ARGS, startSeconds: 300 }).end, 420);
  for (const extra of [
    { video: "" }, { question: " " }, { question: "x".repeat(12001) }, { effort: "low" },
    { fps: 0 }, { fps: 9 }, { fps: NaN }, { maxTokens: 127 }, { maxTokens: 4097 }, { maxTokens: 128.5 },
    { startSeconds: -1 }, { startSeconds: Infinity }, { startSeconds: 30, endSeconds: 30 },
    { startSeconds: 0, endSeconds: 121 }, { endSeconds: NaN },
  ]) assert.throws(() => videoOptions({ ...ARGS, ...extra }), undefined, JSON.stringify(extra));
});

test("only exact HTTPS YouTube video forms enter the downloader route", () => {
  const videoId = "aB_cD-eF123";
  for (const url of [
    `https://youtube.com/watch?v=${videoId}`, `https://www.youtube.com/watch?v=${videoId}&t=20`,
    `https://m.youtube.com/watch?v=${videoId}`, `https://youtu.be/${videoId}`,
    `https://www.youtube.com/shorts/${videoId}`, `https://www.youtube.com/live/${videoId}`,
  ]) assert.equal(youtubeVideoId(url), videoId, url);
  for (const url of [
    `http://youtube.com/watch?v=${videoId}`, `https://youtube.com.evil.test/watch?v=${videoId}`,
    `https://evil.test/?v=${videoId}`, `https://evil.youtube.com/watch?v=${videoId}`,
    `https://user:password@youtube.com/watch?v=${videoId}`, `https://youtube.com:444/watch?v=${videoId}`,
    `https://youtube.com/playlist?list=${videoId}`, `https://youtu.be/${videoId}/extra`,
    "https://youtube.com/watch?v=short", "https://youtube.com/watch?v=too-long-video-id", "not a URL",
  ]) assert.equal(youtubeVideoId(url), null, url);
});

test("direct media sends one bounded analysis request with no search and preserves unknown money despite token usage", async () => {
  mockFetch(() => Response.json(completed()));
  const result = await run({ ...ARGS, effort: "xhigh", fps: 4, maxTokens: 256 } as typeof ARGS);
  assert.equal(result.status, "success");
  assert.equal(result.details?.cost, null);
  assert.equal(result.details?.knownCost, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://api.elorian.ai/v1/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.background, true);
  assert.equal(sent.model, "glimpse");
  assert.equal(sent.reasoning_effort, "xhigh");
  assert.equal(sent.video_fps, 4);
  assert.equal(sent.max_completion_tokens, 256);
  assert.deepEqual(sent.tools, []);
  assert.deepEqual(sent.messages[1].content[1], { type: "video_url", video_url: { url: VIDEO } });
  assert.match(sent.messages[0].content, /untrusted evidence/);
  assert.match(sent.messages[1].content[0].text, /What changes/);
  assert.match(result.text, /model interpretation, not independent corroboration/);
  assert.match(result.text, /Token usage:.*220/);
  assert.equal(retained.length, 1);
  assert.deepEqual(retained[0].body, completed());
});

test("reusing a provider file ID does not upload again or silently apply a local clip", async () => {
  mockFetch(() => Response.json(completed()));
  const result = await run({ ...ARGS, video: "file://file-existing" });
  assert.equal(result.status, "success");
  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.messages[1].content[1].video_url.url, "file://file-existing");
  const clipped = await run({ ...ARGS, video: "file://file-existing", startSeconds: 1 } as typeof ARGS);
  assert.equal(clipped.status, "failed");
  assert.match(clipped.text, /require a YouTube URL or local project file/);
  assert.equal(calls.length, 1);
});

test("HTTP 200 error envelopes fail, redact echoed credentials and are retained without retry", async () => {
  mockFetch(() => Response.json({ error: { code: "media_unavailable", message: "Rejected elorian-offline-synthetic-key" } }));
  const result = await run();
  assert.equal(result.status, "failed");
  assert.match(result.text, /media_unavailable/);
  assert.equal(result.details?.cost, null);
  assert.equal(calls.length, 1);
  assert.equal(retained.length, 1);
  assert.doesNotMatch(JSON.stringify({ result, retained }), /elorian-offline-synthetic-key/);
});

test("rate limits, redirects and transport errors make one attempt and never rerun analysis", async () => {
  for (const scenario of ["rate-limit", "redirect", "transport"]) {
    calls = []; retained = [];
    mockFetch(() => {
      if (scenario === "transport") throw new TypeError("Connection lost");
      return Response.json({ error: { message: scenario } }, { status: scenario === "redirect" ? 302 : 429, headers: { location: "https://elsewhere.invalid/" } });
    });
    const result = await run();
    assert.equal(result.status, "failed");
    assert.equal(result.details?.cost, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(retained.length, 1, `${scenario} keeps its response or incomplete-attempt notice`);
  }
});

test("coverage distinguishes complete inspection from missing frames, truncation, ASR failure and unfinished answers", async () => {
  const cases = [
    { changes: { frames: 0 }, words: /frame coverage/ },
    { changes: { video_seconds: 0 }, words: /frame coverage/ },
    { changes: { truncated: true }, words: /truncated media/ },
    { changes: { trace_truncated: true }, words: /truncated inspection trace/ },
    { changes: { asr: { status: "failed", reason: "decode_error" } }, words: /Audio was not fully transcribed/ },
    { changes: { audio_processed: false }, words: /Audio was not fully transcribed/ },
  ];
  for (const { changes, words } of cases) {
    const value = completion({ usage: { elorian: { ...provenance(), ...changes } } });
    mockFetch(() => Response.json(completed(value)));
    const result = await run();
    assert.equal(result.status, "partial", JSON.stringify(changes));
    assert.match(result.text, words);
    assert.equal(result.details?.cost, null);
  }
  const noCoverage = videoCoverage(completion({ usage: { prompt_tokens: 1 } }));
  assert.equal(noCoverage.partial, true);
  assert.match(noCoverage.warnings.join("\n"), /frame coverage/);
  const length = completion({ choices: [{ finish_reason: "length", message: { content: "At 00:02 the" } }] });
  mockFetch(() => Response.json(completed(length)));
  const result = await run();
  assert.equal(result.status, "partial");
  assert.match(result.text, /did not finish normally \(length\)/);
});

test("a documented silent clip remains a complete visual result with an explicit audio limitation", () => {
  const value = completion({ usage: { elorian: { ...provenance(), asr: { status: "skipped", reason: "silence" } } } });
  const coverage = videoCoverage(value);
  assert.equal(coverage.partial, false);
  assert.match(coverage.warnings.join("\n"), /provider assessment, not proof/);
});

test("cancelling a queued run requests remote cancellation once without another analysis request", async () => {
  const abort = new AbortController();
  mockFetch(url => {
    if (url.pathname === "/v1/chat/completions") {
      setTimeout(() => abort.abort(), 0);
      return Response.json({ id: "run_offline1", status: "queued" });
    }
    assert.equal(url.pathname, "/v1/runs/run_offline1/cancel");
    return Response.json({ id: "run_offline1", status: "cancelled" });
  });
  const result = await run(ARGS, abort.signal);
  assert.equal(result.status, "cancelled");
  assert.equal(result.details?.cost, null);
  assert.deepEqual(calls.map(call => [call.url.pathname, call.init.method]), [
    ["/v1/chat/completions", "POST"], ["/v1/runs/run_offline1/cancel", "POST"],
  ]);
  assert.equal(calls[1].init.signal?.aborted, false, "Remote cleanup has its own bounded signal");
  assert.equal(retained.length, 2);
});

test("an unconfirmed remote cancellation is retained explicitly and never retried", async () => {
  const abort = new AbortController();
  mockFetch(url => {
    if (url.pathname === "/v1/chat/completions") {
      setTimeout(() => abort.abort(), 0);
      return Response.json({ id: "run_offline1", status: "queued" });
    }
    throw new TypeError("Cancellation endpoint unavailable");
  });
  const result = await run(ARGS, abort.signal);
  assert.equal(result.status, "cancelled");
  assert.equal(calls.length, 2);
  assert.ok(retained.some(response => response.label === "Elorian cancellation" && /may still incur usage/.test(String(response.body))));
});

test("cancellation while the accepted run response body resolves still cancels that run exactly once", async () => {
  const abort = new AbortController();
  const accepted = { id: "run_late_cancel", status: "queued" };
  mockFetch(url => {
    if (url.pathname === "/v1/chat/completions") {
      const response = Response.json(accepted);
      response.text = async () => {
        abort.abort();
        return JSON.stringify(accepted);
      };
      return response;
    }
    assert.equal(url.pathname, "/v1/runs/run_late_cancel/cancel");
    return Response.json({ id: accepted.id, status: "cancelled" });
  });
  const result = await run(ARGS, abort.signal);
  assert.equal(result.status, "cancelled");
  assert.equal(result.details?.cost, null);
  assert.deepEqual(calls.map(call => [call.url.pathname, call.init.method]), [
    ["/v1/chat/completions", "POST"], ["/v1/runs/run_late_cancel/cancel", "POST"],
  ], "The accepted ID survives local cancellation; no poll or second analysis starts");
  assert.deepEqual(retained[0].body, accepted);
  assert.equal(retained.length, 2);
});

test("cancelling a media process also stops its descendant before it can write a delayed marker", { skip: process.platform === "win32" }, async () => {
  const ready = join(root, "descendant-ready.json");
  const marker = join(root, "descendant-finished");
  const childCode = `
    const fs = require("node:fs");
    setTimeout(() => fs.writeFileSync(process.argv[2], "descendant survived"), 1000);
    fs.writeFileSync(process.argv[1], JSON.stringify({ parent: process.ppid, child: process.pid }));
  `;
  const parentCode = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}, process.argv[1], process.argv[2]], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `;
  const abort = new AbortController();
  // Observe rejection immediately so aborting during the readiness wait never creates an unhandled rejection.
  const running = runVideoProcess(process.execPath, ["-e", parentCode, ready, marker], context(abort.signal), 5000)
    .then(() => null, error => error);
  let pids: { parent: number; child: number } | undefined;
  let stopDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = Date.now() + 4000;
    while (!pids && Date.now() < deadline) {
      try { pids = JSON.parse(await readFile(ready, "utf8")); } catch {}
      if (!pids) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(pids, "The descendant must be running with its delayed write scheduled before cancellation");
    abort.abort();
    const error = await Promise.race([running, new Promise(resolve => { stopDeadline = setTimeout(() => resolve("did not stop"), 1500); })]);
    assert.notEqual(error, "did not stop", "The cancelled media process must settle without waiting for descendants");
    assert.equal(error?.name, "AbortError");
    await new Promise(resolve => setTimeout(resolve, 1200));
    await assert.rejects(stat(marker), { code: "ENOENT" }, "The descendant must not survive its parent cancellation");
  } finally {
    clearTimeout(stopDeadline);
    abort.abort();
    if (pids) {
      try { process.kill(-pids.parent, "SIGKILL"); } catch {}
      try { process.kill(pids.parent, "SIGKILL"); } catch {}
      try { process.kill(pids.child, "SIGKILL"); } catch {}
    }
    await running;
  }
});

test("an ffconcat playlist disguised as MP4 cannot read linked media outside the project or reach upload", async t => {
  const ffmpeg = findExecutable("ffmpeg"), ffprobe = findExecutable("ffprobe");
  if (!ffmpeg || !ffprobe) { t.skip("Requires installed ffmpeg and ffprobe for the real demuxer regression"); return; }
  const outside = await mkdtemp(join(tmpdir(), "dig-video-playlist-outside-"));
  try {
    const media = join(outside, "outside.mp4");
    await runVideoProcess(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=32x32:r=1", "-t", "1", "-c:v", "mpeg4", media], context(), 15000);
    await symlink(media, join(root, "segment.mp4"));
    const playlist = join(root, "playlist.mp4");
    await writeFile(playlist, "ffconcat version 1.0\nfile 'segment.mp4'\n");
    // Establish that automatic format detection would follow this legal relative name through its symlink.
    const unchecked = await runVideoProcess(ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "stream=codec_type", "-of", "json", playlist], context(), 15000);
    assert.ok(JSON.parse(unchecked.stdout).streams.some((stream: any) => stream.codec_type === "video"));
    mockFetch(() => { throw new Error("A disguised playlist must not contact Elorian"); });
    const result = await run({ ...ARGS, video: playlist });
    assert.equal(result.status, "failed");
    assert.match(result.text, /ffprobe could not prepare this video/);
    assert.equal(calls.length, 0);
    assert.equal(retained.length, 0);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("a prepared clip materially shorter than its selected interval fails before upload", { skip: process.platform === "win32" }, async () => {
  const bin = join(root, "bin"); await mkdir(bin);
  const probe = `#!${process.execPath}
    const file = process.argv.at(-1);
    const duration = file.endsWith("/clip.mp4") ? 5 : 30;
    process.stdout.write(JSON.stringify({ format: { duration }, streams: [{ codec_type: "video", width: 320, height: 180 }] }));
  `;
  const prepare = `#!${process.execPath}
    require("node:fs").writeFileSync(process.argv.at(-1), "synthetic prepared clip");
  `;
  await writeFile(join(bin, "ffprobe"), probe, { mode: 0o700 });
  await writeFile(join(bin, "ffmpeg"), prepare, { mode: 0o700 });
  process.env.PATH = bin;
  const video = join(root, "original.mp4"); await writeFile(video, "synthetic original media");
  mockFetch(() => { throw new Error("A short prepared clip must not contact Elorian"); });
  const result = await run({ ...ARGS, video, startSeconds: 0, endSeconds: 10 } as typeof ARGS);
  assert.equal(result.status, "failed");
  assert.match(result.text, /Prepared clip was shorter than the selected interval; no analysis was started/);
  assert.equal(calls.length, 0);
  assert.equal(retained.length, 0, "No prepared-coverage claim is retained for an incomplete clip");
});

test("local paths outside the project and symlinks escaping it fail before upload or analysis", async () => {
  // Executables are present but must never run: containment is checked before media preparation.
  const bin = join(root, "bin"); await mkdir(bin);
  for (const name of ["ffmpeg", "ffprobe"]) await writeFile(join(bin, name), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  process.env.PATH = bin;
  const outside = await mkdtemp(join(tmpdir(), "dig-video-outside-"));
  try {
    const file = join(outside, "private.mp4"); await writeFile(file, "synthetic media");
    const linked = join(root, "escaped.mp4"); await symlink(file, linked);
    mockFetch(() => { throw new Error("A local path refusal must not contact Elorian"); });
    for (const video of [file, linked]) {
      const result = await run({ ...ARGS, video });
      assert.equal(result.status, "failed");
      assert.match(result.text, /inside the selected project/);
    }
    assert.equal(calls.length, 0);
    assert.equal(retained.length, 0);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("invalid direct inputs and missing credentials fail before provider requests", async () => {
  mockFetch(() => { throw new Error("Validation must not contact Elorian"); });
  for (const extra of [
    { video: "http://media.example.org/demo.mp4" },
    { video: "https://username:password@media.example.org/demo.mp4" },
    { video: "https://youtube.com/playlist?list=123" },
    { startSeconds: 5 }, { effort: "invalid" },
  ]) assert.equal((await run({ ...ARGS, ...extra } as typeof ARGS)).status, "failed");
  delete process.env.ELORIAN_API_KEY;
  const result = await run();
  assert.equal(result.status, "failed");
  assert.match(result.text, /ELORIAN_API_KEY/);
  assert.equal(calls.length, 0);
});
