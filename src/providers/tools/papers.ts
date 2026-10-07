/**
 * Papers research tools.
 *
 * Direct REST-backed scholarly search across two complementary providers:
 *   - Semantic Scholar: better TLDRs, citation signals, related-work recommendations
 *   - OpenAlex: broader work coverage, open-access links, topic/institution metadata
 *
 * Tool names exported from this file:
 *   - papers_semantic_scholar_search
 *   - papers_semantic_scholar_recommendations
 *   - papers_openalex_search
 *
 * Environment variables:
 *   - SEMANTIC_SCHOLAR_API_KEY (optional; anonymous access is a shared throttled pool)
 *   - OPENALEX_API_KEY (optional; increases the free daily metered budget)
 *   - PAPER_SEARCH_MCP_<name> aliases are accepted for both keys
 */
import { keptJson, keptText } from "../http.js"
import { free, metered, outcome } from "../outcome.js"
import type { ToolSpec } from "../types.js"

/**
 * An amount OpenAlex reports for one request, `meta.cost_usd` in USD or
 * `X-RateLimit-Credits-Used` in OpenAlex credits: finite and nonnegative, else null.
 */
export function openAlexAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

/** OpenAlex documents every 4xx/5xx response as costing nothing. */
export function openAlexNoCharge(status: unknown): boolean {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
}

/** A response's own `meta.cost_usd`; zero for a documented no-charge 4xx/5xx; otherwise unknown, never free. */
function openAlexCharge(body: unknown, status: number | string): number | null {
  const meta = body && typeof body === "object" ? (body as { meta?: { cost_usd?: unknown } }).meta : undefined
  const cost = openAlexAmount(meta?.cost_usd)
  if (meta?.cost_usd !== undefined && meta.cost_usd !== null) return cost
  return openAlexNoCharge(status) ? 0 : null
}

const SEMANTIC_SCHOLAR_GRAPH_BASE = "https://api.semanticscholar.org/graph/v1"
const SEMANTIC_SCHOLAR_RECOMMENDATIONS_BASE = "https://api.semanticscholar.org/recommendations/v1"
const OPENALEX_BASE = "https://api.openalex.org"
const DEFAULT_USER_AGENT = "opencode-papers-tool/1.0"

const SEMANTIC_SCHOLAR_FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "publicationDate",
  "url",
  "venue",
  "citationCount",
  "influentialCitationCount",
  "authors.name",
  "externalIds",
  "openAccessPdf",
  "fieldsOfStudy",
  "s2FieldsOfStudy",
  "publicationTypes",
  "tldr",
].join(",")

type SemanticScholarAuthor = {
  authorId?: string
  name?: string
}

type SemanticScholarPaper = {
  paperId?: string
  title?: string
  abstract?: string
  year?: number
  publicationDate?: string
  url?: string
  venue?: string
  citationCount?: number
  influentialCitationCount?: number
  authors?: SemanticScholarAuthor[]
  externalIds?: Record<string, string | undefined>
  openAccessPdf?: {
    url?: string
    status?: string
  }
  fieldsOfStudy?: string[]
  s2FieldsOfStudy?: Array<{ category?: string; source?: string }>
  publicationTypes?: string[]
  tldr?: { text?: string }
}

type SemanticScholarSearchResponse = {
  total?: number
  offset?: number
  next?: number
  data?: SemanticScholarPaper[]
}

type SemanticScholarRecommendationsResponse = {
  recommendedPapers?: SemanticScholarPaper[]
}

type OpenAlexInstitution = {
  id?: string
  display_name?: string
}

type OpenAlexAuthorship = {
  author?: {
    id?: string
    display_name?: string
  }
  institutions?: OpenAlexInstitution[]
}

type OpenAlexLocation = {
  landing_page_url?: string
  pdf_url?: string
  source?: {
    display_name?: string
    id?: string
  }
}

type OpenAlexTopic = {
  id?: string
  display_name?: string
  score?: number
}

