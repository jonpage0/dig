import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext } from "../../core/plugin.ts";
import linkedinDefault, { linkedinAction, linkedinSource } from "./index.ts"; // gitleaks:allow

const TEST_KEY = "sc-test-linkedin-key-1111";

function makeLayers(handler: (url: URL) => Response) {
  const calls: URL[] = [];
  const base = HttpClient.make((req) =>
    Effect.sync(() => {
      const url = new URL(req.url);
      calls.push(url);
      return HttpClientResponse.fromWeb(req, handler(url));
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
  );
  return { calls, layer };
}

function makeCtx(): ActionContext {
  return {
    digId: "test-dig",
    project: "/tmp",
    keep: () => {},
    progress: () => {},
    signal: new AbortController().signal,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("linkedin SourcePlugin", () => {
  const prevKey = process.env.SCRAPECREATORS_API_KEY;
  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = TEST_KEY;
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = prevKey;
  });

  it("exports metadata, default export, and scrapecreators_linkedin action", () => {
    assert.equal(linkedinSource, linkedinDefault);
    assert.equal(linkedinSource.id, "linkedin");
    assert.equal(linkedinSource.group, "social");
    assert.deepEqual(linkedinSource.actions.map((a) => a.name), ["scrapecreators_linkedin"]);
  });

  it("searches public LinkedIn posts and records credits", async () => {
    const { calls, layer } = makeLayers((url) => {
      assert.equal(url.pathname, "/v1/linkedin/search/posts");
      assert.equal(url.searchParams.get("query"), "agentic coding");
      assert.equal(url.searchParams.get("date_posted"), "last-week");
      return json({
        success: true,
        credits_charged: 1,
        cursor: "2",
        posts: [
          {
            author: { name: "Ada", followers: 5200, url: "https://www.linkedin.com/in/ada" },
            description: "Shipping typed Effect plugins.",
            datePublished: "2026-11-20",
            likeCount: 120,
            commentCount: 15,
            url: "https://www.linkedin.com/posts/ada-123",
            comments: [{ author: "Bob", text: "Great architecture!" }],
          },
        ],
      });
    });

    const decoded = decodeActionArgs(linkedinAction, {
      kind: "search",
      query: "agentic coding",
      date_posted: "last-week",
    });
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;

    const res = await Effect.runPromise(
      executeAction(linkedinAction, decoded.args, makeCtx()).pipe(Effect.provide(layer)),
    );
    assert.equal(calls.length, 1);
    assert.equal(res.status, "success");
    assert.deepEqual(res.details?.cost, [{ amount: 1, unit: "credits" }]);
    assert.match(res.text, /Ada \(5\.2K followers\)/);
    assert.match(res.text, /Next page: pass cursor="2"/);
  });

  it("fetches profile, company, company_posts, and post endpoints and validates input bounds", async () => {
    const { calls, layer } = makeLayers((url) => {
      if (url.pathname === "/v1/linkedin/profile") {
        return json({
          success: true,
          credits_charged: 1,
          name: "Ada Lovelace",
          followers: 10500,
          location: "London",
          experience: [{ name: "Analytical Engines", member: { startDate: 1842, description: "Lead" } }],
        });
      }
      if (url.pathname === "/v1/linkedin/company/posts") {
        return json({ success: true, credits_charged: 1, posts: [] });
      }
      return json({ success: false, error: "unexpected" }, 404);
    });

    const prof = await Effect.runPromise(
      executeAction(
        linkedinAction,
        { kind: "profile", url: "https://www.linkedin.com/in/ada" },
        makeCtx(),
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(prof.status, "success");
    assert.match(prof.text, /LinkedIn profile: Ada Lovelace/);
    assert.match(prof.text, /Dates: 1842 - Present/);

    const emptyPosts = await Effect.runPromise(
      executeAction(
        linkedinAction,
        { kind: "company_posts", url: "https://www.linkedin.com/company/acme", page: 2 },
        makeCtx(),
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(emptyPosts.status, "empty");

    const badCursor = await Effect.runPromise(
      executeAction(linkedinAction, { kind: "search", query: "test", cursor: "12" }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(badCursor.status, "failed");
    assert.equal(calls.length, 2, "Invalid cursor 12 must not send HTTP");

    const badHost = await Effect.runPromise(
      executeAction(linkedinAction, { kind: "post", url: "https://example.com/posts/1" }, makeCtx()).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(badHost.status, "failed");
    assert.equal(calls.length, 2);
  });
});
