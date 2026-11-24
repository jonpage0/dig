/**
 * Public LinkedIn source plugin backed by ScrapeCreators (`PaidHttp`).
 *
 * Supports:
 * - kind='profile'       -> GET /v1/linkedin/profile
 * - kind='company'       -> GET /v1/linkedin/company
 * - kind='company_posts' -> GET /v1/linkedin/company/posts (page 1-7)
 * - kind='post'          -> GET /v1/linkedin/post
 * - kind='search'        -> GET /v1/linkedin/search/posts (date_posted, cursor 1-11)
 */
import { Effect, Schema } from "effect";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  type ActionOutcome,
  type SourcePlugin,
} from "../../core/plugin.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  cleanText,
  expectArray,
  failText,
  fmtMetric,
  fmtNum,
  knownCharge,
  MISSING_SCRAPECREATORS_KEY,
  provenanceLine,
  SCRAPECREATORS_BILLING,
  SCRAPECREATORS_PROVIDER,
  scrapecreatorsBilling,
  scrapecreatorsHeaders,
  scrapecreatorsRequest,
  truncate,
  validateEnum,
} from "../shared/scrapecreators.ts";

const LINKEDIN_KIND_VALUES = ["profile", "company", "company_posts", "post", "search"] as const;
const LINKEDIN_DATE_POSTED_VALUES = [
  "last-hour",
  "last-day",
  "last-week",
  "last-month",
  "last-year",
] as const;
const LINKEDIN_MAX_SEARCH_CURSOR = 11;
const LINKEDIN_MAX_COMPANY_POSTS_PAGE = 7;