type OpenAlexWork = {
  id?: string
  display_name?: string
  publication_year?: number
  publication_date?: string
  cited_by_count?: number
  type?: string
  doi?: string
  ids?: Record<string, string | undefined>
  authorships?: OpenAlexAuthorship[]
  best_oa_location?: OpenAlexLocation | null
  primary_location?: OpenAlexLocation | null
  open_access?: {
    is_oa?: boolean
    oa_url?: string
    any_repository_has_fulltext?: boolean
  }
  primary_topic?: OpenAlexTopic | null
  topics?: OpenAlexTopic[]
  abstract_inverted_index?: Record<string, number[]>
}

type OpenAlexSearchResponse = {
  meta?: {
    count?: number
    page?: number
    per_page?: number
    cost_usd?: number
  }
  results?: OpenAlexWork[]
}

function providerKey(name: string): string | undefined {
  return process.env[`PAPER_SEARCH_MCP_${name}`]?.trim() || process.env[name]?.trim() || undefined
}

function semanticScholarHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": DEFAULT_USER_AGENT,
  }

  const apiKey = providerKey("SEMANTIC_SCHOLAR_API_KEY")
  if (apiKey) {
    headers["x-api-key"] = apiKey
  }

  return headers
}

function openAlexHeaders(): Record<string, string> {
  const apiKey = providerKey("OPENALEX_API_KEY")
  return {
    Accept: "application/json",
    "User-Agent": DEFAULT_USER_AGENT,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}

function truncateText(value: string | undefined, maxLength: number): string | null {
  if (!value) {
    return null
  }

  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return null
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

function formatAuthors(authors: Array<{ name?: string } | undefined> | undefined, max = 6): string | null {
  if (!authors?.length) {
    return null
  }

  const names = authors.map((author) => author?.name?.trim()).filter((name): name is string => Boolean(name))
  if (names.length === 0) {
    return null
  }

  const visible = names.slice(0, max)
  return names.length > max ? `${visible.join(", ")} +${names.length - max} more` : visible.join(", ")
}

function formatSemanticScholarFields(paper: SemanticScholarPaper): string | null {
  const fields = new Set<string>()

  for (const field of paper.fieldsOfStudy ?? []) {
    if (field?.trim()) {
      fields.add(field.trim())
    }
  }

  for (const field of paper.s2FieldsOfStudy ?? []) {
    if (field.category?.trim()) {
      fields.add(field.category.trim())
    }
  }

  const values = Array.from(fields)
  return values.length > 0 ? values.slice(0, 5).join(", ") : null
}

function normalizePaperDate(year?: number, publicationDate?: string): string | null {
  if (publicationDate?.trim()) {
    return publicationDate.trim()
  }

  return typeof year === "number" ? String(year) : null
}

function toDoiUrl(doi: string | undefined): string | null {
  if (!doi?.trim()) {
    return null
  }

  const normalized = doi.trim()
  return normalized.startsWith("http://") || normalized.startsWith("https://")
    ? normalized
    : `https://doi.org/${normalized.replace(/^doi:/i, "")}`
}

function formatSemanticScholarExternalIds(externalIds?: Record<string, string | undefined>): string[] {
  if (!externalIds) {
    return []
  }

  const lines: string[] = []
  const doiUrl = toDoiUrl(externalIds.DOI)
  if (doiUrl) {
    lines.push(`DOI: ${doiUrl}`)
  }

  if (externalIds.ArXiv) {
    lines.push(`ArXiv: https://arxiv.org/abs/${externalIds.ArXiv}`)
  }

  if (externalIds.PMID) {
    lines.push(`PMID: ${externalIds.PMID}`)
  }

  return lines
}

function sortSemanticScholarPapers(
  papers: SemanticScholarPaper[],
  sort: "relevance" | "citationCount" | "publicationDate"
): SemanticScholarPaper[] {
  if (sort === "relevance") {
    return papers
  }

  return [...papers].sort((left, right) => {
    if (sort === "citationCount") {
      return (right.citationCount ?? 0) - (left.citationCount ?? 0)
    }

    const rightDate = normalizePaperDate(right.year, right.publicationDate) ?? ""
    const leftDate = normalizePaperDate(left.year, left.publicationDate) ?? ""
    return rightDate.localeCompare(leftDate)
  })
}

function formatSemanticScholarPapers(
  papers: SemanticScholarPaper[],
  header: string
): string {
  const formatted = papers.map((paper) => {
    const lines: string[] = []
    const title = paper.title?.trim() || "(untitled paper)"
    const paperId = paper.paperId?.trim() || "unknown"
    const date = normalizePaperDate(paper.year, paper.publicationDate)
    const authors = formatAuthors(paper.authors)
    const tldr = truncateText(paper.tldr?.text, 240)
    const abstract = truncateText(paper.abstract, 320)
    const fields = formatSemanticScholarFields(paper)
    const externalIds = formatSemanticScholarExternalIds(paper.externalIds)

    lines.push(`**${title}**`)
    lines.push(
      [
        `Paper ID: ${paperId}`,
        date ? `Published: ${date}` : null,
        paper.citationCount !== undefined ? `Citations: ${paper.citationCount}` : null,
        paper.influentialCitationCount !== undefined
          ? `Influential citations: ${paper.influentialCitationCount}`
          : null,
      ]
        .filter(Boolean)
        .join(" | ")
    )

    if (authors) {
      lines.push(`  Authors: ${authors}`)
    }

    if (paper.venue?.trim()) {
      lines.push(`  Venue: ${paper.venue.trim()}`)
    }

    if (paper.publicationTypes?.length) {
      lines.push(`  Type: ${paper.publicationTypes.slice(0, 3).join(", ")}`)
    }

    if (fields) {
      lines.push(`  Fields: ${fields}`)
    }

    if (tldr) {
      lines.push(`  TLDR: ${tldr}`)
    }

    if (abstract) {
      lines.push(`  Abstract: ${abstract}`)
    }

    for (const externalIdLine of externalIds) {
      lines.push(`  ${externalIdLine}`)
    }

    if (paper.openAccessPdf?.url) {
      lines.push(`  Open access PDF: ${paper.openAccessPdf.url}`)
    }

    if (paper.url) {
      lines.push(`  Semantic Scholar: ${paper.url}`)
    }

    return lines.join("\n")
  })

  return `${header}\n\n${formatted.join("\n\n")}`
}

function stripOpenAlexIdPrefix(id: string | undefined): string | null {
  if (!id?.trim()) {
    return null
  }

  const trimmed = id.trim()
  return trimmed.replace(/^https?:\/\/openalex\.org\//, "")
}

function formatOpenAlexAuthors(work: OpenAlexWork): string | null {
  const authors = work.authorships
    ?.map((authorship) => authorship.author?.display_name?.trim())
    .filter((name): name is string => Boolean(name))

  if (!authors?.length) {
    return null
  }

  const visible = authors.slice(0, 6)
  return authors.length > 6 ? `${visible.join(", ")} +${authors.length - 6} more` : visible.join(", ")
}

function formatOpenAlexInstitutions(work: OpenAlexWork): string | null {
  const institutions = new Set<string>()

  for (const authorship of work.authorships ?? []) {
    for (const institution of authorship.institutions ?? []) {
      if (institution.display_name?.trim()) {
        institutions.add(institution.display_name.trim())
      }
    }
  }

  const values = Array.from(institutions)
  return values.length > 0 ? values.slice(0, 5).join(", ") : null
}

// Far beyond any real abstract; an index position past it is treated as malformed rather than sized into an array.
const MAX_ABSTRACT_POSITIONS = 20000

function reconstructOpenAlexAbstract(index?: Record<string, number[]>): string | null {
  if (!index || typeof index !== "object") {
    return null
  }

  let maxPosition = -1
  for (const positions of Object.values(index)) {
    if (!Array.isArray(positions)) {
      return null
    }
    for (const position of positions) {
      if (!Number.isInteger(position) || position < 0 || position >= MAX_ABSTRACT_POSITIONS) {
        return null
      }
      if (position > maxPosition) {
        maxPosition = position
      }
    }
  }

  if (maxPosition < 0) {
    return null
  }

  const tokens = new Array<string>(maxPosition + 1)
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      tokens[position] = word
    }
  }

  const text = tokens.filter(Boolean).join(" ")
  return truncateText(text, 320)
}

function formatOpenAlexTopics(work: OpenAlexWork): string | null {
  const topics = new Set<string>()

  if (work.primary_topic?.display_name?.trim()) {
    topics.add(work.primary_topic.display_name.trim())
  }

  for (const topic of work.topics ?? []) {
    if (topic.display_name?.trim()) {
      topics.add(topic.display_name.trim())
    }
  }

  const values = Array.from(topics)
  return values.length > 0 ? values.slice(0, 5).join(", ") : null
}

function formatOpenAlexOaUrl(work: OpenAlexWork): string | null {
  return (
    work.open_access?.oa_url ||
    work.best_oa_location?.pdf_url ||
    work.best_oa_location?.landing_page_url ||
    work.primary_location?.pdf_url ||
    work.primary_location?.landing_page_url ||
    null
  )
}

function formatOpenAlexWorks(works: OpenAlexWork[], header: string): string {
  const formatted = works.map((work) => {
    const lines: string[] = []
    const title = work.display_name?.trim() || "(untitled work)"
    const openAlexId = stripOpenAlexIdPrefix(work.id) || "unknown"
    const authors = formatOpenAlexAuthors(work)
    const institutions = formatOpenAlexInstitutions(work)
    const topics = formatOpenAlexTopics(work)
    const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index)
    const oaUrl = formatOpenAlexOaUrl(work)
    const doiUrl = toDoiUrl(work.doi || work.ids?.doi)

    lines.push(`**${title}**`)
    lines.push(
      [
        `OpenAlex ID: ${openAlexId}`,
        work.publication_date ? `Published: ${work.publication_date}` : null,
        work.publication_year ? `Year: ${work.publication_year}` : null,
        work.cited_by_count !== undefined ? `Citations: ${work.cited_by_count}` : null,
        work.type ? `Type: ${work.type}` : null,
      ]
        .filter(Boolean)
        .join(" | ")
    )

    if (authors) {
      lines.push(`  Authors: ${authors}`)
    }

    if (institutions) {
      lines.push(`  Institutions: ${institutions}`)
    }

    if (topics) {
      lines.push(`  Topics: ${topics}`)
    }

    if (abstract) {
      lines.push(`  Abstract: ${abstract}`)
    }

    if (oaUrl) {
      lines.push(`  Open access: ${oaUrl}`)
    }

    if (doiUrl) {
      lines.push(`  DOI: ${doiUrl}`)
    }

    if (work.id) {
      lines.push(`  OpenAlex: ${work.id}`)
    }

    return lines.join("\n")
  })

  return `${header}\n\n${formatted.join("\n\n")}`
}

