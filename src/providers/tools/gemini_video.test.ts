import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { executeSource } from "../outcome.js";
import { createYouTubeAnalysisSchemas } from "../youtube-analysis-schemas.js";
import type { RetainedResponse, ToolContext, ToolSpec } from "../types.js";
import { buildYouTubeRequest, formatInteraction, validInteractionId, youtube_analyze, youtube_analysis_status, youtubeInput } from "./gemini_video.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.GEMINI_API_KEY;
const originalState = process.env.DIG_STATE_DIR;
const ID = "aB_cD-eF123";
const URL = `https://www.youtube.com/watch?v=${ID}`;
const ARGS = { question: "What changes at the end of this demonstration?", videos: [{ url: ID }] };
const usage = { total_input_tokens: 400, total_output_tokens: 80, total_tokens: 480, total_thought_tokens: 30 };
let root: string;
let calls: { url: string; init: RequestInit }[];
let retained: RetainedResponse[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dig-gemini-video-"));
  process.env.DIG_STATE_DIR = join(root, "state");
  process.env.GEMINI_API_KEY = "gemini-offline-synthetic-key";
  calls = []; retained = [];
  globalThis.fetch = (async () => { throw new Error("Unexpected network request in offline Gemini test"); }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of [["GEMINI_API_KEY", originalKey], ["DIG_STATE_DIR", originalState]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
  await rm(root, { recursive: true, force: true });
});
const context = (signal = new AbortController().signal): ToolContext => ({
  directory: root, worktree: root, sessionID: "gemini-offline", abort: signal,
  keep: (label, status, body, headers) => retained.push({ label, status, body, ...(headers ? { headers } : {}) }),
});
const run = (args: any = ARGS, signal?: AbortSignal, spec: ToolSpec = youtube_analyze) => executeSource(spec, args, context(signal));
const status = (args: any) => run(args, undefined, youtube_analysis_status);
const completed = (extra: Record<string, unknown> = {}) => ({
  id: "interaction_fixture", status: "completed", model: "gemini-3.8-flash", usage,
  steps: [{ type: "model_output", content: [{ type: "text", text: "At 00:18 the operator closes the door." }] }], ...extra,
});
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | globalThis.URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
}

test("YouTube inputs accept exact video forms, canonicalize them and refuse other hosts, files and playlists", () => {
  for (const url of [ID, `https://youtu.be/${ID}?t=12`, `https://m.youtube.com/watch?v=${ID}`, `https://youtube.com/shorts/${ID}`, `https://www.youtube.com/live/${ID}`]) {
    assert.deepEqual(youtubeInput({ url }), { type: "video", uri: URL, processing: { type: "static" } });
  }
  for (const url of ["/tmp/video.mp4", "file://file-existing", "http://youtube.com/watch?v=" + ID, `https://youtube.com.evil.test/watch?v=${ID}`, `https://evil.youtube.com/watch?v=${ID}`, `https://user:password@youtube.com/watch?v=${ID}`, `https://youtube.com:444/watch?v=${ID}`, "https://youtube.com/playlist?list=PL123", "too-short"]) {
    assert.throws(() => youtubeInput({ url }), /Only exact public YouTube/);
  }
  for (const value of [null, [], "https://youtu.be/" + ID, { url: 1 }]) assert.throws(() => youtubeInput(value));
});

