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
 * sends a descriptive User-Agent header. Uses optional `SEC_USER_AGENT` from Dig's keys.env or
 * environment when set, else a polite default. Never echoes `SEC_USER_AGENT` in output.
 */
import { Effect, Result, Schema } from "effect";
import { freeRequest, type FreeHttp } from "../../core/http.ts";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  type ActionContext,
  type ActionOutcome,
  type SourcePlugin,
} from "../../core/plugin.ts";
import { knownSecrets, redactText } from "../../core/secrets.ts";
import { VERSION } from "../../version.ts";

const EFTS_URL = "https://efts.sec.gov/LATEST/search-index";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const DATA_BASE = "https://data.sec.gov";
const ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data";

const DEFAULT_SEC_USER_AGENT = `DigResearch/${VERSION} (local research client; set SEC_USER_AGENT)`;
const TIMEOUT_MS = 45_000;

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;
const DEFAULT_COMPANY_LIMIT = 20;
const MAX_COMPANY_LIMIT = 50;
const DEFAULT_FACTS_LIMIT = 8;
const MAX_FACTS_LIMIT = 25;
const MAX_FACTS_CONCEPTS = 20;
const CONCEPT_LIST_PREVIEW = 50;

export function secUserAgent(): string {
  return process.env.SEC_USER_AGENT?.trim() || DEFAULT_SEC_USER_AGENT;
}

function secHeaders(): Record<string, string> {
  return {
    "User-Agent": secUserAgent(),
    Accept: "application/json",
  };
}

interface TickerEntry {
  readonly cik10: string;
  readonly cikNum: string;
  readonly ticker: string;
  readonly title: string;
}

let tickerCache: Map<string, TickerEntry> | null = null;

/** Clear the in-memory SEC ticker-to-CIK cache (used by tests). */
export function clearSecTickerCache(): void {
  tickerCache = null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse a numeric CIK (with or without leading zeros or `CIK` prefix) into padded 10-digit + integer strings. */
export function parseCik(value: string): { readonly cik10: string; readonly cikNum: string } | null {
  const match = /^(?:cik\s*)?0*(\d{1,10})$/i.exec(value.trim());
  if (!match) return null;
  const stripped = match[1].replace(/^0+/, "");
  if (!stripped || stripped.length > 10) return null;
  return { cik10: stripped.padStart(10, "0"), cikNum: stripped };
}

function parseIsoDate(value: unknown, field: string): string | { readonly error: string } {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return { error: `${field} must be YYYY-MM-DD.` };
  const [year, month, day] = match.slice(1).map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return { error: `${field} "${text}" is not a valid calendar date.` };
  }
  return text;
}

function normalizeForms(value: unknown): readonly string[] | undefined | { readonly error: string } {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return { error: "forms must be an array of SEC form strings (e.g. ['10-K', '10-Q'])." };
  }
  const clean = [...new Set(value.map((v) => v.trim().toUpperCase()).filter(Boolean))];
  return clean.length ? clean : undefined;
}

type SecFetchResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly cancelled: boolean; readonly status: number; readonly message: string };

function secFetchJson(
  url: string,
  label: string,
  ctx: Pick<ActionContext, "keep" | "signal">,
): Effect.Effect<SecFetchResult, never, FreeHttp> {
  return Effect.gen(function* () {
    const res = yield* Effect.result(
      freeRequest({
        url,
        method: "GET",
        headers: secHeaders(),
        timeoutMs: TIMEOUT_MS,
        signal: ctx.signal,
        label,
        keep: ctx.keep,
      }),
    );

    if (Result.isFailure(res)) {
      if (ctx.signal.aborted) {
        return { ok: false as const, cancelled: true, status: 0, message: "Research call cancelled" };
      }
      const msg = res.failure instanceof Error ? res.failure.message : String(res.failure);
      return {
        ok: false as const,
        cancelled: false,
        status: 0,
        message: redactText(`SEC EDGAR (${label}) request failed: ${msg}`, knownSecrets()),
      };
    }

    const { status, isJson, payload } = res.success;
    if (status < 200 || status >= 300) {
      const hint =
        status === 403 || status === 429
          ? " (set SEC_USER_AGENT='AppName contact@domain.com' in keys.env per SEC Fair Access policy)"
          : "";
      return {
        ok: false as const,
        cancelled: false,
        status,
        message: `SEC EDGAR (${label}) returned HTTP ${status}: request failed${hint}`,
      };
    }
    if (!isJson) {
      return {
        ok: false as const,
        cancelled: false,
        status,
        message: `SEC EDGAR (${label}) returned non-JSON content.`,
      };
    }
    return { ok: true as const, data: payload };
  });
}