function displayScalar(value: unknown): string | null {
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function unreadableLine(count: number, kind: string): string {
  return `Unreadable entries: ${count} returned entr${count === 1 ? "y" : "ies"} lacked a readable ${kind} record and ${count === 1 ? "was" : "were"} skipped.`;
}

function formatLinkedInSearch(
  data: Record<string, unknown>,
  query: string,
  datePosted: string | undefined,
  cursor: string | undefined,
  charges: readonly (number | null)[],
): ActionOutcome {
  const listed = expectArray(data, "posts", "ScrapeCreators LinkedIn post search");
  if (!listed.ok) return failed(listed.error);
  const posts = listed.items.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  const unreadable = listed.items.length - posts.length;
  const nextCursor = asString(data.cursor);
  const lines = [
    `LinkedIn public post search: "${query}"`,
    `Filters: date_posted=${datePosted ?? "(none)"} | cursor=${cursor ?? "1 (first page)"}`,
    "Source: Google-indexed public posts and Pulse articles; best-effort, not a complete LinkedIn-native search. Order as returned.",
    provenanceLine(data, charges),
    nextCursor
      ? `Next page: pass cursor="${nextCursor}"${Number(nextCursor) > LINKEDIN_MAX_SEARCH_CURSOR ? " (beyond the provider's page-11 cap)" : ""}`
      : "Next page: no cursor returned",
    `Posts returned: ${posts.length}`,
  ];
  if (unreadable) lines.push(unreadableLine(unreadable, "post"));
  if (listed.items.length === 0) {
    lines.push(
      "",
      "The provider returned an empty post list for this query and window; Google-indexed coverage is thin here, which is not proof that LinkedIn holds nothing.",
    );
  }
  for (const [index, post] of posts.entries()) {
    const author = asRecord(post.author);
    const authorName = cleanText(author?.name);
    const followers = asNumber(author?.followers);
    const likeCount = asNumber(post.likeCount);
    const commentCount = asNumber(post.commentCount);
    const comments = asArray(post.comments);
    lines.push(
      "",
      `${index + 1}. ${authorName ?? "Unknown author"}${followers !== null ? ` (${fmtNum(followers)} followers)` : ""}`,
    );
    if (cleanText(post.description)) lines.push(`   ${truncate(cleanText(post.description), 400)}`);
    lines.push(
      `   Published: ${cleanText(post.datePublished) ?? "unknown"} | Likes: ${fmtMetric(likeCount)} | Comments: ${fmtMetric(commentCount)}${comments.length ? ` (${comments.length} returned inline)` : ""}`,
    );
    if (cleanText(post.url)) lines.push(`   URL: ${cleanText(post.url)}`);
    if (cleanText(author?.url)) lines.push(`   Author URL: ${cleanText(author?.url)}`);
    const preview = comments
      .map((entry) => {
        const comment = asRecord(entry);
        const text = cleanText(comment?.text);
        return text ? `${cleanText(comment?.author) ?? "Unknown"}: ${truncate(text, 140)}` : null;
      })
      .filter((value): value is string => value !== null)
      .slice(0, 2);
    if (preview.length) lines.push(`   Comment previews: ${preview.join(" || ")}`);
  }
  const status = listed.items.length === 0 ? "empty" : unreadable ? "partial" : "success";
  return outcome(status, lines.join("\n"), {
    provider: "scrapecreators",
    kind: "search",
    query,
    date_posted: datePosted ?? null,
    cursor: nextCursor,
    posts: posts.length,
    unreadable,
    credits_charged: knownCharge(charges),
    urls: posts.map((post) => asString(post.url)).filter((value): value is string => value !== null),
  });
}

function formatLinkedInProfile(
  data: Record<string, unknown>,
  sourceUrl: string,
  charges: readonly (number | null)[],
): ActionOutcome {
  const lines: string[] = [];
  const name = cleanText(data.name) || "Unknown profile";
  const followers = asNumber(data.followers);
  const recentPosts = asArray(data.recentPosts).slice(0, 5);
  const activity = asArray(data.activity).slice(0, 5);
  const articles = asArray(data.articles).slice(0, 3);
  const experience = asArray(data.experience).slice(0, 5);
  const education = asArray(data.education).slice(0, 3);
  const publications = asArray(data.publications).slice(0, 5);
  const projects = asArray(data.projects).slice(0, 3);
  const recommendations = asArray(data.recommendations).slice(0, 3);
  const similarProfiles = asArray(data.similarProfiles).slice(0, 5);

  lines.push(`LinkedIn profile: ${name}`);
  lines.push(`URL: ${sourceUrl}`);
  lines.push(provenanceLine(data, charges));
  if (cleanText(data.location)) lines.push(`Location: ${cleanText(data.location)}`);
  if (followers !== null) lines.push(`Followers: ${fmtNum(followers)}`);
  if (cleanText(data.connections)) lines.push(`Connections: ${cleanText(data.connections)}`);
  if (cleanText(data.about)) {
    lines.push("");
    lines.push(`About: ${truncate(cleanText(data.about), 500)}`);
  }

  if (recentPosts.length > 0) {
    lines.push("", "Recent Posts:");
    for (const item of recentPosts) {
      const record = asRecord(item);
      if (!record) continue;
      const title = cleanText(record.title) || "Untitled post";
      lines.push(`- ${truncate(title, 220)}`);
      if (cleanText(record.activityType)) lines.push(`  Activity: ${cleanText(record.activityType)}`);
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`);
    }
  }

  if (activity.length > 0) {
    lines.push("", "Recent Activity:");
    for (const item of activity) {
      const record = asRecord(item);
      if (!record) continue;
      const title = cleanText(record.title) || "Untitled activity";
      lines.push(`- ${truncate(title, 220)}`);
      if (cleanText(record.activityType)) lines.push(`  Activity: ${cleanText(record.activityType)}`);
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`);
    }
  }

  if (articles.length > 0) {
    lines.push("", "Articles:");
    for (const item of articles) {
      const record = asRecord(item);
      if (!record) continue;
      const headline = cleanText(record.headline) || "Untitled article";
      lines.push(`- ${truncate(headline, 220)}`);
      if (cleanText(record.datePublished)) lines.push(`  Published: ${cleanText(record.datePublished)}`);
      if (cleanText(record.articleBody)) {
        lines.push(`  Excerpt: ${truncate(cleanText(record.articleBody), 220)}`);
      }
    }
  }

  if (experience.length > 0) {
    lines.push("", "Experience:");
    for (const item of experience) {
      const record = asRecord(item);
      if (!record) continue;
      const orgName = cleanText(record.name) || "Unknown organization";
      lines.push(`- ${orgName}`);
      if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`);
      if (cleanText(record.location)) lines.push(`  Location: ${cleanText(record.location)}`);
      const member = asRecord(record.member);
      const roleDescription = member ? cleanText(member.description) : null;
      const startDate = member ? displayScalar(member.startDate) : null;
      const endDate = member ? displayScalar(member.endDate) : null;
      if (startDate || endDate) {
        lines.push(`  Dates: ${startDate || "?"} - ${endDate || "Present"}`);
      }
      if (roleDescription) lines.push(`  Role: ${truncate(roleDescription, 180)}`);
    }
  }

  if (education.length > 0) {
    lines.push("", "Education:");
    for (const item of education) {
      const record = asRecord(item);
      if (!record) continue;
      const schoolName = cleanText(record.name) || "Unknown school";
      lines.push(`- ${schoolName}`);
      if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`);
      const member = asRecord(record.member);
      const startDate = member ? displayScalar(member.startDate) : null;
      const endDate = member ? displayScalar(member.endDate) : null;
      if (startDate || endDate) {
        lines.push(`  Dates: ${startDate || "?"} - ${endDate || "Present"}`);
      }
    }
  }

  if (publications.length > 0) {
    lines.push("", "Publications:");
    for (const item of publications) {
      const record = asRecord(item);
      if (!record) continue;
      const publicationName = cleanText(record.name) || "Untitled publication";
      lines.push(`- ${publicationName}`);
      if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`);
    }
  }

  if (projects.length > 0) {
    lines.push("", "Projects:");
    for (const item of projects) {
      const record = asRecord(item);
      if (!record) continue;
      const projectName = cleanText(record.name) || "Untitled project";
      lines.push(`- ${projectName}`);
      if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`);
      if (cleanText(record.dateRange)) lines.push(`  Date Range: ${cleanText(record.dateRange)}`);
      if (cleanText(record.description)) {
        lines.push(`  Description: ${truncate(cleanText(record.description), 220)}`);
      }
      const contributors = asArray(record.contributors).slice(0, 4);
      if (contributors.length > 0) {
        lines.push(
          `  Contributors: ${contributors
            .map((contributor) => cleanText(asRecord(contributor)?.name))
            .filter((value): value is string => Boolean(value))
            .join(", ")}`,
        );
      }
    }
  }

  if (recommendations.length > 0) {
    lines.push("", "Recommendations:");
    for (const item of recommendations) {
      const record = asRecord(item);
      if (!record) continue;
      const recommender = cleanText(record.name) || "Unknown recommender";
      lines.push(`- ${recommender}`);
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`);
      if (cleanText(record.text)) lines.push(`  Text: ${truncate(cleanText(record.text), 240)}`);
    }
  }

  if (similarProfiles.length > 0) {
    lines.push("", "Similar Profiles:");
    for (const item of similarProfiles) {
      const record = asRecord(item);
      if (!record) continue;
      const profileName = cleanText(record.name) || "Unknown profile";
      lines.push(`- ${profileName}`);
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`);
    }
  }

  return outcome("success", lines.join("\n"), {
    provider: "scrapecreators",
    kind: "profile",
    url: sourceUrl,
    credits_charged: knownCharge(charges),
  });
}

