import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import {
  decodeActionArgs,
  executeAction,
  schemaToMcpJson,
  type ActionContext,
} from "../../core/plugin.ts";
import githubSource, {
  githubInspectAction,
  githubReadAction,
  githubSearchAction,
  resetGhCliTokenCache,
} from "./index.ts";

interface CapturedCall {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

type Route = unknown | ((call: CapturedCall) => unknown | Response);

const TOKEN = "gh_test_token_never_shown";
const DAY = 86_400_000;
const RESET_EPOCH = "1789300000";
const RESET_ISO = "2026-09-13T11:46:40.000Z";
const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const weekSeconds = (daysAgo: number) => Math.floor((NOW - daysAgo * DAY) / 1000);
const isoDate = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

function json(payload: unknown, init: { readonly status?: number; readonly headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function rateLimited(resource: string): Response {
  return json(
    { message: "API rate limit exceeded" },
    {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-resource": resource,
        "x-ratelimit-reset": RESET_EPOCH,
      },
    },
  );
}

function decodeBody(req: HttpClientRequest.HttpClientRequest): unknown {
  if (req.body._tag === "Uint8Array") {
    const text = new TextDecoder().decode(req.body.body);
    return text ? (JSON.parse(text) as unknown) : undefined;
  }
  return undefined;
}

function makeMockLayer(routes: Record<string, Route>, retries = 0) {
  const calls: CapturedCall[] = [];
  const base = HttpClient.make((req) =>
    Effect.sync(() => {
      const url = new URL(req.url);
      const call: CapturedCall = {
        url,
        method: req.method,
        headers: { ...req.headers },
        body: decodeBody(req),
      };
      calls.push(call);
      const route = routes[url.pathname];
      if (route === undefined) {
        return HttpClientResponse.fromWeb(req, json({ message: "Not Found" }, { status: 404 }));
      }
      const payload = typeof route === "function" ? (route as (c: CapturedCall) => unknown)(call) : route;
      const resp = payload instanceof Response ? payload.clone() : json(payload);
      return HttpClientResponse.fromWeb(req, resp);
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries })),
  );
  return { calls, layer };
}

function makeCtx(): ActionContext {
  return {
    digId: "dig-github-test",
    project: "/tmp/github-test",
    signal: new AbortController().signal,
    keep() {},
    progress() {},
  };
}

const publicRepo = {
  full_name: "acme/widget",
  html_url: "https://github.com/acme/widget",
  description: "A widget framework",
  homepage: "https://widget.example",
  language: "TypeScript",
  license: { spdx_id: "MIT", name: "MIT License" },
  topics: ["widgets", "framework"],
  stargazers_count: 1234,
  forks_count: 56,
  subscribers_count: 40,
  open_issues_count: 7,
  created_at: "2024-01-10T00:00:00Z",
  pushed_at: "2026-09-14T20:06:34Z",
  default_branch: "main",
  private: false,
  visibility: "public",
  archived: false,
  fork: false,
  owner: { login: "acme", type: "Organization" },
};

function commit(sha: string, login: string | null, committedDaysAgo: number, parents = 1) {
  return {
    sha,
    commit: {
      author: { name: "Someone", date: iso(committedDaysAgo + 40) },
      committer: { name: "GitHub", date: iso(committedDaysAgo) },
      message: `Change ${sha}\n\nbody`,
    },
    author: login ? { login, type: login.endsWith("[bot]") ? "Bot" : "User" } : null,
    parents: Array.from({ length: parents }, (_, index) => ({ sha: `p${index}` })),
  };
}

function starWeek(daysAgo: number, total: number) {
  return { week: weekSeconds(daysAgo), total, days: [total, 0, 0, 0, 0, 0, 0] };
}

function actor(login: string, bot = false) {
  return { __typename: bot ? "Bot" : "User", login };
}

const graphql = {
  data: {
    rateLimit: { cost: 1, remaining: 4999, resetAt: hoursAgo(0) },
    repository: {
      isPrivate: false,
      mergedPullRequests: {
        totalCount: 120,
        nodes: [
          {
            number: 41,
            title: "Add retries",
            url: "https://github.com/acme/widget/pull/41",
            createdAt: hoursAgo(50),
            mergedAt: hoursAgo(2),
            authorAssociation: "CONTRIBUTOR",
            author: actor("outsider"),
            mergedBy: actor("maintainer"),
            reviews: {
              totalCount: 2,
              nodes: [
                {
                  state: "COMMENTED",
                  submittedAt: hoursAgo(20),
                  url: "https://github.com/acme/widget/pull/41#r1",
                  bodyText: "self note",
                  author: actor("outsider"),
                },
                {
                  state: "APPROVED",
                  submittedAt: hoursAgo(3),
                  url: "https://github.com/acme/widget/pull/41#r2",
                  bodyText: "LGTM, thanks for adding the backoff test.",
                  author: actor("maintainer"),
                },
              ],
            },
          },
          {
            number: 42,
            title: "Bump deps",
            url: "https://github.com/acme/widget/pull/42",
            createdAt: hoursAgo(10),
            mergedAt: hoursAgo(1),
            authorAssociation: "CONTRIBUTOR",
            author: actor("dependabot", true),
            mergedBy: actor("maintainer"),
            reviews: {
              totalCount: 1,
              nodes: [
                {
                  state: "APPROVED",
                  submittedAt: hoursAgo(5),
                  url: "https://github.com/acme/widget/pull/42#r1",
                  bodyText: "",
                  author: actor("copilot-pull-request-reviewer", true),
                },
              ],
            },
          },
        ],
      },
      openIssues: {
        totalCount: 5,
        nodes: [
          {
            number: 7,
            title: "Crash on start",
            url: "https://github.com/acme/widget/issues/7",
            createdAt: hoursAgo(30),
            authorAssociation: "NONE",
            author: actor("reporter"),
            comments: {
              totalCount: 2,
              nodes: [
                {
                  createdAt: hoursAgo(29),
                  authorAssociation: "NONE",
                  url: "c1",
                  bodyText: "same here",
                  author: actor("reporter"),
                },
                {
                  createdAt: hoursAgo(25),
                  authorAssociation: "MEMBER",
                  url: "https://github.com/acme/widget/issues/7#c2",
                  bodyText: "Reproduced on 2.0.0; fix in #43.",
                  author: actor("maintainer"),
                },
              ],
            },
          },
        ],
      },
      closedIssues: {
        totalCount: 300,
        nodes: [
          {
            number: 3,
            title: "Old bug",
            url: null,
            createdAt: hoursAgo(500),
            closedAt: hoursAgo(400),
            authorAssociation: "NONE",
            author: null,
            comments: {
              totalCount: 9,
              nodes: [
                {
                  createdAt: hoursAgo(499),
                  authorAssociation: "NONE",
                  url: null,
                  bodyText: "closing as stale",
                  author: actor("stale", true),
                },
              ],
            },
          },
        ],
      },
    },
  },
};

function repoRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    "/repos/acme/widget": publicRepo,
    "/repos/acme/widget/stargazers/history": [
      starWeek(2, 3),
      starWeek(9, 10),
      starWeek(16, 20),
      starWeek(23, 30),
      starWeek(30, 99),
    ],
    "/repos/acme/widget/commits": (call: CapturedCall) => {
      const page = call.url.searchParams.get("page");
      const payload =
        page === "1"
          ? [commit("aaa1111111", "alice", 1), commit("bbb2222222", "dependabot[bot]", 2, 2)]
          : [commit(`ccc${page ?? "1"}`, null, 3)];
      return json(payload, {
        headers: {
          link: `<https://api.github.com/repos/acme/widget/commits?page=${Number(page) + 1}>; rel="next"`,
        },
      });
    },
    "/repos/acme/widget/releases": [
      {
        tag_name: "v2.0.0",
        published_at: hoursAgo(24),
        prerelease: false,
        draft: false,
        html_url: "https://github.com/acme/widget/releases/tag/v2.0.0",
      },
      { tag_name: "v1.9.0", published_at: iso(100), prerelease: false, draft: false, html_url: null },
      { tag_name: "v2.1.0-draft", published_at: null, prerelease: true, draft: true, html_url: null },
    ],
    "/repos/acme/widget/contributors": json(
      [
        { login: "alice", type: "User", contributions: 900 },
        { login: "dependabot[bot]", type: "Bot", contributions: 120 },
      ],
      { headers: { link: '<https://api.github.com/repos/acme/widget/contributors?page=2>; rel="next"' } },
    ),
    "/graphql": graphql,
    ...overrides,
  };
}

