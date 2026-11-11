import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Type } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { executeSource } from "../outcome.js"
import { createSchemas } from "../schemas.js"
import { tiktok_top, tiktok_comments, instagram_comments, threads } from "./social_evidence.js"
import { transcript } from "./youtube_transcript.js"
import polymarket from "./polymarket.js"
import { history, resolution } from "./polymarket_data.js"
import { content as openalexContent } from "./openalex_content.js"
import { snippets, relations } from "./paper_evidence.js"
import { semantic_scholar_search, openalex_search } from "./papers.js"

const fetchBefore = globalThis.fetch, keyBefore = process.env.SCRAPECREATORS_API_KEY, stateBefore = process.env.DIG_STATE_DIR, openalexKeyBefore = process.env.OPENALEX_API_KEY
let root: string | undefined
afterEach(() => { globalThis.fetch = fetchBefore; if (keyBefore === undefined) delete process.env.SCRAPECREATORS_API_KEY; else process.env.SCRAPECREATORS_API_KEY = keyBefore; if (stateBefore === undefined) delete process.env.DIG_STATE_DIR; else process.env.DIG_STATE_DIR = stateBefore; if (openalexKeyBefore === undefined) delete process.env.OPENALEX_API_KEY; else process.env.OPENALEX_API_KEY = openalexKeyBefore; if (root) rmSync(root, {recursive:true,force:true}); root = undefined })
const ctx = {sessionID:"new-retrieval-test",directory:"/tmp",worktree:"/tmp",abort:new AbortController().signal,keep(){}}
function response(body: unknown) { return Response.json(body) }
test("photo search preserves type, deduplicates, uses the documented parameters and reports real credits", async () => {
  process.env.SCRAPECREATORS_API_KEY = "fixture"
  globalThis.fetch = (async input => { const u = new URL(String(input)); assert.equal(u.pathname,"/v1/tiktok/search/top"); assert.equal(u.searchParams.get("publish_time"),"this-week"); return response({success:true, credits_charged:1, items:[{id:"1",content_type:"multi_photo",images:[{url:"https://example.com/photo"}]},{id:"1"}],cursor:20}) }) as typeof fetch
  const out = await executeSource(tiktok_top,{query:"robot",period:"this-week"},ctx)
  assert.equal(out.status,"success"); assert.match(out.text,/multi_photo/); assert.deepEqual(out.details?.cost,[{amount:1,unit:"credits"}]); assert.equal((JSON.parse(out.text.slice(out.text.indexOf("{"))) as any).items.length,1)
})
test("social empty arrays differ from malformed responses and paid replies are opt-in", async () => {
  process.env.SCRAPECREATORS_API_KEY = "fixture"
  let replies = ""
  globalThis.fetch = (async input => { replies = new URL(String(input)).searchParams.get("include_replies") ?? ""; return response({success:true,comments:[],credits_charged:1}) }) as typeof fetch
  assert.equal((await executeSource(instagram_comments,{url:"https://www.instagram.com/p/abc"},ctx)).status,"empty"); assert.equal(replies,"false")
  await executeSource(instagram_comments,{url:"https://www.instagram.com/p/abc",includeReplies:true},ctx); assert.equal(replies,"true")
  globalThis.fetch = (async () => response({success:true})) as typeof fetch
  assert.equal((await executeSource(tiktok_comments,{url:"https://www.tiktok.com/@example/video/123"},ctx)).status,"failed")
})
test("Threads only reports identifiable public post records", async () => {
  process.env.SCRAPECREATORS_API_KEY = "fixture"
  globalThis.fetch = (async () => response({success:true,post:{id:"1",caption:{text:"Evidence"}}})) as typeof fetch
  assert.equal((await executeSource(threads,{kind:"post",url:"https://www.threads.com/@example/post/abc"},ctx)).status,"success")
  assert.equal((await executeSource(threads,{kind:"post",url:"https://example.org/post"},ctx)).status,"failed")
  globalThis.fetch = (async () => response({success:true,post:{}})) as typeof fetch
  assert.equal((await executeSource(threads,{kind:"post",url:"https://www.threads.com/@example/post/abc"},ctx)).status,"failed")
})
test("hosted YouTube keeps timestamps and language and never overwrites an earlier transcript", async () => {
  process.env.SCRAPECREATORS_API_KEY = "fixture"; root = mkdtempSync(join(tmpdir(),"dig-hosted-transcript-")); process.env.DIG_STATE_DIR = root
  let value = "Original words"
  globalThis.fetch = (async input => { assert.equal(new URL(String(input)).searchParams.get("original_audio"),"true"); return response({success:true,videoId:"abcdefghijk",language:"English",credits_charged:1,transcript:[{startMs:"1",endMs:"200",text:value}]}) }) as typeof fetch
  const first = await executeSource(transcript,{video:"abcdefghijk",originalAudio:true},ctx)
  assert.equal(first.status,"success"); const path = first.details?.transcriptFile as string; assert.match(readFileSync(path,"utf8"),/\[1–200 ms\] Original words/)
  value = "Changed words"; await executeSource(transcript,{video:"abcdefghijk",originalAudio:true},ctx); assert.doesNotMatch(readFileSync(path,"utf8"),/Changed words/)
  globalThis.fetch = (async () => response({success:true,videoId:"abcdefghijk",transcript:null,credits_charged:0})) as typeof fetch
  const absent = await executeSource(transcript,{video:"abcdefghijk",language:"fr"},ctx); assert.equal(absent.status,"empty"); assert.deepEqual(absent.details?.cost,[])
})
test("Polymarket history preserves seconds, states its cursor on a page with more as success, and rejects mixed windows", async () => {
  let calls = 0
  globalThis.fetch = (async input => { calls++; const u = new URL(String(input)); assert.equal(u.searchParams.get("token_id"),"123"); return response({data:[{price:0.4,timestamp:1780000000,resolution_seconds:300}],pagination:{has_more:true,next_cursor:"next"}}) }) as typeof fetch
  const paged = await executeSource(history,{token_id:"123",interval:"1w"},ctx); assert.equal(paged.status,"success"); assert.match(paged.text,/^Pagination: has_more: true; next_cursor: next\n/)
  assert.equal((await executeSource(history,{token_id:"123",interval:"1w",start:1},ctx)).status,"failed"); assert.equal(calls,1)
  globalThis.fetch = (async () => response({data:[],pagination:{has_more:true}})) as typeof fetch
  assert.equal((await executeSource(history,{token_id:"123",interval:"1w"},ctx)).status,"failed")
})
test("Polymarket resolution treats estimates separately and validates selector identity", async () => {
  globalThis.fetch = (async () => response({data:[{status:"proposed",expected_settlement_time:"2026-10-20T12:00:00Z"}]})) as typeof fetch
  const out = await executeSource(resolution,{event_id:"123"},ctx); assert.equal(out.status,"success"); assert.match(out.text,/estimates, not deadlines/)
  assert.equal((await executeSource(resolution,{event_id:"123",question_id:"bad"},ctx)).status,"failed")
})
test("a Polymarket search names each shown market's condition and outcome token IDs, for the history and resolution reads", async () => {
  const market = (id: string, question: string, tokens: string) => ({id, conditionId:`0x${id.repeat(64)}`, clobTokenIds:tokens, question, outcomes:'["Yes","No"]', outcomePrices:'["0.4","0.6"]', active:true, closed:false})
  const single = market("a","Will it rain in Austin?",'["111","222"]'), field = [market("b","Will Ann win the race?",'["333","444"]'), market("c","Will Bo win the race?",'["555","666"]')]
  globalThis.fetch = (async () => response({events:[{id:"e1",title:"Will it rain in Austin?",slug:"rain",markets:[single]},{id:"e2",title:"Who wins the race?",slug:"race",markets:field}]})) as typeof fetch
  const out = await executeSource(polymarket,{query:"rain race"},ctx); assert.equal(out.status,"success",out.text)
  for (const m of [single, ...field]) { assert.ok(out.text.includes(`Condition ID: ${m.conditionId}`), out.text); assert.ok(out.text.includes(`Outcome token IDs (outcome order): ${m.clobTokenIds}`), out.text) }
})
test("a grouped Polymarket event labels each market's odds by Gamma's group title", async () => {
  const market = (id: string, question: string, groupItemTitle: string, yes: string) => ({id, question, groupItemTitle, outcomes:'["Yes","No"]', outcomePrices:JSON.stringify([yes,String(1-Number(yes))]), active:true, closed:false})
  const markets = [market("a","Will there be no change in Fed interest rates after the October meeting?","No change","0.855"), market("b","Will the Fed decrease interest rates by 25 bps after the October meeting?","25 bps decrease","0.145")]
  globalThis.fetch = (async () => response({events:[{id:"e1",title:"Fed decision in October?",slug:"fed",markets}]})) as typeof fetch
  const out = await executeSource(polymarket,{query:"Fed decision"},ctx); assert.equal(out.status,"success",out.text)
  assert.ok(out.text.includes("No change: 85.5%"), out.text); assert.ok(out.text.includes("25 bps decrease: 14.5%"), out.text); assert.doesNotMatch(out.text,/^\s+(there|the): /m)
})
test("scholarly passage and relationship reads preserve source context and paging", async () => {
  globalThis.fetch = (async input => { const u=new URL(String(input)); assert.match(u.pathname,/snippet\/search/); assert.equal(u.searchParams.get("paperIds"),"DOI:10.1/example"); return response({data:[{snippet:{text:"A supported claim",section:"Results"},paper:{corpusId:1}}]}) }) as typeof fetch
  assert.equal((await executeSource(snippets,{query:"evidence",paperIds:["DOI:10.1/example"]},ctx)).status,"success")
  globalThis.fetch = (async () => response({data:[{contexts:["Used as a baseline"],citingPaper:{paperId:"2"}}],next:10})) as typeof fetch
  assert.equal((await executeSource(relations,{paperId:"1",direction:"citations"},ctx)).status,"success")
})
test("citation sorting happens at Semantic Scholar and OpenAlex semantic mode is explicit", async () => {
  globalThis.fetch = (async input => { const u=new URL(String(input)); assert.equal(u.pathname,"/graph/v1/paper/search/bulk"); assert.equal(u.searchParams.get("sort"),"citationCount:desc"); return response({data:[{paperId:"1",title:"Most cited",citationCount:100}],token:"next"}) }) as typeof fetch
  const result=await executeSource(semantic_scholar_search,{query:"robot",sort:"citationCount"},ctx); assert.match(result.text,/by the provider across matching papers/); assert.doesNotMatch(result.text,/Next token|next\b/); assert.match(result.text,/first 1 of the provider's batch for this sort; no continuation is offered\. Reach more by narrowing the search/)
  globalThis.fetch = (async input => { const u=new URL(String(input)); assert.equal(u.searchParams.get("search.semantic"),"a descriptive question"); assert.equal(u.searchParams.has("search"),false); return response({results:[],meta:{cost_usd:0}}) }) as typeof fetch
  assert.equal((await executeSource(openalex_search,{query:"a descriptive question",mode:"semantic"},ctx)).status,"empty")
})

test("OpenAlex content saves bounded XML and rejects an HTML response as paper content", async () => {
  root=mkdtempSync(join(tmpdir(),"dig-openalex-content-"));process.env.DIG_STATE_DIR=root;process.env.OPENALEX_API_KEY="fixture"
  globalThis.fetch=(async (url, init) => {assert.match(String(url),/content\.openalex\.org\/works\/W1\.grobid-xml/);assert.ok(new Headers(init?.headers).get("Authorization"));return new Response('<?xml version="1.0"?><TEI><text>Evidence</text></TEI>')}) as typeof fetch
  const out=await executeSource(openalexContent,{workId:"W1",format:"xml"},ctx);assert.equal(out.status,"success");assert.match(readFileSync(out.details?.file as string,"utf8"),/Evidence/);assert.equal(out.details?.cost,null)
  globalThis.fetch=(async () => new Response('<html>Unavailable</html>')) as typeof fetch
  assert.equal((await executeSource(openalexContent,{workId:"W2",format:"pdf"},ctx)).status,"failed")
})

const pmMarket = (o: Record<string, unknown> = {}) => ({id:"m", question:"Will X happen?", outcomes:'["Yes","No"]', outcomePrices:'["0.4","0.6"]', active:true, closed:false, ...o})
test("a Polymarket search with nothing left to show is empty, and the header counts shown, matching and further events", async () => {
  globalThis.fetch = (async () => response({events:[{id:"e1",title:"X event",slug:"x",markets:[pmMarket({closed:true})]}],pagination:{hasMore:false}})) as typeof fetch
  assert.equal((await executeSource(polymarket,{query:"x"},ctx)).status,"empty")
  globalThis.fetch = (async () => response({events:Array.from({length:12},(_,i)=>({id:`e${i}`,title:`X event ${i}`,slug:`x${i}`,markets:[pmMarket()]})),pagination:{hasMore:true,totalResults:500}})) as typeof fetch
  const out = await executeSource(polymarket,{query:"x",limit:2},ctx); assert.equal(out.status,"success",out.text); assert.match(out.text,/2 of 12 matching open events shown; provider reports more: yes/)
})
test("a Polymarket search prints missing prices and volume as n/a and names the market, unit and rolling period of a movement", async () => {
  globalThis.fetch = (async () => response({events:[{id:"e1",title:"X event",slug:"x",markets:[pmMarket({outcomePrices:undefined,oneWeekPriceChange:-0.05})]}]})) as typeof fetch
  const out = await executeSource(polymarket,{query:"x"},ctx)
  assert.match(out.text,/Volume: n\/a/); assert.match(out.text,/Yes: n\/a \/ No: n\/a/); assert.doesNotMatch(out.text,/\$0 total|0\.0%/)
  assert.match(out.text,/Movement of "Will X happen\?": ↓ 5\.0 percentage points over the rolling 7 days/)
})
test("a failed Polymarket expansion keeps the main query's results, is listed, and makes the search partial", async () => {
  let inFlight = 0, most = 0
  globalThis.fetch = (async (input: any) => { const q = new URL(String(input)).searchParams.get("q"); inFlight++; most = Math.max(most, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--
    if (q === "bitcoin price") return response({events:[{id:"e1",title:"bitcoin price",slug:"b",markets:[pmMarket()]}]})
    if (q === "bitcoin") throw new Error("socket hang up")
    return new Response("busy",{status:503}) }) as typeof fetch
  const out = await executeSource(polymarket,{query:"bitcoin price"},ctx)
  assert.equal(out.status,"partial",out.text); assert.match(out.text,/\*\*bitcoin price\*\*/); assert.match(out.text,/"bitcoin" \(socket hang up\)/); assert.match(out.text,/"price" \(HTTP 503\)/); assert.equal(most,3)
})
test("Polymarket history puts its continuation on the first line and in details, however large the page", async () => {
  const rows = Array.from({length:1000},(_,i)=>({timestamp:1780000000+i*300,price:0.5123,resolution_seconds:300}))
  globalThis.fetch = (async () => response({data:rows,pagination:{has_more:true,next_cursor:"CURSOR_TOKEN_ABC"}})) as typeof fetch
  const out = await executeSource(history,{token_id:"123",interval:"1w",limit:1000},ctx)
  assert.match(out.text.split("\n")[0]!,/has_more: true; next_cursor: CURSOR_TOKEN_ABC/); assert.equal(out.details?.has_more,true); assert.equal(out.details?.next_cursor,"CURSOR_TOKEN_ABC"); assert.doesNotMatch(out.text,/\n  /)
})
test("Polymarket resolution trims spaces around comma-separated ids", async () => {
  let sent = ""
  globalThis.fetch = (async (input: any) => { sent = new URL(String(input)).searchParams.get("condition") ?? ""; return response({data:[{status:"resolved"}]}) }) as typeof fetch
  const a = `0x${"a".repeat(64)}`, b = `0x${"b".repeat(64)}`
  assert.equal((await executeSource(resolution,{condition:`${a}, ${b}`},ctx)).status,"success"); assert.equal(sent,`${a},${b}`)
})
test("Polymarket search takes whole-number limit and page from 1", () => {
  const schema = createSchemas(Type).polymarket
  assert.ok(Value.Check(schema,{query:"x",limit:2,page:1})); for (const bad of [{limit:-1},{limit:0},{page:1.5},{page:0}]) assert.ok(!Value.Check(schema,{query:"x",...bad}), JSON.stringify(bad))
})