type ResolveEntityResult =
  | {
      readonly ok: true;
      readonly entity: {
        readonly cik10: string;
        readonly cikNum: string;
        readonly ticker?: string;
        readonly title?: string;
      };
    }
  | { readonly ok: false; readonly cancelled: boolean; readonly message: string };

function loadTickerMap(
  ctx: Pick<ActionContext, "keep" | "signal">,
): Effect.Effect<
  | { readonly ok: true; readonly map: Map<string, TickerEntry> }
  | { readonly ok: false; readonly cancelled: boolean; readonly message: string },
  never,
  FreeHttp
> {
  return Effect.gen(function* () {
    if (tickerCache) return { ok: true as const, map: tickerCache };
    const res = yield* secFetchJson(TICKERS_URL, "company_tickers", ctx);
    if (!res.ok) return { ok: false as const, cancelled: res.cancelled, message: res.message };
    const record = asRecord(res.data);
    if (!record) {
      return {
        ok: false as const,
        cancelled: false,
        message: "SEC company_tickers.json returned an unexpected payload.",
      };
    }
    const map = new Map<string, TickerEntry>();
    for (const raw of Object.values(record)) {
      const item = asRecord(raw);
      if (!item) continue;
      const ticker = asString(item.ticker)?.toUpperCase();
      const cikRaw = item.cik_str !== undefined ? String(item.cik_str) : "";
      const parsed = parseCik(cikRaw);
      if (!ticker || !parsed) continue;
      map.set(ticker, {
        ...parsed,
        ticker,
        title: asString(item.title) ?? ticker,
      });
    }
    if (map.size === 0) {
      return {
        ok: false as const,
        cancelled: false,
        message: "SEC company_tickers.json contained no usable ticker mappings.",
      };
    }
    tickerCache = map;
    return { ok: true as const, map };
  });
}

function resolveEntity(
  input: string,
  ctx: Pick<ActionContext, "keep" | "signal">,
): Effect.Effect<ResolveEntityResult, never, FreeHttp> {
  return Effect.gen(function* () {
    const trimmed = input.trim();
    if (!trimmed) {
      return { ok: false as const, cancelled: false, message: "entity is required (ticker symbol or CIK)." };
    }
    const direct = parseCik(trimmed);
    if (direct) return { ok: true as const, entity: direct };

    const loaded = yield* loadTickerMap(ctx);
    if (!loaded.ok) return loaded;

    const upper = trimmed.toUpperCase();
    const found =
      loaded.map.get(upper) ??
      (upper.includes(".") ? loaded.map.get(upper.replaceAll(".", "-")) : undefined) ??
      (upper.includes("-") ? loaded.map.get(upper.replaceAll("-", ".")) : undefined);
    if (!found) {
      return {
        ok: false as const,
        cancelled: false,
        message: `Ticker "${trimmed}" was not found in SEC company_tickers.json. Supply a listed ticker or a numeric CIK.`,
      };
    }
    return { ok: true as const, entity: found };
  });
}

function archiveDocumentUrl(cikNum: string, accession: string, document?: string): string {
  const noDash = accession.replaceAll("-", "");
  const doc = document?.trim();
  if (doc) return `${ARCHIVES_BASE}/${cikNum}/${noDash}/${doc}`;
  return `${ARCHIVES_BASE}/${cikNum}/${noDash}/${accession}-index.htm`;
}

function secFail(operation: string, message: string, cancelled = false): ActionOutcome {
  if (cancelled) return outcome("cancelled", "Research call cancelled");
  return failed(`SEC ${operation} failed: ${redactText(message, knownSecrets())}`);
}

