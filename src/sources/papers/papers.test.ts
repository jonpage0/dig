import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import {
  decodeActionArgs,
  executeAction,
  type ActionContext,
  type AnyActionDefinition,
  type ToolProgress,
} from "../../core/plugin.ts";
import { paperSearchInterpreter } from "../shared/executables.ts";
import papersSource, {
  callPaperBridge,
  paperLibraryDir,
  papersFulltextReadAction,
  papersMultiSearchAction,
  papersOpenAlexContentAction,
  papersOpenAlexSearchAction,
  papersPdfDownloadAction,
  papersSectionsAction,
  papersSemanticScholarRecommendationsAction,
  papersSemanticScholarRelationsAction,
  papersSemanticScholarSearchAction,
  papersSemanticScholarSnippetsAction,
  runPaperBridgeTool,
} from "./index.ts";

interface RecordedCall {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function makeHttpLayer(
  handler: (call: RecordedCall) => Response | Error | Promise<Response | Error>,
  calls: RecordedCall[],
) {
  const base = HttpClient.make((req) =>
    Effect.tryPromise({
      try: async () => {
        const call: RecordedCall = {
          url: new URL(req.url),
          method: req.method,
          headers: { ...req.headers },
        };
        calls.push(call);
        const reply = await handler(call);
        if (reply instanceof Error) throw reply;
        return HttpClientResponse.fromWeb(req, reply);
      },
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request: req,
            description: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        }),
    }),
  );
  return Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
  );
}

