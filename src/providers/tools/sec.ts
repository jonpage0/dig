/**
 * SEC EDGAR filings search, company submissions, and XBRL financial facts.
 *
 * Free, official, keyless public APIs operated by the U.S. Securities and Exchange Commission:
 *   - Full-text search:  https://efts.sec.gov/LATEST/search-index
 *   - Ticker directory:  https://www.sec.gov/files/company_tickers.json (cached in memory)
 *   - Submissions:       https://data.sec.gov/submissions/CIK{10-digit}.json
 *   - XBRL companyfacts: https://data.sec.gov/api/xbrl/companyfacts/CIK{10-digit}.json
 *
 * Per SEC EDGAR Fair Access Policy (https://www.sec.gov/os/accessing-edgar-data), every request
 * must send a descriptive User-Agent header. Uses optional `SEC_USER_AGENT` from Dig's keys.env
 * or environment when set, else a polite project default. Never echoes `SEC_USER_AGENT` in output.
 */
import { keptJson, keptText } from "../http.js"
import { failed, free, outcome } from "../outcome.js"
import { knownSecrets, redactText } from "../secrets.js"
import type { ToolContext, ToolSpec } from "../types.js"

const EFTS_URL = "https://efts.sec.gov/LATEST/search-index"
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
const DATA_BASE = "https://data.sec.gov"
const ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data"

const DEFAULT_SEC_USER_AGENT = "DigResearch/1.0 (https://github.com/jonpage0/dig)"
const TIMEOUT_MS = 45_000

const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 25
const DEFAULT_COMPANY_LIMIT = 20
const MAX_COMPANY_LIMIT = 50
const DEFAULT_FACTS_LIMIT = 8
const MAX_FACTS_LIMIT = 25
const MAX_FACTS_CONCEPTS = 20
const CONCEPT_LIST_PREVIEW = 50

// ---------------------------------------------------------------------------
// SEC headers & ticker/CIK cache
// ---------------------------------------------------------------------------

export function secUserAgent(): string {
  return process.env.SEC_USER_AGENT?.trim() || DEFAULT_SEC_USER_AGENT
}

function secHeaders(): Record<string, string> {
  return {
    "User-Agent": secUserAgent(),
    Accept: "application/json",
  }
}

interface TickerEntry {
  cik10: string
  cikNum: string
  ticker: string
  title: string
}

let tickerCache: Map<string, TickerEntry> | null = null

/** Clear the in-memory SEC ticker-to-CIK cache (used by tests). */
export function clearSecTickerCache(): void {
  tickerCache = null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Parse a numeric CIK (with or without leading zeros or `CIK` prefix) into padded 10-digit + integer strings. */
export function parseCik(value: string): { cik10: string; cikNum: string } | null {
  const m = /^(?:cik\s*)?0*(\d{1,10})$/i.exec(value.trim())
  if (!m) return null
  const stripped = m[1].replace(/^0+/, "")
  if (!stripped || stripped.length > 10) return null
  return { cik10: stripped.padStart(10, "0"), cikNum: stripped }
}

function parseIsoDate(value: unknown, field: string): string | { error: string } {
  const text = typeof value === "string" ? value.trim() : ""
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) return { error: `${field} must be YYYY-MM-DD.` }
  const [y, mo, d] = m.slice(1).map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { error: `${field} "${text}" is not a valid calendar date.` }
  }
  return text
}

function normalizeForms(value: unknown): string[] | undefined | { error: string } {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return { error: "forms must be an array of SEC form strings (e.g. ['10-K', '10-Q'])." }
  }
  const clean = [...new Set(value.map((v) => v.trim().toUpperCase()).filter(Boolean))]
  return clean.length ? clean : undefined
}

async function secFetchJson(url: string, label: string, ctx: ToolContext): Promise<{ ok: true; data: unknown } | { ok: false; status: number; message: string }> {
  const response = await fetch(url, {
    headers: secHeaders(),
    signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(TIMEOUT_MS)]),
  })
  if (!response.ok) {
    await keptText(response, ctx.keep, label).catch(() => "")
    const hint = response.status === 403 || response.status === 429 ? " (set SEC_USER_AGENT='AppName contact@domain.com' in keys.env per SEC Fair Access policy)" : ""
    return { ok: false, status: response.status, message: `SEC EDGAR (${label}) returned HTTP ${response.status}: ${response.statusText || "request failed"}${hint}` }
  }
  const data = await keptJson(response, ctx.keep, label)
  ctx.abort.throwIfAborted()
  return { ok: true, data }
}