const SecSearchSchema = Schema.Struct({
  q: Schema.String.annotate({ description: "Full-text query (keywords or exact phrase)." }),
  forms: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Form types, e.g. ['10-K','10-Q','8-K']." }),
  ),
  entity: Schema.optionalKey(Schema.String.annotate({ description: "Filter by company name or CIK." })),
  startDate: Schema.optionalKey(Schema.String.annotate({ description: "Start filing date (YYYY-MM-DD)." })),
  endDate: Schema.optionalKey(Schema.String.annotate({ description: "End filing date (YYYY-MM-DD)." })),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_LIMIT })).annotate({
      description: "Max filings (default: 10, max: 25).",
    }),
  ),
});

export const secSearchAction = defineAction({
  name: "sec_search",
  description:
    "Full-text search across SEC EDGAR filings (since 2001) via efts.sec.gov. " +
    "Filter by form types (e.g. 10-K, 10-Q, 8-K, DEF 14A, S-1), company name or CIK, and filing date range. " +
    "Returns filing dates, form types, entities/CIKs, accession numbers, and direct sec.gov/Archives URLs. Free and keyless.",
  schema: SecSearchSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const q = typeof args.q === "string" ? args.q.trim() : "";
      if (!q) return failed("q is required for sec_search.");

      const forms = normalizeForms(args.forms);
      if (forms && "error" in forms) return failed(forms.error);

      const entity = typeof args.entity === "string" ? args.entity.trim() : "";
      let startDate: string | undefined;
      let endDate: string | undefined;
      if (args.startDate !== undefined) {
        const parsed = parseIsoDate(args.startDate, "startDate");
        if (typeof parsed !== "string") return failed(parsed.error);
        startDate = parsed;
      }
      if (args.endDate !== undefined) {
        const parsed = parseIsoDate(args.endDate, "endDate");
        if (typeof parsed !== "string") return failed(parsed.error);
        endDate = parsed;
      }
      if (startDate && endDate && startDate > endDate) {
        return failed("startDate must not be after endDate.");
      }

      let limit = DEFAULT_SEARCH_LIMIT;
      if (args.limit !== undefined) {
        if (
          typeof args.limit !== "number" ||
          !Number.isInteger(args.limit) ||
          args.limit < 1 ||
          args.limit > MAX_SEARCH_LIMIT
        ) {
          return failed(`limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}.`);
        }
        limit = args.limit;
      }

      const params = new URLSearchParams({ q, from: "0" });
      if (forms?.length) params.set("forms", forms.join(","));
      if (entity) {
        const cik = parseCik(entity);
        if (cik) params.set("ciks", cik.cik10);
        else params.set("entityName", entity);
      }
      if (startDate || endDate) {
        params.set("dateRange", "custom");
        params.set("startdt", startDate ?? "2001-01-01");
        params.set("enddt", endDate ?? new Date().toISOString().slice(0, 10));
      }

      const res = yield* secFetchJson(`${EFTS_URL}?${params.toString()}`, "efts search", ctx);
      if (!res.ok) return res.cancelled ? outcome("cancelled", "Research call cancelled") : failed(res.message);

      const root = asRecord(res.data);
      const hitsWrap = asRecord(root?.hits);
      const rawHits = hitsWrap?.hits;
      if (!Array.isArray(rawHits)) {
        return failed("SEC EDGAR search returned an unexpected payload: missing hits array.");
      }

      const totalObj = asRecord(hitsWrap?.total);
      const totalHits = asNumber(totalObj?.value) ?? rawHits.length;
      const relation = asString(totalObj?.relation);

      if (rawHits.length === 0) {
        const filters = [
          forms?.length ? `forms=${forms.join(",")}` : "",
          entity ? `entity="${entity}"` : "",
          startDate || endDate ? `dates=${startDate ?? "..."}..${endDate ?? "..."}` : "",
        ].filter(Boolean);
        return outcome(
          "empty",
          `No SEC EDGAR filings matched "${q}"${filters.length ? ` (${filters.join("; ")})` : ""}.`,
          { provider: "sec", totalHits: 0, returned: 0 },
        );
      }

      const shown = rawHits.slice(0, limit);
      const lines: string[] = [
        `SEC EDGAR search for "${q}" — ${totalHits.toLocaleString("en-US")}${relation === "gte" ? "+" : ""} matching document${totalHits === 1 ? "" : "s"} (showing ${shown.length}):`,
        "",
      ];

      for (let i = 0; i < shown.length; i++) {
        const hit = asRecord(shown[i]);
        const src = asRecord(hit?._source);
        const id = asString(hit?._id) ?? "";
        const colonIdx = id.indexOf(":");
        const idAdsh = colonIdx >= 0 ? id.slice(0, colonIdx) : id;
        const idFile = colonIdx >= 0 ? id.slice(colonIdx + 1) : "";

        const adsh = asString(src?.adsh) ?? idAdsh;
        const form =
          asString(src?.form) ??
          (Array.isArray(src?.root_forms) ? asString(src.root_forms[0]) : undefined) ??
          "Unknown form";
        const fileDate = asString(src?.file_date) ?? "unknown date";
        const periodEnding = asString(src?.period_ending);
        const fileDesc = asString(src?.file_description);
        const displayNames = Array.isArray(src?.display_names)
          ? src.display_names.filter((x): x is string => typeof x === "string")
          : [];
        const ciks = Array.isArray(src?.ciks) ? src.ciks.filter((x): x is string => typeof x === "string") : [];
        const cikParsed = ciks[0] ? parseCik(ciks[0]) : null;

        const entityLabel = displayNames[0] ?? (cikParsed ? `CIK ${cikParsed.cik10}` : "Unknown filer");
        const url = cikParsed && adsh ? archiveDocumentUrl(cikParsed.cikNum, adsh, idFile || undefined) : null;

        lines.push(`${i + 1}. **${form}** · ${fileDate} · ${entityLabel}`);
        const meta: string[] = [];
        if (cikParsed) meta.push(`CIK: ${cikParsed.cik10}`);
        if (adsh) meta.push(`Accession: ${adsh}`);
        if (periodEnding) meta.push(`Period ending: ${periodEnding}`);
        if (meta.length) lines.push(`   ${meta.join(" | ")}`);
        if (fileDesc) lines.push(`   Document: ${fileDesc}`);
        if (url) lines.push(`   URL: ${url}`);
        lines.push("");
      }

      return outcome("success", lines.join("\n").trim(), {
        provider: "sec",
        totalHits,
        ...(relation ? { relation } : {}),
        returned: shown.length,
      });
    }),
});

