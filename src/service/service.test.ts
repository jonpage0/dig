import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { keysPath } from "../core/config.ts";
import { errorMessage } from "../core/errors.ts";
import { ExecutionService } from "../core/workflow.ts";
import { VERSION } from "../version.ts";
import {
  CARD_URI,
  SAFE_CARD_URL_RE,
  UI_EXTENSION_ID,
  UI_RESOURCE_MIME,
  cardForKeys,
  cardForSourceCall,
  cardForSpendGate,
  declaresUi,
  renderCardHtml,
} from "./card.ts";
import { runCli } from "./cli.ts";
import { health, readServiceFile, serve } from "./daemon.ts";
import { loadMethods, methodFile, promptedMethods } from "./methods.ts";
import { runSetupPreset, runSetupWizard } from "./setup-tui.ts";
import { CORE_ORDER, SOURCE_TOOLS, parseAction, sourceToolOf } from "./surface.ts";

// Every state folder this file starts a service or a bridge in is made by `serviceState` and removed by
// `releaseState`, which first checks that no service is still running for it. A service found running then (or
// for a folder a test never released) fails the suite in the `after` hook below. Only a service that answers
// `/status` under that folder's own token, naming that folder and the pid its service.json records, counts, so
// the check can neither see nor stop a service this file did not start.
const serviceStates = new Set<string>();
const leftRunning: string[] = [];

async function serviceState(prefix: string): Promise<string> {
  const state = await mkdtemp(join(tmpdir(), prefix));
  serviceStates.add(state);
  return state;
}