function formatLinkedInCompany(
  data: Record<string, unknown>,
  sourceUrl: string,
  charges: readonly (number | null)[],
): ActionOutcome {
  const lines: string[] = [];
  const name = cleanText(data.name) || "Unknown company";
  const employeeCount = asNumber(data.employeeCount);
  const posts = asArray(data.posts).slice(0, 5);
  const employees = asArray(data.employees).slice(0, 5);
  const specialties = asArray(data.specialties)
    .map((value) => cleanText(value))
    .filter((value): value is string => Boolean(value))
    .slice(0, 12);

  lines.push(`LinkedIn company page: ${name}`);
  lines.push(`URL: ${sourceUrl}`);
  lines.push(provenanceLine(data, charges));
  if (cleanText(data.website)) lines.push(`Website: ${cleanText(data.website)}`);
  if (cleanText(data.industry)) lines.push(`Industry: ${cleanText(data.industry)}`);
  if (cleanText(data.size)) lines.push(`Size: ${cleanText(data.size)}`);
  if (employeeCount !== null) lines.push(`Employee count: ${fmtNum(employeeCount)}`);
  if (cleanText(data.headquarters)) lines.push(`Headquarters: ${cleanText(data.headquarters)}`);
  if (cleanText(data.type)) lines.push(`Type: ${cleanText(data.type)}`);
  if (asNumber(data.founded) !== null) lines.push(`Founded: ${asNumber(data.founded)}`);
  if (cleanText(data.slogan)) lines.push(`Slogan: ${cleanText(data.slogan)}`);
  if (cleanText(data.description)) {
    lines.push("", `Description: ${truncate(cleanText(data.description), 700)}`);
  }

  if (specialties.length > 0) {
    lines.push("", `Specialties: ${specialties.join(", ")}`);
  }

  if (employees.length > 0) {
    lines.push("", "Notable Employees:");
    for (const item of employees) {
      const record = asRecord(item);
      if (!record) continue;
      const employeeName = cleanText(record.name) || "Unknown employee";
      lines.push(`- ${employeeName}`);
      if (cleanText(record.title)) lines.push(`  Title: ${cleanText(record.title)}`);
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`);
    }
  }

  if (posts.length > 0) {
    lines.push("", "Recent Posts Embedded In Company Page:");
    for (const item of posts) {
      const record = asRecord(item);
      if (!record) continue;
      const text = cleanText(record.text) || "Untitled post";
      lines.push(`- ${truncate(text, 260)}`);
      if (cleanText(record.datePublished)) lines.push(`  Published: ${cleanText(record.datePublished)}`);
      if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`);
    }
  }

  return outcome("success", lines.join("\n"), {
    provider: "scrapecreators",
    kind: "company",
    url: sourceUrl,
    credits_charged: knownCharge(charges),
  });
}

