import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { images } from "./x_images.js"
import { executeSource } from "../outcome.js"
import { providerTools } from "../index.js"
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const kept: { label: string; status: number | string; body: unknown }[] = []
const ctx = { sessionID: "test", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, keep(label: string, status: number | string, body: unknown) { kept.push({ label, status, body }) } }
const run = async (args: unknown) => { kept.length = 0; const out = await executeSource(images, args, ctx); assert.deepEqual(out.details?.cost, [], "X's image host makes no charge"); return out }
/** Requests in order: each handler answers one URL and the test fails on any other. */
function serve(...steps: [RegExp, () => Response][]) {
  const seen: string[] = []
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input); seen.push(url)
    assert.equal(init?.redirect, "manual", "no redirect is followed"); assert.match(new Headers(init?.headers).get("user-agent") ?? "", /^dig\//)
    const step = steps.shift(); assert.ok(step, `unexpected request ${url}`); assert.match(url, step[0]); return step[1]()
  }) as typeof fetch
  return seen
}
const PHOTO = "https://pbs.twimg.com/media/G6DbdA4bQAA85sr.jpg"
const PREVIEW = "https://pbs.twimg.com/amplify_video_thumb/1878043946418597888/img/JAfXUP3Fs2C-uFIF.jpg"
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]), PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const picture = (bytes: Uint8Array<ArrayBuffer>, type: string) => () => new Response(bytes, { headers: { "content-type": type, "content-length": String(bytes.byteLength) } })
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
const sized = (link: string, size: string) => new RegExp(`^${link.replaceAll(".", "\\.")}\\?name=${size}$`)

