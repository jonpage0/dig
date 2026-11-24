import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { decodeActionArgs, executeAction, type ActionContext, type AnyActionDefinition } from "../../core/plugin.ts";
import facebookSource, {
  facebookSource as namedFacebookSource,
  scrapecreatorsFacebookAction,
  scrapecreatorsFacebookEventsAction,
} from "./index.ts";

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
}

function makeTestEnv(handler: (req: RecordedRequest) => Response | { readonly error: string }) {
  const requests: RecordedRequest[] = [];
  const base = HttpClient.make((req) =>
    Effect.gen(function* () {
      const rec = { url: new URL(req.url), method: req.method };
      requests.push(rec);
      const res = handler(rec);
      if ("error" in res) {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request: req, description: res.error }),
          }),
        );
      }
      return HttpClientResponse.fromWeb(req, res);
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0 })),
  );
  const ctx: ActionContext = {
    digId: "dig-test",
    project: "/tmp",
    signal: new AbortController().signal,
    progress: () => {},
    keep: () => {},
  };
  return {
    requests,
    run: <A extends AnyActionDefinition>(action: A, rawArgs: unknown) => {
      const decoded = decodeActionArgs(action, rawArgs);
      if (!decoded.ok) {
        return Promise.resolve({ status: "failed" as const, text: decoded.error, details: { cost: null } });
      }
      return Effect.runPromise(executeAction(action, decoded.args, ctx).pipe(Effect.provide(layer)));
    },
  };
}

const jsonResponse = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("facebook source plugin", () => {
  const savedKey = process.env.SCRAPECREATORS_API_KEY;

  beforeEach(() => {
    process.env.SCRAPECREATORS_API_KEY = "fb-test-secret-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = savedKey;
  });

  test("exports facebookSource as named and default with 2 actions", () => {
    assert.equal(facebookSource, namedFacebookSource);
    assert.equal(facebookSource.id, "facebook");
    assert.equal(facebookSource.group, "social");
    assert.deepEqual(
      facebookSource.actions.map((a) => a.name),
      ["scrapecreators_facebook", "scrapecreators_facebook_events"],
    );
  });

  test("profile handles public, gated, partial gated, and accountDoesNotExist cleanly", async () => {
    const envPublic = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        id: "1001",
        name: "Acme Coffee",
        likeCount: 5400,
        followerCount: 6000,
      }),
    );
    const pub = await envPublic.run(scrapecreatorsFacebookAction, {
      kind: "profile",
      url: "https://www.facebook.com/acmecoffee",
      business_hours: true,
    });
    assert.equal(pub.status, "success");
    assert.equal(envPublic.requests[0].url.searchParams.get("get_business_hours"), "true");
    assert.match(pub.text, /Acme Coffee \(id 1001\)/);
    assert.deepEqual(pub.details?.cost, [{ amount: 1, unit: "credits" }]);

    const envGated = makeTestEnv(() =>
      jsonResponse({ success: true, credits_charged: 1, isPrivate: true, account_status: "age-restricted" }),
    );
    const gated = await envGated.run(scrapecreatorsFacebookAction, {
      kind: "profile",
      url: "https://www.facebook.com/gatedpage",
    });
    assert.equal(gated.status, "failed");
    assert.match(gated.text, /Access: gated/);

    const envLimited = makeTestEnv(() =>
      jsonResponse({
        success: true,
        credits_charged: 1,
        isPrivate: true,
        account_status: "private",
        id: "2002",
        name: "Private Co",
      }),
    );
    const lim = await envLimited.run(scrapecreatorsFacebookAction, {
      kind: "profile",
      url: "https://www.facebook.com/privateco",
      include_gated_profile: true,
    });
    assert.equal(lim.status, "partial");

    const envMissing = makeTestEnv(() =>
      jsonResponse({ success: false, credits_charged: 0, accountDoesNotExist: true }, 404),
    );
    const missing = await envMissing.run(scrapecreatorsFacebookAction, {
      kind: "profile",
      url: "https://www.facebook.com/nobody",
    });
    assert.equal(missing.status, "empty");
    assert.deepEqual(missing.details?.cost, []);
  });

  test("rejects 3xx redirects without following them and validates misplaced args before any call", async () => {
    const envRedir = makeTestEnv(() =>
      jsonResponse({ error: "redirect" }, 302, { location: "https://evil.example/steal" }),
    );
    const redir = await envRedir.run(scrapecreatorsFacebookAction, {
      kind: "post",
      url: "https://www.facebook.com/acme/posts/123",
    });
    assert.equal(redir.status, "failed");
    assert.equal(envRedir.requests.length, 1);
    assert.match(redir.text, /does not follow redirects/);

    const envBad = makeTestEnv(() => jsonResponse({ success: true }));
    for (const bad of [
      { kind: "profile", url: "https://www.facebook.com/groups/123" },
      { kind: "profile_reels", url: "https://www.facebook.com/acme", cursor: "abc" },
      { kind: "replies", feedback_id: "f1" },
      { kind: "group_posts", url: "https://www.facebook.com/acme" },
    ]) {
      assert.equal((await envBad.run(scrapecreatorsFacebookAction, bad)).status, "failed", JSON.stringify(bad));
    }
    assert.equal(envBad.requests.length, 0);
  });

  test("facebook events search and details return structured output and meter credits", async () => {
    const env = makeTestEnv((req) => {
      if (req.url.pathname === "/v1/facebook/events/search") {
        return jsonResponse({
          success: true,
          credits_charged: 1,
          cursor: "ev-2",
          events: [{ id: "99", name: "Austin Jazz Night", day_time_sentence: "Fri 8 PM" }],
        });
      }
      return jsonResponse({
        success: true,
        credits_charged: 1,
        id: "99",
        name: "Austin Jazz Night",
        interested_count: 150,
        going_count: 45,
        description: "Live music downtown",
      });
    });

    const search = await env.run(scrapecreatorsFacebookEventsAction, { kind: "search", query: "jazz" });
    assert.equal(search.status, "success");
    assert.match(search.text, /Austin Jazz Night/);
    assert.match(search.text, /pass cursor="ev-2"/);

    const det = await env.run(scrapecreatorsFacebookEventsAction, { kind: "details", event_id: "99" });
    assert.equal(det.status, "success");
    assert.match(det.text, /Interested: 150 \| Going: 45/);
  });
});
