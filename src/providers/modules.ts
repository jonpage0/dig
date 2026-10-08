/** One catalog owns source names, tools, skills, prerequisites and setup presets. */
export interface DigModule {
  id: string;
  label: string;
  description: string;
  tools: readonly string[];
  skills?: readonly string[];
  env?: readonly string[];
  /**
   * Credentials setup asks for. Each entry is one credential; an inner list names aliases of the same credential, set
   * when any of its names is. Readiness: every entry set is ready, some is partly ready, none needs setup. Names in
   * `env` but not here are optional and never prompted.
   */
  keys?: readonly (string | readonly string[])[];
  credential?: string;
  requires?: readonly string[];
  /**
   * Names in `env` that are settings rather than credentials, such as a contact email. The Sources page lists
   * them with their purpose, and Edit keys.env offers each as an empty line. Presence only: values are never
   * returned.
   */
  envSettings?: readonly { name: string; label: string; purpose: string }[];
  /** Agents that assist a source agent but have no source tools of their own. */
  helpers?: readonly string[];
  /** What the source researches and how Dig reaches it, for Dig's Sources page. Plain sentences. */
  about: string;
  /** The services Dig calls for this source. */
  providers: readonly { name: string; url?: string }[];
  /** How using the source is billed, as far as Dig knows. */
  billing: string;
  /**
   * Brand logo file stem in src/logos, inlined into the view at build. Logos sit on a light tile in both themes,
   * as brands draw them for light backgrounds. Without a logo the Sources page shows the source's Dig glyph.
   */
  logo?: string;
}
/**
 * The Sources page's sections, in order, grouped by what a source researches. Every report source appears in
 * exactly one group.
 */