function formatLinkedInCompanyPosts(
  data: Record<string, unknown>,
  sourceUrl: string,
  page: number,
  charges: readonly (number | null)[],
): ActionOutcome {
  const lines: string[] = [];
  const listed = expectArray(data, "posts", "ScrapeCreators LinkedIn company posts");
  if (!listed.ok) return failed(listed.error);
  const posts = listed.items.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  const unreadable = listed.items.length - posts.length;

  lines.push(`LinkedIn company posts: ${sourceUrl}`);
  lines.push(`Page: ${page} of at most ${LINKEDIN_MAX_COMPANY_POSTS_PAGE}`);
  lines.push(provenanceLine(data, charges));

  if (listed.items.length === 0) {
    lines.push("", "The provider returned an empty post list for this page.");
    return outcome("empty", lines.join("\n"), {
      provider: "scrapecreators",
      kind: "company_posts",
      url: sourceUrl,
      page,
      posts: 0,
      unreadable: 0,
      credits_charged: knownCharge(charges),
    });
  }

  lines.push("", `Posts returned: ${posts.length}`);
  if (unreadable) lines.push(unreadableLine(unreadable, "post"));
  lines.push("");

  for (const record of posts) {
    const text = cleanText(record.text) || "Untitled post";
    lines.push(`- ${truncate(text, 320)}`);
    if (cleanText(record.datePublished)) lines.push(`  Published: ${cleanText(record.datePublished)}`);
    if (cleanText(record.url)) lines.push(`  URL: ${cleanText(record.url)}`);
    if (cleanText(record.id)) lines.push(`  Post ID: ${cleanText(record.id)}`);
  }

  return outcome(unreadable ? "partial" : "success", lines.join("\n"), {
    provider: "scrapecreators",
    kind: "company_posts",
    url: sourceUrl,
    page,
    posts: posts.length,
    unreadable,
    credits_charged: knownCharge(charges),
  });
}