function semanticAccess(): string {
  return providerKey("SEMANTIC_SCHOLAR_API_KEY")
    ? "API key configured; introductory key limit is 1 request/second across endpoints."
    : "No Semantic Scholar API key configured: using the shared anonymous pool, which may be heavily throttled. Set SEMANTIC_SCHOLAR_API_KEY or PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY for dedicated access."
}

function numericHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name)
  if (raw === null || !raw.trim()) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function semanticFailure(response: Response): string {
  const retry = numericHeader(response, "retry-after")
  return `HTTP ${response.status}. ${response.status === 429 ? "Provider throttled this request; this is not an empty search." : response.status === 401 || response.status === 403 ? "Provider rejected access; check configured key and endpoint permissions." : "Provider request failed."} ${semanticAccess()}${retry === undefined ? "" : ` Retry-After: ${retry} seconds.`}`
}

function openAlexBudget(response: Response, cost?: number): string {
  const fields = [
    ["daily credits", "x-ratelimit-limit"],
    ["daily USD", "x-ratelimit-limit-usd"],
    ["remaining credits", "x-ratelimit-remaining"],
    ["request credits", "x-ratelimit-credits-used"],
    ["reset seconds", "x-ratelimit-reset"],
  ].flatMap(([label, header]) => {
    const value = numericHeader(response, header)
    return value === undefined ? [] : [`${label}: ${value}`]
  })
  const usd = openAlexAmount(cost)
  if (usd !== null) fields.push(`request USD: ${usd}`)
  return `OpenAlex access: ${providerKey("OPENALEX_API_KEY") ? "API key configured" : "keyless (limited daily budget; a free OPENALEX_API_KEY raises it 10×)"}. Provider budget: ${fields.length ? fields.join(" | ") : "not reported"}.`
}