export const SOURCE_GROUPS = [
  { id: "web", label: "Web search", sources: ["exa", "perplexity"] },
  { id: "code", label: "Code and developers", sources: ["github", "deepwiki", "hackernews"] },
  { id: "papers", label: "Papers", sources: ["papers"] },
  { id: "video", label: "Video", sources: ["youtube"] },
  { id: "social", label: "Social", sources: ["x", "reddit", "tikhub-reddit", "tiktok", "instagram", "linkedin", "telegram", "china-social"] },
  { id: "markets", label: "Markets and commerce", sources: ["polymarket", "commerce", "tiktok-ads", "dataforseo"] },
] as const;
const SCRAPECREATORS = { name: "ScrapeCreators", url: "https://scrapecreators.com" };
const TIKHUB = { name: "TikHub", url: "https://tikhub.io" };
const SCRAPECREATORS_CREDITS = "ScrapeCreators credits per request, from your ScrapeCreators account. Dig records the credits each response reports.";
const TIKHUB_UNKNOWN = "Paid from your TikHub account. TikHub does not report a per-request amount, so Dig shows these calls' cost as unknown.";
export const MODULES = [
  {
    id: "hackernews",
    label: "Hacker News",
    description: "Developer stories and discussions",
    tools: ["hackernews"],
    about: "Hacker News stories and comment threads, searched through Algolia's public Hacker News index, with comment trees read for context. Useful for how developers and founders react to a launch, a tool or an idea.",
    providers: [{ name: "Algolia Hacker News search", url: "https://hn.algolia.com/api" }, { name: "Hacker News API", url: "https://github.com/HackerNews/API" }],
    billing: "Free. No account or key.",
    logo: "ycombinator",
  },
  {
    id: "deepwiki",
    label: "DeepWiki",
    description: "Public repository documentation and Q&A",
    tools: [
      "deepwiki_read_wiki_structure",
      "deepwiki_read_wiki_contents",
      "deepwiki_ask_question",
    ],
    about: "Generated documentation for public GitHub repositories: browse a repository's wiki or ask a question about its code. Answers are generated from the code and can be wrong, so load-bearing claims get checked in the repository itself.",
    providers: [{ name: "DeepWiki", url: "https://deepwiki.com" }],
    billing: "Free. No account or key.",
  },
  {
    id: "polymarket",
    label: "Polymarket",
    description: "Public prediction-market evidence",
    tools: ["polymarket"],
    about: "Prediction-market questions with their current odds, volume and liquidity. Prices show what traders are betting, not what is true.",
    providers: [{ name: "Polymarket Gamma API", url: "https://docs.polymarket.com" }],
    billing: "Free. No account or key.",
    logo: "polymarket",
  },
  {
    id: "github",
    label: "GitHub",
    description: "Discover, compare and read public repositories",
    tools: ["github_search", "github_inspect", "github_read"],
    env: ["GH_TOKEN", "GITHUB_TOKEN"],
    keys: [["GH_TOKEN", "GITHUB_TOKEN"]],
    credential: "GH_TOKEN or GITHUB_TOKEN, or an existing gh login",
    about: "Finds, compares and reads public repositories: repository search, a repository's activity over a window (stars, commits, releases, contributors, review and issue samples) and single files at an exact commit.",
    providers: [{ name: "GitHub REST and GraphQL APIs", url: "https://docs.github.com/en/rest" }],
    billing: "Free. Works without a login at GitHub's lower anonymous limits; a token in keys.env or a gh login raises them and adds review and issue-reply samples.",
    logo: "github",
  },
  {
    id: "exa",
    label: "Exa",
    description: "Web documents, extraction and similarity",
    tools: ["exa_search", "exa_contents", "exa_similar", "exa_research"],
    env: ["EXA_API_KEY"],
    keys: ["EXA_API_KEY"],
    credential: "EXA_API_KEY",
    about: "Web search that returns ranked pages with their text, plus clean extraction of pages you name and discovery of similar pages. Exa's deep research runs only when explicitly asked for.",
    providers: [{ name: "Exa", url: "https://exa.ai" }],
    billing: "Paid per request in US dollars from your Exa account. Dig records the cost Exa reports.",
    logo: "exa",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    description: "Web search and grounded answers",
    tools: [
      "perplexity_ask",
      "perplexity_search",
      "perplexity_research",
      "perplexity_reason",
    ],
    env: ["PERPLEXITY_API_KEY", "PERPLEXITY_TIMEOUT_MS"],
    keys: ["PERPLEXITY_API_KEY"],
    credential: "PERPLEXITY_API_KEY",
    about: "Web answers with citations at three depths (a quick answer, a reasoned comparison, multi-step research), plus plain search results without an AI answer.",
    providers: [{ name: "Perplexity API", url: "https://docs.perplexity.ai" }],
    billing: "Paid per request in US dollars from your Perplexity API account. Dig records the cost Perplexity reports.",
    logo: "perplexity",
  },
  {
    id: "papers",
    label: "Papers",
    description: "Literature search, full text and optional federated bridge",
    tools: [
      "papers_semantic_scholar_search",
      "papers_semantic_scholar_recommendations",
      "papers_openalex_search",
      "papers_multi_search",
      "papers_fulltext_read",
      "papers_pdf_download",
    ],
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
    credential:
      "Optional provider keys; federated search/full text needs the papers bridge",
    envSettings: [
      {
        name: "PAPER_SEARCH_MCP_UNPAYWALL_EMAIL",
        label: "Unpaywall contact email",
        purpose: "Unpaywall looks up a legal free copy of a paper by its DOI, as one of the Papers bridge's federated search sources, and asks for a contact email. Without one, the bridge skips Unpaywall.",
      },
    ],
    requires: ["uv (optional bridge)"],
    about: "Scholarly literature. Semantic Scholar and OpenAlex search and related-paper recommendations work directly. The optional local Papers bridge adds federated search across many indexes (arXiv, PubMed, Crossref and others), open-access full text and PDF downloads.",
    providers: [{ name: "Semantic Scholar", url: "https://www.semanticscholar.org/product/api" }, { name: "OpenAlex", url: "https://openalex.org" }, { name: "paper-search-mcp bridge", url: "https://github.com/openags/paper-search-mcp" }],
    billing: "Mostly free. OpenAlex reports a US-dollar usage cost that its free daily allowance can cover; optional keys raise providers' rate limits.",
  },
  {
    id: "youtube",
    label: "YouTube",
    description: "Videos and saved transcripts",
    tools: ["youtube"],
    skills: ["youtube"],
    helpers: ["youtube-summarizer"],
    env: ["OPENCODE_RESEARCH_GOOGLE_API_KEY"],
    credential:
      "Optional OPENCODE_RESEARCH_GOOGLE_API_KEY; yt-dlp for transcripts and keyless search",
    requires: ["yt-dlp"],
    about: "Finds videos and saves their full transcripts, so a claim can be checked against what was actually said. Search and transcripts run on your computer through yt-dlp; an optional Google key adds Data API search metadata.",
    providers: [{ name: "yt-dlp", url: "https://github.com/yt-dlp/yt-dlp" }, { name: "YouTube Data API", url: "https://developers.google.com/youtube/v3" }],
    billing: "Free. yt-dlp runs locally; the optional Google key uses your YouTube Data API quota.",
    logo: "youtube",
  },
  {
    id: "x",
    label: "X",
    description: "Posts and discourse: an evidence judge, a breadth finder and a post reader, runnable independently",
    tools: ["xsearch", "x_post", "x_search_posts", "x_count_posts", "x_users", "x_news", "x_explore", "x_bookmarks", "x_likes", "x_community"],
    skills: ["x-judge", "x-breadth", "x-post"],
    env: ["XAI_API_KEY", "X_BEARER_TOKEN", "X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET", "TIKHUB_API_KEY", "TIKHUB_BASE_URL"],
    keys: ["XAI_API_KEY", "X_BEARER_TOKEN"],
    credential: "XAI_API_KEY for xsearch; X_BEARER_TOKEN for the X API tools; optional X sign-in (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET) for people search, Communities search, bookmarks and likes; TIKHUB_API_KEY optional, for x_post's single-post fallback, Communities search without sign-in and a Community's posts",
    about: "Posts and discussion on X, read two ways: X's own API returns the posts, accounts, counts, News stories, trends, Spaces, Communities and Lists themselves, and xAI's Grok searches X live, by keyword and by meaning, watches the videos and reads the images in the posts it finds, and writes up what it finds with links to the posts. Signing in with your own X account adds people and Communities search and reading your bookmarks and likes. Three methods: X judge weighs claims by reach and kind of source; X breadth finds as many distinct posts and angles as it can without judging them; X post reads particular posts exactly, with their thread, reactions, author, spread and origin.",
    providers: [{ name: "X API", url: "https://docs.x.com/x-api/introduction" }, { name: "xAI API", url: "https://x.ai/api" }, TIKHUB],
    billing: "The X API is pay-per-use from credits in your X developer account; X does not report each call's charge, so Dig shows those calls' cost as unknown. xAI is paid per request in US dollars from your xAI account, and Dig records the cost xAI reports. TikHub, used for a single post the X API cannot read, Communities search without sign-in and a Community's posts, shows as unknown too.",
    logo: "x",
  },
  {
    id: "reddit",
    label: "Reddit",
    description: "Public posts and comments via ScrapeCreators",
    tools: ["reddit"],
    env: ["SCRAPECREATORS_API_KEY"],
    keys: ["SCRAPECREATORS_API_KEY"],
    credential: "SCRAPECREATORS_API_KEY",
    about: "Public Reddit posts and comments, searched across Reddit or inside the subreddits you name.",
    providers: [SCRAPECREATORS],
    billing: SCRAPECREATORS_CREDITS,
    logo: "reddit",
  },
  {
    id: "tikhub-reddit",
    label: "TikHub Reddit",
    description: "Advanced Reddit discovery and enrichment",
    tools: ["tikhub_reddit"],
    env: ["TIKHUB_API_KEY", "TIKHUB_BASE_URL"],
    keys: ["TIKHUB_API_KEY"],
    credential: "TIKHUB_API_KEY",
    about: "Deeper Reddit research: query scouting, subreddit context, full comment trees, public author history and batch enrichment of posts.",
    providers: [TIKHUB],
    billing: TIKHUB_UNKNOWN,
    logo: "reddit",
  },
  {
    id: "tiktok",
    label: "TikTok",
    description: "Public videos and transcripts",
    tools: ["scrapecreators_tiktok"],
    env: ["SCRAPECREATORS_API_KEY"],
    keys: ["SCRAPECREATORS_API_KEY"],
    credential: "SCRAPECREATORS_API_KEY",
    about: "Public TikTok videos found by keyword, with captions, engagement counts and transcripts when TikTok has them.",
    providers: [SCRAPECREATORS],
    billing: SCRAPECREATORS_CREDITS,
    logo: "tiktok",
  },
  {
    id: "instagram",
    label: "Instagram",
    description: "Public reels, profiles and transcripts",
    tools: ["scrapecreators_instagram"],
    env: ["SCRAPECREATORS_API_KEY"],
    keys: ["SCRAPECREATORS_API_KEY"],
    credential: "SCRAPECREATORS_API_KEY",
    about: "Public Instagram Reels, accounts, hashtags and places, with captions, engagement and transcripts when available.",
    providers: [SCRAPECREATORS],
    billing: SCRAPECREATORS_CREDITS,
    logo: "instagram",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    description: "Public profiles, companies and posts",
    tools: ["scrapecreators_linkedin"],
    env: ["SCRAPECREATORS_API_KEY"],
    keys: ["SCRAPECREATORS_API_KEY"],
    credential: "SCRAPECREATORS_API_KEY",
    about: "Public LinkedIn profiles, companies and posts from their URLs, plus keyword search of posts that search engines have indexed.",
    providers: [SCRAPECREATORS],
    billing: SCRAPECREATORS_CREDITS,
    logo: "linkedin",
  },
  {
    id: "telegram",
    label: "Telegram",
    description: "Public channels and posts",
    tools: ["scrapecreators_telegram"],
    env: ["SCRAPECREATORS_API_KEY"],
    keys: ["SCRAPECREATORS_API_KEY"],
    credential: "SCRAPECREATORS_API_KEY",
    about: "Public Telegram channels, groups and posts, read through Telegram's public web preview. No Telegram account is used.",
    providers: [SCRAPECREATORS],
    billing: SCRAPECREATORS_CREDITS,
    logo: "telegram",
  },
  {
    id: "china-social",
    label: "China social",
    description: "Seven platforms via TikHub and an optional fallback",
    tools: ["china_social_search"],
    env: [
      "TIKHUB_API_KEY",
      "TIKHUB_BASE_URL",
      "JUSTONE_API_KEY",
      "JUSTONE_BASE_URL",
    ],
    keys: ["TIKHUB_API_KEY"],
    credential: "TIKHUB_API_KEY; JUSTONE_API_KEY only for explicit fallback",
    about: "Mainland-China social platforms (Xiaohongshu, Bilibili, Douyin, Weibo, Zhihu, Kuaishou and WeChat) through TikHub, with the Just One API as a fallback used only when asked for. Reports translate what they quote.",
    providers: [TIKHUB, { name: "Just One API", url: "https://justoneapi.com" }],
    billing: `${TIKHUB_UNKNOWN} Just One needs its own key and account.`,
  },
  {
    id: "commerce",
    label: "Commerce",
    description: "Amazon products, reviews and price history",
    tools: [
      "commerce_search",
      "commerce_product",
      "commerce_history",
      "commerce_reviews",
      "commerce_discover",
    ],
    env: ["SCRAPE_DO_API_KEY", "SCRAPEDO_API_TOKEN", "NEXSCOPE_API_KEY"],
    keys: [["SCRAPE_DO_API_KEY", "SCRAPEDO_API_TOKEN"]],
    credential:
      "SCRAPE_DO_API_KEY or SCRAPEDO_API_TOKEN; NEXSCOPE_API_KEY for reviews/history",
    about: "Amazon products, search results, deals, Best Sellers and seller pages through Scrape.do, plus review samples and up to a year of price and rank history through Nexscope.",
    providers: [{ name: "Scrape.do", url: "https://scrape.do" }, { name: "Nexscope", url: "https://www.nexscope.ai" }],
    billing: "Scrape.do credits per request, which Dig records. Nexscope is paid from its own account and does not report a per-request amount, so those calls show as unknown.",
  },
  {
    id: "tiktok-ads",
    label: "TikTok ads",
    description: "Creative Center and public Ad Library",
    tools: [
      "tiktok_ads_search",
      "tiktok_ads_top",
      "tiktok_ads_detail",
      "tiktok_ad_library",
    ],
    env: ["TIKHUB_API_KEY", "TIKHUB_BASE_URL", "SCRAPECREATORS_API_KEY"],
    keys: ["TIKHUB_API_KEY", "SCRAPECREATORS_API_KEY"],
    credential:
      "TIKHUB_API_KEY for Creative Center; SCRAPECREATORS_API_KEY for Ad Library",
    about: "TikTok advertising: top ads from TikTok's Creative Center with click-through and retention analytics, and the public Ad Library of what a named advertiser is running.",
    providers: [TIKHUB, SCRAPECREATORS],
    billing: "Creative Center through TikHub (cost shown as unknown); Ad Library through ScrapeCreators credits.",
    logo: "tiktok",
  },
  {
    id: "dataforseo",
    label: "DataForSEO",
    description: "SERPs, keywords, rankings, backlinks, local business and AI visibility",
    tools: [
      "dataforseo_docs_sections",
      "dataforseo_docs_index",
      "dataforseo_docs_read",
      "dataforseo_request",
    ],
    env: ["DATAFORSEO_USERNAME", "DATAFORSEO_PASSWORD"],
    keys: ["DATAFORSEO_USERNAME", "DATAFORSEO_PASSWORD"],
    credential:
      "DATAFORSEO_USERNAME and DATAFORSEO_PASSWORD: the API login and API password from DataForSEO's API Access page, not the dashboard password",
    about: "Search-market data: Google results pages, keyword volumes, rankings, backlinks, local businesses and AI-search visibility. Dig reads DataForSEO's documentation before calling an endpoint.",
    providers: [{ name: "DataForSEO v3 API", url: "https://dataforseo.com" }],
    billing: "Paid per request in US dollars from a prepaid DataForSEO account. Dig records the cost each response reports; a free sandbox checks request shapes with dummy data.",
  },
] as const satisfies readonly DigModule[];
export type ModuleId = (typeof MODULES)[number]["id"];
export const ALL_MODULES: ModuleId[] = MODULES.map((m) => m.id);
/**
 * The provider accounts behind Dig's credentials, for the accounts list on the Sources page. One key can serve several
 * sources (one ScrapeCreators key covers six), so the list has a row per account rather than per source. `keys` holds
 * the account's keys.env names as a module's `keys` does: an inner list names aliases of one credential. Which sources
 * each serves, and whether they need it, comes from those sources' credentials in source_info. `signup` is the
 * provider's own page for creating or finding the key; `billing` is a short line drawn from the sources' catalog copy
 * and the provider's documentation, naming no price.
 */
