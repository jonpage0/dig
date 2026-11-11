import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { Type } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { read } from "./hackernews_read.js"
import hackernews from "./hackernews.js"
import { executeSource } from "../outcome.js"
import { createSchemas } from "../schemas.js"
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const ctx = { sessionID: "test", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, keep() {} }
const comment = (id: number, children: any[] = []) => ({ id, author: "author", text: `<p>Text ${id}</p>`, children })
test("direct HN reads retain parent IDs and support complete continuation", async () => {
  let calls = 0
  globalThis.fetch = (async (url) => { calls++; assert.equal(String(url), "https://hn.algolia.com/api/v1/items/1"); return Response.json({ id: 1, title: "Story", children: [comment(2, [comment(3)]), comment(4)] }) }) as typeof fetch
  const first: any = await read.execute({ item: "https://news.ycombinator.com/item?id=1", limit: 1 }, ctx)
  // Another page of comments is a continuation, not a shortfall: success, with the next offset stated.
  assert.equal(first.status, "success"); assert.match(first.text, /2 \(reply to 1\)/); assert.match(first.text, /offset=1/)
  const rest: any = await read.execute({ item: "1", offset: 1, limit: 2 }, ctx)
  assert.equal(rest.status, "success"); assert.match(rest.text, /3 \(reply to 2\)/); assert.match(rest.text, /4 \(reply to 1\)/); assert.equal(calls, 2)
})
test("HN refuses other hosts and malformed identities before retrieval", async () => {
  globalThis.fetch = (async () => { throw new Error("must not fetch") }) as typeof fetch
  for (const item of ["https://example.com/item?id=1", "0", "1e5", "9007199254740993"]) assert.match(String(await read.execute({ item }, ctx)), /^ERROR:/)
})
test("a wrong HN item and malformed descendants cannot claim complete evidence", async () => {
  globalThis.fetch = (async () => Response.json({ id: 2, children: [] })) as typeof fetch
  assert.match(String(await read.execute({ item: "1" }, ctx)), /^ERROR:/)
  globalThis.fetch = (async () => Response.json({ id: 1, children: [{ id: "bad" }] })) as typeof fetch
  assert.equal((await read.execute({ item: "1" }, ctx) as any).status, "partial")
})
test("HN text keeps paragraphs and link targets and decodes an escaped entity once", async () => {
  globalThis.fetch = (async () => Response.json({ id: 1, title: "Story", children: [{ id: 2, author: "a", text: 'First sentence.<p>Second sentence. See <a href="https:&#x2F;&#x2F;example.com&#x2F;a&#x2F;long.html" rel="nofollow">https:&#x2F;&#x2F;example.com&#x2F;a&#x2F;lo...</a> and &amp;lt;b&amp;gt;', children: [] }] })) as typeof fetch
  const out: any = await read.execute({ item: "1" }, ctx)
  assert.ok(out.text.endsWith("First sentence.\nSecond sentence. See https://example.com/a/long.html and &lt;b&gt;"), out.text)
})
test("HN search ellipses only cut text, reports failed thread fetches as partial and states its points filter", async () => {
  const long = "word ".repeat(80), story = (id: string, story_text: string) => ({ objectID: id, title: `T${id}`, author: "a", points: 9, num_comments: 9, created_at: "2026-11-01T00:00:00Z", created_at_i: 1, story_text, _tags: ["story"] })
  let url = ""
  globalThis.fetch = (async (input: any) => { const u = String(input); if (u.includes("/search")) { url = u; return Response.json({ hits: [story("1", "Short.<p>Two &amp;amp; three"), story("2", long)], nbHits: 2 }) } if (u.endsWith("/items/1")) throw new Error("socket hang up"); return Response.json({ id: 2, children: [{ id: 3, author: "b", text: "<p>" + "x".repeat(260) + "</p>", children: [] }, { id: 4, author: "c", text: "<i>Fine</i> &amp; short", children: [] }] }) }) as typeof fetch
  const out = await executeSource(hackernews, { query: "sqlite" }, ctx)
  assert.equal(out.status, "partial", out.text); assert.match(out.text, /1 of 2 comment-tree fetches failed/); assert.match(out.text, /more than 2 points/); assert.match(url, /points%3E2|points>2/)
  assert.match(out.text, /Text: Short\. Two &amp; three\n/); assert.match(out.text, /Text: (word ){40}\.\.\./); assert.match(out.text, /c \(0 replies\): Fine & short\n|c \(0 replies\): Fine & short$/m); assert.match(out.text, /b \(0 replies\): x{250}\.\.\./)
  assert.match(hackernews.description, /more than 2 points/)
})
test("an all-type HN search sends no points filter, since comments carry no points, and says so", async () => {
  let url = ""
  globalThis.fetch = (async (input: any) => { url = String(input); return Response.json({ hits: [{ objectID: "9", author: "a", points: null, comment_text: "A comment.", story_title: "S", created_at: "2026-11-01T00:00:00Z", created_at_i: 1, _tags: ["comment"] }], nbHits: 1 }) }) as typeof fetch
  const out = await executeSource(hackernews, { query: "sqlite", type: "all" }, ctx)
  assert.equal(out.status, "success", out.text); assert.doesNotMatch(url, /points/); assert.match(url, /numericFilters=created_at_i(%3E|>)\d+&/)
  assert.match(out.text, /No points filter: comments carry no points, so items of every score are searched\./); assert.doesNotMatch(out.text, /more than 2 points/)
  assert.match(hackernews.description, /All-type searches apply no points filter/)
})
test("HN search takes whole-number limits from 1 to 50 and days from 1", () => {
  const schema = createSchemas(Type).hackernews
  assert.ok(Value.Check(schema, { query: "x", limit: 50, days: 1 })); for (const bad of [{ limit: 0 }, { limit: 2.5 }, { limit: 51 }, { days: -3 }, { days: 0 }]) assert.ok(!Value.Check(schema, { query: "x", ...bad }), JSON.stringify(bad))
})