// Semantic Scholar is free with or without a key.
export const semantic_scholar_search = free({
  description:
    "Search scholarly papers via Semantic Scholar's Academic Graph API. " +
    "Best for citation-heavy ranking, Semantic Scholar TLDRs, seminal-paper discovery, and related-work seeding. " +
    "Supports year, field-of-study, citation, and open-access filtering.",
  async execute(args, context) {
    const requestedLimit = Math.min(args.limit ?? 10, 20)
    const sort = args.sort ?? "relevance"
    const apiLimit = sort === "relevance" ? requestedLimit : Math.min(Math.max(requestedLimit * 3, 15), 50)

    const url = new URL(`${SEMANTIC_SCHOLAR_GRAPH_BASE}/paper/search`)
    url.searchParams.set("query", args.query)
    url.searchParams.set("limit", String(apiLimit))
    url.searchParams.set("fields", SEMANTIC_SCHOLAR_FIELDS)

    if (args.yearFrom || args.yearTo) {
      url.searchParams.set("year", `${args.yearFrom ?? ""}-${args.yearTo ?? ""}`)
    }

    if (args.fieldsOfStudy?.length) {
      url.searchParams.set("fieldsOfStudy", args.fieldsOfStudy.join(","))
    }

    if (args.minCitationCount !== undefined) {
      url.searchParams.set("minCitationCount", String(args.minCitationCount))
    }

    if (args.openAccessOnly) {
      url.searchParams.set("openAccessPdf", "true")
    }

    try {
      const response = await fetch(url, {
        headers: semanticScholarHeaders(),
        signal: context.abort,
      })

      if (!response.ok) {
        await keptText(response, context.keep, "paper/search").catch(() => "")
        return `ERROR: Semantic Scholar search failed: ${semanticFailure(response)}`
      }

      const data = (await keptJson(response, context.keep, "paper/search")) as SemanticScholarSearchResponse
      if (!data || !Array.isArray(data.data) || "error" in data || "errors" in data || "message" in data) return "ERROR: Semantic Scholar returned an invalid search payload; not evidence of no matches."
      const papers = sortSemanticScholarPapers(data.data, sort).slice(0, requestedLimit)

      if (papers.length === 0) {
        return outcome("empty", `No Semantic Scholar papers found for "${args.query}".\n${semanticAccess()}`)
      }

      const header = [
        `Semantic Scholar papers for "${args.query}" (${papers.length} shown${data.total ? `, ${data.total} total matches` : ""}):`,
        `Sorted by ${sort}.`,
        semanticAccess(),
      ].join("\n")

      return formatSemanticScholarPapers(papers, header)
    } catch (error) {
      if (context.abort.aborted) throw error
      return "ERROR: Semantic Scholar search failed during transport or response decoding; not evidence of no matches."
    }
  },
} satisfies ToolSpec)