async function loadTickerMap(ctx: ToolContext): Promise<Map<string, TickerEntry>> {
  if (tickerCache) return tickerCache
  const res = await secFetchJson(TICKERS_URL, "company_tickers", ctx)
  if (!res.ok) throw new Error(res.message)
  const record = asRecord(res.data)
  if (!record) throw new Error("SEC company_tickers.json returned an unexpected payload.")
  const map = new Map<string, TickerEntry>()
  for (const raw of Object.values(record)) {
    const item = asRecord(raw)
    if (!item) continue
    const ticker = asString(item.ticker)?.toUpperCase()
    const cikRaw = item.cik_str !== undefined ? String(item.cik_str) : ""
    const parsed = parseCik(cikRaw)
    if (!ticker || !parsed) continue
    map.set(ticker, {
      ...parsed,
      ticker,
      title: asString(item.title) ?? ticker,
    })
  }
  if (map.size === 0) throw new Error("SEC company_tickers.json contained no usable ticker mappings.")
  tickerCache = map
  return map
}

async function resolveEntity(input: string, ctx: ToolContext): Promise<{ cik10: string; cikNum: string; ticker?: string; title?: string }> {
  const trimmed = input.trim()
  if (!trimmed) throw new Error("entity is required (ticker symbol or CIK).")
  const direct = parseCik(trimmed)
  if (direct) return direct

  const map = await loadTickerMap(ctx)
  const upper = trimmed.toUpperCase()
  const found =
    map.get(upper) ??
    (upper.includes(".") ? map.get(upper.replaceAll(".", "-")) : undefined) ??
    (upper.includes("-") ? map.get(upper.replaceAll("-", ".")) : undefined)
  if (!found) {
    throw new Error(`Ticker "${trimmed}" was not found in SEC company_tickers.json. Supply a listed ticker or a numeric CIK.`)
  }
  return found
}

function archiveDocumentUrl(cikNum: string, accession: string, document?: string): string {
  const noDash = accession.replaceAll("-", "")
  const doc = document?.trim()
  if (doc) return `${ARCHIVES_BASE}/${cikNum}/${noDash}/${doc}`
  return `${ARCHIVES_BASE}/${cikNum}/${noDash}/${accession}-index.htm`
}

function errorResult(operation: string, error: unknown, ctx: ToolContext): ReturnType<typeof failed> {
  ctx.abort.throwIfAborted()
  const message = error instanceof Error ? error.message : "Unknown error"
  return failed(`SEC ${operation} failed: ${redactText(message, knownSecrets())}`)
}

// ---------------------------------------------------------------------------
// sec_search — Full-text EDGAR filing search (efts.sec.gov)
// ---------------------------------------------------------------------------

