import { num, plural } from "../format.ts";
import {
  arr,
  attempted,
  failedCall,
  noItems,
  nonEmpty,
  numv,
  obj,
  objs,
  query,
  scope,
  str,
  strs,
  type ConnectorState,
  type EvidenceCall,
  type EvidenceItem,
  type EvidenceResult,
} from "./read.ts";

const READS: Record<string, readonly [string, string]> = {
  papers_fulltext_read: ["read the full text of", "read the full text of"],
  papers_pdf_download: ["downloaded the PDF of", "download the PDF of"],
  papers_openalex_content: ["read the OpenAlex cached content of", "read the OpenAlex cached content of"],
  papers_sections: ["extracted the sections of", "extract the sections of"],
};
const INDEX: Record<string, string> = {
  papers_semantic_scholar_search: "Semantic Scholar",
  papers_openalex_search: "OpenAlex",
};
const SORT: Record<string, string> = {
  citationCount: "most cited",
  cited_by_count: "most cited",
  publicationDate: "newest first",
};

interface PaperRow {
  readonly title: string;
  readonly authors?: string;
  readonly year?: string;
  readonly citations?: number;
  readonly url?: string;
  readonly pdf?: string;
}

const doiUrl = (doi: string | undefined): string | undefined =>
  doi ? (doi.startsWith("http") ? doi : `https://doi.org/${doi}`) : undefined;

const titleKey = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const authorList = (names: readonly string[]): string | undefined =>
  names.length ? (names.length > 2 ? `${names[0]} et al.` : names.join(" & ")) : undefined;

function readPapers(b: Record<string, unknown>): PaperRow[] {
  const papers: PaperRow[] = [];
  for (const p of objs(b.papers)) {
    const title = str(p.title);
    if (title) {
      papers.push({
        title,
        authors: authorList(
          (str(p.authors) ?? "")
            .split(";")
            .map((x) => x.trim())
            .filter(Boolean),
        ),
        year: str(p.published_date)?.slice(0, 4),
        citations: numv(p.citations),
        url: str(p.url) ?? doiUrl(str(p.doi)),
        pdf: str(p.pdf_url),
      });
    }
  }
  for (const p of [
    ...objs(b.data).map((x) => obj(x.citingPaper) ?? obj(x.citedPaper) ?? x),
    ...objs(b.recommendedPapers),
  ]) {
    const title = str(p.title);
    if (title && "paperId" in p) {
      papers.push({
        title,
        authors: authorList(
          objs(p.authors).flatMap((x) => {
            const name = str(x.name);
            return name ? [name] : [];
          }),
        ),
        year: str(p.year),
        citations: numv(p.citationCount),
        url: str(p.url) ?? doiUrl(str(obj(p.externalIds)?.DOI)),
        pdf: str(obj(p.openAccessPdf)?.url),
      });
    }
  }
  for (const w of objs(b.results)) {
    const title = str(w.display_name);
    if (title) {
      papers.push({
        title,
        authors: authorList(
          objs(w.authorships).flatMap((x) => {
            const name = str(obj(x.author)?.display_name);
            return name ? [name] : [];
          }),
        ),
        year: str(w.publication_year),
        citations: numv(w.cited_by_count),
        url: doiUrl(str(w.doi)) ?? str(obj(w.primary_location)?.landing_page_url) ?? str(w.id),
        pdf: str(obj(w.best_oa_location)?.pdf_url) ?? str(obj(w.open_access)?.oa_url),
      });
    }
  }
  return papers;
}

const toItem = (p: PaperRow): EvidenceItem => ({
  kind: "paper",
  key: titleKey(p.title),
  title: p.title,
  url: p.url,
  meta: nonEmpty([
    p.authors,
    p.year,
    p.citations === undefined ? undefined : plural(p.citations, "citation"),
    p.pdf ? "open access" : undefined,
  ]),
  links: p.pdf ? [{ label: "PDF", url: p.pdf }] : [],
});