export interface ProviderAccount {
  id: string;
  name: string;
  signup: string;
  keys: readonly (string | readonly string[])[];
  /** keys.env names the account can also supply that no source needs; they never change whether the account reads as set. */
  optional?: readonly string[];
  billing: string;
}
const UNKNOWN_COST = "Dig shows these calls’ cost as unknown, because the provider reports no per-request amount.";
/** In Sources page order: web, code, papers, video, social, then markets. Every credential name of every source is in exactly one, under its `keys` or `optional`. */
export const ACCOUNTS = [
  { id: "exa", name: "Exa", signup: "https://dashboard.exa.ai/api-keys", keys: ["EXA_API_KEY"], billing: "Paid per request in US dollars, which Dig records." },
  { id: "perplexity", name: "Perplexity API", signup: "https://console.perplexity.ai", keys: ["PERPLEXITY_API_KEY"], billing: "Paid per request in US dollars, which Dig records." },
  { id: "github", name: "GitHub", signup: "https://github.com/settings/tokens", keys: [["GH_TOKEN", "GITHUB_TOKEN"]], billing: "Free. A token, or an existing gh login, raises GitHub’s anonymous limits." },
  { id: "semantic-scholar", name: "Semantic Scholar", signup: "https://www.semanticscholar.org/product/api#api-key-form", keys: [["SEMANTIC_SCHOLAR_API_KEY", "PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY"]], billing: "Free. A key replaces the shared anonymous pool with a rate limit of your own." },
  { id: "openalex", name: "OpenAlex", signup: "https://openalex.org/settings/api", keys: [["OPENALEX_API_KEY", "PAPER_SEARCH_MCP_OPENALEX_API_KEY"]], billing: "Reports a US-dollar usage cost, which Dig records and its free daily allowance can cover; a key raises the allowance." },
  { id: "ncbi", name: "NCBI (PubMed and PMC)", signup: "https://account.ncbi.nlm.nih.gov/settings/", keys: [["NCBI_API_KEY", "PAPER_SEARCH_MCP_NCBI_API_KEY"]], billing: "Free. Used by the Papers bridge’s PubMed and PMC searches." },
  { id: "core", name: "CORE", signup: "https://core.ac.uk/services/api#form", keys: ["PAPER_SEARCH_MCP_CORE_API_KEY"], billing: "Used by the Papers bridge’s CORE search, which also works without a key." },
  { id: "google", name: "Google Cloud (YouTube Data API)", signup: "https://console.cloud.google.com/apis/credentials", keys: ["OPENCODE_RESEARCH_GOOGLE_API_KEY"], billing: "Uses your YouTube Data API quota. Adds Data API search metadata; transcripts need yt-dlp." },
  { id: "x-api", name: "X API", signup: "https://console.x.com", keys: ["X_BEARER_TOKEN"], optional: ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"], billing: `Pay-per-use credits from your X developer account. The optional sign-in keys (the app's Consumer Key and Secret and an Access Token and Secret for your own account) let Dig search people and Communities and read your bookmarks and likes as that account. ${UNKNOWN_COST}` },
  { id: "xai", name: "xAI", signup: "https://console.x.ai/team/default/api-keys", keys: ["XAI_API_KEY"], billing: "Paid per request in US dollars, which Dig records." },
  { id: "scrapecreators", name: "ScrapeCreators", signup: "https://app.scrapecreators.com", keys: ["SCRAPECREATORS_API_KEY"], billing: "ScrapeCreators credits per request, which Dig records." },
  { id: "tikhub", name: "TikHub", signup: "https://user.tikhub.io/dashboard/api", keys: ["TIKHUB_API_KEY"], billing: `Paid from your TikHub account. ${UNKNOWN_COST}` },
  { id: "justone", name: "Just One API", signup: "https://dashboard.justoneapi.com/en", keys: ["JUSTONE_API_KEY"], billing: "Its own account, used only when China social’s fallback is asked for. Dig shows these calls’ cost as unknown." },
  { id: "scrape-do", name: "Scrape.do", signup: "https://dashboard.scrape.do/", keys: [["SCRAPE_DO_API_KEY", "SCRAPEDO_API_TOKEN"]], billing: "Scrape.do credits per request, which Dig records." },
  { id: "nexscope", name: "Nexscope", signup: "https://www.nexscope.ai/seller/api-access?tab=api-keys", keys: ["NEXSCOPE_API_KEY"], billing: `Paid from your Nexscope account. ${UNKNOWN_COST}` },
  { id: "dataforseo", name: "DataForSEO", signup: "https://app.dataforseo.com/api-access", keys: ["DATAFORSEO_USERNAME", "DATAFORSEO_PASSWORD"], billing: "Prepaid; US dollars per request, which Dig records. Use the API login and API password from the API Access page, not your dashboard password." },
] as const satisfies readonly ProviderAccount[];
export const PRESETS: Record<string, readonly ModuleId[]> = {
  starter: ["hackernews", "deepwiki", "polymarket"],
  research: [
    "hackernews",
    "deepwiki",
    "github",
    "exa",
    "perplexity",
    "papers",
    "youtube",
  ],
  social: [
    "hackernews",
    "reddit",
    "tiktok",
    "instagram",
    "linkedin",
    "telegram",
    "x",
  ],
  all: ALL_MODULES,
};
/** `undefined` and `"all"` mean every module. */
export function parseModules(
  value: string | readonly string[] | undefined,
): ModuleId[] {
  if (value === undefined || value === "all") return [...ALL_MODULES];
  const names =
    typeof value === "string"
      ? value.split(",").map((x) => x.trim())
      : [...value];
  if (!names.length || names.some((x) => !ALL_MODULES.includes(x as ModuleId)))
    throw new Error(
      `Choose module IDs from: ${ALL_MODULES.join(", ")}. Use 'all' for every module.`,
    );
  return ALL_MODULES.filter((id) => names.includes(id));
}
export function selectedModules(ids: readonly ModuleId[]): DigModule[] {
  return MODULES.filter((m) => ids.includes(m.id));
}
export function reportSources(ids: readonly ModuleId[]): ModuleId[] {
  return ALL_MODULES.filter((id) => ids.includes(id));
}
/**
 * Library tools every installation has, whatever sources are enabled. Source
 * agents get research_save; dig_start and dig_finish are main-thread tools.
 */
export const CORE_TOOLS = ["research_save", "dig_start", "dig_finish"] as const;
export function moduleTools(ids: readonly ModuleId[]): string[] {
  return [...CORE_TOOLS, ...selectedModules(ids).flatMap((m) => m.tools)];
}
/** Source skills of a module (each is also a source agent); default: the module id. */
function sourceSkills(m: DigModule): readonly string[] {
  return m.skills ?? [m.id];
}
export function moduleSkills(ids: readonly ModuleId[]): string[] {
  return [
    "dig",
    "library",
    "setup",
    ...selectedModules(ids).flatMap((m: DigModule) => [
      ...sourceSkills(m),
      ...(m.helpers ?? []),
    ]),
  ];
}
/**
 * One agent per source skill, named like its skill (`x-judge`), with its
 * module's tools. Helpers (`youtube-summarizer`) are agents without source
 * tools.
 */
export interface DigAgent {
  name: string;
  skill: string;
  module: ModuleId;
  tools: string[];
  helper: boolean;
}
export function moduleAgents(ids: readonly ModuleId[]): DigAgent[] {
  const selected = selectedModules(ids);
  return selected.flatMap((m: DigModule) => {
    const agent = (skill: string, helper: boolean): DigAgent => ({
      name: skill,
      skill,
      module: m.id as ModuleId,
      tools: helper ? [] : ["research_save", ...m.tools],
      helper,
    });
    return [
      ...sourceSkills(m).map((s) => agent(s, false)),
      ...(m.helpers ?? []).map((s) => agent(s, true)),
    ];
  });
}
export function moduleEnvironment(ids: readonly ModuleId[]): string[] {
  return [
    ...new Set(selectedModules(ids).flatMap((m: DigModule) => m.env ?? [])),
  ];
}