describe("github source plugin (Effect 4.1.5)", () => {
  const savedGh = process.env.GH_TOKEN;
  const savedGithub = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    resetGhCliTokenCache();
    process.env.GH_TOKEN = TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    resetGhCliTokenCache();
    if (savedGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedGh;
    if (savedGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithub;
  });

  it("exports plugin metadata and validates schemas", () => {
    assert.equal(githubSource.id, "github");
    assert.equal(githubSource.group, "code");
    assert.equal(githubSource.logo, "github");
    assert.deepEqual(
      githubSource.actions.map((a) => a.name),
      ["github_search", "github_inspect", "github_read"],
    );
    for (const action of githubSource.actions) {
      assert.equal(schemaToMcpJson(action.schema, { compact: true }).type, "object");
    }
    assert.equal(decodeActionArgs(githubSearchAction, { query: "effect", perPage: 100 }).ok, true);
    assert.equal(decodeActionArgs(githubSearchAction, { query: "effect", perPage: 101 }).ok, false);
    assert.equal(decodeActionArgs(githubInspectAction, { repo: "acme/widget", days: 90 }).ok, true);
    assert.equal(decodeActionArgs(githubReadAction, { repo: "acme/widget", maxLines: 2000 }).ok, true);
  });

  it("github_search enforces is:public, withholds unmarked items, redacts tokens, and rejects non-public queries", async () => {
    const { calls, layer } = makeMockLayer({
      "/search/repositories": json(
        {
          total_count: 2500,
          incomplete_results: true,
          items: [
            { ...publicRepo },
            { ...publicRepo, full_name: "acme/other", archived: true, license: null },
            { ...publicRepo, full_name: "acme/leaked", private: true, visibility: "private" },
            { ...publicRepo, full_name: "acme/unmarked", visibility: undefined },
          ],
        },
        {
          headers: {
            "x-ratelimit-remaining": "29",
            "x-ratelimit-resource": "search",
            "x-ratelimit-reset": RESET_EPOCH,
          },
        },
      ),
    });

    const result = await Effect.runPromise(
      executeAction(
        githubSearchAction,
        { query: 'widget "is:public" language:TypeScript', sort: "stars", order: "asc", page: 3, perPage: 50 },
        makeCtx(),
      ).pipe(Effect.provide(layer)),
    );

    assert.equal(result.status, "partial");
    assert.deepEqual(result.details?.cost, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url.searchParams.get("q"), 'widget "is:public" language:TypeScript is:public');
    assert.equal(calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0]!.headers["x-github-api-version"], "2026-03-10");
    assert.equal(result.text.includes(TOKEN), false);
    assert.match(result.text, /Withheld 2 returned item\(s\)/);
    assert.equal(result.text.includes("acme/leaked"), false);
    assert.equal(result.details?.withheld, 2);

    // Non-public queries rejected before any HTTP call
    const bad = await Effect.runPromise(
      executeAction(githubSearchAction, { query: "widget is:private" }, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(bad.status, "failed");
    assert.equal(calls.length, 1);

    // Token redaction on error payload
    const errMock = makeMockLayer({
      "/search/repositories": json(
        {
          message: `Bad credentials for ${TOKEN}`,
          errors: [{ message: "echoed ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 back" }],
        },
        { status: 422 },
      ),
    });
    const errOut = await Effect.runPromise(
      executeAction(githubSearchAction, { query: "x" }, makeCtx()).pipe(Effect.provide(errMock.layer)),
    );
    assert.equal(errOut.status, "failed");
    assert.equal(
      errOut.text,
      "ERROR: GitHub returned HTTP 422 for repository search: Bad credentials for [redacted]; echoed [redacted] back",
    );
  });

  it("github_inspect assembles all evidence sections, handles anonymous limits, and marks rate-limited sections partial", async () => {
    const full = makeMockLayer(repoRoutes());
    const ok = await Effect.runPromise(
      executeAction(
        githubInspectAction,
        { repo: "https://github.com/acme/widget.git", days: 14, samples: 2 },
        makeCtx(),
      ).pipe(Effect.provide(full.layer)),
    );
    assert.equal(ok.status, "success");
    assert.deepEqual(ok.details?.cost, []);
    assert.equal(ok.text.includes(TOKEN), false);
    assert.match(ok.text, /Status: complete — all sections returned/);
    assert.match(ok.text, new RegExp(`Window \\(2 of 2 complete weeks, ${isoDate(weekSeconds(16))}`));
    assert.match(ok.text, /LGTM, thanks for adding the backoff test\./);
    assert.match(ok.text, /first MEMBER reply by maintainer after 5h/);

    const partialMock = makeMockLayer(
      repoRoutes({
        "/repos/acme/widget/stargazers/history": (call: CapturedCall) =>
          call.url.searchParams.get("page") === "1"
            ? Array.from({ length: 30 }, (_, index) => starWeek(2 + index * 7, index === 0 ? 1 : 10))
            : rateLimited("core"),
        "/graphql": json({ message: "Bad Gateway" }, { status: 502 }),
      }),
    );
    const partial = await Effect.runPromise(
      executeAction(githubInspectAction, { repo: "acme/widget", days: 365 }, makeCtx()).pipe(
        Effect.provide(partialMock.layer),
      ),
    );
    assert.equal(partial.status, "partial");
    assert.match(partial.text, /Status: partial — 2 section\(s\) unavailable or truncated/);
    assert.match(partial.text, new RegExp(`resets ${RESET_ISO}`));
  });

  it("github_read reads files with line pagination, lists directories, checks refs, and re-probes gh auth token after 401", async () => {
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    const body = Buffer.from("line one\nline two\nline three\nline four\nline five\n").toString("base64");
    const { calls, layer } = makeMockLayer({
      "/repos/acme/widget": publicRepo,
      "/repos/acme/widget/commits/v2.0.0": {
        sha: commitSha,
        commit: { committer: { date: "2026-09-05T00:30:56Z" } },
        html_url: "x",
      },
      "/repos/acme/widget/commits/main": {
        sha: commitSha,
        commit: { committer: { date: "2026-09-05T00:30:56Z" } },
        html_url: "x",
      },
      "/repos/acme/widget/contents/src/index.ts": {
        type: "file",
        encoding: "base64",
        size: 49,
        sha: "blob123",
        content: body,
      },
      "/repos/acme/widget/contents/": {
        type: "dir",
        entries: [
          { type: "file", name: "README.md", path: "README.md", size: 120, sha: "f1" },
          { type: "dir", name: "src", path: "src", size: 0, sha: "d1" },
        ],
      },
    });

    const fileOut = await Effect.runPromise(
      executeAction(
        githubReadAction,
        { repo: "acme/widget", path: "/src/index.ts", ref: "v2.0.0", startLine: 2, maxLines: 2 },
        makeCtx(),
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(fileOut.status, "success");
    assert.match(fileOut.text, /Showing 2–3 \| Continue with startLine: 4/);
    assert.equal(fileOut.text.endsWith("line two\nline three"), true);

    const dirOut = await Effect.runPromise(
      executeAction(githubReadAction, { repo: "acme/widget" }, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(dirOut.status, "success");
    assert.match(dirOut.text, /GitHub directory: \(root\)/);
    assert.ok(dirOut.text.indexOf("dir   src") < dirOut.text.indexOf("file  README.md"));

    // Path traversal rejected before request
    const beforeCount = calls.length;
    const traversal = await Effect.runPromise(
      executeAction(githubReadAction, { repo: "acme/widget", path: "../../etc/passwd" }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(traversal.status, "failed");
    assert.equal(calls.length, beforeCount);

    // gh auth token fallback + 401 cache invalidation
    const dir = mkdtempSync(join(tmpdir(), "dig-gh-20-"));
    const savedPath = process.env.PATH;
    writeFileSync(join(dir, "count"), "0");
    writeFileSync(
      join(dir, "gh"),
      `#!/bin/sh\nn=$(($(cat "${dir}/count") + 1))\necho $n > "${dir}/count"\necho gho_fixture_$n\n`,
    );
    chmodSync(join(dir, "gh"), 0o755);
    delete process.env.GH_TOKEN;
    resetGhCliTokenCache();
    process.env.PATH = `${dir}:${savedPath ?? ""}`;
    try {
      const seenAuth: string[] = [];
      const cliMock = makeMockLayer({
        "/repos/acme/widget": (call: CapturedCall) => {
          seenAuth.push(call.headers.authorization ?? "");
          return seenAuth.length === 1 ? json({ message: "Bad credentials" }, { status: 401 }) : publicRepo;
        },
        "/repos/acme/widget/commits/main": { sha: commitSha },
        "/repos/acme/widget/contents/": { type: "dir", entries: [] },
      });
      await Effect.runPromise(executeAction(githubReadAction, { repo: "acme/widget" }, makeCtx()).pipe(Effect.provide(cliMock.layer)));
      await Effect.runPromise(executeAction(githubReadAction, { repo: "acme/widget" }, makeCtx()).pipe(Effect.provide(cliMock.layer)));
      assert.deepEqual(seenAuth, ["Bearer gho_fixture_1", "Bearer gho_fixture_2"]);
    } finally {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
