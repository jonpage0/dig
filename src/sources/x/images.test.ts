import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import { executeAction, type ActionContext } from "../../core/plugin.ts";
import { xImagesAction } from "./images.ts";

const PHOTO = "https://pbs.twimg.com/media/G6DbdA4bQAA85sr.jpg";
const PREVIEW = "https://pbs.twimg.com/amplify_video_thumb/1878043946418597888/img/JAfXUP3Fs2C-uFIF.jpg";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function makeLayers(handler: (url: URL) => Response) {
  const seen: string[] = [];
  const base = HttpClient.make((req) =>
    Effect.sync(() => {
      seen.push(req.url);
      return HttpClientResponse.fromWeb(req, handler(new URL(req.url)));
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(FreeHttp, makeFreeClient(base, { resolveDns: false, retries: 0, maxRedirects: 0 })),
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
  );
  return { seen, layer };
}

function makeCtx(): { ctx: ActionContext; kept: Array<{ label: string; status: number | string; body: unknown }> } {
  const kept: Array<{ label: string; status: number | string; body: unknown }> = [];
  const ctx: ActionContext = {
    digId: "test-dig",
    project: "/tmp",
    keep: (label, status, body) => kept.push({ label, status, body }),
    progress: () => {},
    signal: new AbortController().signal,
  };
  return { ctx, kept };
}

describe("x_images action", () => {
  it("fetches pictures via freeBytes in order with returnsImages=true, free billing, and no retained base64", async () => {
    const { seen, layer } = makeLayers((url) => {
      if (url.pathname.includes("G6DbdA4bQAA85sr")) {
        return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    });

    const { ctx, kept } = makeCtx();
    const res = await Effect.runPromise(
      executeAction(xImagesAction, { images: [PHOTO, PREVIEW], size: "large" }, ctx).pipe(
        Effect.provide(layer),
      ),
    );
    assert.equal(xImagesAction.returnsImages, true);
    assert.equal(xImagesAction.billing, "free");
    assert.equal(res.status, "success");
    assert.deepEqual(res.details?.cost, []);
    assert.deepEqual(seen, [`${PHOTO}?name=large`, `${PREVIEW}?name=large`]);
    assert.deepEqual(res.images, [
      { data: base64(JPEG), mimeType: "image/jpeg" },
      { data: base64(PNG), mimeType: "image/png" },
    ]);
    assert.equal(kept.length, 2);
    assert.ok(!JSON.stringify(kept).includes(base64(JPEG)), "No base64 image data may be retained");
  });

  it("refuses disallowed hosts, non-HTTPS, credentials, ports, and SSRF targets before any HTTP request", async () => {
    const { seen, layer } = makeLayers(() => new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } }));
    const { ctx, kept } = makeCtx();

    for (const badUrl of [
      "https://example.com/media/a.jpg",
      "https://pbs.twimg.com.example.com/media/a.jpg",
      "http://pbs.twimg.com/media/a.jpg",
      "https://pbs.twimg.com:8443/media/a.jpg",
      "https://user:pass@pbs.twimg.com/media/a.jpg",
      "https://127.0.0.1/media/a.jpg",
    ]) {
      const res = await Effect.runPromise(
        executeAction(xImagesAction, { images: [badUrl] }, ctx).pipe(Effect.provide(layer)),
      );
      assert.equal(res.status, "failed", `Should refuse ${badUrl}`);
      assert.equal(res.images, undefined);
      assert.deepEqual(res.details?.cost, []);
    }
    assert.equal(seen.length, 0);
    assert.equal(kept.length, 0);
  });

  it("handles redirects, non-image responses, and oversized >4MB images cleanly", async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    const { layer } = makeLayers((url) => {
      if (url.pathname.includes("redirect")) {
        return new Response(null, { status: 302, headers: { location: "https://example.com/x.jpg" } });
      }
      if (url.pathname.includes("html")) {
        return new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.pathname.includes("huge")) {
        return new Response(big, { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
    });

    const { ctx } = makeCtx();
    const res = await Effect.runPromise(
      executeAction(
        xImagesAction,
        {
          images: [
            "https://pbs.twimg.com/media/redirect.jpg",
            PHOTO,
            "https://pbs.twimg.com/media/html.jpg",
            "https://pbs.twimg.com/media/huge.jpg",
          ],
        },
        ctx,
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(res.status, "partial");
    assert.deepEqual(res.images, [{ data: base64(JPEG), mimeType: "image/jpeg" }]);
    assert.match(res.text, /not shown: the host redirected it \(HTTP 302\)/);
    assert.match(res.text, /not shown: not a JPEG, PNG, WebP or GIF image/);
    assert.match(res.text, /not shown: larger than 4 MB/);
  });
});