const SecCompanySchema = Schema.Struct({
  entity: Schema.String.annotate({ description: "Ticker symbol (e.g. AAPL) or CIK." }),
  forms: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Filter recent filings by form type." }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_COMPANY_LIMIT })).annotate({
      description: "Max filings (default: 20, max: 50).",
    }),
  ),
});

export const secCompanyAction = defineAction({
  name: "sec_company",
  description:
    "Look up a company by ticker or CIK and list its recent SEC EDGAR filings with metadata and direct document URLs. " +
    "Resolves tickers via SEC company_tickers.json (cached in memory) and reads data.sec.gov/submissions. " +
    "Filter by form types (e.g. 10-K, 10-Q, 8-K) and limit (default 20, max 50). Free and keyless.",
  schema: SecCompanySchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const entityInput = typeof args.entity === "string" ? args.entity.trim() : "";
      if (!entityInput) return failed("entity is required (ticker symbol or CIK).");

      const forms = normalizeForms(args.forms);
      if (forms && "error" in forms) return failed(forms.error);
      const formSet = forms ? new Set(forms) : null;

      let limit = DEFAULT_COMPANY_LIMIT;
      if (args.limit !== undefined) {
        if (
          typeof args.limit !== "number" ||
          !Number.isInteger(args.limit) ||
          args.limit < 1 ||
          args.limit > MAX_COMPANY_LIMIT
        ) {
          return failed(`limit must be an integer between 1 and ${MAX_COMPANY_LIMIT}.`);
        }
        limit = args.limit;
      }

      const resolvedRes = yield* resolveEntity(entityInput, ctx);
      if (!resolvedRes.ok) return secFail("company lookup", resolvedRes.message, resolvedRes.cancelled);
      const resolved = resolvedRes.entity;

      const res = yield* secFetchJson(
        `${DATA_BASE}/submissions/CIK${resolved.cik10}.json`,
        `submissions ${resolved.cik10}`,
        ctx,
      );
      if (!res.ok) {
        if (res.cancelled) return outcome("cancelled", "Research call cancelled");
        if (res.status === 404) {
          return outcome("empty", `No SEC submissions record found for CIK ${resolved.cik10}.`, {
            provider: "sec",
            cik: resolved.cik10,
          });
        }
        return failed(res.message);
      }

      const data = asRecord(res.data);
      if (!data) return failed("SEC submissions returned an unexpected payload.");

      const name = asString(data.name) ?? resolved.title ?? `CIK ${resolved.cik10}`;
      const tickers = Array.isArray(data.tickers)
        ? data.tickers.filter((t): t is string => typeof t === "string" && Boolean(t.trim()))
        : [];
      const exchanges = Array.isArray(data.exchanges)
        ? data.exchanges.filter((e): e is string => typeof e === "string" && Boolean(e.trim()))
        : [];
      const sic = asString(data.sic);
      const sicDesc = asString(data.sicDescription);
      const entityType = asString(data.entityType);
      const fiscalYearEnd = asString(data.fiscalYearEnd);
      const stateInc = asString(data.stateOfIncorporation);

      const filingsObj = asRecord(data.filings);
      const recent = asRecord(filingsObj?.recent);
      const olderFiles = Array.isArray(filingsObj?.files) ? filingsObj.files.length : 0;

      const accessions = Array.isArray(recent?.accessionNumber) ? recent.accessionNumber : [];
      const filingDates = Array.isArray(recent?.filingDate) ? recent.filingDate : [];
      const reportDates = Array.isArray(recent?.reportDate) ? recent.reportDate : [];
      const recentForms = Array.isArray(recent?.form) ? recent.form : [];
      const primaryDocs = Array.isArray(recent?.primaryDocument) ? recent.primaryDocument : [];
      const primaryDescs = Array.isArray(recent?.primaryDocDescription) ? recent.primaryDocDescription : [];
      const itemsArr = Array.isArray(recent?.items) ? recent.items : [];

      const rows: Array<{
        readonly form: string;
        readonly filingDate: string;
        readonly reportDate?: string;
        readonly accession: string;
        readonly description?: string;
        readonly items?: string;
        readonly url: string;
      }> = [];
      let totalMatching = 0;

      for (let i = 0; i < accessions.length; i++) {
        const accession = asString(accessions[i]);
        const form = asString(recentForms[i]);
        if (!accession || !form) continue;
        if (formSet && !formSet.has(form.toUpperCase())) continue;
        totalMatching += 1;
        if (rows.length >= limit) continue;
        const primaryDoc = asString(primaryDocs[i]);
        const rawItems = itemsArr[i];
        const itemsText = Array.isArray(rawItems)
          ? rawItems.filter((x): x is string => typeof x === "string" && Boolean(x.trim())).join(", ")
          : asString(rawItems);
        rows.push({
          form,
          filingDate: asString(filingDates[i]) ?? "unknown",
          reportDate: asString(reportDates[i]),
          accession,
          description: asString(primaryDescs[i]),
          items: itemsText || undefined,
          url: archiveDocumentUrl(resolved.cikNum, accession, primaryDoc),
        });
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
        ]
          .filter(Boolean)
          .join(" | "),
        "",
      ];

      const details: Record<string, unknown> = {
        provider: "sec",
        cik: resolved.cik10,
        name,
        tickers,
        returned: rows.length,
        totalMatchingRecent: totalMatching,
        olderArchiveFiles: olderFiles,
      };

      if (rows.length === 0) {
        return outcome(
          "empty",
          `${header.join("\n")}No recent filings matched${forms?.length ? ` forms ${forms.join(", ")}` : ""} in the company's recent submissions block (${accessions.length} recent filings inspected${olderFiles ? `; ${olderFiles} older archive file(s) not fetched` : ""}).`,
          details,
        );
      }

      const lines = [
        ...header,
        `Showing ${rows.length} of ${totalMatching} matching recent filing${totalMatching === 1 ? "" : "s"}${forms?.length ? ` (forms: ${forms.join(", ")})` : ""}${olderFiles ? ` (${olderFiles} older submission archive file(s) also exist on EDGAR)` : ""}:`,
        "",
      ];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const extra = [
          r.reportDate ? `Period: ${r.reportDate}` : null,
          r.items ? `Items: ${r.items}` : null,
          `Accession: ${r.accession}`,
        ]
          .filter(Boolean)
          .join(" | ");
        lines.push(`${i + 1}. **${r.form}** · Filed ${r.filingDate} · ${extra}`);
        if (r.description && r.description !== r.form) lines.push(`   ${r.description}`);
        lines.push(`   URL: ${r.url}`);
      }

      return outcome("success", lines.join("\n"), details);
    }),
});