test("per-video static offsets map to second strings and preserve independent frame and resolution choices", () => {
  const body = buildYouTubeRequest({ ...ARGS, videos: [
    { url: ID, startSeconds: 0.75, endSeconds: 20.5, fps: 2, resolution: "high" },
    { url: ID, processing: "agentic", resolution: "ultra_high" },
  ] });
  assert.deepEqual(body.input.slice(0, 2), [
    { type: "video", uri: URL, processing: { type: "static", start_offset: "0.75s", end_offset: "20.5s", fps: 2 }, resolution: "high" },
    { type: "video", uri: URL, processing: "agentic", resolution: "ultra_high" },
  ]);
  for (const field of ["startSeconds", "endSeconds", "fps"]) assert.throws(() => youtubeInput({ url: ID, processing: "agentic", [field]: 2 }), /static-mode controls/);
  for (const extra of [{ startSeconds: -1 }, { endSeconds: 0 }, { startSeconds: 4, endSeconds: 4 }, { fps: 0 }, { fps: 31 }, { fps: NaN }, { resolution: "maximum" }, { processing: "adaptive" }]) {
    assert.throws(() => youtubeInput({ url: ID, ...extra }));
  }
});

test("first requests enforce one to ten videos, bounded output and exact provider model choices", () => {
  const body = buildYouTubeRequest(ARGS);
  assert.equal(body.model, "gemini-3.8-flash");
  assert.deepEqual(body.generation_config, { max_output_tokens: 4096, thinking_level: "low", thinking_summaries: "none" });
  assert.equal(body.store, true);
  assert.equal(body.background, true, "The default caller waits on Google's stored background interaction");
  assert.equal(buildYouTubeRequest({ ...ARGS, model: "gemini-4-argon", thinking: "high", maxTokens: 16384 }).model, "gemini-4-argon");
  assert.equal(buildYouTubeRequest({ ...ARGS, videos: Array.from({ length: 10 }, () => ({ url: ID })) }).input.length, 11);
  for (const extra of [{ videos: [] }, { videos: Array.from({ length: 11 }, () => ({ url: ID })) }, { videos: "not an array" }, { question: " " }, { question: "x".repeat(20001) }, { model: "gemini-pro" }, { thinking: "max" }, { maxTokens: 127 }, { maxTokens: 16385 }, { maxTokens: 128.5 }]) {
    assert.throws(() => buildYouTubeRequest({ ...ARGS, ...extra }));
  }
  assert.throws(() => buildYouTubeRequest({ question: "No initial video" }), /Supply videos/);
});

test("optional external tools are off unless chosen and structured findings use the provider response-format shape", () => {
  assert.deepEqual(buildYouTubeRequest(ARGS).tools, []);
  const schema = { type: "object", properties: { observations: { type: "array", items: { type: "string" } } }, required: ["observations"] };
  const body = buildYouTubeRequest({ ...ARGS, webSearch: true, urlContext: true, responseSchema: schema });
  assert.deepEqual(body.tools, [{ type: "google_search", search_types: ["web_search"] }, { type: "url_context" }]);
  assert.deepEqual(body.response_format, { type: "text", mime_type: "application/json", schema });
  for (const key of ["webSearch", "urlContext", "background", "store"]) assert.throws(() => buildYouTubeRequest({ ...ARGS, [key]: "true" }), /must be boolean/);
  for (const responseSchema of [[], null, "object", { description: "x".repeat(20001) }]) assert.throws(() => buildYouTubeRequest({ ...ARGS, responseSchema }), /responseSchema/);
});

test("code execution is absent from the public YouTube schema and rejected before a direct provider call", async () => {
  const schema = createYouTubeAnalysisSchemas(Type).youtube_analyze;
  assert.equal(Object.hasOwn(schema.properties, "codeExecution"), false);
  assert.equal(Value.Check(schema, ARGS), true);
  assert.equal(Value.Check(schema, { ...ARGS, codeExecution: true }), false);
  mockFetch(() => { throw new Error("Unsupported code execution must not reach Google"); });
  const result = await run({ ...ARGS, codeExecution: true });
  assert.equal(result.status, "failed");
  assert.match(result.text, /codeExecution|code execution/i);
  assert.equal(calls.length, 0);
});

