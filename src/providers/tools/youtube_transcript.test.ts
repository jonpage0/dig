import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { executeSource } from "../outcome.js"
import { transcript } from "./youtube_transcript.js"

const fetchBefore = globalThis.fetch, keyBefore = process.env.SCRAPECREATORS_API_KEY, stateBefore = process.env.DIG_STATE_DIR
let root: string | undefined
afterEach(() => { globalThis.fetch = fetchBefore; if (keyBefore === undefined) delete process.env.SCRAPECREATORS_API_KEY; else process.env.SCRAPECREATORS_API_KEY = keyBefore; if (stateBefore === undefined) delete process.env.DIG_STATE_DIR; else process.env.DIG_STATE_DIR = stateBefore; if (root) rmSync(root,{recursive:true,force:true}); root = undefined })
const ctx = {sessionID:"youtube-transcript-test",directory:"/tmp",worktree:"/tmp",abort:new AbortController().signal,keep(){}}

test("original-audio transcripts in two languages are saved apart, and the names that worked before are kept", async () => {
  process.env.SCRAPECREATORS_API_KEY = "fixture"; root = mkdtempSync(join(tmpdir(),"dig-transcript-names-")); process.env.DIG_STATE_DIR = root
  globalThis.fetch = (async input => { const language = new URL(String(input)).searchParams.get("language"); return Response.json({success:true,videoId:"abcdefghijk",language:language ?? "English",credits_charged:1,transcript:[{startMs:"1",endMs:"200",text:`Words in ${language ?? "default"}`}]}) }) as typeof fetch
  const file = async (args: Record<string, unknown>) => (await executeSource(transcript,{video:"abcdefghijk",...args},ctx)).details?.transcriptFile as string
  const french = await file({originalAudio:true,language:"fr"}), german = await file({originalAudio:true,language:"de"})
  assert.notEqual(french, german); assert.match(readFileSync(german,"utf8"),/Words in de/)
  assert.equal(basename(french), "abcdefghijk-scrapecreators-original-fr.md")
  assert.equal(basename(await file({originalAudio:true})), "abcdefghijk-scrapecreators-original.md")
  assert.equal(basename(await file({language:"fr"})), "abcdefghijk-scrapecreators-fr.md")
  assert.equal(basename(await file({})), "abcdefghijk-scrapecreators-auto.md")
})