describe("papersSource", () => {
  const envKeys = [
    "PATH",
    "DIG_STATE_DIR",
    "OPENALEX_API_KEY",
    "PAPER_SEARCH_MCP_OPENALEX_API_KEY",
    "SEMANTIC_SCHOLAR_API_KEY",
    "PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY",
    "PAPER_SEARCH_MCP_ENV_FILE",
    "PAPER_SEARCH_MCP_UNPAYWALL_EMAIL",
    "PAPER_SEARCH_MCP_FAKE_PDF_BYTES",
    "PAPER_SEARCH_MCP_FAKE_PDF_FAIL",
    "PAPER_SEARCH_MCP_FAKE_SEARCH_OUTPUT",
    "PAPER_SEARCH_MCP_FAKE_SEARCH_FAIL",
    "EXA_API_KEY",
  ] as const;
  const saved = new Map<string, string | undefined>(envKeys.map((k) => [k, process.env[k]]));

  let root: string;
  let calls: RecordedCall[];
  let progressEvents: ToolProgress[];

  beforeEach(() => {
    for (const k of envKeys) {
      if (k !== "PATH") delete process.env[k];
    }
    calls = [];
    progressEvents = [];
    root = mkdtempSync(join(tmpdir(), "dig-papers-2-"));
    process.env.DIG_STATE_DIR = join(root, "state");
    mkdirSync(dirname(paperSearchInterpreter()), { recursive: true });
    writeFileSync(paperSearchInterpreter(), "");
    mkdirSync(join(root, "bin"));
    const fakeUv = [
      `#!${process.execPath}`,
      'const { writeFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const cmd = args[args.indexOf("paper-search") + 1];',
      'if (process.env.EXA_API_KEY) { console.error("LEAKED EXA_API_KEY"); process.exit(2); }',
      'if (cmd === "search" || cmd === "tool") {',
      '  if (process.env.PAPER_SEARCH_MCP_FAKE_SEARCH_FAIL) { console.error(process.env.PAPER_SEARCH_MCP_FAKE_SEARCH_FAIL); process.exit(1); }',
      '  process.stdout.write(process.env.PAPER_SEARCH_MCP_FAKE_SEARCH_OUTPUT ?? "");',
      "} else {",
      '  const out = args[args.indexOf("-o") + 1];',
      '  const id = args[args.indexOf(cmd) + 2];',
      '  writeFileSync(`${out}/${id}.pdf`, process.env.PAPER_SEARCH_MCP_FAKE_PDF_BYTES ?? "");',
      '  if (process.env.PAPER_SEARCH_MCP_FAKE_PDF_FAIL) { console.error("download interrupted"); process.exit(1); }',
      '  else console.log(JSON.stringify({ path: `${out}/${id}.pdf` }));',
      "}",
    ].join("\n");
    writeFileSync(join(root, "bin", "uv"), fakeUv, { mode: 0o755 });
    process.env.PATH = `${join(root, "bin")}:${saved.get("PATH") ?? ""}`;
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
    handler: (call: RecordedCall) => Response | Error | Promise<Response | Error> = () => {
      throw new Error("unexpected HTTP");
    },
    overrides: Partial<ActionContext> = {},
  ) => {
    const ctx: ActionContext = {
      digId: "papers-test",
      project: root,
      signal: new AbortController().signal,
      progress: (p) => progressEvents.push(p),
      keep: () => {},
      ...overrides,
    };
    return Effect.runPromise(
      executeAction(action, args as never, ctx).pipe(Effect.provide(makeHttpLayer(handler, calls))),
    );
  };

  it("exports 10 public actions, reusable bridge helpers, and zero non-public add-ons", () => {
    assert.equal(papersSource.id, "papers");
    assert.equal(papersSource.group, "papers");
    assert.equal(papersSource.actions.length, 10);
    assert.deepEqual(
      papersSource.actions.map((a) => a.name),
      [
        "papers_semantic_scholar_search",
        "papers_semantic_scholar_recommendations",
        "papers_semantic_scholar_snippets",
        "papers_semantic_scholar_relations",
        "papers_openalex_search",
        "papers_openalex_content",
        "papers_multi_search",
        "papers_sections",
        "papers_fulltext_read",
        "papers_pdf_download",
      ],
    );
    assert.equal(typeof callPaperBridge, "function");
    assert.equal(typeof runPaperBridgeTool, "function");
    assert.equal(papersMultiSearchAction.slow, true);
    assert.equal(papersSectionsAction.slow, true);
    assert.equal(papersFulltextReadAction.slow, true);
    assert.equal(papersPdfDownloadAction.slow, true);
  });

  it("validates direct paper schemas and enforces Semantic Scholar sort/token/fields/throttling rules", async () => {
    assert.equal(decodeActionArgs(papersSemanticScholarSearchAction, { query: "x", limit: 20 }).ok, true);
    assert.equal(decodeActionArgs(papersSemanticScholarSearchAction, { query: "x", limit: 21 }).ok, false);
    assert.equal(decodeActionArgs(papersOpenAlexSearchAction, { query: "x", limit: 25, page: 1 }).ok, true);
    assert.equal(decodeActionArgs(papersOpenAlexSearchAction, { query: "x", limit: 26 }).ok, false);

    // Refuses token + non-relevance sort before HTTP
    const refused = await run(papersSemanticScholarSearchAction, {
      query: "robot",
      sort: "publicationDate",
      token: "t",
    });
    assert.equal(refused.status, "failed");
    assert.match(refused.text, /token cannot be combined with sort "publicationDate"/);
    assert.equal(calls.length, 0);

    // Relevance search includes tldr; bulk sort and recommendations omit tldr
    const askedFields: string[] = [];
    const handler = (call: RecordedCall) => {
      askedFields.push(call.url.searchParams.get("fields") ?? "");
      if (call.url.pathname.includes("recommendations")) {
        return Response.json({ recommendedPapers: [{ paperId: "r1", title: "Related Paper" }] });
      }
      return Response.json({ data: [{ paperId: "p1", title: "Found Paper", citationCount: 50 }], token: "next-tok" });
    };
    const rec = await run(papersSemanticScholarRecommendationsAction, { positivePaperIds: ["seed"] }, handler);
    assert.equal(rec.status, "success");
    assert.deepEqual(rec.details?.cost, []);
    const rel = await run(papersSemanticScholarSearchAction, { query: "robot" }, handler);
    assert.equal(rel.status, "success");
    assert.match(rel.text, /Next token: next-tok/);
    const sorted = await run(papersSemanticScholarSearchAction, { query: "robot", sort: "citationCount" }, handler);
    assert.equal(sorted.status, "success");
    assert.doesNotMatch(sorted.text, /Next token/);
    assert.ok(!askedFields[0].split(",").includes("tldr"));
    assert.ok(askedFields[1].split(",").includes("tldr"));
    assert.ok(!askedFields[2].split(",").includes("tldr"));

    // Snippets & relations
    const snip = await run(
      papersSemanticScholarSnippetsAction,
      { query: "evidence", paperIds: ["DOI:10.1/example"] },
      (call) => {
        assert.match(call.url.pathname, /snippet\/search/);
        assert.equal(call.url.searchParams.get("paperIds"), "DOI:10.1/example");
        return Response.json({ data: [{ snippet: { text: "Supported claim" } }] });
      },
    );
    assert.equal(snip.status, "success");

    const cite = await run(
      papersSemanticScholarRelationsAction,
      { paperId: "1", direction: "citations" },
      () => Response.json({ data: [{ contexts: ["Baseline"], citingPaper: { paperId: "2" } }], next: 10 }),
    );
    assert.equal(cite.status, "success");
    assert.match(cite.text, /Next offset: 10/);

    // Throttling distinguishes anonymous vs configured key
    const throttled = await run(
      papersSemanticScholarSearchAction,
      { query: "test" },
      () => new Response("", { status: 429, headers: { "retry-after": "12" } }),
    );
    assert.equal(throttled.status, "failed");
    assert.match(throttled.text, /shared anonymous pool/);
    assert.match(throttled.text, /Retry-After: 12/);
  });

  it("extracts OpenAlex USD cost honestly, marks 4xx/5xx free, marks missing/invalid/interrupted billing unknown, and saves cached content safely", async () => {
    const emptyUsd = await run(
      papersOpenAlexSearchAction,
      { query: "absent" },
      () =>
        new Response(JSON.stringify({ results: [], meta: { cost_usd: 0.001 } }), {
          status: 200,
          headers: {
            "x-ratelimit-limit": "1000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-credits-used": "10",
            "x-ratelimit-reset": "60",
          },
        }),
    );
    assert.equal(emptyUsd.status, "empty");
    assert.deepEqual(emptyUsd.details?.cost, [{ amount: 0.001, unit: "USD" }]);
    assert.match(emptyUsd.text, /request USD: 0\.001/);

    // Semantic mode & malformed abstract index
    const sem = await run(
      papersOpenAlexSearchAction,
      { query: "a descriptive question", mode: "semantic" },
      (call) => {
        assert.equal(call.url.searchParams.get("search.semantic"), "a descriptive question");
        assert.equal(call.url.searchParams.has("search"), false);
        return Response.json({
          results: [
            { id: "https://openalex.org/W1", display_name: "Work 1", abstract_inverted_index: { Huge: [100000000] } },
            { id: "https://openalex.org/W2", display_name: "Work 2", abstract_inverted_index: { Good: [0], text: [1] } },
          ],
          meta: { cost_usd: 0 },
        });
      },
    );
    assert.equal(sem.status, "success");
    assert.deepEqual(sem.details?.cost, []);
    assert.match(sem.text, /Good text/);
    assert.doesNotMatch(sem.text, /Huge/);

    // Missing/negative billing -> unknown
    for (const [body, status] of [
      [{ results: [{ id: "https://openalex.org/W1", display_name: "Work" }] }, 200],
      [{ results: [], meta: { cost_usd: -1 } }, 200],
      [{ error: "quota", meta: { cost_usd: -1 } }, 429],
    ] as const) {
      const r = await run(
        papersOpenAlexSearchAction,
        { query: "test" },
        () => new Response(JSON.stringify(body), { status }),
      );
      assert.equal(r.details?.cost, null);
    }

    // 429 without invalid cost_usd -> free, secret redacted
    process.env.PAPER_SEARCH_MCP_OPENALEX_API_KEY = "fixture-oa-secret";
    const err429 = await run(
      papersOpenAlexSearchAction,
      { query: "example" },
      (call) => {
        assert.equal(call.headers.authorization, "Bearer fixture-oa-secret");
        return new Response('{"error":"fixture-oa-secret rejected"}', { status: 429 });
      },
    );
    assert.equal(err429.status, "failed");
    assert.deepEqual(err429.details?.cost, []);
    assert.ok(!err429.text.includes("fixture-oa-secret"));

    // OpenAlex content: saves XML write-once, rejects HTML for PDF
    process.env.OPENALEX_API_KEY = "fixture-oa-key";
    const xmlOut = await run(
      papersOpenAlexContentAction,
      { workId: "W1", format: "xml" },
      (call) => {
        assert.match(call.url.href, /content\.openalex\.org\/works\/W1\.grobid-xml/);
        return new Response('<?xml version="1.0"?><TEI><text>Evidence</text></TEI>', { status: 200 });
      },
    );
    assert.equal(xmlOut.status, "success", xmlOut.text);
    assert.equal(xmlOut.details?.cost, null);
    assert.match(readFileSync(xmlOut.details?.file as string, "utf8"), /Evidence/);

    const badPdf = await run(
      papersOpenAlexContentAction,
      { workId: "W2", format: "pdf" },
      () => new Response("<html>Unavailable</html>", { status: 200 }),
    );
    assert.equal(badPdf.status, "failed");
  });

  it("runs bridge multi_search, sections, fulltext_read, pdf_download with live progress, write-once, confinement, and OpenAlex billing", async () => {
    // 1. Multi-search OpenAlex USD + credits + mixed subtotal + non-OpenAlex free + progress + env isolation
    process.env.EXA_API_KEY = "exa-must-not-leak-to-bridge";
    process.env.PAPER_SEARCH_MCP_FAKE_SEARCH_OUTPUT = JSON.stringify({
      source_status: { openalex: "ok", ssrn: "empty" },
      papers: [{ id: "1" }],
      billing: {
        openalex: { http_status: 200, cost_usd: 0.001 },
        ssrn: { http_status: 200, cost_usd: 0.001 },
      },
      rate_limits: { openalex: { "credits-used": 10 }, ssrn: { "credits-used": 10 } },
    });
    const msUsd = await run(papersMultiSearchAction, { query: "governance", sources: ["openalex", "ssrn"] });
    assert.equal(msUsd.status, "success", msUsd.text);
    assert.deepEqual(msUsd.details?.cost, [{ amount: 0.002, unit: "USD" }]);
    assert.ok(progressEvents.length >= 2, "bridge multi_search must emit progress updates");

    process.env.PAPER_SEARCH_MCP_FAKE_SEARCH_OUTPUT = JSON.stringify({
      source_status: { openalex: "empty", ssrn: "empty", crossref: "empty" },
      papers: [],
      billing: { openalex: { http_status: 200, cost_usd: 0.001 }, ssrn: { http_status: 200, cost_usd: null } },
    });
    const msMixed = await run(papersMultiSearchAction, {
      query: "governance",
      sources: ["openalex", "ssrn", "crossref"],
    });
    assert.equal(msMixed.status, "empty");
    assert.equal(msMixed.details?.cost, null);
    assert.deepEqual(msMixed.details?.knownCost, [{ amount: 0.001, unit: "USD" }]);

    process.env.PAPER_SEARCH_MCP_FAKE_SEARCH_OUTPUT = JSON.stringify({
      source_status: { crossref: "empty", arxiv: "empty" },
      papers: [],
    });
    const msFree = await run(papersMultiSearchAction, { query: "governance", sources: ["crossref", "arxiv"] });
    assert.equal(msFree.status, "empty");
    assert.deepEqual(msFree.details?.cost, []);

    // Contact email redaction in bridge output
    process.env.PAPER_SEARCH_MCP_UNPAYWALL_EMAIL = "researcher@example.test";
    process.env.PAPER_SEARCH_MCP_FAKE_SEARCH_OUTPUT = JSON.stringify({
      source_status: { unpaywall: "partial" },
      warnings: ["Rejected email researcher@example.test"],
      papers: [],
    });
    const msRedacted = await run(papersMultiSearchAction, { query: "test", sources: ["unpaywall"] });
    assert.equal(msRedacted.status, "partial");
    assert.ok(!msRedacted.text.includes("researcher@example.test"));

    // 2. Write-once PDF download & failed download leaves no partial file
    const papers = paperLibraryDir();
    const pdfPath = join(papers, "1234.56789.pdf");
    process.env.PAPER_SEARCH_MCP_FAKE_PDF_BYTES = "original-pdf-bytes";
    const dl1 = await run(papersPdfDownloadAction, { source: "arxiv", paperId: "1234.56789" });
    assert.equal(dl1.status, "success");
    assert.deepEqual(dl1.details?.cost, []);
    assert.equal(dl1.text, JSON.stringify({ path: pdfPath }));

    process.env.PAPER_SEARCH_MCP_FAKE_PDF_BYTES = "replacement-pdf-bytes";
    const dl2 = await run(papersPdfDownloadAction, { source: "arxiv", paperId: "1234.56789" });
    assert.match(dl2.text, /Already saved, kept unchanged/);
    assert.equal(readFileSync(pdfPath, "utf8"), "original-pdf-bytes");
    assert.deepEqual(readdirSync(papers), ["1234.56789.pdf"]);

    process.env.PAPER_SEARCH_MCP_FAKE_PDF_FAIL = "1";
    const dlFail = await run(papersPdfDownloadAction, { source: "arxiv", paperId: "9999.00001" });
    assert.equal(dlFail.status, "failed");
    assert.equal(existsSync(join(papers, "9999.00001.pdf")), false);
    delete process.env.PAPER_SEARCH_MCP_FAKE_PDF_FAIL;
    // 3. savePath confinement refuses symlink escaping project
    const outside = mkdtempSync(join(tmpdir(), "dig-papers-outside-"));
    try {
      const escaped = join(root, "escape-link");
      symlinkSync(outside, escaped);
      const refusedPath = await run(papersPdfDownloadAction, {
        source: "arxiv",
        paperId: "1234.56789",
        savePath: escaped,
      });
      assert.equal(refusedPath.status, "failed");
      assert.match(refusedPath.text, /must lie inside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    // 4. OpenAlex fulltext_read reports unknown cost; arxiv reports free
    const oaRead = await run(papersFulltextReadAction, { source: "openalex", paperId: "W123" });
    assert.equal(oaRead.status, "success");
    assert.equal(oaRead.details?.cost, null);

    // 5. Sections extraction (valid & truncated -> partial)
    process.env.PAPER_SEARCH_MCP_FAKE_SEARCH_OUTPUT = JSON.stringify({
      sections: [{ title: "Intro", text: "Hello" }],
      truncated: true,
    });
    const secOut = await run(papersSectionsAction, { file: "1234.56789.pdf", maxPages: 5 });
    assert.equal(secOut.status, "partial");
    assert.deepEqual(secOut.details?.cost, []);
    const badSec = await run(papersSectionsAction, { file: "../escape.pdf" });
    assert.equal(badSec.status, "failed");
  });
});
