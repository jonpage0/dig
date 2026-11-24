import { catalogMetaFromPlugins, type CatalogMeta } from "../core/config.ts";
import type { AnyActionDefinition, ProviderAccount, SourceGroupId, SourcePlugin } from "../core/plugin.ts";
import { blueskySource } from "./bluesky/index.ts";
import { chinaSocialSource } from "./china-social/index.ts";
import { commerceSource } from "./commerce/index.ts";
import { dataforseoSource } from "./dataforseo/index.ts";
import { deepwikiSource } from "./deepwiki/index.ts";
import { evidenceSource } from "./evidence/index.ts";
import { exaSource } from "./exa/index.ts";
import { facebookSource } from "./facebook/index.ts";
import { facebookAdsSource } from "./facebook-ads/index.ts";
import { firecrawlSource } from "./firecrawl/index.ts";
import { githubSource } from "./github/index.ts";
import { googleAdsSource } from "./google-ads/index.ts";
import { hackernewsSource } from "./hackernews/index.ts";
import { instagramSource } from "./instagram/index.ts";
import { linkedinSource } from "./linkedin/index.ts";
import { linkedinAdsSource } from "./linkedin-ads/index.ts";
import { papersSource } from "./papers/index.ts";
import { polymarketSource } from "./polymarket/index.ts";
import { redditSource } from "./reddit/index.ts";
import { secSource } from "./sec/index.ts";
import { telegramSource } from "./telegram/index.ts";
import { threadsSource } from "./threads/index.ts";
import { tikhubRedditSource } from "./tikhub-reddit/index.ts";
import { tiktokSource } from "./tiktok/index.ts";
import { tiktokAdsSource } from "./tiktok-ads/index.ts";
import { videoSource } from "./video/index.ts";
import { waybackSource } from "./wayback/index.ts";
import { xSource } from "./x/index.ts";
import { youtubeSource } from "./youtube/index.ts";

/**
 * Single source of truth for Dig 2.0's catalog of research sources and shared tools.
 * Every source owns its own metadata, Effect schemas, actions, billing rules, and tests
 * under `src/sources/<id>/`.
 */
export const SOURCES: readonly SourcePlugin[] = [
  hackernewsSource,
  deepwikiSource,
  polymarketSource,
  waybackSource,
  githubSource,
  exaSource,
  papersSource,
  youtubeSource,
  videoSource,
  evidenceSource,
  xSource,
  redditSource,
  tikhubRedditSource,
  tiktokSource,
  instagramSource,
  facebookSource,
  threadsSource,
  linkedinSource,
  telegramSource,
  chinaSocialSource,
  commerceSource,
  tiktokAdsSource,
  facebookAdsSource,
  googleAdsSource,
  linkedinAdsSource,
  dataforseoSource,
  firecrawlSource,
  secSource,
  blueskySource,
] as const;

export const SOURCE_GROUPS: readonly {
  readonly id: SourceGroupId;
  readonly label: string;
  readonly sources: readonly string[];
}[] = [
  { id: "web", label: "Web search", sources: ["exa", "wayback", "firecrawl"] },
  { id: "code", label: "Code and developers", sources: ["github", "deepwiki", "hackernews"] },
  { id: "papers", label: "Papers", sources: ["papers"] },
  { id: "video", label: "Video", sources: ["youtube"] },
  {
    id: "social",
    label: "Social",
    sources: [
      "x",
      "reddit",
      "tikhub-reddit",
      "tiktok",
      "instagram",
      "facebook",
      "threads",
      "linkedin",
      "telegram",
      "china-social",
      "bluesky",
    ],
  },
  {
    id: "markets",
    label: "Markets and commerce",
    sources: [
      "polymarket",
      "sec",
      "commerce",
      "tiktok-ads",
      "facebook-ads",
      "google-ads",
      "linkedin-ads",
      "dataforseo",
    ],
  },
  { id: "tools", label: "Shared tools", sources: ["video", "evidence"] },
] as const;

const UNKNOWN_COST =
  "Dig shows these calls’ cost as unknown, because the provider reports no per-request amount.";

