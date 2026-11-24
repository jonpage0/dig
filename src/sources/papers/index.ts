import { defineSource, type SourcePlugin } from "../../core/plugin.ts";
import {
  ACTIVE_SOURCES,
  boundedOutput,
  callPaperBridge,
  confined,
  DISABLED_SOURCES,
  multiSearchBilling,
  OPENALEX_BACKED_SOURCES,
  openAlexUnknownBilling,
  papersFulltextReadAction,
  papersMultiSearchAction,
  papersPdfDownloadAction,
  papersSectionsAction,
  requestedSources,
  runPaperBridgeTool,
  writeOnce,
} from "./bridge.ts";
import {
  openAlexAmount,
  openAlexCharge,
  openAlexNoCharge,
  paperLibraryDir,
  papersOpenAlexContentAction,
  papersOpenAlexSearchAction,
} from "./openalex.ts";
import {
  papersSemanticScholarRecommendationsAction,
  papersSemanticScholarRelationsAction,
  papersSemanticScholarSearchAction,
  papersSemanticScholarSnippetsAction,
} from "./semantic_scholar.ts";

export {
  ACTIVE_SOURCES,
  boundedOutput,
  callPaperBridge,
  confined,
  DISABLED_SOURCES,
  multiSearchBilling,
  OPENALEX_BACKED_SOURCES,
  openAlexAmount,
  openAlexCharge,
  openAlexNoCharge,
  openAlexUnknownBilling,
  paperLibraryDir,
  papersFulltextReadAction,
  papersMultiSearchAction,
  papersOpenAlexContentAction,
  papersOpenAlexSearchAction,
  papersPdfDownloadAction,
  papersSectionsAction,
  papersSemanticScholarRecommendationsAction,
  papersSemanticScholarRelationsAction,
  papersSemanticScholarSearchAction,
  papersSemanticScholarSnippetsAction,
  requestedSources,
  runPaperBridgeTool,
  writeOnce,
};

export const papersSource: SourcePlugin = defineSource({
  id: "papers",
  group: "papers",
  label: "Papers",
  description: "Literature search, full text and optional federated bridge",
  env: [
    "SEMANTIC_SCHOLAR_API_KEY",
    "OPENALEX_API_KEY",
    "NCBI_API_KEY",
    "PAPER_SEARCH_MCP_NCBI_API_KEY",
    "PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY",
    "PAPER_SEARCH_MCP_OPENALEX_API_KEY",
    "PAPER_SEARCH_MCP_CORE_API_KEY",
    "PAPER_SEARCH_MCP_UNPAYWALL_EMAIL",
  ],
  credential: "Optional provider keys; federated search/full text needs the papers bridge",
  envSettings: [
    {
      name: "PAPER_SEARCH_MCP_UNPAYWALL_EMAIL",
      label: "Unpaywall contact email",
      purpose:
        "Unpaywall looks up a legal free copy of a paper by its DOI, as one of the Papers bridge's federated search sources, and asks for a contact email. Without one, the bridge skips Unpaywall.",
    },
  ],
  requires: ["uv (optional bridge)"],
  about:
    "Scholarly literature. Semantic Scholar and OpenAlex search and related-paper recommendations work directly. The optional local Papers bridge adds federated search across many indexes (arXiv, PubMed, Crossref and others), open-access full text and PDF downloads.",
  providers: [
    { name: "Semantic Scholar", url: "https://www.semanticscholar.org/product/api" },
    { name: "OpenAlex", url: "https://openalex.org" },
    { name: "paper-search-mcp bridge", url: "https://github.com/openags/paper-search-mcp" },
  ],
  billing:
    "Mostly free. OpenAlex reports a US-dollar usage cost that its free daily allowance can cover; optional keys raise providers' rate limits.",
  actions: [
    papersSemanticScholarSearchAction,
    papersSemanticScholarRecommendationsAction,
    papersSemanticScholarSnippetsAction,
    papersSemanticScholarRelationsAction,
    papersOpenAlexSearchAction,
    papersOpenAlexContentAction,
    papersMultiSearchAction,
    papersSectionsAction,
    papersFulltextReadAction,
    papersPdfDownloadAction,
  ],
});

export default papersSource;