async function runningServiceOf(state: string): Promise<{ readonly pid: number; readonly port: number } | null> {
  const file = await readServiceFile(state);
  if (!file || typeof file.pid !== "number") return null;
  try {
    const response = await fetch(`http://127.0.0.1:${file.port}/status`, {
      headers: { authorization: `Bearer ${file.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const status = (await response.json()) as { pid?: unknown; stateDir?: unknown };
    return status.pid === file.pid && typeof status.stateDir === "string" && resolve(status.stateDir) === resolve(state)
      ? { pid: file.pid, port: file.port }
      : null;
  } catch {
    return null;
  }
}

async function releaseState(state: string): Promise<void> {
  const left = await runningServiceOf(state);
  if (left) {
    leftRunning.push(`pid ${left.pid} on port ${left.port} for ${state}`);
    if (left.pid !== process.pid) {
      try {
        process.kill(left.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      for (let i = 0; i < 100 && (await health(left.port))?.pid === left.pid; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
  serviceStates.delete(state);
  await rm(state, { recursive: true, force: true });
}

after(async () => {
  for (const state of [...serviceStates]) await releaseState(state);
  assert.deepEqual(leftRunning, [], "A service this suite started was still running when its test ended");
});

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createNetServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
}

const DIST_DIG = join(process.cwd(), "dist/dig.mjs");

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops the service running for `state` (only one `runningServiceOf` confirms) and waits until it has gone. */
async function stopServiceIn(state: string): Promise<void> {
  const running = await runningServiceOf(state);
  if (!running || running.pid === process.pid) return;
  process.kill(running.pid, "SIGTERM");
  for (let i = 0; i < 100 && processAlive(running.pid); i++) await new Promise((r) => setTimeout(r, 100));
}

/** Starts `dist/dig.mjs serve` as this test's child, on a free port, and waits until it serves. */
async function startDistService(
  state: string,
): Promise<{ readonly port: number; readonly pid: number; readonly stop: () => Promise<void> }> {
  const port = await freePort();
  const child = spawn(process.execPath, [DIST_DIG, "serve"], {
    env: { ...process.env, DIG_STATE_DIR: state, DIG_PORT: String(port), DIG_IDLE_EXIT_MS: "600000" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const pid = child.pid;
  assert.ok(pid, "dig serve started");
  for (let i = 0; i < 300; i++) {
    if ((await health(port))?.pid === pid && (await readServiceFile(state))?.pid === pid) {
      return {
        port,
        pid,
        stop: async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          await exited;
        },
      };
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  await exited;
  throw new Error(`dist/dig.mjs serve did not start: ${stderr}`);
}

function rawHttp(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolveReq, rejectReq) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () =>
          resolveReq({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", rejectReq);
    req.end();
  });
}

describe("Dig 2.0 Service Layer (Effect 4.1.5)", () => {
  it("surface.ts and methods.ts derive clean compact schemas and enforce path security", async () => {
    assert.ok(CORE_ORDER.includes("open_library"));
    assert.equal((CORE_ORDER as readonly string[]).includes("open_trail"), false);
    assert.ok(SOURCE_TOOLS.length >= 20);

    const hn = sourceToolOf("hackernews");
    assert.ok(hn, "hackernews source tool must exist");
    assert.ok(hn.actions.length > 0);
    const badAction = parseAction(hn, "nonexistent_action", {});
    assert.equal(badAction.ok, false);
    if (!badAction.ok) assert.match(badAction.error, /No request was sent/);

    const allMethods = await loadMethods();
    const digMethod = allMethods.byName.get("dig");
    assert.ok(digMethod, "dig method must load from skills/");
    const traversal = methodFile(digMethod, "../setup/SKILL.md");
    assert.ok("error" in traversal, "Parent traversal must be refused");
    const abs = methodFile(digMethod, "/etc/passwd");
    assert.ok("error" in abs, "Absolute path must be refused");
    const uri = methodFile(digMethod, "file:///etc/passwd");
    assert.ok("error" in uri, "URI scheme must be refused");

    const prompted = promptedMethods(allMethods.list);
    assert.equal(
      prompted.some((m) => m.name === "youtube-summarizer"),
      false,
      "Helper-only youtube-summarizer must not be registered as a prompt",
    );
  });

  it("setup-tui refuses cleanly without a TTY and applies presets non-interactively", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dig-svc-setup-"));
    try {
      const exit = await Effect.runPromiseExit(
        runSetupWizard({ stateDir: tmp, isTTY: false }).pipe(Effect.provide(NodeServices.layer)),
      );
      assert.equal(exit._tag, "Failure", "Interactive setup without TTY must fail helpfully");

      const snap = await Effect.runPromise(runSetupPreset("starter", tmp));
      const enabled = snap.sources.filter((s) => s.enabled).map((s) => s.id);
      assert.ok(enabled.includes("hackernews"));
      assert.ok(enabled.includes("deepwiki"));
      assert.ok(enabled.includes("sec"));
      assert.ok(enabled.includes("bluesky"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("cli.ts executes subcommands via effect/cli Command.runWith", async () => {
    await Effect.runPromise(runCli(["version"]));
  });

  it("full daemon lifecycle: auth/host/origin guards, /open/:code, SPA JSON & SSE APIs, /keys/:code, /approve/:code, /mcp round-trip, and /stop", async () => {
    const tmp = await serviceState("dig-svc-full-");
    const projectDir = await mkdtemp(join(tmpdir(), "dig-svc-proj-"));
    const service = await serve({
      state: tmp,
      port: 0,
      handleSignals: false,
      env: { ...process.env, DIG_STATE_DIR: tmp, DIG_IDLE_EXIT_MS: "600000" },
    });

    try {
      const { port, token, origin } = service;
      assert.ok(port > 0 && port !== 47811, `Expected isolated free port, got ${port}`);

      // ---- 1. /health (unauthenticated) & /status (Bearer required) ----
      const healthRes = await fetch(`${origin}/health`);
      assert.equal(healthRes.status, 200);
      const healthJson = (await healthRes.json()) as Record<string, unknown>;
      assert.equal(healthJson.ok, true);
      assert.equal(healthJson.version, VERSION);
      assert.equal(healthJson.pid, process.pid);
      assert.equal("stateDir" in healthJson, false, "/health must not disclose stateDir");
      assert.equal(healthJson.runningJobs, 0);
      assert.equal(typeof healthJson.build, "string");
      assert.equal(typeof healthJson.startedAt, "string");

      const statusNoAuth = await fetch(`${origin}/status`);
      assert.equal(statusNoAuth.status, 401);

      const statusAuthed = await fetch(`${origin}/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(statusAuthed.status, 200);
      const statusJson = (await statusAuthed.json()) as Record<string, unknown>;
      assert.equal(statusJson.ok, true);
      assert.equal(statusJson.port, port);
      assert.ok(Array.isArray(statusJson.runningJobs));
      assert.ok(Array.isArray(statusJson.activeCalls));

      // ---- 2. Host & Origin spoofing guards (403) ----
      const spoofedHost = await rawHttp(port, "/health", { host: `evil.example:${port}` });
      assert.equal(spoofedHost.status, 403, "Spoofed Host header must be rejected with 403");

      const spoofedOrigin = await fetch(`${origin}/health`, {
        headers: { origin: "https://evil.example" },
      });
      assert.equal(spoofedOrigin.status, 403, "Cross-origin request must be rejected with 403");

      // Unauthenticated browser endpoints return 401
      const unauthRoot = await fetch(`${origin}/`);
      assert.equal(unauthRoot.status, 401);
      const unauthApi = await fetch(`${origin}/api/library`);
      assert.equal(unauthApi.status, 401);

      // ---- 3. /open/:code single-use browser session mint ----
      const openPost = await fetch(`${origin}/open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: "/setup" }),
      });
      assert.equal(openPost.status, 200);
      const { address: openUrl } = (await openPost.json()) as { address: string };
      assert.ok(openUrl.startsWith(`${origin}/open/`));

      const openRedeem = await fetch(openUrl, { redirect: "manual" });
      assert.equal(openRedeem.status, 302);
      assert.equal(openRedeem.headers.get("location"), "/setup");
      const setCookie = openRedeem.headers.get("set-cookie") ?? "";
      assert.match(setCookie, new RegExp(`dig_session_${port}=[^;]+`));
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      const cookieHeader = setCookie.split(";")[0];

      // Replay of single-use /open/:code must be rejected
      const openReplay = await fetch(openUrl, { redirect: "manual" });
      assert.equal(openReplay.status, 403);

      // Authenticated SPA root works, sets nosniff AND strict CSP
      const authedRoot = await fetch(`${origin}/`, { headers: { cookie: cookieHeader } });
      assert.equal(authedRoot.status, 200);
      assert.equal(authedRoot.headers.get("x-content-type-options"), "nosniff");
      assert.match(authedRoot.headers.get("content-security-policy") ?? "", /default-src 'none'/);
      assert.match(authedRoot.headers.get("content-security-policy") ?? "", /script-src 'self'/);

      // Global Origin: null on /api/* MUST be rejected 403
      const nullOriginApi = await fetch(`${origin}/api/library`, {
        headers: { cookie: cookieHeader, origin: "null", "sec-fetch-site": "same-origin" },
      });
      assert.equal(nullOriginApi.status, 403);

      // /health must NOT disclose stateDir without auth
      const healthBody = (await (await fetch(`${origin}/health`)).json()) as Record<string, unknown>;
      assert.equal("stateDir" in healthBody, false, "/health must not leak stateDir");

      // ---- 4. Cookie-authenticated SPA APIs: /api/library, /api/settings (6 spend caps), /api/setup/* ----
      const libSnapRes = await fetch(`${origin}/api/library`, {
        headers: { cookie: cookieHeader },
      });
      assert.equal(libSnapRes.status, 200);
      const libSnap = (await libSnapRes.json()) as Record<string, unknown>;
      assert.equal(libSnap.version, VERSION);
      assert.ok(Array.isArray(libSnap.items));
      assert.ok(Array.isArray(libSnap.sources));
      assert.ok(Array.isArray(libSnap.groups));

      const settingsUpdateRes = await fetch(`${origin}/api/settings`, {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          set: {
            spend_dig_ceiling_usd: 5.5,
            spend_ask_above_usd: 0.75,
            spend_max_credits: 250,
            spend_max_x_post_reads: 1000,
            spend_max_x_account_reads: 120,
            spend_max_unknown_calls: 8,
          },
        }),
      });
      assert.equal(settingsUpdateRes.status, 200);
      const settingsAfter = (await settingsUpdateRes.json()) as {
        values: Record<string, unknown>;
        config: { spend: Record<string, number | null> };
      };
      assert.equal(settingsAfter.config.spend.dig_ceiling_usd, 5.5);
      assert.equal(settingsAfter.config.spend.ask_above_usd, 0.75);
      assert.equal(settingsAfter.config.spend.max_credits, 250);
      assert.equal(settingsAfter.config.spend.max_x_post_reads, 1000);
      assert.equal(settingsAfter.config.spend.max_x_account_reads, 120);
      assert.equal(settingsAfter.config.spend.max_unknown_calls, 8);

      const setupGetRes = await fetch(`${origin}/api/setup`, {
        headers: { cookie: cookieHeader },
      });
      assert.equal(setupGetRes.status, 200);

      const setupPresetRes = await fetch(`${origin}/api/setup/preset`, {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ preset: "starter" }),
      });
      assert.equal(setupPresetRes.status, 200);
      const presetSnap = (await setupPresetRes.json()) as {
        sources: { id: string; enabled: boolean }[];
      };
      assert.equal(
        presetSnap.sources.find((s) => s.id === "bluesky")?.enabled,
        true,
      );

      const setupSourcesRes = await fetch(`${origin}/api/setup/sources`, {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: ["hackernews", "exa"] }),
      });
      assert.equal(setupSourcesRes.status, 200);

      // Save key via /api/setup/keys -> verify 0600 permissions & ZERO secret leak in response!
      const fakeSecret = "exa_super_secret_test_token_123456";
      const setupKeysRes = await fetch(`${origin}/api/setup/keys`, {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ values: { EXA_API_KEY: fakeSecret } }),
      });
      assert.equal(setupKeysRes.status, 200);
      const setupKeysText = await setupKeysRes.text();
      assert.equal(
        setupKeysText.includes(fakeSecret),
        false,
        "API key secret must NEVER be leaked in /api/setup/keys response",
      );
      const setupKeysJson = JSON.parse(setupKeysText) as { saved: string[] };
      assert.deepEqual(setupKeysJson.saved, ["EXA_API_KEY"]);

      const keysStat = await stat(keysPath(tmp));
      assert.equal(keysStat.mode & 0o777, 0o600, "keys.env must have 0600 permissions");

      // ---- 5. Live SSE stream GET /api/events ----
      const sseController = new AbortController();
      const sseRes = await fetch(`${origin}/api/events`, {
        headers: { cookie: cookieHeader },
        signal: sseController.signal,
      });
      assert.equal(sseRes.status, 200);
      assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";
      const receivedEvents: Record<string, unknown>[] = [];

      const readUntil = async (predicate: () => boolean, timeoutMs = 4000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate() && Date.now() < deadline) {
          const { value, done } = await Promise.race([
            reader.read(),
            new Promise<{ value: undefined; done: true }>((r) =>
              setTimeout(() => r({ value: undefined, done: true }), Math.max(10, deadline - Date.now())),
            ),
          ]);
          if (done || !value) break;
          sseBuf += decoder.decode(value, { stream: true });
          const frames = sseBuf.split("\n\n");
          sseBuf = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (line) receivedEvents.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
          }
        }
      };

      await readUntil(() => receivedEvents.some((e) => e.type === "connected"));
      assert.ok(
        receivedEvents.some((e) => e.type === "connected" && e.version === VERSION),
        "SSE must emit connected event immediately",
      );

      // Trigger a settings change and verify live SSE delivery
      await fetch(`${origin}/api/settings`, {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ set: { keep_raw: true } }),
      });

      await readUntil(() =>
        receivedEvents.some(
          (e) =>
            e.type === "event" &&
            (e.event as { type?: string } | undefined)?.type === "settings_changed",
        ),
      );
      assert.ok(
        receivedEvents.some(
          (e) =>
            e.type === "event" &&
            (e.event as { type?: string } | undefined)?.type === "settings_changed",
        ),
        "SSE must stream live settings_changed event",
      );
      sseController.abort();
      await reader.cancel().catch(() => {});

      // ---- 6. /keys/:code single-use HTML form & replay rejection ----
      const keyCodeRecord = await service.runtime.runPromise(
        Effect.flatMap(ExecutionService, (exec) =>
          exec.createOpaqueCode({
            kind: "keys",
            payload: {
              names: [{ name: "XAI_API_KEY", labels: ["X"], guidance: "xAI API key" }],
              source: "x",
            },
            ttlMs: 60_000,
          }),
        ),
      );
      const keyPageRes = await fetch(`${origin}/keys/${keyCodeRecord.code}`);
      assert.equal(keyPageRes.status, 200);
      assert.equal(
        keyPageRes.headers.get("referrer-policy"),
        "same-origin",
        "Form page must use Referrer-Policy: same-origin so browsers send real Origin on POST",
      );
      assert.match(
        keyPageRes.headers.get("content-security-policy") ?? "",
        /default-src 'none'/,
      );
      const keyPageHtml = await keyPageRes.text();
      assert.match(keyPageHtml, /XAI_API_KEY/);
      assert.equal(
        keyPageHtml.includes('name="referrer" content="no-referrer"'),
        false,
        "Form HTML must not inject no-referrer meta tag",
      );

      const xaiSecret = "xai_test_secret_value_987654";
      // Also verify browser form POST with Origin: null + Sec-Fetch-Site: same-origin succeeds
      const keyPostRes = await fetch(`${origin}/keys/${keyCodeRecord.code}`, {
        method: "POST",
        headers: {
          origin: "null",
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ XAI_API_KEY: xaiSecret }).toString(),
      });
      assert.equal(keyPostRes.status, 200);
      const keyPostHtml = await keyPostRes.text();
      assert.match(keyPostHtml, /XAI_API_KEY/);
      assert.equal(
        keyPostHtml.includes(xaiSecret),
        false,
        "Key page confirmation must never echo secret value",
      );
      const keysFileContents = await readFile(keysPath(tmp), "utf8");
      assert.match(keysFileContents, /XAI_API_KEY=/);

      // Replay must be rejected with 410
      const keyReplayGet = await fetch(`${origin}/keys/${keyCodeRecord.code}`);
      assert.equal(keyReplayGet.status, 410);
      const keyReplayPost = await fetch(`${origin}/keys/${keyCodeRecord.code}`, {
        method: "POST",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ XAI_API_KEY: "another_secret_value" }).toString(),
      });
      assert.equal(keyReplayPost.status, 410);

      // ---- 7. /approve/:code browser spend-approval flow (requires session cookie!) ----
      const approveCode = await service.runtime.runPromise(
        Effect.flatMap(ExecutionService, (exec) =>
          exec.createOpaqueCode({
            kind: "spend_approval",
            payload: {
              digHandle: "proj-123456/test-dig",
              key: "ceiling",
              unit: "credits",
              bind: "bind-test-1",
              title: "Dig: credit ceiling reached",
              message: "Raise credit ceiling?",
              choices: [
                { value: "raise", title: "Raise by 100" },
                { value: "stop", title: "Stop here" },
              ],
              targetRaised: 100,
            },
            ttlMs: 60_000,
          }),
        ),
      );
      // Unauthenticated curl/GET/POST MUST be refused 401 so a model cannot self-approve!
      const approveNoCookieGet = await fetch(`${origin}/approve/${approveCode.code}`);
      assert.equal(approveNoCookieGet.status, 401, "GET /approve/:code must require browser session cookie");
      const approveNoCookiePost = await fetch(`${origin}/approve/${approveCode.code}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ choice: "raise" }).toString(),
      });
      assert.equal(approveNoCookiePost.status, 401, "POST /approve/:code must require browser session cookie");

      // P1 #1: GET /api/library must expose pending spend approvals even if Trail tab opened AFTER refusal!
      const libWithApproval = (await (
        await fetch(`${origin}/api/library`, { headers: { cookie: cookieHeader } })
      ).json()) as { pendingApprovals?: { code: string; title: string }[] };
      assert.ok(
        libWithApproval.pendingApprovals?.some((a) => a.code === approveCode.code),
        "GET /api/library must include unexpired pendingApprovals",
      );

      const approveGet = await fetch(`${origin}/approve/${approveCode.code}`, {
        headers: { cookie: cookieHeader },
      });
      assert.equal(approveGet.status, 200);
      assert.equal(approveGet.headers.get("referrer-policy"), "same-origin");
      assert.match(await approveGet.text(), /Raise credit ceiling/);

      const approvePost = await fetch(`${origin}/approve/${approveCode.code}`, {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          origin: "null",
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ choice: "raise" }).toString(),
      });
      assert.equal(approvePost.status, 200);
      const overrides = await service.runtime.runPromise(
        Effect.flatMap(ExecutionService, (exec) =>
          exec.getSpendOverrides("proj-123456/test-dig"),
        ),
      );
      assert.equal(overrides.raisedCredits, 100);

      const approveReplay = await fetch(`${origin}/approve/${approveCode.code}`, {
        headers: { cookie: cookieHeader },
      });
      assert.equal(approveReplay.status, 410);

      // ---- 8. MCP 2026-07-28 + 2025-era legacy session + gated SEP-1865 ui://dig/card ----
      // 8a. 2025-era legacy session (used by Codex CLI) still connects, lists tools, and closes cleanly
      const legacyHeaders = (sid?: string): Record<string, string> => ({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sid ? { "mcp-session-id": sid } : {}),
      });
      const legacyInitRes = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: legacyHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "legacy-codex-test", version: "0.171.0" },
          },
        }),
      });
      assert.equal(legacyInitRes.status, 200, "2025-era legacy initialize must stay supported");
      const legacySid = legacyInitRes.headers.get("mcp-session-id") ?? undefined;
      assert.ok(legacySid, "2025-era initialize must return mcp-session-id");
      const legacyNotify = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: legacyHeaders(legacySid),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      assert.ok(legacyNotify.status === 200 || legacyNotify.status === 202);
      const legacyToolsRes = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: legacyHeaders(legacySid),
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      assert.equal(legacyToolsRes.status, 200);
      const legacyTasksRes = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: legacyHeaders(legacySid),
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tasks/list", params: {} }),
      });
      assert.equal(legacyTasksRes.status, 200);
      assert.match(await legacyTasksRes.text(), /"tasks":\[\]/);
      await fetch(`${origin}/mcp`, { method: "DELETE", headers: legacyHeaders(legacySid) });

      const connectClient = async (name: string, capabilities: Record<string, unknown>) => {
        const client = new Client(
          { name, version: "1.0.0" },
          { capabilities, versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          authProvider: { token: async () => token },
        });
        await client.connect(transport);
        return { client, transport };
      };

      // 8b. Non-UI 2026-07-28 client (with tasks extension & URL elicitation, WITHOUT io.modelcontextprotocol/ui)
      const plain = await connectClient("dig-service-test-plain", {
        extensions: { "io.modelcontextprotocol/tasks": {} },
      });
      let uiClient: Awaited<ReturnType<typeof connectClient>> | null = null;
      let elicitClient: Awaited<ReturnType<typeof connectClient>> | null = null;
      try {
        const toolsList = await plain.client.listTools();
        const toolNames = toolsList.tools.map((t) => t.name);
        for (const core of CORE_ORDER) {
          assert.ok(toolNames.includes(core), `Expected core tool ${core} in tools/list`);
        }
        assert.ok(toolNames.includes("method"));
        assert.ok(toolNames.includes("hackernews"));
        assert.ok(toolNames.includes("exa"));
        assert.equal(toolNames.includes("open_trail"), false, "open_trail must stay removed in Dig 2.0");
        for (const tool of toolsList.tools) {
          assert.equal(
            (tool as { _meta?: Record<string, unknown> })._meta?.ui,
            undefined,
            `Non-UI client must not receive _meta.ui on ${tool.name}`,
          );
        }

        const resList = await plain.client.listResources();
        assert.equal(
          resList.resources.some((r) => r.uri.startsWith("ui://")),
          false,
          "Non-UI client must see zero ui:// resources",
        );
        const tmplList = await plain.client.listResourceTemplates();
        assert.ok(tmplList.resourceTemplates.some((t) => t.uriTemplate === "dig://library/{file}"));

        // 2026-07-28 `tasks/get` extension dispatch (reaches our custom handler and reports unknown task -32602)
        const taskGetRes = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tasks/get",
            "mcp-name": "job-doesNotExist000000001",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            method: "tasks/get",
            params: {
              taskId: "job-doesNotExist000000001",
              _meta: {
                [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
                [CLIENT_CAPABILITIES_META_KEY]: {
                  extensions: { "io.modelcontextprotocol/tasks": {} },
                },
              },
            },
          }),
        });
        const taskGetBody = await taskGetRes.text();
        assert.match(taskGetBody, /Unknown task job-doesNotExist000000001/);

        // tools/call: dig_start -> research_save -> library_list -> library_search -> library_read
        const startedRes = (await plain.client.callTool({
          name: "dig_start",
          arguments: { project: projectDir, question: "How does Dig 2.0 service layer work?" },
        })) as { isError?: boolean; structuredContent: { dig: string }; _meta?: Record<string, unknown> };
        assert.notEqual(startedRes.isError, true);
        const digHandle = startedRes.structuredContent.dig;
        assert.ok(digHandle.includes("/"));

        const reportMarkdown = [
          "```yaml",
          "source_card:",
          "  source: hackernews",
          "  status: complete",
          "  evidence_grade: high",
          "```",
          "",
          "# Dig 2.0 Effect Service Architecture",
          "",
          "## Summary",
          "Dig 2.0 uses Effect 4.1.5 HttpRouter, SQLite FTS5, and a single localhost Web SPA.",
          "",
          "## Evidence Highlights",
          "- Zero zod, Effect 4.1.5 core.",
          "",
          "## Needs Follow-Up",
          "- None.",
          "",
          "## Negative Evidence (when relevant)",
          "- None.",
        ].join("\n");

        const saveRes = (await plain.client.callTool({
          name: "research_save",
          arguments: { dig: digHandle, source: "hackernews", content: reportMarkdown },
        })) as { isError?: boolean; structuredContent: { file: string }; _meta?: Record<string, unknown> };
        assert.notEqual(saveRes.isError, true);
        assert.equal(saveRes._meta?.digCard, undefined, "Non-UI client must not receive _meta.digCard");

        const listRes = (await plain.client.callTool({
          name: "library_list",
          arguments: {},
        })) as { structuredContent: { total: number } };
        assert.equal(listRes.structuredContent.total, 1);

        const searchRes = (await plain.client.callTool({
          name: "library_search",
          arguments: { query: "HttpRouter localhost", mode: "keyword" },
        })) as { structuredContent: { hits: { file: string }[] } };
        assert.ok(searchRes.structuredContent.hits.length >= 1);

        const readRes = (await plain.client.callTool({
          name: "library_read",
          arguments: { file: saveRes.structuredContent.file },
        })) as { structuredContent: { text: string } };
        assert.match(readRes.structuredContent.text, /Dig 2\.0 Effect Service Architecture/);

        // tools/call: dig_finish
        const finishRes = (await plain.client.callTool({
          name: "dig_finish",
          arguments: {
            dig: digHandle,
            answer: "# Answer\nDig 2.0 service layer uses Effect 4.1.5 cleanly.",
            status: "answered",
            reports: ["hackernews.md"],
          },
        })) as { isError?: boolean; structuredContent: { file: string }; _meta?: Record<string, unknown> };
        assert.notEqual(finishRes.isError, true);
        assert.match(finishRes.structuredContent.file, /answer\.md$/);
        assert.equal(finishRes._meta?.digCard, undefined);

        // Cookie-authenticated SPA endpoints POST /api/library/read & POST /api/library/search
        const apiReadRes = await fetch(`${origin}/api/library/read`, {
          method: "POST",
          headers: { cookie: cookieHeader, origin, "content-type": "application/json" },
          body: JSON.stringify({ file: saveRes.structuredContent.file }),
        });
        assert.equal(apiReadRes.status, 200);
        const apiReadJson = (await apiReadRes.json()) as { text: string };
        assert.match(apiReadJson.text, /Dig 2\.0 Effect Service Architecture/);

        const apiSearchRes = await fetch(`${origin}/api/library/search`, {
          method: "POST",
          headers: { cookie: cookieHeader, origin, "content-type": "application/json" },
          body: JSON.stringify({ query: "HttpRouter localhost", mode: "keyword" }),
        });
        assert.equal(apiSearchRes.status, 200);
        const apiSearchJson = (await apiSearchRes.json()) as { hits: unknown[] };
        assert.ok(apiSearchJson.hits.length >= 1);

        // tools/call: source_info
        const infoRes = (await plain.client.callTool({
          name: "source_info",
          arguments: { source: "hackernews" },
        })) as { structuredContent: { sources: { id: string; enabled: boolean }[] } };
        assert.equal(infoRes.structuredContent.sources.length, 1);
        assert.equal(infoRes.structuredContent.sources[0].id, "hackernews");
        assert.equal(infoRes.structuredContent.sources[0].enabled, true);

        // source_info: GitHub works without a token, so with none in keys.env it reads partial, not setup-required.
        const enableGithub = (await plain.client.callTool({
          name: "settings",
          arguments: { set: { github_enabled: true } },
        })) as { isError?: boolean };
        assert.notEqual(enableGithub.isError, true);
        const githubInfo = (await plain.client.callTool({
          name: "source_info",
          arguments: { source: "github" },
        })) as {
          structuredContent: {
            sources: {
              readiness: { status: string; message: string };
              credentials: { name: string; available: boolean; required: boolean }[];
            }[];
          };
        };
        const githubReadiness = githubInfo.structuredContent.sources[0].readiness;
        assert.equal(githubReadiness.status, "partial");
        assert.doesNotMatch(githubReadiness.message, /Missing keys/);
        assert.match(githubReadiness.message, /anonymously or through an existing gh login/);
        assert.match(githubReadiness.message, /gh login was not probed/);
        assert.deepEqual(githubInfo.structuredContent.sources[0].credentials, [
          { name: "GH_TOKEN", available: false, required: false },
          { name: "GITHUB_TOKEN", available: false, required: false },
        ]);
        await plain.client.callTool({ name: "settings", arguments: { set: { github_enabled: false } } });

        // tools/call: settings (reads & updates multi-unit caps)
        const mcpSettingsRes = (await plain.client.callTool({
          name: "settings",
          arguments: { set: { spend_max_unknown_calls: 12 } },
        })) as { isError?: boolean; structuredContent: { values: Record<string, unknown> } };
        assert.notEqual(mcpSettingsRes.isError, true);
        assert.equal(mcpSettingsRes.structuredContent.values.spend_max_unknown_calls, 12);

        // tools/call: open_library (returns one-time /open/<code> link for setup & dig reader)
        const openLibRes = (await plain.client.callTool({
          name: "open_library",
          arguments: { view: "setup" },
        })) as {
          isError?: boolean;
          structuredContent: { address: string; path: string; opened: boolean };
          _meta?: Record<string, unknown>;
        };
        assert.notEqual(openLibRes.isError, true);
        assert.equal(openLibRes.structuredContent.path, "/setup");
        assert.ok(openLibRes.structuredContent.address.startsWith(`${origin}/open/`));
        assert.equal(openLibRes._meta?.digCard, undefined);

        const openDigRes = (await plain.client.callTool({
          name: "open_library",
          arguments: { dig: digHandle },
        })) as { isError?: boolean; structuredContent: { path: string; dig: string } };
        assert.notEqual(openDigRes.isError, true);
        const [digFolder, digId] = digHandle.split("/");
        assert.equal(openDigRes.structuredContent.path, `/dig/${digFolder}/${digId}`);

        // 8c. 2026-07-28 2-round `input_required` URL elicitation round-trip on `open_library`
        const rawElicit = new Client(
          { name: "dig-service-test-elicit", version: "1.0.0" },
          {
            capabilities: { elicitation: { url: {} } },
            versionNegotiation: { mode: { pin: "2026-07-28" } },
          },
        );
        let elicitedUrl = "";
        rawElicit.setRequestHandler("elicitation/create", async (req) => {
          elicitedUrl = String((req.params as { url?: unknown }).url ?? "");
          return { action: "accept" as const };
        });
        const elicitTransport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          authProvider: { token: async () => token },
        });
        await rawElicit.connect(elicitTransport);
        elicitClient = { client: rawElicit, transport: elicitTransport };
        const elicitedOpen = (await rawElicit.callTool({
          name: "open_library",
          arguments: { view: "sources" },
        })) as { isError?: boolean; structuredContent: { opened: boolean; path: string } };
        assert.notEqual(elicitedOpen.isError, true);
        assert.equal(elicitedOpen.structuredContent.opened, true);
        assert.equal(elicitedOpen.structuredContent.path, "/sources");
        assert.ok(elicitedUrl.startsWith(`${origin}/open/`), "URL elicitation must present a one-time /open/ URL");

        // tools/call: method
        const methodRes = (await plain.client.callTool({
          name: "method",
          arguments: { name: "dig" },
        })) as { isError?: boolean; content: { type: string; text: string }[] };
        assert.notEqual(methodRes.isError, true);
        assert.match(methodRes.content[0].text, /source_info/);

        // tools/call: job (unknown job id refused cleanly)
        const jobRes = (await plain.client.callTool({
          name: "job",
          arguments: { id: "job-doesNotExist000000001" },
        })) as { isError?: boolean };
        assert.equal(jobRes.isError, true);

        // 8d. SEP-1865 UI-capable 2026-07-28 client (`io.modelcontextprotocol/ui`)
        uiClient = await connectClient("dig-service-test-ui", {
          extensions: {
            [UI_EXTENSION_ID]: { mimeTypes: [UI_RESOURCE_MIME] },
          },
        });
        const uiTools = await uiClient.client.listTools();
        const cardToolNames = new Set(["research_save", "dig_finish", "keys", "job", "open_library", "hackernews", "exa"]);
        for (const t of uiTools.tools) {
          const uiMeta = (t as { _meta?: { ui?: { resourceUri?: string } } })._meta?.ui;
          if (cardToolNames.has(t.name)) {
            assert.equal(uiMeta?.resourceUri, CARD_URI, `UI client must get CARD_URI on ${t.name}`);
          } else {
            assert.equal(uiMeta, undefined, `Non-card tool ${t.name} should not carry _meta.ui`);
          }
        }

        const uiResList = await uiClient.client.listResources();
        const cardResEntry = uiResList.resources.find((r) => r.uri === CARD_URI);
        assert.ok(cardResEntry, "UI client must see ui://dig/card resource");
        assert.equal(cardResEntry.mimeType, UI_RESOURCE_MIME);

        const cardRead = await uiClient.client.readResource({ uri: CARD_URI });
        const cardContent = cardRead.contents[0] as {
          text?: string;
          mimeType?: string;
          _meta?: { ui?: { prefersBorder?: boolean; csp?: { connectDomains: string[]; resourceDomains: string[] } } };
        };
        const cardHtml = cardContent.text ?? "";
        assert.equal(cardContent.mimeType, UI_RESOURCE_MIME);
        assert.equal(cardContent._meta?.ui?.prefersBorder, false);
        assert.deepEqual(cardContent._meta?.ui?.csp, { connectDomains: [], resourceDomains: [] });
        assert.match(cardHtml, /ui\/initialize/);
        assert.match(cardHtml, /ui\/notifications\/tool-result/);
        assert.match(cardHtml, /ui\/open-link/);
        assert.match(cardHtml, /ev\.source!==window\.parent/, "Card must ignore non-parent postMessage sources");
        assert.match(cardHtml, /127\\\.0\\\.0\\\.1/, "Card must restrict ui/open-link strictly to loopback Dig URLs");
        assert.match(cardHtml, /method==="ping"/, "Card must reply to host ping requests");
        assert.match(cardHtml, /params:\{height:h\}/, "size-changed must report height only");
        assert.doesNotMatch(cardHtml, /innerHTML/i, "Card HTML must never use innerHTML");

        // UI client gets `_meta.digCard` on open_library and research_save (with single-use /open/<code> link)
        const uiOpenRes = (await uiClient.client.callTool({
          name: "open_library",
          arguments: { view: "trail", dig: digHandle },
        })) as { _meta?: { digCard?: { card: string; badge?: string; action?: { url: string } } } };
        assert.equal(uiOpenRes._meta?.digCard?.card, "open_library");
        assert.match(uiOpenRes._meta?.digCard?.badge ?? "", /single-use/);
        assert.ok(uiOpenRes._meta?.digCard?.action?.url.startsWith(`${origin}/open/`));

        const uiDigStart = (await uiClient.client.callTool({
          name: "dig_start",
          arguments: { project: projectDir, question: "SEP-1865 card test dig" },
        })) as { structuredContent: { dig: string } };
        const uiSaveRes = (await uiClient.client.callTool({
          name: "research_save",
          arguments: { dig: uiDigStart.structuredContent.dig, source: "hackernews", content: reportMarkdown },
        })) as { _meta?: { digCard?: { card: string; title: string; chips?: { label: string; value: string }[]; action?: { url: string } } } };
        assert.equal(uiSaveRes._meta?.digCard?.card, "report_saved");
        assert.equal(uiSaveRes._meta?.digCard?.title, "Dig 2.0 Effect Service Architecture");
        assert.ok(uiSaveRes._meta?.digCard?.action?.url.startsWith(`${origin}/open/`));
        assert.ok(uiSaveRes._meta?.digCard?.chips?.some((c) => c.label === "Link" && c.value.includes("single-use")));

        // Verify `hasPendingTokens()` ignores `browser_open` codes (so `open_library` & UI cards do NOT block `?ifIdle=1`)
        const pendingBeforeKeys = await service.runtime.runPromise(
          Effect.flatMap(ExecutionService, (exec) => exec.hasPendingTokens()),
        );
        assert.equal(pendingBeforeKeys, false, "Ephemeral browser_open codes must not count as pending tokens");

        // Now call `keys`, which mints an active `keys` token -> MUST block `POST /stop?ifIdle=1` with 409!
        const mcpKeysRes = (await plain.client.callTool({
          name: "keys",
          arguments: { source: "exa" },
        })) as { isError?: boolean; structuredContent: { set: string[]; address?: string } };
        assert.notEqual(mcpKeysRes.isError, true);
        assert.ok(mcpKeysRes.structuredContent.set.includes("EXA_API_KEY"));
        assert.ok(mcpKeysRes.structuredContent.address?.startsWith(`${origin}/keys/`));

        const idleBlocked = await fetch(`${origin}/stop?ifIdle=1`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(idleBlocked.status, 409, "Active keys token must block POST /stop?ifIdle=1");

        // Redeem the keys token so `hasPendingTokens()` returns false again (even with unexpired browser_open codes!)
        const mintedKeyCode = mcpKeysRes.structuredContent.address!.split("/").at(-1)!;
        await service.runtime.runPromise(
          Effect.flatMap(ExecutionService, (exec) => exec.redeemOpaqueCode(mintedKeyCode)),
        );
        const pendingAfterKeysRedeem = await service.runtime.runPromise(
          Effect.flatMap(ExecutionService, (exec) => exec.hasPendingTokens()),
        );
        assert.equal(pendingAfterKeysRedeem, false);

        // Card helper security & edge-case checks
        assert.equal(SAFE_CARD_URL_RE.test(`${origin}/open/abc_123`), true);
        assert.equal(SAFE_CARD_URL_RE.test(`${origin}/keys/abc-123`), true);
        assert.equal(SAFE_CARD_URL_RE.test("https://evil.example/keys/abc"), false);
        assert.equal(SAFE_CARD_URL_RE.test(`${origin}/approve/secretcode`), false);

        const spendCard = cardForSpendGate({
          sourceLabel: "Exa",
          actionName: "exa_search",
          title: "Confirm paid call",
          reason: "Typical cost exceeds ask_above_usd.",
        });
        assert.equal(spendCard.card, "spend_gate");
        assert.equal(spendCard.action, undefined);
        assert.equal(JSON.stringify(spendCard).includes("/approve/"), false);

        // Failed job with trailing period renders red (`err`) with clean badge & receipt
        const failedCard = cardForSourceCall({
          sourceLabel: "Exa",
          actionName: "exa_search",
          status: "failed",
          jobId: "job-fail",
          receiptId: null,
          dig: digHandle,
          isError: true,
          resultText: "exa_search · job job-fail · failed · receipt c-999.\n\nProvider error.",
          error: "Provider error.",
        });
        assert.equal(failedCard.tone, "err");
        assert.equal(failedCard.badge, "failed");
        assert.equal(failedCard.chips?.find((c) => c.label === "Receipt")?.value, "c-999");

        // Declined `keys` card shows refusal line and omits the "Open key page" action button
        const declinedKeysCard = cardForKeys({
          scopeLabel: "Exa",
          set: [],
          missing: ["EXA_API_KEY"],
          declined: true,
          url: `${origin}/keys/unused`,
          line: "The person declined to open the key page; nothing was changed.",
        });
        assert.equal(declinedKeysCard.badge, "not opened");
        assert.equal(declinedKeysCard.action, undefined);
        assert.match(declinedKeysCard.title, /declined/);

        const srcCard = cardForSourceCall({
          sourceLabel: "X",
          actionName: "x_web_search",
          status: "completed",
          jobId: "job-1",
          receiptId: "c-1",
          dig: digHandle,
          reused: true,
          resultText: "X · x_web_search · success · receipt c-1 · cost: 1 credit · dig so far: $0.01 + 2 credits",
          rawFile: "proj/sessions/s1/raw/c-1.json",
          openUrl: `${origin}/open/testcode`,
        });
        assert.equal(srcCard.badge, "reused");
        assert.equal(srcCard.action?.label, "Inspect in Dig ↗");

        assert.equal(declaresUi({ extensions: { [UI_EXTENSION_ID]: {} } }), true);
        assert.equal(declaresUi({ extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_RESOURCE_MIME] } } }), true);
        assert.equal(declaresUi({ extensions: { [UI_EXTENSION_ID]: { mimeTypes: ["text/plain"] } } }), false);
        assert.equal(declaresUi({}), false);
        assert.ok(renderCardHtml().includes(`"dig-card"`));
      } finally {
        await elicitClient?.client.close().catch(() => {});
        await uiClient?.client.close().catch(() => {});
        await plain.client.close().catch(() => {});
      }

      // ---- 9. POST /stop?ifIdle=1 succeeds despite unexpired browser_open tokens! ----
      const stopRes = await fetch(`${origin}/stop?ifIdle=1`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(stopRes.status, 200, "Unexpired browser_open codes must not block POST /stop?ifIdle=1");
      assert.deepEqual(await stopRes.json(), { stopping: true });

      await service.waitForStop;
      assert.equal(await health(port), null, "Service must stop responding after POST /stop");
    } finally {
      await service.stop("test-cleanup").catch(() => {});
      await releaseState(tmp);
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("static SPA asset server serves dist/web assets, handles client routes with dots, and blocks path traversal", async () => {
    const tmp = await serviceState("dig-svc-web-");
    const webDir = join(tmp, "web");
    await mkdir(join(webDir, "assets"), { recursive: true });
    await writeFile(join(webDir, "index.html"), "<!doctype html><div id='root'>SPA</div>");
    await writeFile(join(webDir, "assets", "app.js"), "console.log('dig');");

    const service = await serve({
      state: tmp,
      port: 0,
      webDir,
      handleSignals: false,
      env: { ...process.env, DIG_STATE_DIR: tmp, DIG_IDLE_EXIT_MS: "600000" },
    });
    try {
      const { origin, token } = service;
      const openPost = await fetch(`${origin}/open`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const { address } = (await openPost.json()) as { address: string };
      const redeemed = await fetch(address, { redirect: "manual" });
      const cookie = (redeemed.headers.get("set-cookie") ?? "").split(";")[0];

      const assetRes = await fetch(`${origin}/assets/app.js`, { headers: { cookie } });
      assert.equal(assetRes.status, 200);
      assert.match(assetRes.headers.get("content-type") ?? "", /javascript/);
      assert.equal(assetRes.headers.get("x-content-type-options"), "nosniff");
      assert.match(await assetRes.text(), /console\.log/);

      // Client-side SPA route containing dots in dig id falls back to index.html
      const digRouteRes = await fetch(`${origin}/dig/my-proj-abc123/2026-11-23-dig-2.0`, {
        headers: { cookie },
      });
      assert.equal(digRouteRes.status, 200);
      assert.match(await digRouteRes.text(), /<div id='root'>SPA<\/div>/);

      // Missing static asset returns 404 (not index.html)
      const missingAsset = await fetch(`${origin}/assets/missing.js`, { headers: { cookie } });
      assert.equal(missingAsset.status, 404);

      // Encoded traversal outside webDir cannot escape
      const traversal = await fetch(`${origin}/assets/%2e%2e/%2e%2e/service.json`, {
        headers: { cookie },
      });
      assert.equal(traversal.status, 404);
    } finally {
      await service.stop("test-cleanup").catch(() => {});
      await releaseState(tmp);
    }
  });

  it("Review #2 regressions: second runtime boot preserves dispatched jobs, safeRedirectPath blocks /\\\\host, digRouteFromFile handles /digs/, and symlink CLI executes", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dig-svc-reg2-"));
    try {
      const { bootDigRuntime } = await import("../core/runtime.ts");
      const { SOURCES, ACCOUNTS } = await import("../sources/index.ts");
      const SqlClientMod = await import("effect/sql/SqlClient");
      const { safeRedirectPath } = await import("./http-api.ts");
      const { digRouteFromFile } = await import("../frontend/state/atoms.ts");
      const { symlink } = await import("node:fs/promises");

      // 1. P0 #1 (Real dispatchCall): Secondary bootDigRuntime + listLibrary + dispose while a REAL paid
      //    call is actively in flight MUST NOT replay or fail the live call, leaving 1 real receipt and status='completed'!
      const { Layer, Schema } = await import("effect");
      const HttpClient = await import("effect/http/HttpClient");
      const HttpClientResponse = await import("effect/http/HttpClientResponse");
      const { FreeHttp, PaidHttp, makeFreeClient, makePaidClient, paidRequest } = await import("../core/http.ts");
      const { LibraryService } = await import("../core/library.ts");
      const { defineAction, defineSource, meteredBilling, outcome } = await import("../core/plugin.ts");

      let releaseProvider!: () => void;
      let providerStarted!: () => void;
      const startedPromise = new Promise<void>((r) => {
        providerStarted = r;
      });
      const gatePromise = new Promise<void>((r) => {
        releaseProvider = r;
      });
      let providerHits = 0;
      const slowMock = HttpClient.make((req) =>
        Effect.gen(function* () {
          providerHits++;
          providerStarted();
          yield* Effect.promise(() => gatePromise);
          return HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ ok: true, costDollars: { total: 0.5 } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      );
      const slowAction = defineAction({
        name: "demo_slow_flight",
        description: "Slow paid action",
        schema: Schema.Struct({ q: Schema.String }),
        slow: true,
        billing: meteredBilling(
          "USD",
          (body) => (body as { costDollars?: { total?: number } })?.costDollars?.total ?? null,
        ),
        execute: (args, ctx) =>
          Effect.gen(function* () {
            yield* paidRequest({
              url: "https://93.184.216.34/flight",
              method: "POST",
              body: { q: args.q },
              label: "flight",
              keep: ctx.keep,
            }).pipe(Effect.orDie);
            return outcome("success", "flight completed");
          }),
      });
      const slowPlugin = defineSource({
        id: "demo-flight",
        group: "web",
        label: "Demo Flight",
        description: "Demo",
        about: "Demo",
        providers: [{ name: "Demo" }],
        billing: "USD",
        actions: [slowAction],
      });
      const mockHttpLayer = Layer.mergeAll(
        Layer.succeed(PaidHttp, makePaidClient(slowMock, { resolveDns: false })),
        Layer.succeed(FreeHttp, makeFreeClient(slowMock, { resolveDns: false, retries: 0 })),
      );

      const rt1 = await bootDigRuntime({
        stateDir: tmp,
        plugins: [slowPlugin],
        accounts: [],
        loadKeys: false,
        httpLayer: mockHttpLayer,
      });
      try {
        const startedDig = await rt1.runPromise(
          Effect.flatMap(LibraryService, (lib) => lib.startDig({ project: tmp, question: "Live flight test" })),
        );
        const resolvedDig = await rt1.runPromise(
          Effect.flatMap(LibraryService, (lib) => lib.resolveHandle(startedDig.handle)),
        );

        // Kick off a REAL paid call through ProviderCallWorkflow (in-flight until releaseProvider())
        const flightPromise = rt1.runPromise(
          Effect.flatMap(ExecutionService, (exec) =>
            exec.dispatchCall({
              plugin: slowPlugin,
              action: slowAction,
              dig: resolvedDig,
              args: { q: "live" },
              waitMs: 10_000,
            }),
          ),
        );
        await startedPromise;

        // Boot a second independent runtime (mirroring `dig list` / `dig setup`), query library, and dispose!
        const rt2 = await bootDigRuntime({
          stateDir: tmp,
          plugins: [slowPlugin],
          accounts: [],
          loadKeys: false,
          httpLayer: mockHttpLayer,
        });
        try {
          await rt2.runPromise(Effect.flatMap(LibraryService, (lib) => lib.listLibrary()));
          const runningFromRt2 = await rt2.runPromise(
            Effect.flatMap(ExecutionService, (exec) => exec.runningJobs()),
          );
          assert.equal(runningFromRt2.length, 1, "Second runtime must still see the live job as working");
        } finally {
          await rt2.dispose();
        }

        // Release provider response and verify the live call finishes cleanly with 1 real $0.50 receipt!
        releaseProvider();
        const finished = await flightPromise;
        assert.equal(providerHits, 1, "Provider must be called strictly once");
        assert.equal(finished.job.status, "completed", "Live call must stay completed, not failed by second runtime");
        const digCalls = await rt1.runPromise(
          Effect.flatMap(LibraryService, (lib) => lib.readDigCalls(resolvedDig)),
        );
        assert.equal(digCalls.length, 1, "Must write strictly 1 receipt (no phantom unknown-cost receipt)");
        assert.deepEqual(digCalls[0].cost, [{ amount: 0.5, unit: "USD" }]);

        // 1b. Graceful runtime dispose mid-flight MUST settle as `failed` (STOPPED, unknown cost, NOT `cancelled`),
        //     so repeating the identical call after restart reuses the failed job and NEVER sends a second paid call!
        let startedStopProbe!: () => void;
        const stopProbeStarted = new Promise<void>((r) => {
          startedStopProbe = r;
        });
        let stopProbeHits = 0;
        const hangingMock = HttpClient.make((req) =>
          Effect.gen(function* () {
            stopProbeHits++;
            startedStopProbe();
            yield* Effect.never;
            return HttpClientResponse.fromWeb(req, new Response("{}", { status: 200 }));
          }),
        );
        const hangingHttpLayer = Layer.mergeAll(
          Layer.succeed(PaidHttp, makePaidClient(hangingMock, { resolveDns: false })),
          Layer.succeed(FreeHttp, makeFreeClient(hangingMock, { resolveDns: false, retries: 0 })),
        );
        const stopDir = await mkdtemp(join(tmpdir(), "dig-svc-stopfail-"));
        try {
          const rtStop = await bootDigRuntime({
            stateDir: stopDir,
            plugins: [slowPlugin],
            accounts: [],
            loadKeys: false,
            httpLayer: hangingHttpLayer,
          });
          const dStop = await rtStop.runPromise(
            Effect.flatMap(LibraryService, (lib) => lib.startDig({ project: stopDir, question: "Stop probe" })),
          );
          const rStop = await rtStop.runPromise(
            Effect.flatMap(LibraryService, (lib) => lib.resolveHandle(dStop.handle)),
          );
          const pendingFlight = rtStop
            .runPromise(
              Effect.flatMap(ExecutionService, (exec) =>
                exec.dispatchCall({
                  plugin: slowPlugin,
                  action: slowAction,
                  dig: rStop,
                  args: { q: "hang" },
                  waitMs: 10_000,
                }),
              ),
            )
            .catch(() => null);
          await stopProbeStarted;
          // Graceful stop disposes the runtime directly (no abortAllActive user-cancel!)
          await rtStop.dispose();
          await pendingFlight;

          const rtAfter = await bootDigRuntime({
            stateDir: stopDir,
            plugins: [slowPlugin],
            accounts: [],
            loadKeys: false,
            httpLayer: hangingHttpLayer,
          });
          try {
            const repeat = await rtAfter.runPromise(
              Effect.flatMap(ExecutionService, (exec) =>
                exec.dispatchCall({
                  plugin: slowPlugin,
                  action: slowAction,
                  dig: rStop,
                  args: { q: "hang" },
                  waitMs: 500,
                }),
              ),
            );
            assert.equal(repeat.reused, true, "Identical repeat after graceful stop must reuse failed job");
            assert.equal(repeat.job.status, "failed", "Graceful stop must settle as failed, NEVER cancelled");
            assert.equal(stopProbeHits, 1, "Identical repeat after graceful stop must NEVER re-send paid request");
            const stopCalls = await rtAfter.runPromise(
              Effect.flatMap(LibraryService, (lib) => lib.readDigCalls(rStop)),
            );
            assert.equal(stopCalls.length, 1);
            assert.equal(stopCalls[0].cost, null, "Gracefully stopped paid call must record unknown (null) cost");
          } finally {
            await rtAfter.dispose();
          }
        } finally {
          await rm(stopDir, { recursive: true, force: true });
        }
      } finally {
        await rt1.dispose();
      }

      // 2. safeRedirectPath blocks protocol-relative // and backslash /\host
      assert.equal(safeRedirectPath("/\\evil.example"), "/");
      assert.equal(safeRedirectPath("//evil.example"), "/");
      assert.equal(safeRedirectPath("/trail?dig=proj-1/dig-2"), "/trail?dig=proj-1/dig-2");

      // 3. P1 #9: digRouteFromFile resolves `<projectFolder>/digs/<digId>/<file>` properly
      assert.deepEqual(
        digRouteFromFile("proj-123456/digs/2026-11-24-abc/hackernews.md"),
        { project: "proj-123456", dig: "2026-11-24-abc" },
      );

      // 4. P1 #7: Symlinked invocation of built dist/dig.mjs runs normally instead of silent exit 0
      const distDig = join(process.cwd(), "dist/dig.mjs");
      const linkPath = join(tmp, "dig-symlink.mjs");
      await symlink(distDig, linkPath);
      const res = spawnSync(process.execPath, [linkPath, "version"], { encoding: "utf8" });
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), VERSION);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("runStdioBridge (`dig mcp`) proxies both 2026-07-28 and 2025-era stdio clients cleanly", async () => {
    // The service is dist/dig.mjs's own, as a host would find it: bridges replace an idle service of another
    // build, so one started inside this test process would be swapped for a detached one and never tested.
    const tmp = await serviceState("dig-svc-stdio-");
    const service = await startDistService(tmp);
    const env = { ...process.env, DIG_STATE_DIR: tmp, DIG_PORT: String(service.port) };
    const modernClient = new Client(
      { name: "dig-stdio-modern", version: "1.0.0" },
      {
        capabilities: { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_RESOURCE_MIME] } } },
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      },
    );
    const legacyClient = new Client(
      { name: "dig-stdio-legacy", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await modernClient.connect(
        new StdioClientTransport({ command: process.execPath, args: [DIST_DIG, "mcp"], env, stderr: "pipe" }),
      );
      const modernTools = await modernClient.listTools();
      assert.ok(modernTools.tools.some((t) => t.name === "open_library"));
      const openTool = modernTools.tools.find((t) => t.name === "open_library") as {
        _meta?: { ui?: { resourceUri?: string } };
      };
      assert.equal(openTool._meta?.ui?.resourceUri, CARD_URI);

      await legacyClient.connect(
        new StdioClientTransport({ command: process.execPath, args: [DIST_DIG, "mcp"], env, stderr: "pipe" }),
      );
      const legacyTools = await legacyClient.listTools();
      assert.ok(legacyTools.tools.some((t) => t.name === "open_library"));

      assert.equal((await health(service.port))?.pid, service.pid, "both bridges used the service this test started");
      assert.equal((await readServiceFile(tmp))?.pid, service.pid);
    } finally {
      await legacyClient.close().catch(() => {});
      await modernClient.close().catch(() => {});
      await service.stop();
      await releaseState(tmp);
    }
  });

  it("bridges starting at once on an empty state folder share one service, and each losing start exits with one plain line", async () => {
    const tmp = await serviceState("dig-svc-race-");
    const port = await freePort();
    const env = { ...process.env, DIG_STATE_DIR: tmp, DIG_PORT: String(port), DIG_IDLE_EXIT_MS: "600000" };
    const clients = Array.from(
      { length: 4 },
      (_, i) => new Client({ name: `dig-race-${i}`, version: "1.0.0" }, { capabilities: {} }),
    );
    try {
      await Promise.all(
        clients.map((client) =>
          client.connect(
            new StdioClientTransport({ command: process.execPath, args: [DIST_DIG, "mcp"], env, stderr: "pipe" }),
          ),
        ),
      );
      // Each listing goes through its own bridge with the port and token that bridge's ensureService returned.
      for (const client of clients) {
        assert.ok((await client.listTools()).tools.some((t) => t.name === "dig_start"));
      }
      const file = await readServiceFile(tmp);
      const running = await health(port);
      assert.ok(file && running, "one service is running");
      assert.equal(file.pid, running.pid);
      assert.equal(file.port, port);

      // Every `dig serve` the bridges spawned wrote exactly one line: the one that bound says it is listening,
      // each loser names the running service and its own pid, and has exited.
      const lines = async () =>
        (await readFile(join(tmp, "service.log"), "utf8")).split("\n").filter((line) => line.trim() !== "");
      const log = await lines();
      assert.equal(log.filter((line) => /listening on/.test(line)).length, 1, log.join("\n"));
      assert.match(log.find((line) => /listening on/.test(line)) ?? "", new RegExp(`\\(pid ${running.pid}\\)`));
      for (const line of log.filter((l) => /already serves|could not|EADDRINUSE|ERROR|error/i.test(l))) {
        const loser: RegExpExecArray | null = new RegExp(
          `^dig: Dig ${VERSION.replaceAll(".", "\\.")} \\(pid ${running.pid}\\) already serves port ${port}; this start \\(pid (\\d+)\\) exits\\.$`,
        ).exec(line);
        assert.ok(loser, `Unexpected service.log line: ${line}`);
        const loserPid: number = Number(loser[1]);
        for (let i = 0; i < 50 && processAlive(loserPid); i++) await new Promise((r) => setTimeout(r, 100));
        assert.equal(processAlive(loserPid), false, `losing start ${loserPid} has exited`);
      }
      assert.doesNotMatch(log.join("\n"), /ERROR|An error occurred|EADDRINUSE|\n\s+at /);
    } finally {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
      await stopServiceIn(tmp);
      await releaseState(tmp);
    }
  });

  it("dig serve on a port Dig already serves writes one plain line and exits 0; on a port held by something else it names the port and DIG_PORT and exits 1", async () => {
    const tmp = await serviceState("dig-svc-port-");
    const other = await serviceState("dig-svc-port-other-");
    const service = await startDistService(tmp);
    const holder = createNetServer((socket) => socket.destroy());
    await new Promise<void>((done) => holder.listen(0, "127.0.0.1", () => done()));
    const heldPort = (holder.address() as AddressInfo).port;
    try {
      const again = spawnSync(process.execPath, [DIST_DIG, "serve"], {
        env: { ...process.env, DIG_STATE_DIR: tmp, DIG_PORT: String(service.port) },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(again.status, 0, again.stderr);
      assert.equal(again.stdout, "");
      assert.match(
        again.stderr,
        new RegExp(`^dig: Dig ${VERSION.replaceAll(".", "\\.")} \\(pid ${service.pid}\\) already serves port ${service.port}; this start \\(pid \\d+\\) exits\\.\n$`),
      );
      assert.equal((await health(service.port))?.pid, service.pid, "the running service is untouched");

      const blocked = spawnSync(process.execPath, [DIST_DIG, "serve"], {
        env: { ...process.env, DIG_STATE_DIR: other, DIG_PORT: String(heldPort) },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(blocked.status, 1, blocked.stderr);
      assert.match(blocked.stderr, new RegExp(`[Pp]ort ${heldPort}\\b.*not Dig`));
      assert.match(blocked.stderr, /DIG_PORT/);
      assert.doesNotMatch(blocked.stderr, /An error occurred|\n\s+at /);
      assert.equal(await readServiceFile(other), null, "a start that did not bind writes no service.json");
    } finally {
      await new Promise<void>((done) => holder.close(() => done()));
      await service.stop();
      await releaseState(tmp);
      await releaseState(other);
    }
  });

  it("errorMessage gives a failure's own cause when its message is empty, so the CLI never prints a bare generic error", () => {
    const bindFailure = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:1"), {
      code: "EADDRINUSE",
    });
    const wrapper = Object.assign(new Error(""), { _tag: "ServeError", cause: bindFailure });
    assert.equal(errorMessage(wrapper), "listen EADDRINUSE: address already in use 127.0.0.1:1");
    assert.equal(errorMessage(new Error("plain")), "plain");
    assert.equal(errorMessage("text"), "text");
    assert.equal(errorMessage(Object.assign(new Error(""), { _tag: "Tagged" })), "Tagged (no message)");
    assert.ok(errorMessage(new Error("")).length > 0);
    assert.ok(errorMessage(undefined).length > 0);
    assert.notEqual(errorMessage(new Error("")), "An error occurred");
  });
});