export const search = free({
  description:
    "Full-text search across SEC EDGAR filings (since 2001) via efts.sec.gov. " +
    "Filter by form types (e.g. 10-K, 10-Q, 8-K, DEF 14A, S-1), company name or CIK, and filing date range. " +
    "Returns filing dates, form types, entities/CIKs, accession numbers, and direct sec.gov/Archives URLs. Free and keyless.",
  async execute(args, ctx: ToolContext) {
    ctx.abort.throwIfAborted()
    const q = typeof args.q === "string" ? args.q.trim() : ""
    if (!q) return failed("q is required for sec_search.")

    const forms = normalizeForms(args.forms)
    if (forms && "error" in forms) return failed(forms.error)

    const entity = typeof args.entity === "string" ? args.entity.trim() : ""
    let startDate: string | undefined
    let endDate: string | undefined
    if (args.startDate !== undefined) {
      const parsed = parseIsoDate(args.startDate, "startDate")
      if (typeof parsed !== "string") return failed(parsed.error)
      startDate = parsed
    }
    if (args.endDate !== undefined) {
      const parsed = parseIsoDate(args.endDate, "endDate")
      if (typeof parsed !== "string") return failed(parsed.error)
      endDate = parsed
    }
    if (startDate && endDate && startDate > endDate) {
      return failed("startDate must not be after endDate.")
    }

    let limit = DEFAULT_SEARCH_LIMIT
    if (args.limit !== undefined) {
      if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_SEARCH_LIMIT) {
        return failed(`limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}.`)
      }
      limit = args.limit
    }

    const params = new URLSearchParams({ q, from: "0" })
    if (forms?.length) params.set("forms", forms.join(","))
    if (entity) {
      const cik = parseCik(entity)
      if (cik) params.set("ciks", cik.cik10)
      else params.set("entityName", entity)
    }
    if (startDate || endDate) {
      params.set("dateRange", "custom")
      params.set("startdt", startDate ?? "2001-01-01")
      params.set("enddt", endDate ?? new Date().toISOString().slice(0, 10))
    }

    try {
      const res = await secFetchJson(`${EFTS_URL}?${params.toString()}`, "efts search", ctx)
      if (!res.ok) return failed(res.message)

      const root = asRecord(res.data)
      const hitsWrap = asRecord(root?.hits)
      const rawHits = hitsWrap?.hits
      if (!Array.isArray(rawHits)) {
        return failed("SEC EDGAR search returned an unexpected payload: missing hits array.")
      }

      const totalObj = asRecord(hitsWrap?.total)
      const totalHits = asNumber(totalObj?.value) ?? rawHits.length
      const relation = asString(totalObj?.relation)

      if (rawHits.length === 0) {
        const filters = [
          forms?.length ? `forms=${forms.join(",")}` : "",
          entity ? `entity="${entity}"` : "",
          startDate || endDate ? `dates=${startDate ?? "..."}..${endDate ?? "..."}` : "",
        ].filter(Boolean)
        return outcome(
          "empty",
          `No SEC EDGAR filings matched "${q}"${filters.length ? ` (${filters.join("; ")})` : ""}.`,
          { provider: "sec", totalHits: 0, returned: 0 },
        )
      }

      const shown = rawHits.slice(0, limit)
      const lines: string[] = [
        `SEC EDGAR search for "${q}" — ${totalHits.toLocaleString("en-US")}${relation === "gte" ? "+" : ""} matching document${totalHits === 1 ? "" : "s"} (showing ${shown.length}):`,
        "",
      ]

      for (let i = 0; i < shown.length; i++) {
        const hit = asRecord(shown[i])
        const src = asRecord(hit?._source)
        const id = asString(hit?._id) ?? ""
        const colonIdx = id.indexOf(":")
        const idAdsh = colonIdx >= 0 ? id.slice(0, colonIdx) : id
        const idFile = colonIdx >= 0 ? id.slice(colonIdx + 1) : ""

        const adsh = asString(src?.adsh) ?? idAdsh
        const form = asString(src?.form) ?? (Array.isArray(src?.root_forms) ? asString(src.root_forms[0]) : undefined) ?? "Unknown form"
        const fileDate = asString(src?.file_date) ?? "unknown date"
        const periodEnding = asString(src?.period_ending)
        const fileDesc = asString(src?.file_description)
        const displayNames = Array.isArray(src?.display_names) ? src.display_names.filter((x): x is string => typeof x === "string") : []
        const ciks = Array.isArray(src?.ciks) ? src.ciks.filter((x): x is string => typeof x === "string") : []
        const cikParsed = ciks[0] ? parseCik(ciks[0]) : null

        const entityLabel = displayNames[0] ?? (cikParsed ? `CIK ${cikParsed.cik10}` : "Unknown filer")
        const url = cikParsed && adsh ? archiveDocumentUrl(cikParsed.cikNum, adsh, idFile || undefined) : null

        lines.push(`${i + 1}. **${form}** · ${fileDate} · ${entityLabel}`)
        const meta: string[] = []
        if (cikParsed) meta.push(`CIK: ${cikParsed.cik10}`)
        if (adsh) meta.push(`Accession: ${adsh}`)
        if (periodEnding) meta.push(`Period ending: ${periodEnding}`)
        if (meta.length) lines.push(`   ${meta.join(" | ")}`)
        if (fileDesc) lines.push(`   Document: ${fileDesc}`)
        if (url) lines.push(`   URL: ${url}`)
        lines.push("")
      }

      return outcome("success", lines.join("\n").trim(), {
        provider: "sec",
        totalHits,
        ...(relation ? { relation } : {}),
        returned: shown.length,
      })
    } catch (error) {
      return errorResult("search", error, ctx)
    }
  },
} satisfies ToolSpec)

