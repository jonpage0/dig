import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync, linkSync, rmSync, lstatSync, existsSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../runtime-config.js"
import { keptText } from "../http.js"
import { knownSecrets, redactText } from "../secrets.js"
import { outcome } from "../outcome.js"
import type { ToolSpec } from "../types.js"

/** Cached open-access files, metered separately from metadata search. */
export const content: ToolSpec = {
  description: "Retrieve an OpenAlex cached open-access PDF or Grobid TEI XML by W-prefixed work ID. Requires an existing OpenAlex API key. Saves a bounded file in the paper library; no overwrite. XML includes a bounded text preview. Per-request cost remains unknown unless reported by the provider.",
  async execute(args, ctx) {
    try {
      const workId = String(args.workId ?? "").replace(/^https:\/\/openalex.org\//, "")
      if (!/^W\d+$/.test(workId)) throw new Error("workId must be an OpenAlex W-prefixed ID")
      const format = args.format ?? "xml"
      if (!["pdf", "xml"].includes(format)) throw new Error("format must be pdf or xml")
      const key = process.env.PAPER_SEARCH_MCP_OPENALEX_API_KEY?.trim() || process.env.OPENALEX_API_KEY?.trim()
      if (!key) throw new Error("An OPENALEX_API_KEY is required for cached full text")
      const folder = join(loadConfig().library, "papers")
      mkdirSync(folder, {recursive:true})
      const file = join(folder, `openalex-${workId}.${format}`)
      if (existsSync(file) && !lstatSync(file).isFile()) throw new Error("The destination is not a regular paper file")
      const response = await fetch(`https://content.openalex.org/works/${workId}.${format === "pdf" ? "pdf" : "grobid-xml"}`, {headers:{Authorization:`Bearer ${key}`}, redirect:"error", signal:AbortSignal.any([ctx.abort,AbortSignal.timeout(60000)])})
      if (!response.ok) {await keptText(response,ctx.keep,`OpenAlex content ${workId}`); throw new Error(`OpenAlex content returned HTTP ${response.status}`)}
      if (!response.body) throw new Error("OpenAlex returned no content body")
      const reader=response.body.getReader(), chunks:Uint8Array[]=[]; let size=0
      try {while(true){const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>50*1024*1024){await reader.cancel();throw new Error("OpenAlex content exceeds 50 MiB")}; chunks.push(value)}}finally{reader.releaseLock()}
      const bytes=format==="xml"?Buffer.from(redactText(Buffer.concat(chunks).toString("utf8"),knownSecrets())):Buffer.concat(chunks), beginning=bytes.subarray(0,1000).toString("utf8").trimStart()
      if(format==="pdf" ? !beginning.startsWith("%PDF-") : !/<(?:\?xml|TEI\b|tei:TEI\b)/.test(beginning)) throw new Error("OpenAlex returned content in an unexpected format")
      const scratch=mkdtempSync(join(folder,".openalex-"));let existing=false
      try {const temp=join(scratch,"content");writeFileSync(temp,bytes,{flag:"wx",mode:0o600});try{linkSync(temp,file)}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;existing=true}}finally{rmSync(scratch,{recursive:true,force:true})}
      ctx.keep(`OpenAlex cached content ${workId}`,response.status,{workId,format,bytes:size,sha256:createHash("sha256").update(bytes).digest("hex"),file,existingFileKept:existing})
      const xml=format==="xml"&&!existing?bytes.toString("utf8"):""
      return outcome(xml.length>60000?"partial":"success",`OpenAlex cached ${format}: ${file}\n${existing?"Existing file preserved; newly fetched content was not substituted.":"File saved."}\nFetched ${size} bytes. Provider cost unknown. ${format==="xml"?"Grobid XML is machine extraction, not a verified transcription.":"PDF bytes validated by file signature; page contents not inspected."}${xml?`\n\n${xml.slice(0,60000)}${xml.length>60000?"\n[Preview truncated; complete file saved.]":""}`:""}`,{file})
    } catch(error){ctx.abort.throwIfAborted();return `ERROR: ${error instanceof Error?error.message:"OpenAlex content failed"}`}
  },
}
