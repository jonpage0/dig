import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { read } from "./hackernews_read.js"
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const ctx = { sessionID: "test", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, keep() {} }
const comment = (id: number, children: any[] = []) => ({ id, author: "author", text: `<p>Text ${id}</p>`, children })
test("direct HN reads retain parent IDs and support complete continuation", async () => {
  let calls = 0
  globalThis.fetch = (async (url) => { calls++; assert.equal(String(url), "https://hn.algolia.com/api/v1/items/1"); return Response.json({ id: 1, title: "Story", children: [comment(2, [comment(3)]), comment(4)] }) }) as typeof fetch
  const first: any = await read.execute({ item: "https://news.ycombinator.com/item?id=1", limit: 1 }, ctx)
  assert.equal(first.status, "partial"); assert.match(first.text, /2 \(reply to 1\)/); assert.match(first.text, /offset=1/)
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