export const semantic_scholar_recommendations = free({
  description:
    "Get related-paper recommendations from Semantic Scholar using one or more seed paper IDs. " +
    "Best for related-work expansion after you've identified a few anchor papers. " +
    "Use paper IDs surfaced by papers_semantic_scholar_search.",
  async execute(args, context) {
    const limit = Math.min(args.limit ?? 10, 20)
    const url = new URL(`${SEMANTIC_SCHOLAR_RECOMMENDATIONS_BASE}/papers`)
    url.searchParams.set("fields", SEMANTIC_SCHOLAR_FIELDS)
    url.searchParams.set("limit", String(limit))

    try {
      const response = await fetch(url, {
        method: "POST",
        signal: context.abort,
        headers: {
          ...semanticScholarHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          positivePaperIds: args.positivePaperIds,
          negativePaperIds: args.negativePaperIds,
        }),
      })

      if (!response.ok) {
        await keptText(response, context.keep, "recommendations").catch(() => "")
        return `ERROR: Semantic Scholar recommendations failed: ${semanticFailure(response)}`
      }

      const data = (await keptJson(response, context.keep, "recommendations")) as SemanticScholarRecommendationsResponse
      if (!data || !Array.isArray(data.recommendedPapers) || "error" in data || "errors" in data || "message" in data) return "ERROR: Semantic Scholar returned an invalid recommendations payload; not evidence of no matches."
      const papers = data.recommendedPapers

      if (papers.length === 0) {
        return outcome("empty", `No Semantic Scholar recommendations were returned for the provided seed papers.\n${semanticAccess()}`)
      }

      const seedList = args.positivePaperIds.join(", ")
      return formatSemanticScholarPapers(
        papers,
        `Semantic Scholar related-work recommendations seeded by: ${seedList}\n${semanticAccess()}`
      )
    } catch (error) {
      if (context.abort.aborted) throw error
      return "ERROR: Semantic Scholar recommendations failed during transport or response decoding; not evidence of no matches."
    }
  },
} satisfies ToolSpec)