test("two pictures are shown in the order asked, each requested at X's size, with a note kept in place of its bytes and no charge", async () => {
  const seen = serve([sized(PHOTO, "large"), picture(JPEG, "image/jpeg")], [sized(PREVIEW, "large"), picture(PNG, "image/png")])
  const out = await run({ images: [PHOTO, PREVIEW], size: "large" })
  assert.equal(out.status, "success", out.text)
  assert.deepEqual(seen, [`${PHOTO}?name=large`, `${PREVIEW}?name=large`])
  assert.deepEqual(out.images, [{ data: base64(JPEG), mimeType: "image/jpeg" }, { data: base64(PNG), mimeType: "image/png" }])
  assert.match(out.text, /^Pictures from X's image host \(pbs\.twimg\.com\), size large: 2 of 2 shown, in the order asked\./)
  assert.match(out.text, new RegExp(`^1\\. ${PHOTO.replaceAll(".", "\\.")}\\?name=large · shown · image/jpeg · 9 bytes$`, "m"))
  assert.match(out.text, /^2\. \S+amplify_video_thumb\S+\?name=large · shown · image\/png · 8 bytes$/m)
  assert.match(out.text, /What you see is each picture as X serves it now\. What you say a picture shows is your own reading of it: label it as such in a report, and quote any text in the picture exactly\.$/)
  assert.deepEqual(kept, [
    { label: "image 1", status: 200, body: `[picture not retained] ${PHOTO}?name=large · image/jpeg · 9 bytes · shown` },
    { label: "image 2", status: 200, body: `[picture not retained] ${PREVIEW}?name=large · image/png · 8 bytes · shown` },
  ])
  assert.ok(!JSON.stringify(kept).includes(base64(JPEG)), "no picture data is kept")
  // Without size, a photo is asked for at medium, as X serves a link without one.
  serve([sized(PHOTO, "medium"), picture(JPEG, "image/jpeg")])
  assert.equal((await run({ images: [PHOTO] })).status, "success")
})

test("a link on another host, an http link, a link with a port or credentials, five links and an unknown size are refused before any request", async () => {
  serve()
  for (const [args, reason] of [
    [{ images: ["https://example.com/media/a.jpg"] }, /is on example\.com, not pbs\.twimg\.com/],
    [{ images: ["https://pbs.twimg.com.example.com/media/a.jpg"] }, /not pbs\.twimg\.com/],
    [{ images: ["http://pbs.twimg.com/media/a.jpg"] }, /is not https/],
    [{ images: ["https://pbs.twimg.com:8443/media/a.jpg"] }, /carries a port/],
    [{ images: ["https://user:pass@pbs.twimg.com/media/a.jpg"] }, /carries credentials/],
    [{ images: [PHOTO, PHOTO, PHOTO, PHOTO, PHOTO] }, /1 to 4 X image links.*; 5 were given/],
    [{ images: [] }, /; 0 were given/],
    [{ images: [PHOTO], size: "orig" }, /size must be small, medium, large .*"orig" is not one/],
  ] as const) {
    const out = await run(args)
    assert.equal(out.status, "failed", JSON.stringify(args))
    assert.match(out.text, /^ERROR: X images refused before any request: /)
    assert.match(out.text, reason)
    if (!/size/.test(String(reason))) assert.match(out.text, /as x_post, x_search_posts and the other X tools print them after "Media:"/)
    assert.equal(out.images, undefined); assert.deepEqual(kept, [])
  }
})

test("a redirect, a non-image response and an oversized picture are each not shown, with the reason: partial beside a shown picture, failed alone", async () => {
  const big = 4 * 1024 * 1024 + 1
  serve(
    [sized(PHOTO, "medium"), () => new Response(null, { status: 302, headers: { location: "https://example.com/elsewhere.jpg" } })],
    [sized(PREVIEW, "medium"), picture(JPEG, "image/jpeg")],
    [/name=medium$/, () => new Response("<html>not found</html>", { headers: { "content-type": "text/html; charset=utf-8" } })],
    [/name=medium$/, () => new Response(new Uint8Array(big), { headers: { "content-type": "image/jpeg" } })],
  )
  const out = await run({ images: [PHOTO, PREVIEW, "https://pbs.twimg.com/media/page.jpg", "https://pbs.twimg.com/media/huge.jpg"] })
  assert.equal(out.status, "partial", out.text)
  assert.match(out.text, /^Pictures from X's image host \(pbs\.twimg\.com\), size medium: 1 of 4 shown, in the order asked\./)
  assert.match(out.text, /^1\. \S+ · not shown: the host redirected it \(HTTP 302 to example\.com\), and Dig follows no redirect · no media type · size unknown$/m)
  assert.match(out.text, /^2\. \S+ · shown · image\/jpeg · 9 bytes$/m)
  assert.match(out.text, /^3\. \S+ · not shown: not a JPEG, PNG, WebP or GIF image · text\/html · size unknown$/m)
  assert.match(out.text, /^4\. \S+ · not shown: larger than 4 MB · image\/jpeg · size unknown$/m)
  assert.deepEqual(out.images, [{ data: base64(JPEG), mimeType: "image/jpeg" }])
  assert.deepEqual(kept.map(k => [k.label, k.status]), [["image 1", 302], ["image 2", 200], ["image 3", 200], ["image 4", 200]])
  assert.ok(kept.every(k => typeof k.body === "string" && k.body.startsWith("[picture not retained] https://pbs.twimg.com/")))
  // A declared size over the limit is refused without reading the body.
  serve([sized(PHOTO, "small"), () => new Response(new Uint8Array(8), { headers: { "content-type": "image/png", "content-length": String(big) } })])
  const alone = await run({ images: [PHOTO], size: "small" })
  assert.equal(alone.status, "failed", alone.text)
  assert.match(alone.text, /^ERROR: The picture asked for could not be shown \(X's image host, pbs\.twimg\.com, size small\)\./)
  assert.match(alone.text, new RegExp(`^1\\. \\S+ · not shown: larger than 4 MB · image/png · ${big.toLocaleString("en-US")} bytes$`, "m"))
  assert.equal(alone.images, undefined)
  assert.equal(kept.length, 1)
})

test("x_images is the only provider tool that returns pictures", () => {
  assert.deepEqual(Object.entries(providerTools).filter(([, spec]) => (spec as { returnsImages?: boolean }).returnsImages !== undefined).map(([name]) => name), ["x_images"])
})