interface FactPoint {
  readonly start?: string;
  readonly end: string;
  readonly val: number;
  readonly accn?: string;
  readonly fy?: number;
  readonly fp?: string;
  readonly form?: string;
  readonly filed?: string;
  readonly frame?: string;
}

function formatFactValue(val: number, unit: string): string {
  const formatted = val.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (unit === "USD") return `$${formatted}`;
  return `${formatted} ${unit}`;
}

function parseFactPoints(raw: unknown): FactPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: FactPoint[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const end = asString(rec.end);
    const val = asNumber(rec.val);
    if (!end || val === undefined) continue;
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
    });
  }
  return out;
}

/** Keep the most recently filed disclosure per distinct reporting period/form to avoid comparative duplicates crowding out recent periods. */
function latestPerPeriod(points: readonly FactPoint[]): FactPoint[] {
  const byPeriod = new Map<string, FactPoint>();
  for (const p of points) {
    const key = `${p.start ?? ""}|${p.end}|${p.form ?? ""}`;
    const prev = byPeriod.get(key);
    if (
      !prev ||
      (p.filed ?? "") > (prev.filed ?? "") ||
      ((p.filed ?? "") === (prev.filed ?? "") && (p.accn ?? "") > (prev.accn ?? ""))
    ) {
      byPeriod.set(key, p);
    }
  }
  return [...byPeriod.values()].sort(
    (a, b) =>
      b.end.localeCompare(a.end) ||
      (b.filed ?? "").localeCompare(a.filed ?? "") ||
      (b.start ?? "").localeCompare(a.start ?? ""),
  );
}