// OpenAlex reports each response's usage cost (`meta.cost_usd`) and documents 4xx/5xx responses as free;
// any other response leaves the call's cost unknown.
export const openalex_search = metered({
  description:
    "Search scholarly works via OpenAlex. " +
    "Best for broad literature coverage, open-access links, topic/institution metadata, and ecosystem mapping beyond one provider's index. " +
    "Supports year and open-access filtering plus cited_by_count/publication_date sorting.",
  async execute(args, context) {
    const limit = Math.min(args.limit ?? 10, 25)
    const page = Math.max(args.page ?? 1, 1)
    const url = new URL(`${OPENALEX_BASE}/works`)

    url.searchParams.set("search", args.query)
    url.searchParams.set("per_page", String(limit))
    url.searchParams.set("page", String(page))

    const filters: string[] = []
    if (args.yearFrom) {
      filters.push(`from_publication_date:${args.yearFrom}-01-01`)
    }
    if (args.yearTo) {
      filters.push(`to_publication_date:${args.yearTo}-12-31`)
    }
    if (args.openAccessOnly) {
      filters.push("is_oa:true")
    }

    if (filters.length > 0) {
      url.searchParams.set("filter", filters.join(","))
    }

    const sort = args.sort ?? "relevance"
    if (sort !== "relevance") {
      url.searchParams.set("sort", `${sort}:desc`)
    }

    try {
      const response = await fetch(url, {
        headers: openAlexHeaders(),
        signal: context.abort,
      })

      if (!response.ok) {
        await keptText(response, context.keep, "works").catch(() => "")
        return `ERROR: OpenAlex search failed with HTTP ${response.status}.${response.status === 429 ? " Daily budget exhausted or request-rate limit exceeded; not evidence of no matches." : ""}\n${openAlexBudget(response)}`
      }

      const data = (await keptJson(response, context.keep, "works")) as OpenAlexSearchResponse
      if (!data || !Array.isArray(data.results) || "error" in data || "errors" in data || "message" in data) return `ERROR: OpenAlex returned an invalid search payload; not evidence of no matches.\n${openAlexBudget(response)}`
      const works = data.results
      const budget = openAlexBudget(response, data.meta?.cost_usd)

      if (works.length === 0) {
        return outcome("empty", `No OpenAlex works found for "${args.query}".\n${budget}`)
      }

      const header = [
        `OpenAlex works for "${args.query}" (${works.length} shown${data.meta?.count ? `, ${data.meta.count} total matches` : ""}):`,
        `Page ${data.meta?.page ?? page} | Sorted by ${sort}.`,
        budget,
      ].join("\n")

      return formatOpenAlexWorks(works, header)
    } catch (error) {
      if (context.abort.aborted) throw error
      return "ERROR: OpenAlex search failed during transport or response decoding; not evidence of no matches."
    }
  },
} satisfies ToolSpec, "USD", openAlexCharge)
