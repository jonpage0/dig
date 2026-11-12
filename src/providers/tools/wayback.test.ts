import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { Type } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { read, snapshots } from "./wayback.js"
import { executeSource } from "../outcome.js"
import { createSchemas } from "../schemas.js"
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const kept: { label: string; status: number | string; body: unknown }[] = []
const ctx = { sessionID: "test", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, keep(label: string, status: number | string, body: unknown) { kept.push({ label, status, body }) } }
const run = async (spec: typeof read, args: unknown) => { kept.length = 0; const out = await executeSource(spec, args, ctx); assert.deepEqual(out.details?.cost, [], "the archive is free"); return out }
/** Requests in order: each handler answers one URL and the test fails on any other. */
function serve(...steps: [RegExp, () => Response][]) {
  const seen: string[] = []
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input); seen.push(url)
    assert.equal(init?.redirect, "manual", "redirects are followed by hand"); assert.match(new Headers(init?.headers).get("user-agent") ?? "", /^dig\//)
    const step = steps.shift(); assert.ok(step, `unexpected request ${url}`); assert.match(url, step[0]); return step[1]()
  }) as typeof fetch
  return seen
}
const capture = (body: BodyInit, type: string, at: string, status = 200) => new Response(body, { status, headers: { "content-type": type, "memento-datetime": at } })
// Real archive responses, trimmed: the CDX server (example.com, 2010–2011), the availability API and id_ captures.
const HEADER = ["timestamp", "original", "mimetype", "statuscode", "length"]
const PAGE_ONE = [HEADER, ["20100102003410", "http://example.com/", "text/html", "200", "700"], ["20100603215612", "http://www.example.com/", "text/html", "200", "608"], ["20100730171721", "http://www.example.com/", "text/html", "200", "613"], [], ["eJxLzs_VSa1IzC3ISdXUVzAyMDQ0MDSyMDI2tTAwBgB_bweU"]]
const PAGE_TWO = [HEADER, ["20110129014121", "http://www.example.com/", "unk", "302", "340"]]
const AVAILABLE_2006 = { url: "example.com", archived_snapshots: { closest: { status: "200", available: true, url: "http://web.archive.org/web/20060101213916/http://example.com:80/", timestamp: "20060101213916" } }, timestamp: "20060101" }
const PAGE_2006 = `<HTML>\n<HEAD>\n  <TITLE>Example Web Page</TITLE>\n</HEAD> \n<body>  \n<p>You have reached this web page by typing &quot;example.com&quot;,\n&quot;example.net&quot;,\n  or &quot;example.org&quot; into your web browser.</p>\n<p>These domain names are reserved for use in documentation and are not available \n  for registration. See <a href="http://www.rfc-editor.org/rfc/rfc2606.txt">RFC \n  2606</a>, Section 3.</p>\n</BODY>\n</HTML>\n`
const AVAILABLE_2026 = { url: "example.com", archived_snapshots: { closest: { status: "200", available: true, url: "http://web.archive.org/web/20261111025926/https://example.com/", timestamp: "20261111025926" } } }
const PAGE_2026 = `<!doctype html><html lang=en><head><meta charset=utf-8><link rel=icon href=data:,><meta name=viewport content="width=device-width,initial-scale=1"><title>Example Domain</title><style>html{color-scheme:light dark;background:light-dark(#eee,#222)}body{font:16px/1.6 system-ui,sans-serif;max-width:26em;margin:auto;padding:25vh 2em 2em;text-align:center}</style></head><body><p>This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.</p><script src=/s.js></script></body></html>`
const AVAILABLE_PDF = { url: "arxiv.org/pdf/1706.03762", archived_snapshots: { closest: { status: "200", available: true, url: "http://web.archive.org/web/20240428071122/http://arxiv.org/pdf/1706.03762", timestamp: "20240428071122" } }, timestamp: "2019" }
const NOT_ARCHIVED = { url: "example.com/dig-no-such-page-7f3a9c", archived_snapshots: {} }
const CDX = /^https:\/\/web\.archive\.org\/cdx\/search\/cdx\?/, AVAILABLE = /^https:\/\/archive\.org\/wayback\/available\?/