/** Provider accounts in Sources page order. Every source credential key appears in exactly one entry. */
export const ACCOUNTS: readonly ProviderAccount[] = [
  {
    id: "exa",
    name: "Exa",
    signup: "https://dashboard.exa.ai/api-keys",
    keys: ["EXA_API_KEY"],
    billing: "Paid per request in US dollars, which Dig records.",
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    signup: "https://www.firecrawl.dev/app/api-keys",
    keys: ["FIRECRAWL_API_KEY"],
    billing:
      "Firecrawl credits per request. Dig records the credits each response reports and shows unknown when omitted.",
  },
  {
    id: "github",
    name: "GitHub",
    signup: "https://github.com/settings/tokens",
    keys: [["GH_TOKEN", "GITHUB_TOKEN"]],
    billing: "Free. A token, or an existing gh login, raises GitHub’s anonymous limits.",
  },
  {
    id: "semantic-scholar",
    name: "Semantic Scholar",
    signup: "https://www.semanticscholar.org/product/api#api-key-form",
    keys: [["SEMANTIC_SCHOLAR_API_KEY", "PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY"]],
    billing: "Free. A key replaces the shared anonymous pool with a rate limit of your own.",
  },
  {
    id: "openalex",
    name: "OpenAlex",
    signup: "https://openalex.org/settings/api",
    keys: [["OPENALEX_API_KEY", "PAPER_SEARCH_MCP_OPENALEX_API_KEY"]],
    billing:
      "Reports a US-dollar usage cost, which Dig records and its free daily allowance can cover; a key raises the allowance.",
  },
  {
    id: "ncbi",
    name: "NCBI (PubMed and PMC)",
    signup: "https://account.ncbi.nlm.nih.gov/settings/",
    keys: [["NCBI_API_KEY", "PAPER_SEARCH_MCP_NCBI_API_KEY"]],
    billing: "Free. Used by the Papers bridge’s PubMed and PMC searches.",
  },
  {
    id: "core",
    name: "CORE",
    signup: "https://core.ac.uk/services/api#form",
    keys: ["PAPER_SEARCH_MCP_CORE_API_KEY"],
    billing: "Used by the Papers bridge’s CORE search, which also works without a key.",
  },
  {
    id: "google",
    name: "Google Cloud (YouTube Data API)",
    signup: "https://console.cloud.google.com/apis/credentials",
    keys: ["OPENCODE_RESEARCH_GOOGLE_API_KEY"],
    billing:
      "Uses your YouTube Data API quota. Adds Data API search metadata; transcripts need yt-dlp.",
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    signup: "https://aistudio.google.com/apikey",
    keys: ["GEMINI_API_KEY"],
    billing:
      "Optional YouTube video analysis through Gemini. Token usage is shown when returned; no per-call charge is reported, so Dig records cost as unknown.",
  },
  {
    id: "x-api",
    name: "X API",
    signup: "https://console.x.com",
    keys: ["X_BEARER_TOKEN"],
    optional: [
      "X_CONSUMER_KEY",
      "X_CONSUMER_SECRET",
      "X_ACCESS_TOKEN",
      "X_ACCESS_TOKEN_SECRET",
    ],
    billing:
      "Pay-per-use credits from your X developer account (docs.x.com/x-api/introduction). The optional sign-in keys let Dig search people and Communities and read your bookmarks and likes as that account. X reports no per-request amount and bills reads per resource returned, so Dig records the posts and accounts each call read (X post reads and X account reads, including List reads), not money. X charges a resource once per UTC day, so its bill can be lower than the reads recorded; Dig does not know which reads were repeats. Counts, News, trends, Spaces and Communities show as unknown.",
  },
  {
    id: "xai",
    name: "xAI",
    signup: "https://console.x.ai/team/default/api-keys",
    keys: ["XAI_API_KEY"],
    billing: "Paid per request in US dollars, which Dig records.",
  },
  {
    id: "scrapecreators",
    name: "ScrapeCreators",
    signup: "https://app.scrapecreators.com",
    keys: ["SCRAPECREATORS_API_KEY"],
    billing: "ScrapeCreators credits per request, which Dig records.",
  },
  {
    id: "tikhub",
    name: "TikHub",
    signup: "https://user.tikhub.io/dashboard/api",
    keys: ["TIKHUB_API_KEY"],
    billing: `Paid from your TikHub account. ${UNKNOWN_COST}`,
  },
  {
    id: "justone",
    name: "Just One API",
    signup: "https://dashboard.justoneapi.com/en",
    keys: ["JUSTONE_API_KEY"],
    billing:
      "Its own account, used only when China social’s fallback is asked for. Dig shows these calls’ cost as unknown.",
  },
  {
    id: "scrape-do",
    name: "Scrape.do",
    signup: "https://dashboard.scrape.do/",
    keys: [["SCRAPE_DO_API_KEY", "SCRAPEDO_API_TOKEN"]],
    billing: "Scrape.do credits per request, which Dig records.",
  },
  {
    id: "nexscope",
    name: "Nexscope",
    signup: "https://www.nexscope.ai/seller/api-access?tab=api-keys",
    keys: ["NEXSCOPE_API_KEY"],
    billing: `Paid from your Nexscope account. ${UNKNOWN_COST}`,
  },
  {
    id: "dataforseo",
    name: "DataForSEO",
    signup: "https://app.dataforseo.com/api-access",
    keys: ["DATAFORSEO_USERNAME", "DATAFORSEO_PASSWORD"],
    billing:
      "Prepaid; US dollars per request, which Dig records. Use the API login and API password from the API Access page, not your dashboard password.",
  },
  {
    id: "elorian",
    name: "Elorian",
    signup: "https://platform.elorian.ai/settings/keys",
    keys: ["ELORIAN_API_KEY"],
    billing:
      "Paid video analysis. Token usage is shown when returned, but no per-call charge is reported, so Dig records cost as unknown.",
  },
  {
    id: "typesafe",
    name: "TypeSafe",
    signup: "https://console.typesafe.ai/keys",
    keys: ["TYPESAFE_API_KEY"],
    billing:
      "Optional evidence ranking with Jev (`jev-latest`). Returned token usage is shown when available; no per-call dollar charge is reported, so Dig records cost as unknown.",
  },
] as const;

