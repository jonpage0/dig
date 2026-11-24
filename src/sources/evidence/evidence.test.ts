import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer, Result, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { executeAction, type ActionContext, type ActionOutcome } from "../../core/plugin.ts";
import { registerSecret } from "../../core/secrets.ts";
import evidenceSource, {
  buildEvidenceRequest,
  EVIDENCE_MODEL,
  evidenceRankAction,
  formatEvidence,
  RELEVANCE,
  type EvidenceCandidateRow,
} from "./index.ts";

const ARGS = {
  question: "What does the experiment establish about captions?",
  candidates: [
    { id: "context", text: "A related background explanation.", reference: "https://example.test/context" },
    { id: "contradiction", text: "The experiment explicitly found no improvement.", reference: "retained/source.json" },
    { id: "other", text: "An unrelated caption font." },
  ],
  claim: "The experiment found an improvement.",
};

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
}

interface KeptEntry {
  readonly label: string;
  readonly status: number | string;
  readonly body: unknown;
}

function makeScore(level: number) {
  return {
    type: "score" as const,
    score: level,
    confidence: 1,
    legend: Object.fromEntries(RELEVANCE.map((v, i) => [String(i), v])),
    probabilities: Object.fromEntries(RELEVANCE.map((_, i) => [String(i), i === level ? 1 : 0])),
  };
}

function makeRelation(label: "supported" | "contradicted" | "insufficient") {
  return {
    type: "choice" as const,
    choice: label,
    confidence: 1,
    probabilities: Object.fromEntries(
      (["supported", "contradicted", "insufficient"] as const).map((k) => [k, k === label ? 1 : 0]),
    ),
  };
}

function makeResponse(model = "jev-1.14.0") {
  return {
    model,
    answers: {
      relevance_0: makeScore(2),
      relevance_1: makeScore(3),
      relevance_2: makeScore(0),
      relation_0: makeRelation("insufficient"),
      relation_1: makeRelation("contradicted"),
      relation_2: makeRelation("insufficient"),
    },
    usage: { input_tokens: 520, output_tokens: 100 },
  };
}

