import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { keysPath } from "../core/config.ts";
import { ExecutionService } from "../core/workflow.ts";
import { VERSION } from "../version.ts";
import { runCli } from "./cli.ts";
import { health, serve } from "./daemon.ts";
import { loadMethods, methodFile, promptedMethods } from "./methods.ts";
import { runSetupPreset, runSetupWizard } from "./setup-tui.ts";
import { CORE_ORDER, SOURCE_TOOLS, parseAction, sourceToolOf } from "./surface.ts";

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

async function parseMcpResponse(res: Response): Promise<Record<string, unknown>> {
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const text = await res.text();
  if (ct.includes("application/json")) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  // Streamable HTTP SSE frame: extract the last `data: {...}` line
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  assert.ok(dataLines.length > 0, `Expected SSE data line in MCP response: ${text}`);
  return JSON.parse(dataLines.at(-1)!) as Record<string, unknown>;
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
    const tmp = await mkdtemp(join(tmpdir(), "dig-svc-full-"));
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

      // ---- 8. /mcp JSON-RPC round-trip (ZERO ui:// tools or resources!) ----
      const mcpHeaders = (sid?: string): Record<string, string> => ({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sid ? { "mcp-session-id": sid } : {}),
      });

      const initRes = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: mcpHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "dig-service-test", version: "1.0.0" },
          },
        }),
      });
      assert.equal(initRes.status, 200);
      const sid = initRes.headers.get("mcp-session-id") ?? undefined;
      assert.ok(sid, "2025-era initialize must return mcp-session-id");
      const initPayload = await parseMcpResponse(initRes);
      assert.ok("result" in initPayload);

      const initializedNotify = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: mcpHeaders(sid),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      assert.ok(initializedNotify.status === 202 || initializedNotify.status === 200);

      const rpc = async (id: number, method: string, params: Record<string, unknown> = {}) => {
        const res = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: mcpHeaders(sid),
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        assert.equal(res.status, 200, `RPC ${method} failed with HTTP ${res.status}`);
        return parseMcpResponse(res);
      };

      // tools/list: verify all core tools + method + enabled sources, ZERO ui:// or open_trail!
      const toolsList = (await rpc(2, "tools/list")) as {
        result: { tools: { name: string; _meta?: Record<string, unknown> }[] };
      };
      const toolNames = toolsList.result.tools.map((t) => t.name);
      for (const core of CORE_ORDER) {
        assert.ok(toolNames.includes(core), `Expected core tool ${core} in tools/list`);
      }
      assert.ok(toolNames.includes("method"));
      assert.ok(toolNames.includes("hackernews"));
      assert.ok(toolNames.includes("exa"));
      assert.equal(toolNames.includes("open_trail"), false, "open_trail must be dropped in Dig 2.0");
      for (const tool of toolsList.result.tools) {
        assert.equal(
          tool._meta?.ui,
          undefined,
          `Tool ${tool.name} must not carry _meta.ui in Dig 2.0`,
        );
      }

      // resources/list & resources/templates/list: ZERO ui:// resources!
      const resList = (await rpc(3, "resources/list")) as {
        result: { resources: { uri: string }[] };
      };
      assert.equal(
        resList.result.resources.some((r) => r.uri.startsWith("ui://")),
        false,
        "ZERO ui:// resources allowed in Dig 2.0",
      );
      const tmplList = (await rpc(4, "resources/templates/list")) as {
        result: { resourceTemplates: { uriTemplate: string }[] };
      };
      assert.ok(
        tmplList.result.resourceTemplates.some((t) => t.uriTemplate === "dig://library/{file}"),
      );

      // tools/call: dig_start -> research_save -> library_list -> library_search -> library_read
      const startedRes = (await rpc(5, "tools/call", {
        name: "dig_start",
        arguments: { project: projectDir, question: "How does Dig 2.0 service layer work?" },
      })) as { result: { isError?: boolean; structuredContent: { dig: string } } };
      assert.notEqual(startedRes.result.isError, true);
      const digHandle = startedRes.result.structuredContent.dig;
      assert.ok(digHandle.includes("/"));

      const reportMarkdown = [
        "```yaml",
        "source_card:",
        "  source: hackernews",
        "  status: complete",
        "```",
        "",
        "# Dig 2.0 Effect Service Architecture",
        "",
        "## Summary",
        "Dig 2.0 uses Effect 4.1.5 HttpRouter, SQLite FTS5, and a single localhost Web SPA.",
        "",
        "## Evidence Highlights",
        "- Zero zod, zero ui:// MCP Apps.",
        "",
        "## Needs Follow-Up",
        "- None.",
        "",
        "## Negative Evidence (when relevant)",
        "- None.",
      ].join("\n");

      const saveRes = (await rpc(6, "tools/call", {
        name: "research_save",
        arguments: { dig: digHandle, source: "hackernews", content: reportMarkdown },
      })) as { result: { isError?: boolean; structuredContent: { file: string } } };
      assert.notEqual(saveRes.result.isError, true);

      const listRes = (await rpc(7, "tools/call", {
        name: "library_list",
        arguments: {},
      })) as { result: { structuredContent: { total: number } } };
      assert.equal(listRes.result.structuredContent.total, 1);

      const searchRes = (await rpc(8, "tools/call", {
        name: "library_search",
        arguments: { query: "HttpRouter localhost", mode: "keyword" },
      })) as { result: { structuredContent: { hits: { file: string }[] } } };
      assert.ok(searchRes.result.structuredContent.hits.length >= 1);

      const readRes = (await rpc(9, "tools/call", {
        name: "library_read",
        arguments: { file: saveRes.result.structuredContent.file },
      })) as { result: { structuredContent: { text: string } } };
      assert.match(readRes.result.structuredContent.text, /Dig 2\.0 Effect Service Architecture/);

      // tools/call: dig_finish
      const finishRes = (await rpc(10, "tools/call", {
        name: "dig_finish",
        arguments: {
          dig: digHandle,
          answer: "# Answer\nDig 2.0 service layer uses Effect 4.1.5 cleanly.",
          status: "answered",
          reports: ["hackernews.md"],
        },
      })) as { result: { isError?: boolean; structuredContent: { file: string } } };
      assert.notEqual(finishRes.result.isError, true);
      assert.match(finishRes.result.structuredContent.file, /answer\.md$/);

      // Cookie-authenticated SPA endpoints POST /api/library/read & POST /api/library/search
      const apiReadRes = await fetch(`${origin}/api/library/read`, {
        method: "POST",
        headers: { cookie: cookieHeader, origin, "content-type": "application/json" },
        body: JSON.stringify({ file: saveRes.result.structuredContent.file }),
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
      const infoRes = (await rpc(11, "tools/call", {
        name: "source_info",
        arguments: { source: "hackernews" },
      })) as { result: { structuredContent: { sources: { id: string; enabled: boolean }[] } } };
      assert.equal(infoRes.result.structuredContent.sources.length, 1);
      assert.equal(infoRes.result.structuredContent.sources[0].id, "hackernews");
      assert.equal(infoRes.result.structuredContent.sources[0].enabled, true);

      // tools/call: settings (reads & updates multi-unit caps)
      const mcpSettingsRes = (await rpc(12, "tools/call", {
        name: "settings",
        arguments: { set: { spend_max_unknown_calls: 12 } },
      })) as { result: { isError?: boolean; structuredContent: { values: Record<string, unknown> } } };
      assert.notEqual(mcpSettingsRes.result.isError, true);
      assert.equal(mcpSettingsRes.result.structuredContent.values.spend_max_unknown_calls, 12);

      // tools/call: open_library (returns one-time /open/<code> link for setup & dig reader)
      const openLibRes = (await rpc(13, "tools/call", {
        name: "open_library",
        arguments: { view: "setup" },
      })) as {
        result: {
          isError?: boolean;
          structuredContent: { address: string; path: string; opened: boolean };
        };
      };
      assert.notEqual(openLibRes.result.isError, true);
      assert.equal(openLibRes.result.structuredContent.path, "/setup");
      assert.ok(openLibRes.result.structuredContent.address.startsWith(`${origin}/open/`));

      const openDigRes = (await rpc(14, "tools/call", {
        name: "open_library",
        arguments: { dig: digHandle },
      })) as {
        result: {
          isError?: boolean;
          structuredContent: { path: string; dig: string };
        };
      };
      assert.notEqual(openDigRes.result.isError, true);
      const [digFolder, digId] = digHandle.split("/");
      assert.equal(openDigRes.result.structuredContent.path, `/dig/${digFolder}/${digId}`);

      // tools/call: keys (never leaks secret; returns one-time /keys/<code> link)
      const mcpKeysRes = (await rpc(15, "tools/call", {
        name: "keys",
        arguments: { source: "exa" },
      })) as {
        result: {
          isError?: boolean;
          structuredContent: { set: string[]; address?: string };
        };
      };
      assert.notEqual(mcpKeysRes.result.isError, true);
      assert.ok(mcpKeysRes.result.structuredContent.set.includes("EXA_API_KEY"));
      assert.ok(mcpKeysRes.result.structuredContent.address?.startsWith(`${origin}/keys/`));

      // tools/call: method
      const methodRes = (await rpc(16, "tools/call", {
        name: "method",
        arguments: { name: "dig" },
      })) as { result: { isError?: boolean; content: { type: string; text: string }[] } };
      assert.notEqual(methodRes.result.isError, true);
      assert.match(methodRes.result.content[0].text, /source_info/);

      // tools/call: job (unknown job id refused cleanly)
      const jobRes = (await rpc(17, "tools/call", {
        name: "job",
        arguments: { id: "job-doesNotExist000000001" },
      })) as { result: { isError?: boolean } };
      assert.equal(jobRes.result.isError, true);

      // tasks/list returns empty running tasks cleanly
      const tasksListRes = (await rpc(18, "tasks/list", {})) as {
        result: { tasks: unknown[] };
      };
      assert.ok(Array.isArray(tasksListRes.result.tasks));

      // Close legacy MCP session cleanly
      await fetch(`${origin}/mcp`, { method: "DELETE", headers: mcpHeaders(sid) });

      // ---- 9. POST /stop graceful shutdown ----
      const stopRes = await fetch(`${origin}/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(stopRes.status, 200);
      assert.deepEqual(await stopRes.json(), { stopping: true });

      await service.waitForStop;
      assert.equal(await health(port), null, "Service must stop responding after POST /stop");
    } finally {
      await service.stop("test-cleanup").catch(() => {});
      await rm(tmp, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("static SPA asset server serves dist/web assets, handles client routes with dots, and blocks path traversal", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dig-svc-web-"));
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
      await rm(tmp, { recursive: true, force: true });
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
      const { spawnSync } = await import("node:child_process");

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
});
