import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { FreeHttp, makeFreeClient, makePaidClient, PaidHttp } from "../../core/http.ts";
import {
  decodeActionArgs,
  executeAction,
  schemaToMcpJson,
  type ActionContext,
} from "../../core/plugin.ts";
import waybackSource, { waybackReadAction, waybackSnapshotsAction } from "./index.ts";

const HEADER = ["timestamp", "original", "mimetype", "statuscode", "length"];
const PAGE_ONE = [
  HEADER,
  ["20100102003410", "http://example.com/", "text/html", "200", "700"],
  ["20100603215612", "http://www.example.com/", "text/html", "200", "608"],
  ["20100730171721", "http://www.example.com/", "text/html", "200", "613"],
  [],
  ["eJxLzs_VSa1IzC3ISdXUVzAyMDQ0MDSyMDI2tTAwBgB_bweU"],
];
const PAGE_TWO = [
  HEADER,
  ["20110129014121", "http://www.example.com/", "unk", "302", "340"],
];
const AVAILABLE_2006 = {
  url: "example.com",
  archived_snapshots: {
    closest: {
      status: "200",
      available: true,
      url: "http://web.archive.org/web/20060101213916/http://example.com:80/",
      timestamp: "20060101213916",
    },
  },
  timestamp: "20060101",
};
const PAGE_2006 = `<HTML>\n<HEAD>\n  <TITLE>Example Web Page</TITLE>\n</HEAD> \n<body>  \n<p>You have reached this web page by typing &quot;example.com&quot;,\n&quot;example.net&quot;,\n  or &quot;example.org&quot; into your web browser.</p>\n<p>These domain names are reserved for use in documentation and are not available \n  for registration. See <a href="http://www.rfc-editor.org/rfc/rfc2606.txt">RFC \n  2606</a>, Section 3.</p>\n</BODY>\n</HTML>\n`;
const AVAILABLE_2026 = {
  url: "example.com",
  archived_snapshots: {
    closest: {
      status: "200",
      available: true,
      url: "http://web.archive.org/web/20261111025926/https://example.com/",
      timestamp: "20261111025926",
    },
  },
};
const PAGE_2026 = `<!doctype html><html lang=en><head><meta charset=utf-8><title>Example Domain</title><style>body{color:#222}</style></head><body><p>This domain is for use in documentation examples without needing permission.</p><script src=/s.js></script></body></html>`;
const AVAILABLE_PDF = {
  url: "arxiv.org/pdf/1706.03762",
  archived_snapshots: {
    closest: {
      status: "200",
      available: true,
      url: "http://web.archive.org/web/20240428071122/http://arxiv.org/pdf/1706.03762",
      timestamp: "20240428071122",
    },
  },
  timestamp: "2019",
};
const NOT_ARCHIVED = { url: "example.com/dig-no-such-page-7f3a9c", archived_snapshots: {} };
const CDX = /^https:\/\/web\.archive\.org\/cdx\/search\/cdx\?/;
const AVAILABLE = /^https:\/\/archive\.org\/wayback\/available\?/;

