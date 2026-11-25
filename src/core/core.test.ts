import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { catalogMetaFromPlugins, keysPath, makeConfigLayer, makeKeysLayer, ConfigService, KeysService } from "./config.ts";
import { dbPath, makeDigDbLayer } from "./db.ts";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp, paidRequest } from "./http.ts";
import { LibraryService, makeLibraryLayer } from "./library.ts";
import { defineAction, defineSource, meteredBilling, outcome, schemaToMcpJson } from "./plugin.ts";
import { ProgressHub } from "./progress.ts";
import { makeSearchLayer, SearchService } from "./search.ts";
import { makeSetupLayer, SetupService } from "./setup.ts";
import { assertPublicUrl, validatePublicUrlSyntax } from "./ssrf.ts";
import { ExecutionService, makeExecutionLayer, makeWorkflowEngineLayer, STOPPED } from "./workflow.ts";
import { bootDigRuntime } from "./runtime.ts";

describe("Dig 2.0 Effect 4.1.5 Core Foundation", () => {
  it("SSRF guard blocks private/loopback/CGNAT/IPv6-mapped/metadata URLs and hop-1 redirects", async () => {
    const blocked = [
      "http://127.0.0.1/secret",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/cgnat",
      "http://[::1]/loopback",
      "http://[::ffff:127.0.0.1]/mapped",
      "http://metadata.google.internal/",
      "http://metadata.goog/",
      "http://example..com/",
      "file:///etc/passwd",
      "http://user:pass@example.com/",
    ];
    for (const url of blocked) {
      const res = validatePublicUrlSyntax(url);
      assert.ok(res instanceof Error, `Expected SSRF block for ${url}`);
    }

    // Verify hop-safe SSRF guard inside HttpClient.transform blocks redirect from public IP -> loopback!
    let hits = 0;
    const mockBase = HttpClient.make((req) =>
      Effect.sync(() => {
        hits++;
        if (req.url.startsWith("https://93.184.216.34/start")) {
          return HttpClientResponse.fromWeb(
            req,
            new Response(null, { status: 302, headers: { location: "http://127.0.0.1:47811/status" } }),
          );
        }
        return HttpClientResponse.fromWeb(req, new Response("leaked", { status: 200 }));
      }),
    );

    const free = makeFreeClient(mockBase, { resolveDns: false, retries: 0 });
    const exit = await Effect.runPromiseExit(free.get("https://93.184.216.34/start"));
    assert.equal(exit._tag, "Failure");
    assert.equal(hits, 1, "Hop-1 redirect to 127.0.0.1 must be blocked before contacting target");
  });

  it("PaidHttp never retries on HTTP 500 or transport error", async () => {
    let calls = 0;
    const failingBase = HttpClient.make((req) =>
      Effect.gen(function* () {
        calls++;
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request: req, description: "connection reset" }),
          }),
        );
      }),
    );

    const paid = makePaidClient(failingBase, { resolveDns: false });
    const exit = await Effect.runPromiseExit(paid.get("https://93.184.216.34/charge"));
    assert.equal(exit._tag, "Failure");
    assert.equal(calls, 1, "PaidHttp must never retry a transport failure");
  });

  it("Crash-safe paid_call_ledger + Workflow executes paid call once, reuses within 10m, and never replays crashed calls", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dig-core-wf-"));
    try {
      let providerHits = 0;
      const mockPaidBase = HttpClient.make((req) =>
        Effect.sync(() => {
          providerHits++;
          return HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ ok: true, cost: 0.012, hit: providerHits }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      );

      const testAction = defineAction({
        name: "demo_paid",
        description: "Demo paid action",
        schema: Schema.Struct({
          query: Schema.String.annotate({ description: "Search query text" }),
        }),
        billing: meteredBilling("USD", (body) =>
          typeof (body as { cost?: number })?.cost === "number" ? (body as { cost: number }).cost : null,
        ),
        execute: (args, ctx) =>
          Effect.gen(function* () {
            const res = yield* paidRequest({
              url: "https://93.184.216.34/api/search",
              method: "POST",
              body: { q: args.query },
              label: "demo",
              keep: ctx.keep,
            }).pipe(Effect.orDie);
            return outcome("success", `Result for ${args.query}: hit ${(res.payload as { hit: number }).hit}`);
          }),
      });

      // Verify compact schema strips nested descriptions
      const compact = schemaToMcpJson(testAction.schema, { compact: true }) as {
        properties: { query: { description?: string } };
      };
      assert.equal(compact.properties.query.description, undefined);

      const testPlugin = defineSource({
        id: "demo",
        group: "web",
        label: "Demo",
        description: "Demo source",
        about: "Demo",
        providers: [{ name: "Demo" }],
        billing: "USD",
        actions: [testAction],
      });

      const meta = catalogMetaFromPlugins([testPlugin]);
      const dbLayer = makeDigDbLayer(dbPath(tmp));
      const configLayer = makeConfigLayer(tmp, meta);
      const keysLayer = makeKeysLayer(tmp, meta);
      const hubLayer = ProgressHub.Live;
      const httpLayer = Layer.mergeAll(
        Layer.succeed(PaidHttp, makePaidClient(mockPaidBase, { resolveDns: false })),
        Layer.succeed(FreeHttp, makeFreeClient(mockPaidBase, { resolveDns: false })),
      );
      const wfEngineLayer = makeWorkflowEngineLayer().pipe(Layer.provide(dbLayer));
      const libLayer = makeLibraryLayer([testPlugin]).pipe(
        Layer.provide(Layer.mergeAll(configLayer, dbLayer, hubLayer)),
      );
      const execLayer = makeExecutionLayer([testPlugin]).pipe(
        Layer.provide(Layer.mergeAll(configLayer, libLayer, dbLayer, hubLayer, httpLayer, wfEngineLayer)),
      );
      const appLayer = Layer.mergeAll(configLayer, keysLayer, dbLayer, hubLayer, libLayer, execLayer);

      await Effect.runPromise(
        Effect.gen(function* () {
          const lib = yield* LibraryService;
          const exec = yield* ExecutionService;
          const sql = yield* SqlClient.SqlClient;

          const started = yield* lib.startDig({ project: tmp, question: "Test paid workflow" });
          const dig = yield* lib.resolveHandle(started.handle);

          // 1. First paid call executes once
          const r1 = yield* exec.dispatchCall({
            plugin: testPlugin,
            action: testAction,
            dig,
            args: { query: "effect v4" },
          });
          assert.equal(r1.reused, false);
          assert.equal(r1.job.status, "completed");
          assert.equal(providerHits, 1);

          // 2. Identical call within REUSE_MS reuses result without paying again
          const r2 = yield* exec.dispatchCall({
            plugin: testPlugin,
            action: testAction,
            dig,
            args: { query: "effect v4" },
          });
          assert.equal(r2.reused, true);
          assert.equal(providerHits, 1, "Identical call within REUSE_MS must NOT send a second HTTP request");

          // 3. fresh: true pays again intentionally
          const r3 = yield* exec.dispatchCall({
            plugin: testPlugin,
            action: testAction,
            dig,
            args: { query: "effect v4" },
            fresh: true,
          });
          assert.equal(r3.reused, false);
          assert.equal(providerHits, 2);

          // 4. Simulate daemon crash mid-flight (`status='dispatched'`) -> recoverCrashedCalls
          const now = new Date().toISOString();
          yield* sql`
            INSERT INTO paid_call_ledger (
              call_id, dig_handle, project, source, tool, args_hash,
              args_redacted_json, declared_json, is_paid, is_slow,
              status, created_at, dispatched_at, last_updated_at
            ) VALUES (
              'job-crashedMidFlight00001', ${dig.handle}, ${dig.project}, 'demo', 'demo_paid',
              'deadbeef', '{"query":"crashed"}', '["query"]', 1, 0,
              'dispatched', ${now}, ${now}, ${now}
            )
          `;
          const recovered = yield* exec.recoverCrashedCalls();
          assert.equal(recovered, 1);
          assert.equal(providerHits, 2, "Crash recovery must NEVER re-send HTTP");

          const crashedJob = yield* exec.getJob("job-crashedMidFlight00001");
          assert.equal(crashedJob?.status, "failed");
          assert.equal(crashedJob?.error, STOPPED);
          assert.ok(crashedJob?.receiptId, "Crashed call must emit an unknown-cost receipt");

          const calls = yield* lib.readDigCalls(dig);
          const crashReceipt = calls.find((c) => c.id === crashedJob?.receiptId);
          assert.equal(crashReceipt?.cost, null, "Crashed paid call receipt cost must be unknown (null), never 0");

          // 5. Opaque DurableDeferred code + HMAC requestState sealing
          const { code } = yield* exec.createOpaqueCode({
            kind: "keys",
            payload: { names: ["DEMO_API_KEY"] },
            ttlMs: 60_000,
          });
          assert.ok(code.length >= 24);
          const firstRedeem = yield* exec.redeemOpaqueCode(code, { saved: ["DEMO_API_KEY"] });
          assert.ok(firstRedeem?.used);
          const secondRedeem = yield* exec.redeemOpaqueCode(code);
          assert.equal(secondRedeem, null, "Opaque code must be strictly single-use");

          const sealed = yield* exec.sealState({ key: "spend", bind: "abc" }, 300);
          const verified = yield* exec.verifyState(sealed);
          assert.equal(verified?.key, "spend");
          const tampered = yield* exec.verifyState(`${sealed}x`);
          assert.equal(tampered, null);
        }).pipe(Effect.provide(appLayer)),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("Plain-file Library + SQLite index + FTS5 Search rebuild cleanly from disk if dig.sqlite is deleted", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dig-core-lib-"));
    try {
      const demoPlugin = defineSource({
        id: "hackernews",
        group: "code",
        label: "Hacker News",
        description: "HN",
        about: "HN",
        providers: [{ name: "HN" }],
        billing: "Free",
        actions: [],
      });
      const meta = catalogMetaFromPlugins([demoPlugin]);

      const buildLayer = () => {
        const dbLayer = makeDigDbLayer(dbPath(tmp));
        const configLayer = makeConfigLayer(tmp, meta);
        const keysLayer = makeKeysLayer(tmp, meta);
        const hubLayer = ProgressHub.Live;
        const libLayer = makeLibraryLayer([demoPlugin]).pipe(
          Layer.provide(Layer.mergeAll(configLayer, dbLayer, hubLayer)),
        );
        const searchLayer = makeSearchLayer([demoPlugin]).pipe(
          Layer.provide(Layer.mergeAll(configLayer, libLayer, dbLayer)),
        );
        const setupLayer = makeSetupLayer([demoPlugin], []).pipe(
          Layer.provide(Layer.mergeAll(configLayer, keysLayer, hubLayer)),
        );
        return Layer.mergeAll(configLayer, keysLayer, dbLayer, hubLayer, libLayer, searchLayer, setupLayer);
      };

      const reportBody = [
        "```yaml",
        "source_card:",
        "  source: hackernews",
        "  status: complete",
        "```",
        "",
        "# Effect 4.1.5 SQLite FTS5 Search Architecture",
        "",
        "## Summary",
        "Effect 4.1.5 consolidates workflow, cluster, and built-in node:sqlite FTS5 search cleanly.",
        "",
        "## Evidence Highlights",
        "- Verified zero-native-addon SQLite WAL and BM25 FTS5 queries.",
        "",
        "## Needs Follow-Up",
        "- None.",
        "",
        "## Negative Evidence (when relevant)",
        "- None.",
      ].join("\n");

      // Phase 1: Write research using first SQLite instance
      const handle = await Effect.runPromise(
        Effect.gen(function* () {
          const cfg = yield* ConfigService;
          yield* cfg.update({
            spend_dig_ceiling_usd: 2.5,
            spend_max_credits: 100,
            spend_max_x_post_reads: 500,
            spend_max_unknown_calls: 10,
          });
          const lib = yield* LibraryService;
          const started = yield* lib.startDig({ project: tmp, question: "How does Dig 2.0 index research?" });
          const dig = yield* lib.resolveHandle(started.handle);
          yield* lib.saveReport({ dig, source: "hackernews", content: reportBody });
          yield* lib.finishDig({
            dig,
            answer: "# Answer\nFiles on disk + rebuildable SQLite FTS5 index.",
            status: "answered",
            reports: ["hackernews.md"],
          });
          return started.handle;
        }).pipe(Effect.provide(buildLayer())),
      );

      // Phase 2: DELETE dig.sqlite completely (simulating fresh machine / cache wipe)
      await rm(dbPath(tmp), { force: true });
      await rm(`${dbPath(tmp)}-wal`, { force: true });
      await rm(`${dbPath(tmp)}-shm`, { force: true });

      // Phase 3: Reopen fresh DB -> verify full automatic rebuild of library + FTS5 search + multi-unit spend config!
      await Effect.runPromise(
        Effect.gen(function* () {
          const cfg = yield* ConfigService;
          const loaded = yield* cfg.load();
          assert.equal(loaded.spend.dig_ceiling_usd, 2.5);
          assert.equal(loaded.spend.max_credits, 100);
          assert.equal(loaded.spend.max_x_post_reads, 500);
          assert.equal(loaded.spend.max_unknown_calls, 10);

          const lib = yield* LibraryService;
          const listed = yield* lib.listLibrary();
          assert.equal(listed.items.length, 1);
          assert.equal(listed.items[0].dig, handle);
          assert.equal(listed.items[0].status, "answered");

          const searchSvc = yield* SearchService;
          const res = yield* searchSvc.search({ query: "FTS5 BM25 zero-native-addon", mode: "keyword" });
          assert.equal(res.mode_used, "keyword");
          assert.ok(res.hits.length >= 1, "Rebuilt FTS5 index must find report passage");
          assert.match(res.hits[0].excerpt, /FTS5/);

          const setup = yield* SetupService;
          const snap = yield* setup.snapshot();
          assert.equal(snap.sources[0].id, "hackernews");
          assert.equal(snap.sources[0].readiness, "ready");
        }).pipe(Effect.provide(buildLayer())),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("bootDigRuntime composes full runtime and enforces multi-unit [spend] caps", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dig-core-rt-"));
    try {
      const mockPaid = HttpClient.make((req) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ ok: true, credits_used: 50 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      );
      const creditsAction = defineAction({
        name: "demo_credits",
        description: "Credits action",
        schema: Schema.Struct({ q: Schema.String }),
        billing: meteredBilling("ScrapeCreators credits", (body) =>
          typeof (body as { credits_used?: number })?.credits_used === "number"
            ? (body as { credits_used: number }).credits_used
            : null,
        ),
        execute: (args, ctx) =>
          Effect.gen(function* () {
            yield* paidRequest({
              url: "https://93.184.216.34/credits",
              body: { q: args.q },
              label: "credits",
              keep: ctx.keep,
              signal: ctx.signal,
            }).pipe(Effect.orDie);
            return outcome("success", `ok ${args.q}`);
          }),
      });
      const plugin = defineSource({
        id: "demo-credits",
        group: "social",
        label: "Demo Credits",
        description: "Demo",
        about: "Demo",
        providers: [{ name: "Demo" }],
        billing: "credits",
        actions: [creditsAction],
      });

      const rt = await bootDigRuntime({
        stateDir: tmp,
        plugins: [plugin],
        accounts: [],
        loadKeys: false,
        httpLayer: Layer.mergeAll(
          Layer.succeed(PaidHttp, makePaidClient(mockPaid, { resolveDns: false })),
          Layer.succeed(FreeHttp, makeFreeClient(mockPaid, { resolveDns: false })),
        ),
      });
      try {
        await rt.runPromise(
          Effect.gen(function* () {
            const cfg = yield* ConfigService;
            const loadedCfg = yield* cfg.update({ spend_max_credits: 40 });
            const lib = yield* LibraryService;
            const exec = yield* ExecutionService;
            const started = yield* lib.startDig({ project: tmp, question: "Spend cap test" });
            const dig = yield* lib.resolveHandle(started.handle);

            const gateBefore = yield* exec.checkSpendGate({
              config: loadedCfg,
              dig,
              sourceLabel: plugin.label,
              actionName: creditsAction.name,
              args: { q: "a" },
            });
            assert.equal(gateBefore.allow, true);

            yield* exec.dispatchCall({ plugin, action: creditsAction, dig, args: { q: "a" } });

            const gateAfter = yield* exec.checkSpendGate({
              config: loadedCfg,
              dig,
              sourceLabel: plugin.label,
              actionName: creditsAction.name,
              args: { q: "b" },
            });
            assert.equal(gateAfter.allow, false);
            if (!gateAfter.allow) {
              assert.equal(gateAfter.question.unit, "credits");
            }
          }),
        );
      } finally {
        await rt.dispose();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("P0/P1 regressions: library allowlist blocks keys.env, concurrent fresh:true attaches once, FreeHttp strips cross-origin keys & obeys followRedirects:false, and reconcile runs on crash recovery", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dig-core-reg-"));
    try {
      const { writeFile } = await import("node:fs/promises");
      // 1. P0 #1: Library allowlist blocks keys.env & arbitrary files even if library === stateDir
      await writeFile(join(tmp, "keys.env"), "EXA_API_KEY=secret-test-value-9999\n", { mode: 0o600 });
      await writeFile(join(tmp, "notes.md"), "# Private notes outside digs/\n");

      let providerHits = 0;
      let reconcileHits = 0;
      const mockPaid = HttpClient.make((req) =>
        Effect.gen(function* () {
          providerHits++;
          yield* Effect.sleep("40 millis");
          return HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ ok: true, cost: 0.01, hit: providerHits }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      );
      const seenHeaders: Record<string, string>[] = [];
      const mockFree = HttpClient.make((req) =>
        Effect.sync(() => {
          seenHeaders.push({ ...(req.headers as Record<string, string>) });
          if (req.url === "https://93.184.216.34/redir") {
            return HttpClientResponse.fromWeb(
              req,
              new Response(null, { status: 302, headers: { location: "https://93.184.216.35/final" } }),
            );
          }
          return HttpClientResponse.fromWeb(req, new Response("ok", { status: 200 }));
        }),
      );

      const slowPaid = defineAction({
        name: "demo_slow_paid",
        description: "Slow paid action with reconcile",
        slow: true,
        schema: Schema.Struct({ q: Schema.String }),
        billing: meteredBilling("USD", (b) =>
          typeof (b as { cost?: number })?.cost === "number" ? (b as { cost: number }).cost : null,
        ),
        reconcile: (remoteId) =>
          Effect.sync(() => {
            reconcileHits++;
            return outcome("success", `Reconciled remote job ${remoteId}`);
          }),
        execute: (args, ctx) =>
          Effect.gen(function* () {
            ctx.reportRemoteJobId?.("resp_remote_123");
            const r = yield* paidRequest({
              url: "https://93.184.216.34/slow",
              method: "POST",
              body: { q: args.q },
              label: "slow",
              keep: ctx.keep,
            }).pipe(Effect.orDie);
            return outcome("success", `hit ${(r.payload as { hit: number }).hit}`);
          }),
      });
      const plugin = defineSource({
        id: "demo-reg",
        group: "web",
        label: "Demo Reg",
        description: "Demo",
        about: "Demo",
        providers: [{ name: "Demo" }],
        billing: "USD",
        actions: [slowPaid],
      });

      const rt = await bootDigRuntime({
        stateDir: tmp,
        plugins: [plugin],
        accounts: [],
        loadKeys: false,
        httpLayer: Layer.mergeAll(
          Layer.succeed(PaidHttp, makePaidClient(mockPaid, { resolveDns: false })),
          Layer.succeed(FreeHttp, makeFreeClient(mockFree, { resolveDns: false, retries: 0 })),
        ),
      });
      try {
        await rt.runPromise(
          Effect.gen(function* () {
            const cfg = yield* ConfigService;
            // Point library directly at stateDir to prove allowlist blocks keys.env & stray .md!
            yield* cfg.update({ library: tmp });
            const lib = yield* LibraryService;
            const exec = yield* ExecutionService;
            const sql = yield* SqlClient.SqlClient;

            const readKeysExit = yield* Effect.exit(lib.readFile("keys.env"));
            assert.equal(readKeysExit._tag, "Failure", "library_read MUST refuse keys.env");
            const readStrayExit = yield* Effect.exit(lib.readFile("notes.md"));
            assert.equal(readStrayExit._tag, "Failure", "library_read MUST refuse non-research .md files");

            // 2. P0 #2: Two simultaneous identical fresh:true calls -> strictly ONE provider hit!
            const started = yield* lib.startDig({ project: tmp, question: "Concurrent fresh test" });
            const dig = yield* lib.resolveHandle(started.handle);
            const [resA, resB] = yield* Effect.all(
              [
                exec.dispatchCall({ plugin, action: slowPaid, dig, args: { q: "race" }, fresh: true, waitMs: 5_000 }),
                exec.dispatchCall({ plugin, action: slowPaid, dig, args: { q: "race" }, fresh: true, waitMs: 5_000 }),
              ],
              { concurrency: "unbounded" },
            );
            assert.equal(providerHits, 1, "Two simultaneous identical fresh:true calls MUST only dispatch once");
            assert.equal(resA.job.id, resB.job.id);
            assert.equal(resA.job.status, "completed");
            assert.equal(resB.job.status, "completed");

            // 3. P1 #7: FreeHttp strips x-api-key cross-origin, omits traceparent/b3, obeys followRedirects:false
            const { freeRequest } = yield* Effect.promise(() => import("./http.ts"));
            const noFollow = yield* freeRequest({
              url: "https://93.184.216.34/redir",
              headers: { "x-api-key": "top-secret-key" },
              followRedirects: false,
              label: "no-follow",
              keep: () => {},
            });
            assert.equal(noFollow.status, 302);
            assert.equal(seenHeaders[0]["traceparent"], undefined);
            assert.equal(seenHeaders[0]["b3"], undefined);

            seenHeaders.length = 0;
            const followed = yield* freeRequest({
              url: "https://93.184.216.34/redir",
              headers: { "x-api-key": "top-secret-key", "user-agent": "dig-test" },
              label: "cross-origin-redir",
              keep: () => {},
            });
            assert.equal(followed.status, 200);
            assert.equal(seenHeaders.length, 2);
            assert.equal(seenHeaders[0]["x-api-key"], "top-secret-key");
            assert.equal(seenHeaders[1]["x-api-key"], undefined, "x-api-key MUST be stripped on cross-origin redirect");
            assert.equal(seenHeaders[1]["user-agent"], "dig-test");

            // 4. P1 #3 & #6: recoverCrashedCalls settles stale pending_approval as cancelled & reconciles dispatched row with remote_job_id
            const now = new Date().toISOString();
            yield* sql`
              INSERT INTO paid_call_ledger (
                call_id, dig_handle, project, source, tool, args_hash,
                args_redacted_json, declared_json, is_paid, is_slow,
                status, remote_job_id, created_at, dispatched_at, last_updated_at
              ) VALUES (
                'job-reconcileCrash000001', ${dig.handle}, ${dig.project}, 'demo-reg', 'demo_slow_paid',
                'hashrec1', '{"q":"rec"}', '["q"]', 1, 1,
                'dispatched', 'resp_crash_999', ${now}, ${now}, ${now}
              )
            `;
            yield* sql`
              INSERT INTO paid_call_ledger (
                call_id, dig_handle, project, source, tool, args_hash,
                args_redacted_json, declared_json, is_paid, is_slow,
                status, created_at, last_updated_at
              ) VALUES (
                'job-stalePending00000001', ${dig.handle}, ${dig.project}, 'demo-reg', 'demo_slow_paid',
                'hashpend1', '{"q":"pend"}', '["q"]', 1, 1,
                'pending_approval', ${now}, ${now}
              )
            `;
            yield* exec.recoverCrashedCalls();
            assert.equal(reconcileHits, 1, "recoverCrashedCalls must invoke read-only reconcile when remote_job_id is stored");
            const recJob = yield* exec.getJob("job-reconcileCrash000001");
            assert.equal(recJob?.status, "completed");
            const pendJob = yield* exec.getJob("job-stalePending00000001");
            assert.equal(pendJob?.status, "cancelled");

            // 5. Attribution & rawFile regression: report claims prior same-source call and exposes library-relative rawFile
            const saved = yield* lib.saveReport({
              dig,
              source: "demo-reg",
              agent: "demo-reg",
              content: [
                "```yaml",
                "source_card:",
                '  source: "demo-reg"',
                '  status: "complete"',
                "  report_path: null",
                '  evidence_grade: "medium"',
                "  strongest_findings: []",
                "  contradictions: []",
                "  negative_evidence: []",
                "  follow_up_targets: []",
                '  confidence: "medium"',
                "```",
                "",
                "# Attribution Regression",
                "",
                "## Summary",
                "Verifies receipt attribution and rawFile.",
                "",
                "## Evidence Highlights",
                "- Checked.",
                "",
                "## Needs Follow-Up",
                "None.",
                "",
                "## Negative Evidence (when relevant)",
                "None.",
              ].join("\n"),
            });
            const listed = yield* lib.listLibrary();
            const digItem = listed.items.find((item) => item.dig === dig.handle);
            assert.ok(digItem, "dig item present in library_list");
            const primaryCall = digItem.calls.find((c) => c.id === resA.job.receiptId);
            assert.ok(primaryCall, "dispatched receipt present in dig calls");
            assert.equal(primaryCall.claimedBy, saved.file, "saved report must claim prior same-source receipt");
            assert.ok(
              primaryCall.rawFile?.endsWith(`/raw/${resA.job.receiptId}.json`),
              `rawFile must be library-relative path, got: ${primaryCall.rawFile}`,
            );
          }),
        );
      } finally {
        await rt.dispose();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
  it("an optional key group leaves a source partial with its own message, never needing setup", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dig-core-optkeys-"));
    try {
      const base = { group: "code" as const, about: "x", providers: [{ name: "x" }], billing: "Free", actions: [] };
      const anonymous = defineSource({
        ...base,
        id: "anon",
        label: "Anon",
        description: "Works without its token",
        env: ["ANON_TOKEN", "ANON_ALIAS_TOKEN"],
        optionalKeys: [{ names: ["ANON_TOKEN", "ANON_ALIAS_TOKEN"], whenAbsent: "Works anonymously at lower limits." }],
      });
      const mixed = defineSource({
        ...base,
        id: "mixed",
        label: "Mixed",
        description: "Needs one key, can use another",
        env: ["MIXED_REQUIRED_KEY", "MIXED_EXTRA_KEY"],
        keys: ["MIXED_REQUIRED_KEY"],
        optionalKeys: [{ names: ["MIXED_EXTRA_KEY"], whenAbsent: "Extras are off." }],
      });
      const plugins = [anonymous, mixed];
      const meta = catalogMetaFromPlugins(plugins);
      assert.ok(meta.credentialKeyNames.includes("ANON_ALIAS_TOKEN"), "optional keys are credentials too");
      const env: NodeJS.ProcessEnv = {};
      const keysLayer = makeKeysLayer(tmp, meta, env);
      const accounts = [
        { id: "anon-co", name: "Anon", signup: "https://example.com", billing: "Free", keys: [["ANON_TOKEN", "ANON_ALIAS_TOKEN"]] },
        { id: "mixed-co", name: "Mixed", signup: "https://example.com", billing: "Paid", keys: ["MIXED_REQUIRED_KEY", "MIXED_EXTRA_KEY"] },
      ];
      const layer = makeSetupLayer(plugins, accounts).pipe(
        Layer.provideMerge(Layer.mergeAll(makeConfigLayer(tmp, meta), keysLayer, ProgressHub.Live)),
      );
      const snapshotWith = (keysEnv: string) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.promise(() => writeFile(keysPath(tmp), keysEnv, { mode: 0o600 }));
            yield* Effect.flatMap(KeysService, (k) => k.reload());
            const snap = yield* Effect.flatMap(SetupService, (s) => s.snapshot());
            assert.deepEqual(
              snap.accounts.flatMap((a) => a.keys.map((k) => [k.name, k.required])),
              [["ANON_TOKEN", false], ["MIXED_REQUIRED_KEY", true], ["MIXED_EXTRA_KEY", false]],
            );
            return new Map(snap.sources.map((s) => [s.id, s]));
          }).pipe(Effect.provide(layer)),
        );

      const none = await snapshotWith("");
      assert.equal(none.get("anon")?.readiness, "partial");
      assert.deepEqual(none.get("anon")?.missingKeys, []);
      assert.deepEqual(none.get("anon")?.optionalKeys, [{ name: "ANON_TOKEN", set: false }]);
      assert.deepEqual(none.get("anon")?.notes, ["Works anonymously at lower limits."]);
      assert.equal(none.get("mixed")?.readiness, "needs_setup");
      assert.deepEqual(none.get("mixed")?.missingKeys, ["MIXED_REQUIRED_KEY"]);

      const onlyOptional = await snapshotWith("ANON_ALIAS_TOKEN=a\nMIXED_EXTRA_KEY=b\n");
      assert.equal(onlyOptional.get("anon")?.readiness, "ready");
      assert.deepEqual(onlyOptional.get("anon")?.optionalKeys, [{ name: "ANON_ALIAS_TOKEN", set: true }]);
      assert.deepEqual(onlyOptional.get("anon")?.notes, []);
      assert.equal(onlyOptional.get("mixed")?.readiness, "needs_setup", "an optional key never stands in for a required one");

      const requiredOnly = await snapshotWith("MIXED_REQUIRED_KEY=c\n");
      assert.equal(requiredOnly.get("mixed")?.readiness, "partial");
      assert.deepEqual(requiredOnly.get("mixed")?.missingKeys, []);
      assert.deepEqual(requiredOnly.get("mixed")?.notes, ["Extras are off."]);

      const both = await snapshotWith("MIXED_REQUIRED_KEY=c\nMIXED_EXTRA_KEY=b\n");
      assert.equal(both.get("mixed")?.readiness, "ready");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