function makeHttpLayers(
  handler: (call: RecordedCall) => Response | Error,
  calls: RecordedCall[],
) {
  const mockBase = HttpClient.make((req) =>
    Effect.gen(function* () {
      const bodyText =
        req.body._tag === "Uint8Array"
          ? new TextDecoder().decode(req.body.body)
          : req.body._tag === "Raw" && typeof req.body.body === "string"
            ? req.body.body
            : "";
      const call: RecordedCall = {
        url: req.url,
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
    Layer.succeed(PaidHttp, makePaidClient(mockBase, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(mockBase, { resolveDns: false, retries: 0 })),
  );
}

function ranked(outcome: ActionOutcome): {
  readonly model: string | null;
  readonly requestedModel: string;
  readonly candidates: readonly EvidenceCandidateRow[];
  readonly warnings: readonly string[];
} {
  return outcome.details as {
    readonly model: string | null;
    readonly requestedModel: string;
    readonly candidates: readonly EvidenceCandidateRow[];
    readonly warnings: readonly string[];
  };
}

describe("evidenceSource (@effect/ai-typesafe)", () => {
  const savedKey = process.env.TYPESAFE_API_KEY;
  let calls: RecordedCall[];
  let retained: KeptEntry[];

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = "typesafe-synthetic-offline-key";
    calls = [];
    retained = [];
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedKey;
  });

  const runAction = (
    handler: (call: RecordedCall) => Response | Error,
    args: typeof ARGS | Record<string, unknown> = ARGS,
    signal = new AbortController().signal,
  ) => {
    const ctx: ActionContext = {
      digId: "dig-evidence-test",
      project: "/tmp",
      signal,
      progress: () => {},
      keep: (label, status, body) => {
        retained.push({ label, status, body });
      },
    };
    const layer = makeHttpLayers(handler, calls);
    return Effect.runPromise(
      executeAction(evidenceRankAction, args as typeof ARGS, ctx).pipe(Effect.provide(layer)),
    );
  };

  it("exports plugin metadata with kind='tool', helperSkill='evidence-rank', and default model 'jev-latest'", () => {
    assert.equal(evidenceSource.id, "evidence");
    assert.equal(evidenceSource.kind, "tool");
    assert.equal(evidenceSource.group, "tools");
    assert.equal(evidenceSource.helperSkill, "evidence-rank");
    assert.deepEqual(evidenceSource.keys, ["TYPESAFE_API_KEY"]);
    assert.equal(EVIDENCE_MODEL, "jev-latest");
  });

  it("enforces schema bounds, excess properties, IDs, caps, duplicates, and UTF-8 byte limits before HTTP", async () => {
    const strictDecode = Schema.decodeUnknownResult(evidenceRankAction.schema);
    assert.ok(Result.isSuccess(strictDecode(ARGS, { onExcessProperty: "error" })));
    for (const extra of [{ model: "jev-1.14.0" }, { threshold: 0.5 }, { url: "https://example.test" }]) {
      assert.ok(Result.isFailure(strictDecode({ ...ARGS, ...extra }, { onExcessProperty: "error" })));
    }

    const invalidCases: Array<Record<string, unknown>> = [
      { question: " " },
      { question: "a".repeat(4001) },
      { claim: "" },
      { candidates: [] },
      { candidates: Array.from({ length: 33 }, (_, i) => ({ id: `id${i}`, text: "x" })) },
      { candidates: [{ id: "a", text: "x" }, { id: "a", text: "y" }] },
      { candidates: [{ id: "../a", text: "x" }] },
      { candidates: [{ id: "a", text: "x".repeat(6001) }] },
      { candidates: [{ id: "a", text: "x", reference: "r".repeat(513) }] },
    ];
    for (const patch of invalidCases) {
      const res = await runAction(() => {
        throw new Error("unexpected HTTP");
      }, { ...ARGS, ...patch });
      assert.equal(res.status, "failed");
    }

    const oversized = await runAction(() => {
      throw new Error("unexpected HTTP");
    }, {
      ...ARGS,
      candidates: [
        { id: "a", text: "界".repeat(4000) },
        { id: "b", text: "界".repeat(4000) },
      ],
    });
    assert.equal(oversized.status, "failed");
    assert.match(oversized.text, /24000 UTF-8 bytes/);
    assert.equal(calls.length, 0);
  });

  it("sends 'jev-latest' via TypeSafeClient, faithfully records resolved 'jev-1.14.0' with zero mismatch warnings, and captures raw JSON in ctx.keep", async () => {
    const secret = "never-send-this-test-credential";
    registerSecret(secret);

    const res = await runAction(
      (call) => {
        assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
        assert.equal(call.method, "POST");
        assert.equal(call.headers.authorization, "Bearer typesafe-synthetic-offline-key");
        assert.ok(!call.bodyText.includes(secret), "secrets must be redacted before transmission");
        assert.ok(!call.bodyText.includes("private-reference"), "references stay strictly local");
        const parsed = JSON.parse(call.bodyText) as { model: string; questions: Record<string, unknown> };
        assert.equal(parsed.model, "jev-latest");
        assert.deepEqual(Object.keys(parsed.questions), [
          "relevance_0",
          "relation_0",
          "relevance_1",
          "relation_1",
          "relevance_2",
          "relation_2",
        ]);
        return Response.json(makeResponse("jev-1.14.0"));
      },
      {
        ...ARGS,
        candidates: [
          { id: "context", text: `Background with ${secret}`, reference: "private-reference" },
          ARGS.candidates[1],
          ARGS.candidates[2],
        ],
      },
    );

    assert.equal(res.status, "success");
    assert.equal(calls.length, 1);
    assert.equal(retained.length, 1);
    assert.equal(retained[0].status, 200);
    assert.equal((retained[0].body as { model: string }).model, "jev-1.14.0");

    const info = ranked(res);
    assert.equal(info.model, "jev-1.14.0");
    assert.equal(info.requestedModel, "jev-latest");
    assert.deepEqual(info.warnings, []);
    assert.match(res.text, /TypeSafe Jev \(jev-1\.14\.0\)/);
    assert.match(res.text, /not truth in the world/);
    assert.deepEqual(
      info.candidates.map((c) => c.id),
      ARGS.candidates.map((c) => c.id),
    );
    assert.deepEqual(res.details?.suggestedOrder, ["contradiction", "context", "other"]);
    assert.equal(info.candidates[1].claimRelation?.relation, "contradicted");
    assert.equal(res.details?.cost, null);
    assert.equal(res.details?.knownCost, undefined);
    assert.deepEqual(res.details?.usage, { input_tokens: 520, output_tokens: 100 });
    assert.ok(!JSON.stringify(res).includes(ARGS.candidates[1].text));
  });

  it("omits relation questions when claim is omitted and preserves caller order on ties", () => {
    const req = buildEvidenceRequest({ question: ARGS.question, candidates: ARGS.candidates });
    assert.equal(Object.keys(req.body.questions).length, 3);
    const out = formatEvidence(
      {
        model: "jev-1.14.0",
        answers: { relevance_0: makeScore(2), relevance_1: makeScore(2), relevance_2: makeScore(2) },
        usage: { input_tokens: 30, output_tokens: 20 },
      },
      req,
    );
    assert.equal(out.status, "success");
    assert.deepEqual(out.details?.suggestedOrder, ["context", "contradiction", "other"]);
    assert.ok(ranked(out).candidates.every((c) => c.claimRelation === null));
    assert.equal(ranked(out).model, "jev-1.14.0");
  });

  it("preserves unscored candidates on missing or malformed answers and flags non-Jev models or missing usage", () => {
    const partial = makeResponse("jev-1.14.0");
    delete (partial.answers as Record<string, unknown>).relevance_1;
    delete (partial.answers as Record<string, unknown>).relation_1;
    const outPartial = formatEvidence(partial, buildEvidenceRequest(ARGS));
    assert.equal(outPartial.status, "partial");
    assert.equal(ranked(outPartial).candidates[1].relevance, null);
    assert.equal(ranked(outPartial).candidates[1].claimRelation, null);
    assert.deepEqual(outPartial.details?.suggestedOrder, ["context", "other", "contradiction"]);

    for (const invalidScore of [
      { ...makeScore(2), score: Infinity },
      { ...makeScore(2), score: -1 },
      { ...makeScore(2), confidence: 1.1 },
      { ...makeScore(2), probabilities: { "0": 0, "1": 0, "2": 0.5, "3": 0 } },
      { ...makeScore(2), legend: { "0": "changed", "1": RELEVANCE[1], "2": RELEVANCE[2], "3": RELEVANCE[3] } },
      { ...makeScore(2), score: 3 },
    ]) {
      const payload = makeResponse("jev-1.14.0");
      (payload.answers as Record<string, unknown>).relevance_0 = invalidScore;
      const r = formatEvidence(payload, buildEvidenceRequest(ARGS));
      assert.equal(r.status, "partial");
      assert.equal(ranked(r).candidates[0].relevance, null);
    }

    for (const invalidRel of [
      { ...makeRelation("supported"), choice: "true" },
      { ...makeRelation("supported"), choice: "contradicted" },
      { ...makeRelation("supported"), probabilities: { supported: 1, contradicted: 0, unknown: 0 } },
    ]) {
      const payload = makeResponse("jev-1.14.0");
      (payload.answers as Record<string, unknown>).relation_0 = invalidRel;
      assert.equal(ranked(formatEvidence(payload, buildEvidenceRequest(ARGS))).candidates[0].claimRelation, null);
    }

    const allEmpty = formatEvidence({ model: "jev-1.14.0", answers: {} }, buildEvidenceRequest(ARGS));
    assert.equal(allEmpty.status, "failed");
    assert.equal(ranked(allEmpty).candidates.length, 3);

    for (const patch of [
      { model: "other-family-1" },
      { model: "" },
      { usage: null },
      { answers: { ...makeResponse().answers, injected_id: makeScore(3) } },
    ]) {
      const r = formatEvidence({ ...makeResponse(), ...patch }, buildEvidenceRequest(ARGS));
      assert.equal(r.status, "partial");
      assert.ok(ranked(r).warnings.length > 0);
    }
  });

  it("never retries on HTTP errors, error envelopes, invalid JSON, or transport failures", async () => {
    const cases: Array<() => Response | Error> = [
      () => Response.json({ detail: "limit" }, { status: 429 }),
      () => Response.json({ error: { message: "failure" } }, { status: 200 }),
      () => new Response("not JSON", { status: 200 }),
      () => new Error("network reset"),
    ];
    for (const respond of cases) {
      calls = [];
      retained = [];
      const res = await runAction(respond);
      assert.equal(res.status, "failed");
      assert.equal(calls.length, 1, "Paid TypeSafe request must never retry");
      assert.equal(retained.length, 1);
      assert.equal(ranked(res).candidates.length, 3);
      assert.equal(res.details?.cost, null);
    }
  });

  it("fails cleanly without HTTP when TYPESAFE_API_KEY is missing and retains received response on cancellation", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const missing = await runAction(() => {
      throw new Error("unexpected HTTP");
    });
    assert.equal(missing.status, "failed");
    assert.match(missing.text, /TYPESAFE_API_KEY/);
    assert.equal(calls.length, 0);
    assert.equal(ranked(missing).candidates.length, 3);

    process.env.TYPESAFE_API_KEY = "typesafe-synthetic-offline-key";
    const abort = new AbortController();
    const cancelled = await runAction(
      () => {
        abort.abort();
        return Response.json(makeResponse("jev-1.14.0"));
      },
      ARGS,
      abort.signal,
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(calls.length, 1);
    assert.equal(retained.length, 1);
    assert.equal(cancelled.details?.cost, null);
  });
});