// ---------------------------------------------------------------------------
// sec_company — Company profile & recent filings (data.sec.gov/submissions)
// ---------------------------------------------------------------------------

export const company = free({
  description:
    "Look up a company by ticker or CIK and list its recent SEC EDGAR filings with metadata and direct document URLs. " +
    "Resolves tickers via SEC company_tickers.json (cached in memory) and reads data.sec.gov/submissions. " +
    "Filter by form types (e.g. 10-K, 10-Q, 8-K) and limit (default 20, max 50). Free and keyless.",
  async execute(args, ctx: ToolContext) {
    ctx.abort.throwIfAborted()
    const entityInput = typeof args.entity === "string" ? args.entity.trim() : ""
    if (!entityInput) return failed("entity is required (ticker symbol or CIK).")

    const forms = normalizeForms(args.forms)
    if (forms && "error" in forms) return failed(forms.error)
    const formSet = forms ? new Set(forms) : null

    let limit = DEFAULT_COMPANY_LIMIT
    if (args.limit !== undefined) {
      if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_COMPANY_LIMIT) {
        return failed(`limit must be an integer between 1 and ${MAX_COMPANY_LIMIT}.`)
      }
      limit = args.limit
    }

    try {
      const resolved = await resolveEntity(entityInput, ctx)
      const res = await secFetchJson(`${DATA_BASE}/submissions/CIK${resolved.cik10}.json`, `submissions ${resolved.cik10}`, ctx)
      if (!res.ok) {
        if (res.status === 404) return outcome("empty", `No SEC submissions record found for CIK ${resolved.cik10}.`, { provider: "sec", cik: resolved.cik10 })
        return failed(res.message)
      }

      const data = asRecord(res.data)
      if (!data) return failed("SEC submissions returned an unexpected payload.")

      const name = asString(data.name) ?? resolved.title ?? `CIK ${resolved.cik10}`
      const tickers = Array.isArray(data.tickers) ? data.tickers.filter((t): t is string => typeof t === "string" && !!t.trim()) : []
      const exchanges = Array.isArray(data.exchanges) ? data.exchanges.filter((e): e is string => typeof e === "string" && !!e.trim()) : []
      const sic = asString(data.sic)
      const sicDesc = asString(data.sicDescription)
      const entityType = asString(data.entityType)
      const fiscalYearEnd = asString(data.fiscalYearEnd)
      const stateInc = asString(data.stateOfIncorporation)

      const filingsObj = asRecord(data.filings)
      const recent = asRecord(filingsObj?.recent)
      const olderFiles = Array.isArray(filingsObj?.files) ? filingsObj.files.length : 0

      const accessions = Array.isArray(recent?.accessionNumber) ? recent.accessionNumber : []
      const filingDates = Array.isArray(recent?.filingDate) ? recent.filingDate : []
      const reportDates = Array.isArray(recent?.reportDate) ? recent.reportDate : []
      const recentForms = Array.isArray(recent?.form) ? recent.form : []
      const primaryDocs = Array.isArray(recent?.primaryDocument) ? recent.primaryDocument : []
      const primaryDescs = Array.isArray(recent?.primaryDocDescription) ? recent.primaryDocDescription : []
      const itemsArr = Array.isArray(recent?.items) ? recent.items : []

      const rows: {
        form: string
        filingDate: string
        reportDate?: string
        accession: string
        description?: string
        items?: string
        url: string
      }[] = []
      let totalMatching = 0

      for (let i = 0; i < accessions.length; i++) {
        const accession = asString(accessions[i])
        const form = asString(recentForms[i])
        if (!accession || !form) continue
        if (formSet && !formSet.has(form.toUpperCase())) continue
        totalMatching += 1
        if (rows.length >= limit) continue
        const primaryDoc = asString(primaryDocs[i])
        const rawItems = itemsArr[i]
        const itemsText = Array.isArray(rawItems)
          ? rawItems.filter((x): x is string => typeof x === "string" && !!x.trim()).join(", ")
          : asString(rawItems)
        rows.push({
          form,
          filingDate: asString(filingDates[i]) ?? "unknown",
          reportDate: asString(reportDates[i]),
          accession,
          description: asString(primaryDescs[i]),
          items: itemsText || undefined,
          url: archiveDocumentUrl(resolved.cikNum, accession, primaryDoc),
        })
      }

      const header: string[] = [
        `# ${name} (CIK ${resolved.cik10})`,
        [
          tickers.length ? `Tickers: ${tickers.join(", ")}` : null,
          exchanges.length ? `Exchanges: ${[...new Set(exchanges)].join(", ")}` : null,
          sic ? `SIC: ${sic}${sicDesc ? ` (${sicDesc})` : ""}` : null,
          entityType ? `Type: ${entityType}` : null,
          fiscalYearEnd ? `FY End: ${fiscalYearEnd}` : null,
          stateInc ? `State: ${stateInc}` : null,
        ].filter(Boolean).join(" | "),
        "",
      ]

      const details: Record<string, unknown> = {
        provider: "sec",
        cik: resolved.cik10,
        name,
        tickers,
        returned: rows.length,
        totalMatchingRecent: totalMatching,
        olderArchiveFiles: olderFiles,
      }

      if (rows.length === 0) {
        return outcome(
          "empty",
          `${header.join("\n")}No recent filings matched${forms?.length ? ` forms ${forms.join(", ")}` : ""} in the company's recent submissions block (${accessions.length} recent filings inspected${olderFiles ? `; ${olderFiles} older archive file(s) not fetched` : ""}).`,
          details,
        )
      }

      const lines = [
        ...header,
        `Showing ${rows.length} of ${totalMatching} matching recent filing${totalMatching === 1 ? "" : "s"}${forms?.length ? ` (forms: ${forms.join(", ")})` : ""}${olderFiles ? ` (${olderFiles} older submission archive file(s) also exist on EDGAR)` : ""}:`,
        "",
      ]
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        const extra = [
          r.reportDate ? `Period: ${r.reportDate}` : null,
          r.items ? `Items: ${r.items}` : null,
          `Accession: ${r.accession}`,
        ].filter(Boolean).join(" | ")
        lines.push(`${i + 1}. **${r.form}** · Filed ${r.filingDate} · ${extra}`)
        if (r.description && r.description !== r.form) lines.push(`   ${r.description}`)
        lines.push(`   URL: ${r.url}`)
      }

      return outcome("success", lines.join("\n"), details)
    } catch (error) {
      return errorResult("company lookup", error, ctx)
    }
  },
} satisfies ToolSpec)