const SecFactsSchema = Schema.Struct({
  entity: Schema.String.annotate({ description: "Ticker symbol (e.g. AAPL) or CIK." }),
  concepts: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "XBRL concepts (e.g. Revenues, NetIncomeLoss, Assets); omit to list concepts.",
    }),
  ),
  taxonomy: Schema.optionalKey(Schema.String.annotate({ description: "Taxonomy namespace (default: us-gaap)." })),
  forms: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Filter facts by form type (e.g. ['10-K','10-Q'])." }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_FACTS_LIMIT })).annotate({
      description: "Recent periods per concept (default: 8, max: 25).",
    }),
  ),
});

export const secFactsAction = defineAction({
  name: "sec_facts",
  description:
    "Fetch structured XBRL company financials from SEC EDGAR (data.sec.gov/api/xbrl/companyfacts) by ticker or CIK. " +
    "Pass concept names (e.g. Revenues, NetIncomeLoss, Assets) to get recent reported periods, or omit concepts to list available concepts in the taxonomy (default us-gaap). " +
    "Filter by forms (e.g. 10-K, 10-Q) and periods per concept (default 8, max 25). Free and keyless.",
  schema: SecFactsSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
      const entityInput = typeof args.entity === "string" ? args.entity.trim() : "";
      if (!entityInput) return failed("entity is required (ticker symbol or CIK).");

      const taxonomy = typeof args.taxonomy === "string" && args.taxonomy.trim() ? args.taxonomy.trim() : "us-gaap";

      const forms = normalizeForms(args.forms);
      if (forms && "error" in forms) return failed(forms.error);
      const formSet = forms ? new Set(forms) : null;

      let concepts: string[] = [];
      if (args.concepts !== undefined) {
        if (!Array.isArray(args.concepts) || args.concepts.some((c: unknown) => typeof c !== "string")) {
          return failed("concepts must be an array of XBRL concept names.");
        }
        concepts = [...new Set(args.concepts.map((c) => c.trim()).filter(Boolean))];
        if (concepts.length > MAX_FACTS_CONCEPTS) {
          return failed(`concepts accepts at most ${MAX_FACTS_CONCEPTS} names per call.`);
        }
      }

      let limit = DEFAULT_FACTS_LIMIT;
      if (args.limit !== undefined) {
        if (
          typeof args.limit !== "number" ||
          !Number.isInteger(args.limit) ||
          args.limit < 1 ||
          args.limit > MAX_FACTS_LIMIT
        ) {
          return failed(`limit must be an integer between 1 and ${MAX_FACTS_LIMIT}.`);
        }
        limit = args.limit;
      }

      const resolvedRes = yield* resolveEntity(entityInput, ctx);
      if (!resolvedRes.ok) return secFail("facts lookup", resolvedRes.message, resolvedRes.cancelled);
      const resolved = resolvedRes.entity;

      const res = yield* secFetchJson(
        `${DATA_BASE}/api/xbrl/companyfacts/CIK${resolved.cik10}.json`,
        `companyfacts ${resolved.cik10}`,
        ctx,
      );
      if (!res.ok) {
        if (res.cancelled) return outcome("cancelled", "Research call cancelled");
        if (res.status === 404) {
          return outcome("empty", `No SEC XBRL companyfacts found for CIK ${resolved.cik10}.`, {
            provider: "sec",
            cik: resolved.cik10,
          });
        }
        return failed(res.message);
      }

      const data = asRecord(res.data);
      const factsRoot = asRecord(data?.facts);
      if (!data || !factsRoot) {
        return failed("SEC companyfacts returned an unexpected payload: missing facts object.");
      }

      const entityName = asString(data.entityName) ?? resolved.title ?? `CIK ${resolved.cik10}`;
      const taxonomies = Object.keys(factsRoot);
      const taxonomyObj = Object.hasOwn(factsRoot, taxonomy) ? asRecord(factsRoot[taxonomy]) : null;

      if (!taxonomyObj) {
        return outcome(
          "empty",
          `${entityName} (CIK ${resolved.cik10}) has no XBRL facts under taxonomy "${taxonomy}". Available taxonomies: ${taxonomies.length ? taxonomies.join(", ") : "none"}.`,
          { provider: "sec", cik: resolved.cik10, entityName, taxonomy, availableTaxonomies: taxonomies },
        );
      }

      const conceptEntries = Object.entries(taxonomyObj);

      if (concepts.length === 0) {
        const summaries = conceptEntries
          .map(([name, raw]) => {
            const rec = asRecord(raw);
            const unitsObj = asRecord(rec?.units);
            const unitNames = unitsObj ? Object.keys(unitsObj) : [];
            let latestEnd = "";
            let count = 0;
            if (unitsObj) {
              for (const list of Object.values(unitsObj)) {
                const pts = parseFactPoints(list);
                count += pts.length;
                for (const p of pts) if (p.end > latestEnd) latestEnd = p.end;
              }
            }
            return { name, label: asString(rec?.label), units: unitNames, latestEnd, count };
          })
          .sort((a, b) => b.latestEnd.localeCompare(a.latestEnd) || b.count - a.count || a.name.localeCompare(b.name));

        const shown = summaries.slice(0, CONCEPT_LIST_PREVIEW);
        const lines: string[] = [
          `# ${entityName} (CIK ${resolved.cik10}) — XBRL Concepts (${taxonomy})`,
          `Available taxonomies: ${taxonomies.join(", ")} | Total concepts in ${taxonomy}: ${summaries.length} (showing top ${shown.length} by recency & coverage).`,
          "Pass `concepts: [...]` to sec_facts to retrieve reported values.",
          "",
        ];
        for (const s of shown) {
          lines.push(
            `- **${s.name}**${s.label && s.label !== s.name ? ` — ${s.label}` : ""} (${s.units.join(", ") || "no units"}; latest ${s.latestEnd || "n/a"}; ${s.count} entries)`,
          );
        }
        return outcome("success", lines.join("\n"), {
          provider: "sec",
          cik: resolved.cik10,
          entityName,
          taxonomy,
          availableTaxonomies: taxonomies,
          totalConcepts: summaries.length,
        });
      }

      const lowerIndex = new Map<string, string>();
      for (const key of Object.keys(taxonomyObj)) lowerIndex.set(key.toLowerCase(), key);

      const lines: string[] = [
        `# ${entityName} (CIK ${resolved.cik10}) — XBRL Facts (${taxonomy})`,
        `Forms: ${forms?.length ? forms.join(", ") : "all"} | Periods per concept: up to ${limit}`,
        "",
      ];

      const matched: string[] = [];
      const missing: string[] = [];

      for (const requested of concepts) {
        const canonical = Object.hasOwn(taxonomyObj, requested)
          ? requested
          : lowerIndex.get(requested.toLowerCase());
        if (!canonical) {
          missing.push(requested);
          const needle = requested.toLowerCase();
          const suggestions = Object.keys(taxonomyObj)
            .filter((k) => k.toLowerCase().includes(needle))
            .slice(0, 5);
          lines.push(`## ${requested}`);
          lines.push(
            `Not found in taxonomy "${taxonomy}".` +
              (suggestions.length ? ` Similar concepts: ${suggestions.join(", ")}.` : ""),
          );
          lines.push("");
          continue;
        }

        const conceptRec = asRecord(taxonomyObj[canonical]);
        const label = asString(conceptRec?.label);
        const unitsObj = asRecord(conceptRec?.units);
        lines.push(`## ${canonical}${label && label !== canonical ? ` (${label})` : ""}`);

        if (!unitsObj || Object.keys(unitsObj).length === 0) {
          lines.push("No unit series reported.", "");
          continue;
        }

        let conceptHasData = false;
        for (const [unit, rawPoints] of Object.entries(unitsObj)) {
          let points = parseFactPoints(rawPoints);
          if (formSet) points = points.filter((p) => p.form && formSet.has(p.form.toUpperCase()));
          const deduped = latestPerPeriod(points);
          const slice = deduped.slice(0, limit);
          if (slice.length === 0) continue;
          conceptHasData = true;
          lines.push(
            `Unit: ${unit} (showing ${slice.length} of ${deduped.length} distinct period${deduped.length === 1 ? "" : "s"})`,
          );
          for (const p of slice) {
            const period = p.start ? `${p.start} to ${p.end}` : `as of ${p.end}`;
            const fiscal = p.fy !== undefined || p.fp ? `FY${p.fy ?? "?"}${p.fp ? ` ${p.fp}` : ""}` : "";
            const parts = [
              period,
              formatFactValue(p.val, unit),
              fiscal || null,
              p.form ?? null,
              p.filed ? `filed ${p.filed}` : null,
              p.accn ? `accn ${p.accn}` : null,
            ].filter(Boolean);
            lines.push(`- ${parts.join(" | ")}`);
          }
        }
        if (conceptHasData) {
          matched.push(canonical);
        } else {
          lines.push(`No facts matched${forms?.length ? ` forms ${forms.join(", ")}` : ""}.`);
        }
        lines.push("");
      }

      const details: Record<string, unknown> = {
        provider: "sec",
        cik: resolved.cik10,
        entityName,
        taxonomy,
        matchedConcepts: matched,
        missingConcepts: missing,
      };

      return outcome(matched.length === 0 ? "empty" : "success", lines.join("\n").trim(), details);
    }),
});

export const secSource: SourcePlugin = defineSource({
  id: "sec",
  group: "markets",
  label: "SEC EDGAR",
  description: "Public company filings and XBRL financial statements",
  env: ["SEC_USER_AGENT"],
  credential: "No API key required; optional SEC_USER_AGENT contact string per SEC fair-access policy",
  envSettings: [
    {
      name: "SEC_USER_AGENT",
      label: "SEC EDGAR User-Agent",
      purpose:
        "Descriptive User-Agent header (for example AppName contact@domain.com) per SEC EDGAR fair-access policy. Dig sends a polite default when unset.",
    },
  ],
  about:
    "Official U.S. SEC EDGAR filings and structured XBRL financial data: full-text filing search since 2001, company submission histories with direct sec.gov/Archives URLs, and structured companyfacts financial series.",
  providers: [{ name: "SEC EDGAR", url: "https://www.sec.gov/edgar" }],
  billing: "Free. No account or key.",
  actions: [secSearchAction, secCompanyAction, secFactsAction],
});

export default secSource;