test("provider history can be continued or disabled without inventing an interaction ID", () => {
  const followup = buildYouTubeRequest({ question: "Explain that step.", previousInteractionId: "interaction_previous" });
  assert.equal(followup.previous_interaction_id, "interaction_previous");
  assert.deepEqual(followup.input, [{ type: "text", text: "Explain that step." }]);
  const privateRequest = buildYouTubeRequest({ ...ARGS, store: false });
  assert.equal(privateRequest.store, false);
  assert.equal(privateRequest.background, false);
  for (const extra of [{ background: true }, { previousInteractionId: "interaction_previous" }]) assert.throws(() => buildYouTubeRequest({ ...ARGS, store: false, ...extra }), /foreground first request/);
  for (const id of ["../other", "https://example.org", "id?query", "x".repeat(513), "", null]) {
    assert.equal(validInteractionId(id), false);
    assert.throws(() => buildYouTubeRequest({ question: "Follow up", previousInteractionId: id }));
  }
});

test("a stateless completed response may omit its ID, but stored or running responses may not", async () => {
  mockFetch(() => Response.json(completed({ id: undefined })));
  const result = await run({ ...ARGS, store: false });
  assert.equal(result.status, "success");
  assert.equal(result.details?.interactionId, null);
  assert.match(result.text, /not stored \(no continuation ID\)/);
  assert.equal(result.details?.cost, null);
  assert.equal(calls.length, 1, "A stateless answer needs neither polling nor cancellation");
  assert.equal((await run()).status, "failed");
  mockFetch(() => Response.json({ status: "in_progress" }));
  assert.equal((await run({ ...ARGS, store: false })).status, "failed");
});

test("grounding distinguishes enabled tools from execution and preserves a tool failure as partial", () => {
  const value = completed({ steps: [
    { type: "google_search_call" }, { type: "google_search_result", is_error: true },
    { type: "model_output", content: [{ type: "text", text: "Here is a video-only answer." }] },
  ] });
  const result = formatInteraction(value, { requested: buildYouTubeRequest({ ...ARGS, webSearch: true, urlContext: true }) });
  assert.equal(result.status, "partial");
  assert.match(result.text, /Google Search yes; URL context not observed/);
  assert.match(result.text, /provider tool reported an error/);
});

test("status reads preserve unconfirmed agentic coverage from retained provider input", async () => {
  mockFetch(() => Response.json(completed({ steps: [
    { type: "user_input", content: [{ type: "video", uri: URL, processing: "agentic" }] },
    { type: "model_output", content: [{ type: "text", text: "An interpretation without processing evidence." }] },
  ] })));
  const result = await status({ interactionId: "interaction_fixture" });
  assert.equal(result.status, "partial");
  assert.match(result.text, /Agentic video was requested/);
  assert.deepEqual(result.details?.videoUrls, [URL]);
});