function formatLinkedInPost(
  data: Record<string, unknown>,
  sourceUrl: string,
  charges: readonly (number | null)[],
): ActionOutcome {
  const lines: string[] = [];
  const comments = asArray(data.comments).slice(0, 5);
  const moreArticles = asArray(data.moreArticles).slice(0, 3);
  const likeCount = asNumber(data.likeCount);
  const commentCount = asNumber(data.commentCount);
  const author = asRecord(data.author);

  lines.push(`LinkedIn post: ${cleanText(data.name) || cleanText(data.headline) || "Untitled post"}`);
  lines.push(`URL: ${sourceUrl}`);
  lines.push(provenanceLine(data, charges));
  if (cleanText(data.headline)) lines.push(`Headline: ${truncate(cleanText(data.headline), 260)}`);
  if (cleanText(data.datePublished)) lines.push(`Published: ${cleanText(data.datePublished)}`);
  if (likeCount !== null || commentCount !== null) {
    lines.push(
      `Engagement: ${likeCount !== null ? `${fmtNum(likeCount)} likes` : "likes unknown"} | ${commentCount !== null ? `${fmtNum(commentCount)} comments` : "comments unknown"}`,
    );
  }

  if (author) {
    lines.push("", "Author:");
    if (cleanText(author.name)) lines.push(`- Name: ${cleanText(author.name)}`);
    if (cleanText(author.url)) lines.push(`- URL: ${cleanText(author.url)}`);
    const authorFollowers = asNumber(author.followers);
    if (authorFollowers !== null) lines.push(`- Followers: ${fmtNum(authorFollowers)}`);
  }

  if (cleanText(data.description)) {
    lines.push("", `Description: ${truncate(cleanText(data.description), 700)}`);
  }

  if (comments.length > 0) {
    lines.push("", "Comments:");
    for (const item of comments) {
      const record = asRecord(item);
      if (!record) continue;
      const authorName = cleanText(record.author) || "Unknown commenter";
      const text = cleanText(record.text) || "";
      lines.push(`- ${authorName}: ${truncate(text, 220)}`);
      if (cleanText(record.linkedinUrl)) lines.push(`  URL: ${cleanText(record.linkedinUrl)}`);
    }
  }

  if (moreArticles.length > 0) {
    lines.push("", "Related Articles:");
    for (const item of moreArticles) {
      const record = asRecord(item);
      if (!record) continue;
      const title = cleanText(record.title) || "Untitled article";
      lines.push(`- ${truncate(title, 220)}`);
      if (cleanText(record.datePublished)) lines.push(`  Published: ${cleanText(record.datePublished)}`);
      if (cleanText(record.link)) lines.push(`  URL: ${cleanText(record.link)}`);
      const reactions = asNumber(record.reactionCount);
      const commentsCount = asNumber(record.commentCount);
      if (reactions !== null || commentsCount !== null) {
        lines.push(
          `  Engagement: ${reactions !== null ? `${fmtNum(reactions)} reactions` : "reactions unknown"} | ${commentsCount !== null ? `${fmtNum(commentsCount)} comments` : "comments unknown"}`,
        );
      }
    }
  }

  return outcome("success", lines.join("\n"), {
    provider: "scrapecreators",
    kind: "post",
    url: sourceUrl,
    credits_charged: knownCharge(charges),
  });
}

const LinkedInSchema = Schema.Struct({
  kind: Schema.Literals(LINKEDIN_KIND_VALUES).annotate({
    description: "LinkedIn resource kind; search finds public posts by keyword.",
  }),
  url: Schema.optionalKey(Schema.String).annotate({
    description: "Public LinkedIn URL. Required for every kind except search.",
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description: "kind='search' only. Keyword or phrase for Google-indexed public LinkedIn posts.",
  }),
  page: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LINKEDIN_MAX_COMPANY_POSTS_PAGE })),
  ).annotate({
    description: "kind='company_posts' only. Company posts page (default: 1, max: 7).",
  }),
  date_posted: Schema.optionalKey(Schema.Literals(LINKEDIN_DATE_POSTED_VALUES)).annotate({
    description: "kind='search' only. Google-indexed date window.",
  }),
  cursor: Schema.optionalKey(Schema.String).annotate({
    description: "kind='search' only. Cursor from the previous search response (pages 1-11).",
  }),
});