const capture = (body: BodyInit, type: string, at: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": type, "memento-datetime": at } });

function serve(
  steps: ReadonlyArray<readonly [RegExp, () => Response]>,
  options?: { readonly maxRedirects?: number },
) {
  const queue = [...steps];
  const seen: string[] = [];
  const base = HttpClient.make((req) =>
    Effect.sync(() => {
      seen.push(req.url);
      assert.match(req.headers["user-agent"] ?? "", /^dig\//);
      const step = queue.shift();
      assert.ok(step, `unexpected request ${req.url}`);
      assert.match(req.url, step[0]);
      return HttpClientResponse.fromWeb(req, step[1]());
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(PaidHttp, makePaidClient(base, { resolveDns: false })),
    Layer.succeed(
      FreeHttp,
      makeFreeClient(base, {
        resolveDns: false,
        retries: 0,
        ...(options?.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
      }),
    ),
  );
  return { seen, layer };
}

function makeCtx() {
  const kept: Array<{ readonly label: string; readonly status: number | string; readonly body: unknown }> = [];
  const ctx: ActionContext = {
    digId: "dig-wayback-test",
    project: "/tmp/wayback-test",
    signal: new AbortController().signal,
    keep(label, status, body) {
      kept.push({ label, status, body });
    },
    progress() {},
  };
  return { ctx, kept };
}

describe("wayback source plugin (Effect 4.1.5)", () => {
  it("exports plugin metadata and validates schemas", () => {
    assert.equal(waybackSource.id, "wayback");
    assert.equal(waybackSource.group, "web");
    assert.deepEqual(
      waybackSource.actions.map((a) => a.name),
      ["wayback_snapshots", "wayback_read"],
    );
    for (const action of waybackSource.actions) {
      assert.equal(schemaToMcpJson(action.schema, { compact: true }).type, "object");
    }
    assert.equal(
      decodeActionArgs(waybackSnapshotsAction, {
        url: "example.com",
        from: "2010",
        to: "2011-06-30",
        match: "domain",
        limit: 100,
        changesOnly: false,
        resumeKey: "k",
      }).ok,
      true,
    );
    assert.equal(decodeActionArgs(waybackSnapshotsAction, { url: "x", limit: 101 }).ok, false);
    assert.equal(
      decodeActionArgs(waybackReadAction, {
        url: "example.com",
        date: "20060101213916",
        offset: 0,
        limit: 100_000,
      }).ok,
      true,
    );
    assert.equal(decodeActionArgs(waybackReadAction, { url: "x", limit: 100_001 }).ok, false);
  });

  it("wayback_snapshots lists captures with resumeKey continuation and free billing", async () => {
    const firstMock = serve([[CDX, () => Response.json(PAGE_ONE)]]);
    const { ctx: ctx1, kept: kept1 } = makeCtx();
    const first = await Effect.runPromise(
      executeAction(
        waybackSnapshotsAction,
        { url: "example.com", from: "2010", to: "2011", limit: 3 },
        ctx1,
      ).pipe(Effect.provide(firstMock.layer)),
    );
    assert.equal(first.status, "success", first.text);
    assert.deepEqual(first.details?.cost, []);
    const query = new URL(firstMock.seen[0]!).searchParams;
    assert.deepEqual(Object.fromEntries(query), {
      url: "https://example.com/",
      output: "json",
      fl: "timestamp,original,mimetype,statuscode,length",
      limit: "3",
      showResumeKey: "true",
      from: "2010",
      to: "2011",
      collapse: "digest",
    });
    assert.match(first.text, /3 shown, oldest first/);
    assert.match(first.text, /resumeKey "eJxLzs_VSa1IzC3ISdXUVzAyMDQ0MDSyMDI2tTAwBgB_bweU"/);
    assert.equal(kept1[0]!.label, "captures");

    const secondMock = serve([[CDX, () => Response.json(PAGE_TWO)]]);
    const last = await Effect.runPromise(
      executeAction(
        waybackSnapshotsAction,
        {
          url: "example.com",
          from: "2010",
          to: "2011",
          limit: 3,
          resumeKey: "eJxLzs_VSa1IzC3ISdXUVzAyMDQ0MDSyMDI2tTAwBgB_bweU", // gitleaks:allow
        },
        makeCtx().ctx,
      ).pipe(Effect.provide(secondMock.layer)),
    );
    assert.equal(last.status, "success", last.text);
    assert.match(last.text, /No further captures\./);
  });

  it("wayback_read decodes HTML, strips scripts/styles, pages by offset, and skips binary PDFs as partial", async () => {
    const htmlMock = serve([
      [AVAILABLE, () => Response.json(AVAILABLE_2006)],
      [
        /^https:\/\/web\.archive\.org\/web\/20060101213916id_\/http:\/\/example\.com:80\/$/,
        () => capture(PAGE_2006, "text/html; charset=UTF-8", "Sun, 01 Jan 2006 21:39:16 GMT"),
      ],
    ]);
    const { ctx, kept } = makeCtx();
    const out = await Effect.runPromise(
      executeAction(waybackReadAction, { url: "http://example.com", date: "2006-01-01" }, ctx).pipe(
        Effect.provide(htmlMock.layer),
      ),
    );
    assert.equal(out.status, "success", out.text);
    assert.deepEqual(out.details?.cost, []);
    assert.match(out.text, /^# Example Web Page\n/);
    assert.match(out.text, /Captured 2006-01-01 21:39:16 UTC; text\/html\./);
    assert.match(out.text, /See RFC 2606, Section 3\./);
    assert.deepEqual(
      kept.map((k) => k.label),
      ["availability", "capture 20060101213916"],
    );

    const pagedMock = serve([
      [AVAILABLE, () => Response.json(AVAILABLE_2006)],
      [/id_\//, () => capture(PAGE_2006, "text/html; charset=UTF-8", "Sun, 01 Jan 2006 21:39:16 GMT")],
    ]);
    const page1 = await Effect.runPromise(
      executeAction(
        waybackReadAction,
        { url: "example.com", date: "20060101213916", limit: 40 },
        makeCtx().ctx,
      ).pipe(Effect.provide(pagedMock.layer)),
    );
    assert.equal(page1.status, "success");
    assert.match(page1.text, /Characters 0–40 of \d+\./);
    assert.match(page1.text, /offset 40/);

    const pdfMock = serve([
      [AVAILABLE, () => Response.json(AVAILABLE_PDF)],
      [
        /20240428071122id_\/http:\/\/arxiv\.org\/pdf\/1706\.03762$/,
        () => capture(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf", "Sun, 28 Apr 2024 07:11:22 GMT"),
      ],
    ]);
    const pdfOut = await Effect.runPromise(
      executeAction(waybackReadAction, { url: "arxiv.org/pdf/1706.03762", date: "2019" }, makeCtx().ctx).pipe(
        Effect.provide(pdfMock.layer),
      ),
    );
    assert.equal(pdfOut.status, "partial", pdfOut.text);
    assert.match(pdfOut.text, /1,579 days after it/);
    assert.match(pdfOut.text, /Dig reads only HTML and text captures/);
  });

  it("wayback_read confirms empty availability against CDX index and handles redirects safely", async () => {
    const confirmedEmpty = serve([
      [AVAILABLE, () => Response.json(NOT_ARCHIVED)],
      [CDX, () => Response.json([])],
    ]);
    const none = await Effect.runPromise(
      executeAction(waybackReadAction, { url: "example.com/dig-no-such-page-7f3a9c" }, makeCtx().ctx).pipe(
        Effect.provide(confirmedEmpty.layer),
      ),
    );
    assert.equal(none.status, "empty", none.text);

    const corrected = serve([
      [AVAILABLE, () => Response.json({ url: "https://example.com/", archived_snapshots: {} })],
      [CDX, () => Response.json([["timestamp", "original"], ["20261111025926", "https://example.com/"]])],
      [/20261111025926id_/, () => capture(PAGE_2026, "text/html", "Wed, 11 Nov 2026 02:59:26 GMT")],
    ]);
    const fixed = await Effect.runPromise(
      executeAction(waybackReadAction, { url: "example.com" }, makeCtx().ctx).pipe(
        Effect.provide(corrected.layer),
      ),
    );
    assert.equal(fixed.status, "success", fixed.text);
    assert.match(fixed.text, /# Example Domain/);

    // Manual redirect mode (maxRedirects: 0) refuses off-host redirect without contacting target
    const available302 = {
      archived_snapshots: {
        closest: {
          status: "302",
          available: true,
          url: "http://web.archive.org/web/20110129014121/http://www.example.com/",
          timestamp: "20110129014121",
        },
      },
    };
    const offHost = serve(
      [
        [AVAILABLE, () => Response.json(available302)],
        [/id_\//, () => new Response(null, { status: 302, headers: { location: "https://www.iana.org/domains/example/" } })],
      ],
      { maxRedirects: 0 },
    );
    const refused = await Effect.runPromise(
      executeAction(waybackReadAction, { url: "www.example.com", date: "2011-01-29" }, makeCtx().ctx).pipe(
        Effect.provide(offHost.layer),
      ),
    );
    assert.equal(refused.status, "failed", refused.text);
    assert.match(refused.text, /another host \(www\.iana\.org\)/);
    assert.equal(offHost.seen.length, 2);

    // Same-host redirect followed cleanly when FreeHttp follows redirects too
    const inArchive = serve([
      [AVAILABLE, () => Response.json(available302)],
      [
        /20110129014121id_\/http:\/\/www\.example\.com\/$/,
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://web.archive.org/web/20110130000000id_/http://www.iana.org/domains/example/" },
          }),
      ],
      [
        /20110130000000id_\/http:\/\/www\.iana\.org\/domains\/example\/$/,
        () => capture("<title>IANA</title><p>RFC 2606.</p>", "text/html", "Sun, 30 Jan 2011 00:00:00 GMT"),
      ],
    ]);
    const followed = await Effect.runPromise(
      executeAction(waybackReadAction, { url: "www.example.com", date: "2011-01-29" }, makeCtx().ctx).pipe(
        Effect.provide(inArchive.layer),
      ),
    );
    assert.equal(followed.status, "success", followed.text);
    assert.match(followed.text, /Captured 2011-01-30 00:00:00 UTC/);
    assert.match(followed.text, /The archive redirected the capture of http:\/\/www\.example\.com\/ here\./);
  });

  it("refuses malformed URLs and invalid dates before any request", async () => {
    const mock = serve([]);
    for (const url of ["", "ftp://example.com/file", "localhost", "https://user:pass@example.com/"]) {
      const out = await Effect.runPromise(
        executeAction(waybackReadAction, { url }, makeCtx().ctx).pipe(Effect.provide(mock.layer)),
      );
      assert.equal(out.status, "failed", url);
    }
    const badDate = await Effect.runPromise(
      executeAction(waybackReadAction, { url: "example.com", date: "2019-02-30" }, makeCtx().ctx).pipe(
        Effect.provide(mock.layer),
      ),
    );
    assert.equal(badDate.status, "failed");
    assert.equal(mock.seen.length, 0);
  });
});