// ---------------------------------------------------------------------------
// sec_facts — Structured XBRL company financials (data.sec.gov/api/xbrl)
// ---------------------------------------------------------------------------

interface FactPoint {
  start?: string
  end: string
  val: number
  accn?: string
  fy?: number
  fp?: string
  form?: string
  filed?: string
  frame?: string
}

function formatFactValue(val: number, unit: string): string {
  const formatted = val.toLocaleString("en-US", { maximumFractionDigits: 4 })
  if (unit === "USD") return `$${formatted}`
  return `${formatted} ${unit}`
}

function parseFactPoints(raw: unknown): FactPoint[] {
  if (!Array.isArray(raw)) return []
  const out: FactPoint[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    if (!rec) continue
    const end = asString(rec.end)
    const val = asNumber(rec.val)
    if (!end || val === undefined) continue
    out.push({
      start: asString(rec.start),
      end,
      val,
      accn: asString(rec.accn),
      fy: asNumber(rec.fy),
      fp: asString(rec.fp),
      form: asString(rec.form),
      filed: asString(rec.filed),
      frame: asString(rec.frame),
    })
  }
  return out
}

/** Keep the most recently filed disclosure per distinct reporting period/form to avoid comparative duplicates crowding out recent periods. */
function latestPerPeriod(points: FactPoint[]): FactPoint[] {
  const byPeriod = new Map<string, FactPoint>()
  for (const p of points) {
    // Key on the reported period + form (excluding filing fy/fp so comparative rows from later filings collapse cleanly).
    const key = `${p.start ?? ""}|${p.end}|${p.form ?? ""}`
    const prev = byPeriod.get(key)
    if (!prev || (p.filed ?? "") > (prev.filed ?? "") || ((p.filed ?? "") === (prev.filed ?? "") && (p.accn ?? "") > (prev.accn ?? ""))) {
      byPeriod.set(key, p)
    }
  }
  return [...byPeriod.values()].sort((a, b) =>
    b.end.localeCompare(a.end) ||
    (b.filed ?? "").localeCompare(a.filed ?? "") ||
    (b.start ?? "").localeCompare(a.start ?? ""),
  )
}

