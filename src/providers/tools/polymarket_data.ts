import { requestJson } from "../http.js"
import { free, outcome } from "../outcome.js"
import type { ToolContext, ToolSpec } from "../types.js"

async function read(path: string, params: Record<string, unknown>, ctx: ToolContext, history = false) {
  const url = new URL(`https://data-api.polymarket.com/v2/${path}`)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value))
  const response = await requestJson({ url, signal: ctx.abort, retries: 0, timeoutMs: 60000, provider: "Polymarket", keep: ctx.keep, label: path })
  const body = response.payload as any
  if (response.status !== 200 || !body || !Array.isArray(body.data) || body.error) throw new Error(`Polymarket ${path} returned an error or malformed data (HTTP ${response.status})`)
  if (history && (!body.pagination || typeof body.pagination.has_more !== "boolean")) throw new Error("Price history omitted its pagination contract")
  if (history && body.data.some((row: any) => !row || !Number.isFinite(row.price) || row.price < 0 || row.price > 1 || !Number.isSafeInteger(row.timestamp))) throw new Error("Price history returned an invalid price or epoch timestamp")
  if (!history && body.data.some((row: any) => !row || typeof row.status !== "string")) throw new Error("Resolution response omitted its status")
  if (history && body.pagination.has_more && (typeof body.pagination.next_cursor !== "string" || !body.pagination.next_cursor)) throw new Error("Price history claims more pages but provides no cursor")
  const json = JSON.stringify(body, null, 2), truncated = json.length > 60000
  return outcome(body.pagination?.has_more || truncated ? "partial" : body.data.length ? "success" : "empty", `${history ? "Prices are market observations in USDC per share; timestamps are epoch seconds. An empty requested resolution does not prove no trading occurred." : "Resolution status and payout evidence; expected settlement times are estimates, not deadlines."}\n${truncated ? "Output shortened; read the retained original.\n" : ""}${json.slice(0, 60000)}`)
}
function tool(description: string, action: ToolSpec["execute"]): ToolSpec {
  return free({ description, async execute(args, ctx) { try { return await action(args, ctx) } catch (error) { ctx.abort.throwIfAborted(); return `ERROR: ${error instanceof Error ? error.message : "Polymarket read failed"}` } } })
}
export const history = tool("Read one page of Polymarket outcome-token price history. Choose one window: interval, start/end epoch seconds, or as_of epoch seconds. Follow returned cursor using the same query. No trading or account access.", async (args, ctx) => {
  if (typeof args.token_id !== "string" || !/^\d+$/.test(args.token_id)) throw new Error("token_id must be an outcome token's decimal ID, not a market ID")
  const selectors = [args.interval !== undefined, args.start !== undefined || args.end !== undefined, args.as_of !== undefined].filter(Boolean).length
  if (selectors !== 1) throw new Error("Choose exactly one window: interval, start/end, or as_of")
  if (args.interval !== undefined && !["max", "all", "1m", "1w", "1d", "6h", "1h"].includes(args.interval)) throw new Error("Unsupported interval")
  for (const field of ["start", "end", "as_of"]) if (args[field] !== undefined && (!Number.isSafeInteger(args[field]) || args[field] < 0)) throw new Error(`${field} must be epoch seconds`)
  if (args.end !== undefined && (args.start === undefined || args.end <= args.start)) throw new Error("end must follow start")
  if (args.bucket_seconds !== undefined && (!Number.isInteger(args.bucket_seconds) || args.bucket_seconds < 60 || args.bucket_seconds > 86400)) throw new Error("bucket_seconds must be 60–86400")
  const limit = args.limit ?? 200
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be 1–1000")
  return read("prices-history", { token_id: args.token_id, interval: args.interval, start: args.start, end: args.end, as_of: args.as_of, bucket_seconds: args.bucket_seconds, limit, cursor: args.cursor }, ctx, true)
})
export const resolution = tool("Read current Polymarket resolution state by exactly one selector: condition IDs, Gamma event IDs, or one UMA question ID. Returns oracle state and published payouts; settlement estimates are not final outcomes.", async (args, ctx) => {
  const fields = ["condition", "event_id", "question_id"].filter(key => args[key] !== undefined)
  if (fields.length !== 1) throw new Error("Choose exactly one of condition, event_id or question_id")
  const field = fields[0], value = args[field]
  if (typeof value !== "string") throw new Error("The selector must be a string")
  const ids = [...new Set(value.split(","))]
  if (!ids.length || ids.length > (field === "question_id" ? 1 : 20) || ids.some(id => field === "event_id" ? !/^[1-9]\d*$/.test(id) : !/^0x[0-9a-f]{64}$/i.test(id))) throw new Error("Invalid selector IDs")
  return read("resolutions", { [field]: ids.join(",") }, ctx)
})