test("the capture list shows each capture's time, status, type, size and address, and the key for the next page", async () => {
  const seen = serve([CDX, () => Response.json(PAGE_ONE)])
  const first = await run(snapshots, { url: "example.com", from: "2010", to: "2011", limit: 3 })
  // Another page is a continuation, not a shortfall.
  assert.equal(first.status, "success", first.text)
  const query = new URL(seen[0]).searchParams
  assert.deepEqual(Object.fromEntries(query), { url: "https://example.com/", output: "json", fl: "timestamp,original,mimetype,statuscode,length", limit: "3", showResumeKey: "true", from: "2010", to: "2011", collapse: "digest" })
  assert.match(first.text, /3 shown, oldest first/)
  assert.match(first.text, /^- 2010-01-02 00:34:10 UTC · HTTP 200 · text\/html · 700 B stored · https:\/\/web\.archive\.org\/web\/20100102003410\/http:\/\/example\.com\/$/m)
  assert.match(first.text, /resumeKey "eJxLzs_VSa1IzC3ISdXUVzAyMDQ0MDSyMDI2tTAwBgB_bweU"/)
  assert.equal(kept[0].label, "captures"); assert.deepEqual(kept[0].body, PAGE_ONE)
  const again = serve([CDX, () => Response.json(PAGE_TWO)])
  const last = await run(snapshots, { url: "example.com", from: "2010", to: "2011", limit: 3, resumeKey: "eJxLzs_VSa1IzC3ISdXUVzAyMDQ0MDSyMDI2tTAwBgB_bweU" })
  assert.equal(last.status, "success", last.text); assert.equal(new URL(again[0]).searchParams.get("resumeKey"), "eJxLzs_VSa1IzC3ISdXUVzAyMDQ0MDSyMDI2tTAwBgB_bweU")
  assert.match(last.text, /1 shown, oldest first, continuing an earlier list/); assert.match(last.text, /HTTP 302 · unk · 340 B stored/); assert.match(last.text, /No further captures\./); assert.doesNotMatch(last.text, /resumeKey "/)
})

test("every capture and a wider match are asked for as the CDX server names them", async () => {
  const seen = serve([CDX, () => Response.json(PAGE_TWO)])
  const out = await run(snapshots, { url: "https://example.com/blog/", match: "prefix", changesOnly: false })
  assert.equal(out.status, "success", out.text); assert.match(out.text, /These are all the captures\./); assert.match(out.text, /addresses under this prefix, every capture/)
  const query = new URL(seen[0]).searchParams
  assert.equal(query.get("matchType"), "prefix"); assert.equal(query.get("collapse"), null); assert.equal(query.get("limit"), "20")
})

test("a range with no capture is empty", async () => {
  serve([CDX, () => Response.json([])])
  const out = await run(snapshots, { url: "example.com", from: "1990", to: "1991-06" })
  assert.equal(out.status, "empty", out.text); assert.match(out.text, /no capture of https:\/\/example\.com\/ from 1990 to 1991-06/)
})

test("an HTML capture reads as its title and text: scripts and styles dropped, link text kept, references decoded", async () => {
  const seen = serve([AVAILABLE, () => Response.json(AVAILABLE_2006)], [/^https:\/\/web\.archive\.org\/web\/20060101213916id_\/http:\/\/example\.com:80\/$/, () => capture(PAGE_2006, "text/html; charset=UTF-8", "Sun, 01 Jan 2006 21:39:16 GMT")])
  const out = await run(read, { url: "http://example.com", date: "2006-01-01" })
  assert.equal(out.status, "success", out.text)
  assert.equal(new URL(seen[0]).searchParams.get("timestamp"), "20060101"); assert.equal(new URL(seen[0]).searchParams.get("url"), "http://example.com/")
  assert.match(out.text, /^# Example Web Page\n/)
  assert.match(out.text, /Captured 2006-01-01 21:39:16 UTC; text\/html\./); assert.match(out.text, /Asked for 2006-01-01: the capture falls within it\./)
  assert.match(out.text, /Capture: https:\/\/web\.archive\.org\/web\/20060101213916\/http:\/\/example\.com:80\/\nOriginal: http:\/\/example\.com:80\//)
  assert.match(out.text, /You have reached this web page by typing "example\.com", "example\.net", or "example\.org" into your web browser\.\n\nThese domain names .* See RFC 2606, Section 3\./)
  assert.doesNotMatch(out.text, /<|&quot;|rfc-editor/); assert.match(out.text, /, complete\./)
  assert.deepEqual(kept.map(k => k.label), ["availability", "capture 20060101213916"]); assert.equal(kept[1].body, PAGE_2006)
  serve([AVAILABLE, () => Response.json(AVAILABLE_2026)], [/20261111025926id_\/https:\/\/example\.com\/$/, () => capture(PAGE_2026, "text/html; charset=utf-8", "Wed, 11 Nov 2026 02:59:26 GMT")])
  const modern = await run(read, { url: "example.com" })
  assert.equal(modern.status, "success", modern.text); assert.match(modern.text, /^# Example Domain\n/); assert.doesNotMatch(modern.text, /Asked for/)
  assert.match(modern.text, /\n\nThis domain is for use in documentation examples without needing permission\. This is not a service; avoid relying on it for testing and monitoring purposes\.$/)
  assert.doesNotMatch(modern.text, /color-scheme|s\.js/)
})

test("a long capture pages by offset and says where to continue", async () => {
  const page = () => [[AVAILABLE, () => Response.json(AVAILABLE_2006)], [/id_\//, () => capture(PAGE_2006, "text/html; charset=UTF-8", "Sun, 01 Jan 2006 21:39:16 GMT")]] as [RegExp, () => Response][]
  serve(...page())
  const first = await run(read, { url: "example.com", date: "20060101213916", limit: 40 })
  assert.equal(first.status, "success", first.text); assert.match(first.text, /Asked for 20060101213916: this is that capture\./)
  assert.match(first.text, /Characters 0–40 of \d+\.\n\nYou have reached this web page by typing\n\nThe text continues: call wayback_read with url "https:\/\/example\.com\/", date "20060101213916" and offset 40\.$/)
  serve(...page())
  const rest = await run(read, { url: "example.com", date: "20060101213916", offset: 40 })
  assert.equal(rest.status, "success", rest.text); assert.match(rest.text, /Characters 40–\d+ of \d+, complete\.\n\n "example\.com"/); assert.doesNotMatch(rest.text, /continues/)
  serve(...page())
  assert.equal((await run(read, { url: "example.com", date: "20060101213916", offset: 100000 })).status, "failed")
})

test("the nearest capture far from the date asked for gives the distance in days; a capture that is not text is partial", async () => {
  serve([AVAILABLE, () => Response.json(AVAILABLE_PDF)], [/20240428071122id_\/http:\/\/arxiv\.org\/pdf\/1706\.03762$/, () => capture(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35]), "application/pdf", "Sun, 28 Apr 2024 07:11:22 GMT")])
  const out = await run(read, { url: "arxiv.org/pdf/1706.03762", date: "2019" })
  assert.equal(out.status, "partial", out.text)
  assert.match(out.text, /Captured 2024-04-28 07:11:22 UTC; application\/pdf\./); assert.match(out.text, /Asked for 2019: the nearest capture is 1,579 days after it\./)
  assert.match(out.text, /Capture: https:\/\/web\.archive\.org\/web\/20240428071122\/http:\/\/arxiv\.org\/pdf\/1706\.03762/)
  assert.match(out.text, /Dig reads only HTML and text captures/); assert.doesNotMatch(out.text, /%PDF/)
  assert.equal(kept[1].label, "capture 20240428071122"); assert.match(String(kept[1].body), /application\/pdf capture not retained/)
})

test("a page built by scripts is empty, and so is an address the archive holds no capture of", async () => {
  serve([AVAILABLE, () => Response.json(AVAILABLE_2026)], [/id_\//, () => capture(PAGE_2026.replace(/<p>.*<\/p>/, '<div id="app"></div>'), "text/html", "Wed, 11 Nov 2026 02:59:26 GMT")])
  const scripted = await run(read, { url: "example.com" })
  assert.equal(scripted.status, "empty", scripted.text); assert.match(scripted.text, /no readable text/); assert.match(scripted.text, /built by scripts/); assert.match(scripted.text, /^# Example Domain/)
  // The capture index confirms it: the newest capture that returned the page is asked for, and there is none.
  const seen = serve([AVAILABLE, () => Response.json(NOT_ARCHIVED)], [CDX, () => Response.json([])])
  const none = await run(read, { url: "example.com/dig-no-such-page-7f3a9c" })
  assert.equal(none.status, "empty", none.text); assert.match(none.text, /no capture of https:\/\/example\.com\/dig-no-such-page-7f3a9c/); assert.equal(seen.length, 2)
  assert.deepEqual(Object.fromEntries(new URL(seen[1]).searchParams), { url: "https://example.com/dig-no-such-page-7f3a9c", output: "json", fl: "timestamp,original", filter: "statuscode:200", limit: "-1" })
  assert.deepEqual(kept.map(k => k.label), ["availability", "capture index"])
})

test("an availability lookup that wrongly names no capture is corrected by the capture index; an index that cannot confirm is a failure, not an empty result", async () => {
  // Seen live: the availability lookup answered with no snapshots for a page the archive holds.
  const empty = { url: "https://example.com/", archived_snapshots: {}, timestamp: "20060101" }
  const seen = serve([AVAILABLE, () => Response.json(empty)], [CDX, () => Response.json([["timestamp", "original"], ["20060101213916", "http://example.com:80/"]])], [/\/web\/20060101213916id_\/http:\/\/example\.com:80\/$/, () => capture(PAGE_2006, "text/html", "Sun, 01 Jan 2006 21:39:16 GMT")])
  const out = await run(read, { url: "example.com", date: "2006-01-01" })
  assert.equal(out.status, "success", out.text); assert.match(out.text, /Captured 2006-01-01 21:39:16 UTC/)
  const index = new URL(seen[1]).searchParams
  assert.equal(index.get("closest"), "20060101"); assert.equal(index.get("sort"), "closest"); assert.equal(index.get("limit"), "1"); assert.equal(index.get("filter"), "statuscode:200")
  assert.deepEqual(kept.map(k => k.label), ["availability", "capture index", "capture 20060101213916"])
  serve([AVAILABLE, () => Response.json(empty)], [CDX, () => new Response("busy", { status: 503 })])
  const unsure = await run(read, { url: "example.com", date: "2006-01-01" })
  assert.equal(unsure.status, "failed", unsure.text); assert.match(unsure.text, /capture index, asked to confirm, returned HTTP 503\. This is not evidence that the archive holds no capture\./)
})

test("plain-text captures are returned as they are", async () => {
  serve([AVAILABLE, () => Response.json({ archived_snapshots: { closest: { status: "200", available: true, url: "http://web.archive.org/web/20100101000000/http://example.com/robots.txt", timestamp: "20100101000000" } } })], [/id_\//, () => capture("User-agent: *\nDisallow: <none> &amp;\n", "text/plain", "Fri, 01 Jan 2010 00:00:00 GMT")])
  const out = await run(read, { url: "example.com/robots.txt" })
  assert.equal(out.status, "success", out.text); assert.match(out.text, /^# http:\/\/example\.com\/robots\.txt\n/); assert.match(out.text, /\n\nUser-agent: \*\nDisallow: <none> &amp;\n$/)
})

test("a redirect within the archive is followed and read at its own time; a redirect to another host is refused", async () => {
  const available = { archived_snapshots: { closest: { status: "302", available: true, url: "http://web.archive.org/web/20110129014121/http://www.example.com/", timestamp: "20110129014121" } } }
  const seen = serve([AVAILABLE, () => Response.json(available)],
    [/20110129014121id_\/http:\/\/www\.example\.com\/$/, () => new Response(null, { status: 302, headers: { location: "https://web.archive.org/web/20110129014121id_/http://www.iana.org/domains/example/", "memento-datetime": "Sat, 29 Jan 2011 01:41:21 GMT" } })],
    [/20110129014121id_\/http:\/\/www\.iana\.org\/domains\/example\/$/, () => new Response(null, { status: 302, headers: { location: "/web/20110130000000id_/http://www.iana.org/domains/example/" } })],
    [/^https:\/\/web\.archive\.org\/web\/20110130000000id_\/http:\/\/www\.iana\.org\/domains\/example\/$/, () => capture("<title>IANA — Example domains</title><h1>Example Domains</h1><p>As described in RFC 2606.</p>", "text/html", "Sun, 30 Jan 2011 00:00:00 GMT")])
  const out = await run(read, { url: "www.example.com", date: "2011-01-29" })
  assert.equal(out.status, "success", out.text); assert.equal(seen.length, 4)
  assert.match(out.text, /^# IANA — Example domains\n/); assert.match(out.text, /Captured 2011-01-30 00:00:00 UTC/); assert.match(out.text, /Asked for 2011-01-29: the nearest capture is less than a day after it\./)
  assert.match(out.text, /Original: http:\/\/www\.iana\.org\/domains\/example\/\nThe archive redirected the capture of http:\/\/www\.example\.com\/ here\./)
  assert.deepEqual(kept.map(k => k.label), ["availability", "capture 20110129014121", "capture 20110129014121", "capture 20110130000000"])
  const refused = serve([AVAILABLE, () => Response.json(available)], [/id_\//, () => new Response(null, { status: 302, headers: { location: "https://www.iana.org/domains/example/" } })])
  const away = await run(read, { url: "www.example.com", date: "2011-01-29" })
  assert.equal(away.status, "failed", away.text); assert.match(away.text, /another host \(www\.iana\.org\)/); assert.equal(refused.length, 2)
})

test("a bad url or date is refused before any request", async () => {
  const seen = serve()
  for (const url of ["", "mailto:someone@example.com", "ftp://example.com/file", "javascript:alert(1)", "localhost", "https://user:pass@example.com/", "file:///etc/hosts"]) {
    assert.equal((await run(read, { url })).status, "failed", url); assert.equal((await run(snapshots, { url })).status, "failed", url)
  }
  for (const date of ["2019-13", "2019-02-30", "19", "2019/01/01", "20190230000000"]) assert.equal((await run(read, { url: "example.com", date })).status, "failed", date)
  for (const args of [{ from: "2012", to: "2011" }, { limit: 101 }, { match: "regex" }, { resumeKey: " " }]) assert.equal((await run(snapshots, { url: "example.com", ...args })).status, "failed", JSON.stringify(args))
  assert.deepEqual(seen, [])
  serve([CDX, () => Response.json(PAGE_TWO)])
  assert.equal((await run(snapshots, { url: "example.com:8080/page" })).status, "success")
})

test("a 503 from the archive is a failed call that states the status", async () => {
  const unavailable = () => new Response("<html><head><title>503 Service Temporarily Unavailable</title></head></html>", { status: 503, headers: { "content-type": "text/html" } })
  const seen = serve([CDX, unavailable])
  const list = await run(snapshots, { url: "example.com" })
  assert.equal(list.status, "failed"); assert.match(list.text, /HTTP 503/); assert.equal(seen.length, 1, "no retry"); assert.equal(kept[0].status, 503)
  serve([AVAILABLE, unavailable])
  const lookup = await run(read, { url: "example.com" })
  assert.equal(lookup.status, "failed"); assert.match(lookup.text, /availability lookup returned HTTP 503/)
  serve([AVAILABLE, () => Response.json(AVAILABLE_2006)], [/id_\//, unavailable])
  const page = await run(read, { url: "example.com" })
  assert.equal(page.status, "failed"); assert.match(page.text, /returned HTTP 503 for the capture/)
})

test("the schemas take the documented arguments and bounds", () => {
  const schemas = createSchemas(Type)
  assert.ok(Value.Check(schemas.wayback_snapshots, { url: "example.com", from: "2010", to: "2011-06-30", match: "domain", limit: 100, changesOnly: false, resumeKey: "k" }))
  for (const bad of [{ limit: 0 }, { limit: 101 }, { match: "regex" }, { from: 2010 }]) assert.ok(!Value.Check(schemas.wayback_snapshots, { url: "x", ...bad }), JSON.stringify(bad))
  assert.ok(Value.Check(schemas.wayback_read, { url: "example.com", date: "20060101213916", offset: 0, limit: 100000 }))
  for (const bad of [{ offset: -1 }, { limit: 100001 }, { limit: 0 }]) assert.ok(!Value.Check(schemas.wayback_read, { url: "x", ...bad }), JSON.stringify(bad))
})