export const ALL_SOURCE_IDS: readonly string[] = SOURCES.map((s) => s.id);

export const PRESETS: Record<string, readonly string[]> = {
  starter: ["hackernews", "deepwiki", "polymarket", "wayback", "sec", "bluesky"],
  research: [
    "hackernews",
    "deepwiki",
    "github",
    "exa",
    "firecrawl",
    "wayback",
    "papers",
    "sec",
    "youtube",
    "evidence",
  ],
  social: [
    "hackernews",
    "x",
    "bluesky",
    "reddit",
    "tiktok",
    "instagram",
    "facebook",
    "threads",
    "linkedin",
    "telegram",
  ],
  all: ALL_SOURCE_IDS,
};

const SOURCE_MAP = new Map<string, SourcePlugin>(SOURCES.map((s) => [s.id, s]));

const ACTION_MAP = new Map<string, { readonly source: SourcePlugin; readonly action: AnyActionDefinition }>();
for (const source of SOURCES) {
  for (const action of source.actions) {
    ACTION_MAP.set(action.name, { source, action });
  }
}

export function sourceById(id: string): SourcePlugin | undefined {
  return SOURCE_MAP.get(id);
}

export function actionByName(
  name: string,
): { readonly source: SourcePlugin; readonly action: AnyActionDefinition } | undefined {
  return ACTION_MAP.get(name);
}

export function selectedSources(ids: readonly string[]): SourcePlugin[] {
  const wanted = new Set(ids);
  return SOURCES.filter((s) => wanted.has(s.id));
}

export function reportSourceIds(ids: readonly string[] = ALL_SOURCE_IDS): string[] {
  return selectedSources(ids)
    .filter((s) => s.kind !== "tool")
    .map((s) => s.id);
}

export function sourceSkills(s: SourcePlugin): readonly string[] {
  return s.kind === "tool" ? [] : (s.skills ?? [s.id]);
}

export function allMethodsFor(ids: readonly string[] = ALL_SOURCE_IDS): string[] {
  return [
    "dig",
    "library",
    "setup",
    ...selectedSources(ids).flatMap((s) => [
      ...sourceSkills(s),
      ...(s.helpers ?? []),
      ...(s.helperSkill ? [s.helperSkill] : []),
    ]),
  ];
}

export interface DigMethodEntry {
  readonly name: string;
  readonly source: string;
  readonly helper: boolean;
  readonly actions: readonly string[];
}

export function methodEntries(ids: readonly string[] = ALL_SOURCE_IDS): DigMethodEntry[] {
  return selectedSources(ids).flatMap((s) => {
    const actionNames = s.actions.map((a) => a.name);
    const out: DigMethodEntry[] = [];
    for (const skill of sourceSkills(s)) {
      out.push({ name: skill, source: s.id, helper: false, actions: actionNames });
    }
    for (const helper of s.helpers ?? []) {
      out.push({ name: helper, source: s.id, helper: true, actions: [] });
    }
    if (s.helperSkill) {
      out.push({ name: s.helperSkill, source: s.id, helper: false, actions: actionNames });
    }
    return out;
  });
}

export const CATALOG_META: CatalogMeta = catalogMetaFromPlugins(SOURCES);