export const facts = free({
  description:
    "Fetch structured XBRL company financials from SEC EDGAR (data.sec.gov/api/xbrl/companyfacts) by ticker or CIK. " +
    "Pass concept names (e.g. Revenues, NetIncomeLoss, Assets) to get recent reported periods, or omit concepts to list available concepts in the taxonomy (default us-gaap). " +
    "Filter by forms (e.g. 10-K, 10-Q) and periods per concept (default 8, max 25). Free and keyless.",
  async execute(args, ctx: ToolContext) {
    ctx.abort.throwIfAborted()
    const entityInput = typeof args.entity === "string" ? args.entity.trim() : ""
    if (!entityInput) return failed("entity is required (ticker symbol or CIK).")

    const taxonomy = typeof args.taxonomy === "string" && args.taxonomy.trim() ? args.taxonomy.trim() : "us-gaap"

    const forms = normalizeForms(args.forms)
    if (forms && "error" in forms) return failed(forms.error)
    const formSet = forms ? new Set(forms) : null

    let concepts: string[] = []
    if (args.concepts !== undefined) {
      if (!Array.isArray(args.concepts) || args.concepts.some((c: unknown) => typeof c !== "string")) {
        return failed("concepts must be an array of XBRL concept names.")
      }
      concepts = [...new Set((args.concepts as string[]).map((c) => c.trim()).filter(Boolean))]
      if (concepts.length > MAX_FACTS_CONCEPTS) {
        return failed(`concepts accepts at most ${MAX_FACTS_CONCEPTS} names per call.`)
      }
    }

    let limit = DEFAULT_FACTS_LIMIT
    if (args.limit !== undefined) {
      if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_FACTS_LIMIT) {
        return failed(`limit must be an integer between 1 and ${MAX_FACTS_LIMIT}.`)
      }
      limit = args.limit
    }

    try {
      const resolved = await resolveEntity(entityInput, ctx)
      const res = await secFetchJson(`${DATA_BASE}/api/xbrl/companyfacts/CIK${resolved.cik10}.json`, `companyfacts ${resolved.cik10}`, ctx)
      if (!res.ok) {
        if (res.status === 404) return outcome("empty", `No SEC XBRL companyfacts found for CIK ${resolved.cik10}.`, { provider: "sec", cik: resolved.cik10 })
        return failed(res.message)
      }

      const data = asRecord(res.data)
      const factsRoot = asRecord(data?.facts)
      if (!data || !factsRoot) return failed("SEC companyfacts returned an unexpected payload: missing facts object.")

      const entityName = asString(data.entityName) ?? resolved.title ?? `CIK ${resolved.cik10}`
      const taxonomies = Object.keys(factsRoot)
      const taxonomyObj = Object.hasOwn(factsRoot, taxonomy) ? asRecord(factsRoot[taxonomy]) : null

      if (!taxonomyObj) {
        return outcome(
          "empty",
          `${entityName} (CIK ${resolved.cik10}) has no XBRL facts under taxonomy "${taxonomy}". Available taxonomies: ${taxonomies.length ? taxonomies.join(", ") : "none"}.`,
          { provider: "sec", cik: resolved.cik10, entityName, taxonomy, availableTaxonomies: taxonomies },
        )
      }

      const conceptEntries = Object.entries(taxonomyObj)

      // Discovery mode: omit concepts to list top available concept names
      if (concepts.length === 0) {
        const summaries = conceptEntries.map(([name, raw]) => {
          const rec = asRecord(raw)
          const unitsObj = asRecord(rec?.units)
          const unitNames = unitsObj ? Object.keys(unitsObj) : []
          let latestEnd = ""
          let count = 0
          if (unitsObj) {
            for (const list of Object.values(unitsObj)) {
              const pts = parseFactPoints(list)
              count += pts.length
              for (const p of pts) if (p.end > latestEnd) latestEnd = p.end
            }
          }
          return { name, label: asString(rec?.label), units: unitNames, latestEnd, count }
        }).sort((a, b) => b.latestEnd.localeCompare(a.latestEnd) || b.count - a.count || a.name.localeCompare(b.name))

        const shown = summaries.slice(0, CONCEPT_LIST_PREVIEW)
        const lines: string[] = [
          `# ${entityName} (CIK ${resolved.cik10}) — XBRL Concepts (${taxonomy})`,
          `Available taxonomies: ${taxonomies.join(", ")} | Total concepts in ${taxonomy}: ${summaries.length} (showing top ${shown.length} by recency & coverage).`,
          "Pass `concepts: [...]` to sec_facts to retrieve reported values.",
          "",
        ]
        for (const s of shown) {
          lines.push(`- **${s.name}**${s.label && s.label !== s.name ? ` — ${s.label}` : ""} (${s.units.join(", ") || "no units"}; latest ${s.latestEnd || "n/a"}; ${s.count} entries)`)
        }
        return outcome("success", lines.join("\n"), {
          provider: "sec",
          cik: resolved.cik10,
          entityName,
          taxonomy,
          availableTaxonomies: taxonomies,
          totalConcepts: summaries.length,
        })
      }

      // Specific concepts mode
      const lowerIndex = new Map<string, string>()
      for (const key of Object.keys(taxonomyObj)) lowerIndex.set(key.toLowerCase(), key)

      const lines: string[] = [
        `# ${entityName} (CIK ${resolved.cik10}) — XBRL Facts (${taxonomy})`,
        `Forms: ${forms?.length ? forms.join(", ") : "all"} | Periods per concept: up to ${limit}`,
        "",
      ]

      const matched: string[] = []
      const missing: string[] = []

      for (const requested of concepts) {
        const canonical = Object.hasOwn(taxonomyObj, requested) ? requested : lowerIndex.get(requested.toLowerCase())
        if (!canonical) {
          missing.push(requested)
          const needle = requested.toLowerCase()
          const suggestions = Object.keys(taxonomyObj)
            .filter((k) => k.toLowerCase().includes(needle))
            .slice(0, 5)
          lines.push(`## ${requested}`)
          lines.push(
            `Not found in taxonomy "${taxonomy}".` +
              (suggestions.length ? ` Similar concepts: ${suggestions.join(", ")}.` : ""),
          )
          lines.push("")
          continue
        }

        const conceptRec = asRecord(taxonomyObj[canonical])
        const label = asString(conceptRec?.label)
        const unitsObj = asRecord(conceptRec?.units)
        lines.push(`## ${canonical}${label && label !== canonical ? ` (${label})` : ""}`)

        if (!unitsObj || Object.keys(unitsObj).length === 0) {
          lines.push("No unit series reported.", "")
          continue
        }

        let conceptHasData = false
        for (const [unit, rawPoints] of Object.entries(unitsObj)) {
          let points = parseFactPoints(rawPoints)
          if (formSet) points = points.filter((p) => p.form && formSet.has(p.form.toUpperCase()))
          const deduped = latestPerPeriod(points)
          const slice = deduped.slice(0, limit)
          if (slice.length === 0) continue
          conceptHasData = true
          lines.push(`Unit: ${unit} (showing ${slice.length} of ${deduped.length} distinct period${deduped.length === 1 ? "" : "s"})`)
          for (const p of slice) {
            const period = p.start ? `${p.start} to ${p.end}` : `as of ${p.end}`
            const fiscal = p.fy !== undefined || p.fp ? `FY${p.fy ?? "?"}${p.fp ? ` ${p.fp}` : ""}` : ""
            const parts = [
              period,
              formatFactValue(p.val, unit),
              fiscal || null,
              p.form ?? null,
              p.filed ? `filed ${p.filed}` : null,
              p.accn ? `accn ${p.accn}` : null,
            ].filter(Boolean)
            lines.push(`- ${parts.join(" | ")}`)
          }
        }
        if (conceptHasData) {
          matched.push(canonical)
        } else {
          lines.push(`No facts matched${forms?.length ? ` forms ${forms.join(", ")}` : ""}.`)
        }
        lines.push("")
      }

      const details: Record<string, unknown> = {
        provider: "sec",
        cik: resolved.cik10,
        entityName,
        taxonomy,
        matchedConcepts: matched,
        missingConcepts: missing,
      }

      if (matched.length === 0) {
        return outcome("empty", lines.join("\n").trim(), details)
      }
      return outcome("success", lines.join("\n").trim(), details)
    } catch (error) {
      return errorResult("facts lookup", error, ctx)
    }
  },
} satisfies ToolSpec)