function connectors(b: Record<string, unknown>): { answered: number; asked: number } | undefined {
  const status = obj(b.source_status);
  if (!status) return undefined;
  const states = Object.values(status).map(String);
  return {
    answered: states.filter((s) => s === "ok" || s === "partial").length,
    asked: states.length,
  };
}

function readText(responseBodies: readonly unknown[]): string | undefined {
  for (const body of responseBodies) {
    if (typeof body === "string") return `${num(body.length)} characters of text`;
    const b = obj(body);
    if (b && Array.isArray(b.sections)) return plural(b.sections.length, "section");
    if (b && (str(b.path) ?? str(b.file))) return `saved ${str(b.path) ?? str(b.file)}`;
  }
  return undefined;
}

function connectorStates(responseBodies: readonly unknown[]): ConnectorState[] {
  for (const body of responseBodies) {
    const b = obj(body);
    const status = obj(b?.source_status);
    if (!b || !status) continue;
    const results = obj(b.source_results) ?? {};
    const errors = obj(b.errors) ?? {};
    const warnings = obj(b.warnings) ?? {};
    return Object.entries(status).map(([name, state]) => ({
      name,
      state: String(state),
      results: numv(results[name]),
      note: str(errors[name]) ?? (arr(warnings[name]).map(String).join("; ") || undefined),
    }));
  }
  return [];
}

export function readPapersCall(
  call: EvidenceCall,
  responseBodies: readonly unknown[],
): EvidenceResult {
  const a = call.args;
  const failed = failedCall(call);
  if (Object.hasOwn(READS, call.tool)) {
    const what = nonEmpty([str(a.source), str(a.paperId), str(a.workId), str(a.file)]).join(" ");
    const [verb, tried] = READS[call.tool];
    return {
      action: [attempted(call.status, verb, tried), what || "a paper"],
      result: failed ? undefined : readText(responseBodies),
      items: [],
    };
  }
  const byKey = new Map<string, PaperRow>();
  let matches: number | undefined;
  let health: { answered: number; asked: number } | undefined;
  for (const body of responseBodies) {
    const b = obj(body);
    if (!b) continue;
    for (const p of readPapers(b)) {
      if (!byKey.has(titleKey(p.title))) byKey.set(titleKey(p.title), p);
    }
    matches ??= numv(b.total) ?? numv(obj(b.meta)?.count);
    health ??= connectors(b);
  }
  const papers = [...byKey.values()].sort((x, y) => (y.citations ?? -1) - (x.citations ?? -1));
  const found =
    matches !== undefined && matches > papers.length
      ? `${num(papers.length)} of ${plural(matches, "paper")}`
      : papers.length
        ? plural(papers.length, "paper")
        : noItems(call);
  const index = INDEX[call.tool];
  const action =
    call.tool === "papers_multi_search"
      ? [
          "searched",
          health ? `${num(health.asked)} paper indexes for` : "the paper indexes for",
          ...query(str(a.query)),
        ]
      : call.tool === "papers_semantic_scholar_recommendations"
        ? [
            "asked Semantic Scholar for papers like",
            strs(a.positivePaperIds).join(", ") || "a paper",
          ]
        : call.tool === "papers_semantic_scholar_relations"
          ? [
              str(a.direction) === "references"
                ? "read the references of"
                : "read the papers citing",
              str(a.paperId) ?? "a paper",
            ]
          : [index ? `searched ${index} for` : "searched for papers on", ...query(str(a.query))];
  return {
    action: [
      ...action,
      ...scope([
        numv(a.yearFrom) ? `since ${a.yearFrom}` : undefined,
        SORT[str(a.sort) ?? ""],
      ]),
    ],
    result: failed
      ? undefined
      : health && health.answered < health.asked
        ? `${found}; ${num(health.answered)} of ${num(health.asked)} answered`
        : found,
    items: papers.map(toItem),
    connectors: connectorStates(responseBodies),
  };
}