test("completed output retains the original once and reports cumulative token usage with unknown cost", async () => {
  mockFetch(() => Response.json(completed()));
  const result = await run();
  assert.equal(result.status, "success");
  assert.equal(result.details?.cost, null);
  assert.equal(result.details?.knownCost, undefined);
  assert.deepEqual(result.details?.usage, usage);
  assert.deepEqual(result.details?.videoUrls, [URL]);
  assert.match(result.text, /Token counts are cumulative/);
  assert.match(result.text, /not independent corroboration/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(new Headers(calls[0].init.headers).get("x-goog-api-key"), "gemini-offline-synthetic-key");
  assert.deepEqual(retained.map(response => response.body), [completed()]);
});

test("an awaited analysis polls the accepted interaction and never starts generation twice", async () => {
  mockFetch((_url, init) => Response.json(init.method === "POST" ? { id: "interaction_fixture", status: "in_progress" } : completed()));
  const result = await run();
  assert.equal(result.status, "success");
  assert.deepEqual(calls.map(call => [call.url.split("/interactions")[1], call.init.method]), [["", "POST"], ["/interaction_fixture", "GET"]]);
  assert.equal(retained.length, 2);
});

test("background pending output returns its ID and continuation tool without polling or cancelling it", async () => {
  mockFetch(() => Response.json({ id: "interaction_fixture", status: "queued", model: "gemini-4-argon" }));
  const result = await run({ ...ARGS, model: "gemini-4-argon", background: true });
  assert.equal(result.status, "partial");
  assert.equal(result.details?.interactionId, "interaction_fixture");
  assert.equal(result.details?.interactionStatus, "queued");
  assert.equal(result.details?.nextTool, "youtube_analysis_status");
  assert.equal(result.details?.cost, null);
  assert.equal(calls.length, 1);
  assert.match(result.text, /do not start the analysis again/);
});

test("status get, bounded wait and cancel use only the existing interaction and do not create another charge", async () => {
  let reads = 0;
  mockFetch((url, init) => {
    if (url.endsWith("/cancel")) return Response.json(completed({ status: "cancelled" }));
    assert.equal(init.method, "GET");
    reads++;
    return Response.json(reads === 1 ? { id: "interaction_fixture", status: "in_progress" } : completed());
  });
  const first = await status({ interactionId: "interaction_fixture", waitSeconds: 0.001 });
  const again = await status({ interactionId: "interaction_fixture" });
  const cancelled = await status({ interactionId: "interaction_fixture", action: "cancel" });
  assert.equal(first.status, "success");
  assert.deepEqual(first.details?.usage, again.details?.usage);
  assert.equal(cancelled.status, "cancelled");
  for (const result of [first, again, cancelled]) {
    assert.equal(result.details?.cost, null);
    assert.equal(result.details?.knownCost, undefined);
  }
  assert.equal(calls.filter(call => call.init.method === "POST").length, 1);
  assert.ok(calls.at(-1)?.url.endsWith("/interaction_fixture/cancel"));
  assert.ok(calls.every(call => call.url.includes("/interactions/interaction_fixture")));
});

test("status rejects malformed or mismatched IDs, invalid actions and invalid waits", async () => {
  mockFetch(() => Response.json(completed({ id: "different_interaction" })));
  const mismatch = await status({ interactionId: "interaction_fixture" });
  assert.equal(mismatch.status, "failed");
  assert.match(mismatch.text, /different interaction/);
  const count = calls.length;
  for (const args of [{ interactionId: "../escape" }, { interactionId: "ok", action: "restart" }, { interactionId: "ok", waitSeconds: -1 }, { interactionId: "ok", waitSeconds: 121 }, { interactionId: "ok", action: "cancel", waitSeconds: 1 }]) {
    assert.equal((await status(args)).status, "failed");
  }
  assert.equal(calls.length, count);
});

test("HTTP 200 errors and HTTP failures are redacted and never retried or redirected", async () => {
  for (const code of [200, 302, 429, 503]) {
    calls = []; retained = [];
    mockFetch(() => Response.json({ error: { status: "UNAVAILABLE", message: "Echo gemini-offline-synthetic-key" } }, { status: code, headers: { location: "https://elsewhere.invalid" } }));
    const result = await run();
    assert.equal(result.status, "failed");
    assert.equal(result.details?.cost, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(retained.length, 1);
    assert.doesNotMatch(JSON.stringify({ result, retained }), /gemini-offline-synthetic-key/);
  }
});

test("transport failure keeps an incomplete-attempt receipt and does not start again", async () => {
  mockFetch(() => { throw new TypeError("Network interrupted"); });
  const result = await run();
  assert.equal(result.status, "failed");
  assert.equal(result.details?.cost, null);
  assert.equal(calls.length, 1);
  assert.equal(retained.length, 1);
  assert.match(String(retained[0].body), /not retried/);
});

test("incomplete answers, missing usage and mixed non-text output retain their limits", async () => {
  const cases = [
    { extra: { status: "incomplete" }, words: /incomplete answer/ },
    { extra: { usage: undefined }, words: /did not return token usage/ },
    { extra: { model: "different-model" }, words: /requested model was/ },
    { extra: { steps: [{ type: "model_output", content: [{ type: "text", text: "Useful prose." }, { type: "image", uri: "provider-generated-image" }] }] }, words: /non-text output/ },
    { extra: { status: "requires_action" }, words: /does not execute arbitrary returned function calls/ },
  ];
  for (const { extra, words } of cases) {
    mockFetch(() => Response.json(completed(extra)));
    const result = await run();
    assert.equal(result.status, "partial");
    assert.match(result.text, words);
  }
  mockFetch(() => Response.json(completed({ steps: [{ type: "model_output", content: [{ type: "image" }] }] })));
  assert.equal((await run()).status, "failed", "An image alone is not the requested text analysis");
});

test("agentic inspection requires observed processing steps and structured JSON preserves a parse failure", async () => {
  const args = { ...ARGS, videos: [{ url: ID, processing: "agentic" }] };
  mockFetch(() => Response.json(completed()));
  assert.equal((await run(args)).status, "partial");
  const value = completed({ steps: [{ type: "processing_call" }, { type: "processing_result" }, { type: "model_output", content: [{ type: "text", text: '{"observations":["door closes"]}', mime_type: "application/json" }] }] });
  mockFetch(() => Response.json(value));
  const good = await run({ ...args, responseSchema: { type: "object" } });
  assert.equal(good.status, "success");
  assert.equal(good.details?.processingObserved, true);
  assert.deepEqual(good.details?.structuredAnswer, { observations: ["door closes"] });
  assert.match(good.text, /structuredAnswer/);
  assert.doesNotMatch(good.text, /"observations"|"door closes"/, "The parsed JSON answer is carried once, in structuredAnswer");
  mockFetch(() => Response.json(completed()));
  const invalid = await run({ ...ARGS, responseSchema: { type: "object" } });
  assert.equal(invalid.status, "partial");
  assert.match(invalid.text, /not valid JSON/);
});

test("only provider citation annotations become external grounding and user or thought URLs are excluded", () => {
  const value = completed({ steps: [
    { type: "user_input", content: [{ type: "url_citation", url: "https://user.invalid" }] },
    { type: "thought", content: [{ type: "url_citation", url: "https://thought.invalid" }] },
    { type: "model_output", content: [{ type: "text", text: "A prose URL https://prose.invalid", annotations: [{ type: "url_citation", url: "https://evidence.example.org", title: "Actual source" }] }] },
  ] });
  const result = formatInteraction(value);
  assert.deepEqual(result.details?.citations, [{ url: "https://evidence.example.org", title: "Actual source" }]);
  assert.match(result.text, /External grounding citations \(separate from video evidence\)/);
});

test("a run accepted during response-body cancellation is cancelled once without polling or reanalysis", async () => {
  const abort = new AbortController();
  mockFetch(url => {
    if (url.endsWith("/cancel")) return Response.json(completed({ status: "cancelled" }));
    const body = { id: "interaction_fixture", status: "in_progress" };
    const response = Response.json(body);
    response.text = async () => { abort.abort(); return JSON.stringify(body); };
    return response;
  });
  const result = await run(ARGS, abort.signal);
  assert.equal(result.status, "cancelled");
  assert.equal(result.details?.cost, null);
  assert.deepEqual(calls.map(call => [call.url.split("/interactions")[1], call.init.method]), [["", "POST"], ["/interaction_fixture/cancel", "POST"]]);
  assert.equal(calls[1].init.signal?.aborted, false);
});

test("missing credentials and invalid requests never contact Google", async () => {
  mockFetch(() => { throw new Error("Validation cannot contact Google"); });
  delete process.env.GEMINI_API_KEY;
  assert.match((await run()).text, /GEMINI_API_KEY/);
  assert.equal((await status({ interactionId: "interaction_fixture" })).status, "failed");
  assert.equal((await run({ ...ARGS, videos: [{ url: "/tmp/local.mp4" }] })).status, "failed");
  assert.equal(calls.length, 0);
});