export const linkedinAction = defineAction({
  name: "scrapecreators_linkedin",
  description:
    "Fetch public LinkedIn data via ScrapeCreators. kind='profile' | 'company' | 'company_posts' | 'post' take an exact public URL. " +
    "kind='search' finds public posts and Pulse articles by keyword through Google-indexed results (/v1/linkedin/search/posts) with date_posted and cursor pages 1-11; " +
    "it is best-effort, not a complete LinkedIn-native search. Requires SCRAPECREATORS_API_KEY; 1 credit per request. No login is used and only public data is returned.",
  schema: LinkedInSchema,
  billing: scrapecreatorsBilling,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const headers = scrapecreatorsHeaders();
      if (!headers) return failed(MISSING_SCRAPECREATORS_KEY);
      const invalid =
        validateEnum("kind", args.kind, LINKEDIN_KIND_VALUES) ??
        validateEnum("date_posted", args.date_posted, LINKEDIN_DATE_POSTED_VALUES);
      if (invalid) return failed(invalid);
      const kind = args.kind;

      if (kind === "search") {
        if (args.url !== undefined) {
          return failed("url applies to profile/company/company_posts/post; kind='search' takes query.");
        }
        if (args.page !== undefined) {
          return failed("page applies to kind='company_posts' only; search paginates with cursor.");
        }
        const query = cleanText(args.query);
        if (!query) return failed("query is required for kind='search'.");
        const cursor = args.cursor?.trim();
        if (cursor) {
          const numeric = Number(cursor);
          if (!Number.isInteger(numeric) || numeric < 1 || numeric > LINKEDIN_MAX_SEARCH_CURSOR) {
            return failed(
              `cursor must be the value returned by the previous search (1-${LINKEDIN_MAX_SEARCH_CURSOR}); the provider rejects cursor 12 or greater.`,
            );
          }
        }
        const response = yield* scrapecreatorsRequest(
          "/v1/linkedin/search/posts",
          { query, date_posted: args.date_posted, cursor },
          headers,
          ctx,
          "ScrapeCreators LinkedIn post search",
        );
        if (!response.ok) {
          return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
        }
        return formatLinkedInSearch(response.payload, query, args.date_posted, cursor, response.charges);
      }

      if (args.query !== undefined) return failed("query applies to kind='search' only.");
      if (args.date_posted !== undefined || args.cursor !== undefined) {
        return failed("date_posted and cursor apply to kind='search' only.");
      }
      const url = args.url?.trim();
      if (!url) return failed(`url is required for kind='${kind}'.`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return failed("url must be a full public LinkedIn URL.");
      }
      if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) {
        return failed("url must be a linkedin.com URL.");
      }
      if (kind !== "company_posts" && args.page !== undefined) {
        return failed("page applies to kind='company_posts' only.");
      }
      if (
        args.page !== undefined &&
        (!Number.isInteger(args.page) || args.page < 1 || args.page > LINKEDIN_MAX_COMPANY_POSTS_PAGE)
      ) {
        return failed(`page must be an integer from 1 to ${LINKEDIN_MAX_COMPANY_POSTS_PAGE}.`);
      }
      const page = args.page ?? 1;

      const path =
        kind === "profile"
          ? "/v1/linkedin/profile"
          : kind === "company"
            ? "/v1/linkedin/company"
            : kind === "company_posts"
              ? "/v1/linkedin/company/posts"
              : "/v1/linkedin/post";
      const response = yield* scrapecreatorsRequest(
        path,
        { url, page: kind === "company_posts" ? page : undefined },
        headers,
        ctx,
        `ScrapeCreators LinkedIn ${kind.replace("_", " ")}`,
      );
      if (!response.ok) {
        return outcome(response.cancelled ? "cancelled" : "failed", failText(response));
      }

      switch (kind) {
        case "profile":
          return formatLinkedInProfile(response.payload, url, response.charges);
        case "company":
          return formatLinkedInCompany(response.payload, url, response.charges);
        case "company_posts":
          return formatLinkedInCompanyPosts(response.payload, url, page, response.charges);
        case "post":
          return formatLinkedInPost(response.payload, url, response.charges);
      }
    }),
});

export const linkedinSource: SourcePlugin = defineSource({
  id: "linkedin",
  group: "social",
  label: "LinkedIn",
  description: "Public profiles, companies and posts",
  about:
    "Public LinkedIn profiles, companies and posts from their URLs, plus keyword search of posts that search engines have indexed.",
  providers: [SCRAPECREATORS_PROVIDER],
  billing: SCRAPECREATORS_BILLING,
  logo: "linkedin",
  env: ["SCRAPECREATORS_API_KEY"],
  keys: ["SCRAPECREATORS_API_KEY"],
  credential: "SCRAPECREATORS_API_KEY",
  actions: [linkedinAction],
});

export default linkedinSource;
