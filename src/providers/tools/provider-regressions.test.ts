import { afterEach, beforeEach, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { providerTools } from "../index.js";
import { executeSource, hostResult, outcome } from "../outcome.js";
import { loadConfig } from "../runtime-config.js";
import { expect } from "expect";

const originalFetch = globalThis.fetch;
const saved = {
  OPENCODE_RESEARCH_GOOGLE_API_KEY: process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY,
  EXA_API_KEY: process.env.EXA_API_KEY,
  PATH: process.env.PATH,
  DIG_STATE_DIR: process.env.DIG_STATE_DIR,
};
let root: string;
beforeEach(() => {
  // Transcripts and downloads land in an isolated native library.
  root = mkdtempSync(join(tmpdir(), "dig-provider-test-"));
  process.env.DIG_STATE_DIR = join(root, "state");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
/** Where YouTube keeps the fixture video's transcript: shared across projects in the library. */
const transcriptFile = () =>
  join(loadConfig().library, "youtube-transcripts", `${id}.md`);
/** One provider call through the shared outcome boundary, shaped as a host result. */
async function tool(
  name: string,
  args: Record<string, unknown>,
  signal = new AbortController().signal,
) {
  const result = await executeSource(providerTools[name], args, {
    sessionID: "test",
    directory: root,
    worktree: root,
    abort: signal,
    keep: () => {},
  });
  return hostResult(result, name);
}
function mockFetch(impl: (url: unknown, options?: RequestInit) => unknown) {
  globalThis.fetch = impl as typeof fetch;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const id = "abcdefghijk";
const search = {
  items: [
    {
      id: { videoId: id },
      snippet: {
        title: "Known title",
        channelTitle: "Creator",
        publishedAt: "2026-09-01",
      },
    },
  ],
};

test("DeepWiki upstream isError remains a failed tool outcome", async () => {
  mockFetch(async () =>
    Response.json({
      jsonrpc: "2.0",
      result: {
        isError: true,
        content: [{ type: "text", text: "Repository unavailable" }],
      },
    }),
  );
  const result = await tool("deepwiki_read_wiki_contents", {
    repoName: "fixture/repo",
  });
  expect(result.isError).toBe(true);
  expect(result.details?.status).toBe("failed");
  expect(result.content[0].text).toContain("Repository unavailable");
});
test("DeepWiki answers streamed after progress notifications are successes", async () => {
  // Shape observed from mcp.deepwiki.com on 2026-09-27 for a slow ask_question.
  const stream = [
    ": ping - 2026-09-27 19:29:26",
    "",
    "event: message",
    'data: {"method":"notifications/message","params":{"level":"info","data":{"msg":"Processing query (14s elapsed)"}},"jsonrpc":"2.0"}',
    "",
    "event: message",
    'data: {"jsonrpc":"2.0","id":"ask_question-1","result":{"content":[{"type":"text","text":"It produces an HTMLBundle."}]}}',
    "",
  ].join("\r\n");
  mockFetch(
    async () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  );
  const result = await tool("deepwiki_ask_question", {
    repoName: "oven-sh/bun",
    question: "How do HTML imports work?",
  });
  expect(result.details?.status).toBe("success");
  expect(result.content[0].text).toContain("HTMLBundle");
});
test("a DeepWiki wiki over 200,000 characters is cut at a page heading, partial, and says where the rest is; the original stays whole", async () => {
  const page = (n: number) => `# Page: Part ${n}\n\n${"Body text of this page. ".repeat(400)}\n\n`;
  const wiki = Array.from({ length: 40 }, (_, n) => page(n + 1)).join("");
  const kept: unknown[] = [];
  mockFetch(async () => Response.json({ jsonrpc: "2.0", result: { content: [{ type: "text", text: wiki }] } }));
  const result = await executeSource(providerTools.deepwiki_read_wiki_contents, { repoName: "fixture/repo" }, {
    sessionID: "test", directory: root, worktree: root, abort: new AbortController().signal, keep: (_label, _status, body) => kept.push(body),
  });
  expect(wiki.length).toBeGreaterThan(200_000);
  expect(result.status).toBe("partial");
  const [notice, ...rest] = result.text.split("\n\n");
  const shown = rest.join("\n\n");
  expect(shown.length).toBeLessThanOrEqual(200_000);
  expect(wiki.startsWith(shown)).toBe(true);
  expect(wiki.slice(shown.length).startsWith("# Page: ")).toBe(true);
  expect(notice).toBe(`Showing the first ${shown.length.toLocaleString("en-US")} of ${wiki.length.toLocaleString("en-US")} characters of this wiki (Dig returns at most 200,000 per call); the retained original holds the whole wiki, and deepwiki_ask_question or the page list from deepwiki_read_wiki_structure reaches a specific page.`);
  expect((kept[0] as { result: { content: Array<{ text: string }> } }).result.content[0].text).toBe(wiki);

  mockFetch(async () => Response.json({ jsonrpc: "2.0", result: { content: [{ type: "text", text: "# Page: Small\n\nShort wiki." }] } }));
  const small = await tool("deepwiki_read_wiki_contents", { repoName: "fixture/repo" });
  expect(small.details?.status).toBe("success");
  expect(small.content[0].text).toBe("# Page: Small\n\nShort wiki.");
});
test("a DeepWiki error excerpt is redacted before it is cut, so no fragment of an echoed key survives", async () => {
  process.env.EXA_API_KEY = `PRIVATE/percent+KEY space-unique-${"7G9w".repeat(20)}`; // gitleaks:allow (synthetic test key)
  const encoded = encodeURIComponent(process.env.EXA_API_KEY).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
  // The 300-character excerpt ends inside the echoed key.
  mockFetch(async () => new Response(`${"X".repeat(260)}${encoded}`, { status: 502 }));
  const result = await tool("deepwiki_read_wiki_contents", { repoName: "fixture/repo" });
  expect(result.details?.status).toBe("failed");
  expect(result.content[0].text).toContain("DeepWiki HTTP 502");
  expect(result.content[0].text).not.toContain("PRIVATE%2f");
});
test("the keyless Hacker News, Polymarket and DeepWiki reads bound each request with a timeout", async () => {
  const timeout = AbortSignal.timeout, seen: number[] = [];
  AbortSignal.timeout = (ms: number) => { seen.push(ms); return timeout.call(AbortSignal, ms); };
  try {
    mockFetch(async () => Response.json({ jsonrpc: "2.0", result: { content: [{ type: "text", text: "ok" }] } }));
    for (const [name, args, ms] of [
      ["deepwiki_read_wiki_structure", { repoName: "fixture/repo" }, 60_000],
      ["deepwiki_read_wiki_contents", { repoName: "fixture/repo" }, 60_000],
      ["deepwiki_ask_question", { repoName: "fixture/repo", question: "How?" }, 180_000],
    ] as const) {
      seen.length = 0;
      await tool(name, args);
      expect(seen).toEqual([ms]);
    }
    mockFetch(async () => Response.json({ hits: [], nbHits: 0, events: [], id: 1, children: [] }));
    for (const [name, args] of [["hackernews", { query: "x" }], ["hackernews_read", { item: "1" }], ["polymarket", { query: "x" }]] as const) {
      seen.length = 0;
      await tool(name, args);
      expect(seen).toEqual([60_000]);
    }
  } finally {
    AbortSignal.timeout = timeout;
  }
});
test("explicit successful text is not classified as a failure by its first word", () => {
  expect(
    hostResult(outcome("success", "ERROR: quoted source text"), "fixture")
      .isError,
  ).toBeUndefined();
});
test("YouTube malformed search is failed rather than negative evidence", async () => {
  process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY = "fixture";
  mockFetch(async () => Response.json({ unexpected: "shape" }));
  const result = await tool("youtube", { query: "test", transcripts: false });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).not.toContain("No YouTube results");
});
test("YouTube only calls a validated empty search empty", async () => {
  process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY = "fixture";
  let calls = 0;
  mockFetch(async () => {
    calls++;
    return Response.json({ items: [] });
  });
  const result = await tool("youtube", { query: "test", transcripts: false });
  expect(result.details?.status).toBe("empty");
  expect(calls).toBe(2);
});
test("YouTube detail outage retains search metadata and unknown metrics", async () => {
  process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY = "fixture";
  let calls = 0;
  mockFetch(async () =>
    ++calls === 1
      ? Response.json(search)
      : new Response("unavailable", { status: 503 }),
  );
  const result = await tool("youtube", { query: "test", transcripts: false });
  expect(result.details?.status).toBe("partial");
  expect(result.content[0].text).toContain("Known title");
  expect(result.content[0].text).toContain("Views: unavailable");
  expect(result.content[0].text).not.toContain("Total: 0");
  expect(result.content[0].text).toContain("503");
});
test("YouTube preserves an observed zero while a missing metric stays unknown", async () => {
  process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY = "fixture";
  let calls = 0;
  mockFetch(async () =>
    ++calls === 1
      ? Response.json(search)
      : Response.json({ items: [{ id, statistics: { viewCount: "0" } }] }),
  );
  const result = await tool("youtube", { query: "test", transcripts: false });
  expect(result.content[0].text).toContain("Views: 0 | Likes: unavailable");
  expect(result.details?.status).toBe("partial");
});
test("Hacker News receives cancellation during fetch and reports cancelled", async () => {
  const controller = new AbortController(),
    entered = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  mockFetch(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        signal = options?.signal ?? undefined;
        entered.resolve();
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
      }),
  );
  const pending = tool("hackernews", { query: "test" }, controller.signal);
  await entered.promise;
  controller.abort();
  const result = await pending;
  expect(signal?.aborted).toBe(true);
  expect(result.details?.status).toBe("cancelled");
  expect(result.isError).toBe(true);
});
test("cancellation after Exa returns billing preserves the reported subtotal", async () => {
  process.env.EXA_API_KEY = "isolated-cost-fixture";
  const controller = new AbortController();
  mockFetch(async () => {
    const response = Response.json({ results: [], costDollars: { total: 0.125 } });
    const text = response.text.bind(response);
    response.text = async () => {
      const body = await text();
      controller.abort();
      return body;
    };
    return response;
  });
  const result = await tool("exa_search", { query: "retained billing", numResults: 1 }, controller.signal);
  expect(result.details.status).toBe("cancelled");
  expect(result.details.cost).toBeNull();
  expect(result.details.knownCost).toEqual([{ amount: 0.125, unit: "USD" }]);
});
test("aborting YouTube during an uncooperative fetch prevents follow-up requests and disk writes", async () => {
  process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY = "fixture";
  const controller = new AbortController(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0;
  mockFetch(async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return Response.json(search);
  });
  const pending = tool(
    "youtube",
    { query: "test", transcripts: true },
    controller.signal,
  );
  await entered.promise;
  controller.abort();
  release.resolve();
  const result = await pending;
  expect(result.details?.status).toBe("cancelled");
  expect(calls).toBe(1);
  expect(existsSync(transcriptFile())).toBe(false);
});
test("aborting YouTube terminates transcript subprocesses before persistence", async () => {
  process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY = "fixture";
  const controller = new AbortController();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const marker = join(root, "child-started");
  writeFileSync(
    join(bin, "yt-dlp"),
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ready");\nsetTimeout(() => {}, 60000);\n`,
    { mode: 0o755 },
  );
  process.env.PATH = bin + ":" + saved.PATH;
  let calls = 0;
  mockFetch(async () =>
    ++calls === 1
      ? Response.json(search)
      : Response.json({
          items: [{ id, statistics: { viewCount: "1", likeCount: "1" } }],
        }),
  );
  const pending = tool(
    "youtube",
    { query: "test", transcripts: true },
    controller.signal,
  );
  let settled = false;
  pending.then(() => (settled = true), () => (settled = true));
  while (!settled && !existsSync(marker)) await sleep(5);
  const started = existsSync(marker);
  controller.abort();
  const result = await pending;
  expect(started).toBe(true);
  expect(result.details?.status).toBe("cancelled");
  expect(existsSync(transcriptFile())).toBe(false);
});
