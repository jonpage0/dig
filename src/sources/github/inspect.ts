import { Effect, Schema } from "effect";
import type { FreeHttp } from "../../core/http.ts";
import { defineAction, failed, outcome } from "../../core/plugin.ts";
import {
  apiUrl,
  asArray,
  asNumber,
  asRecord,
  asString,
  authLabel,
  clampInt,
  DAY_MS,
  describeFailure,
  fmtDate,
  fmtNum,
  githubRequest,
  hasNextPage,
  isBotLogin,
  loadPublicRepo,
  MAINTAINER_ASSOCIATIONS,
  parseRepo,
  redactSecrets,
  repoPath,
  truncate,
  WEEK_MS,
  type Auth,
  type RepoMetadata,
  type RepoRef,
  type RequestContext,
} from "./client.ts";

const INSPECT_DEFAULT_DAYS = 90;
const INSPECT_MIN_DAYS = 7;
const INSPECT_MAX_DAYS = 365;
const INSPECT_DEFAULT_SAMPLES = 5;
const INSPECT_MAX_SAMPLES = 20;
const STAR_HISTORY_PER_PAGE = 30;
const STAR_HISTORY_PAGE_CAP = 4;
const COMMITS_PER_PAGE = 100;
const COMMITS_PAGE_CAP = 3;
const RELEASES_PER_PAGE = 10;
const CONTRIBUTORS_PER_PAGE = 100;
const CONTRIBUTORS_SHOWN = 10;
const ISSUE_COMMENT_SAMPLE = 5;
const PR_REVIEW_SAMPLE = 10;
const REVIEWS_QUOTED_PER_PR = 2;
const QUOTE_MAX_CHARS = 200;

type StarBucket = "current" | "window" | "prior" | "older";

interface StarWeek {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly total: number;
  readonly days: readonly number[];
  readonly bucket: StarBucket;
}

interface StarSpan {
  readonly weeks: number;
  readonly start: string;
  readonly end: string;
  readonly total: number;
}

interface StarHistory {
  readonly weeks: readonly StarWeek[];
  readonly weeksPerWindow: number;
  readonly current: (StarWeek & { readonly daysElapsed: number }) | null;
  readonly window: StarSpan | null;
  readonly prior: StarSpan | null;
  readonly historyExhausted: boolean;
  readonly pagesFetched: number;
}

interface CommitRecord {
  readonly sha: string;
  readonly date: string | null;
  readonly author: string;
  readonly login: string | null;
  readonly bot: boolean;
  readonly merge: boolean;
  readonly message: string;
}

interface CommitSummary {
  readonly count: number;
  readonly capped: boolean;
  readonly mergeCommits: number;
  readonly humanAuthors: readonly string[];
  readonly botAuthors: readonly string[];
  readonly unlinkedAuthors: number;
  readonly latest: {
    readonly sha: string;
    readonly date: string | null;
    readonly author: string;
    readonly message: string;
  } | null;
  readonly latestOutsideWindow: {
    readonly sha: string;
    readonly date: string | null;
    readonly author: string;
    readonly message: string;
  } | null;
}

interface ReleaseSummary {
  readonly listed: number;
  readonly inWindow: number;
  readonly latest: {
    readonly tag: string;
    readonly publishedAt: string | null;
    readonly prerelease: boolean;
    readonly url: string | null;
  } | null;
  readonly moreMayExist: boolean;
}

interface ContributorSummary {
  readonly listed: number;
  readonly moreExist: boolean;
  readonly top: readonly {
    readonly login: string;
    readonly contributions: number | null;
    readonly bot: boolean;
  }[];
  readonly bots: number;
}

interface ReviewQuote {
  readonly reviewer: string;
  readonly bot: boolean;
  readonly state: string;
  readonly submittedAt: string | null;
  readonly url: string | null;
  readonly quote: string | null;
}

interface PullSample {
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly author: string;
  readonly authorBot: boolean;
  readonly association: string;
  readonly mergedAt: string | null;
  readonly mergedBy: string | null;
  readonly reviewCount: number;
  readonly reviewsSampled: number;
  readonly reviewsCapped: boolean;
  readonly humanReviewers: readonly string[];
  readonly botReviewers: readonly string[];
  readonly approvedByHuman: boolean;
  readonly approvedByBot: boolean;
  readonly reviews: readonly ReviewQuote[];
}

interface CommentQuote {
  readonly login: string;
  readonly association: string;
  readonly hours: number;
  readonly url: string | null;
  readonly quote: string | null;
}

interface IssueSample {
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly author: string;
  readonly authorBot: boolean;
  readonly association: string;
  readonly createdAt: string | null;
  readonly closedAt: string | null;
  readonly commentCount: number;
  readonly firstMaintainerResponse: CommentQuote | null;
  readonly commentsSampled: number;
}

interface GraphqlEvidence {
  readonly mergedTotal: number;
  readonly pulls: readonly PullSample[];
  readonly openTotal: number;
  readonly openIssues: readonly IssueSample[];
  readonly closedTotal: number;
  readonly closedIssues: readonly IssueSample[];
  readonly cost: number | null;
}

type Section<T> =
  | { readonly ok: true; readonly data: T; readonly partialNote?: string }
  | { readonly ok: false; readonly error: string; readonly limit?: true };

// ---------------------------------------------------------------------------
// Section fetchers
// ---------------------------------------------------------------------------

function fmtWeekEnd(weekStartMs: number): string {
  return new Date(weekStartMs + WEEK_MS - DAY_MS).toISOString().slice(0, 10);
}

function normalizeStarWeek(
  raw: unknown,
): { readonly weekStartMs: number; readonly total: number; readonly days: readonly number[] } | null {
  const record = asRecord(raw);
  const weekSeconds = asNumber(record?.week);
  const total = asNumber(record?.total);
  if (!record || weekSeconds === null || total === null) return null;
  const days: number[] = [];
  for (const day of asArray(record.days)) {
    const count = asNumber(day);
    if (count === null) return null;
    days.push(count);
  }
  return { weekStartMs: weekSeconds * 1_000, total, days };
}

function starSpan(weeks: readonly StarWeek[]): StarSpan | null {
  if (weeks.length === 0) return null;
  return {
    weeks: weeks.length,
    start: weeks[weeks.length - 1]!.weekStart,
    end: weeks[0]!.weekEnd,
    total: weeks.reduce((sum, week) => sum + week.total, 0),
  };
}

function fetchStarHistory(
  repo: RepoRef,
  auth: Auth,
  ctx: RequestContext,
  days: number,
  nowMs: number,
): Effect.Effect<Section<StarHistory>, never, FreeHttp> {
  return Effect.gen(function* () {
    const weeksPerWindow = Math.ceil(days / 7);
    const weeks: StarWeek[] = [];
    let pagesFetched = 0;
    let historyExhausted = false;
    let partialNote: string | undefined;

    while (pagesFetched < STAR_HISTORY_PAGE_CAP && weeks.length < weeksPerWindow * 2 + 1) {
      const req = yield* githubRequest(
        apiUrl(repoPath(repo, "/stargazers/history"), {
          per_page: STAR_HISTORY_PER_PAGE,
          page: pagesFetched + 1,
        }),
        auth,
        ctx,
      );
      if (!req.ok) {
        const error = `Star history unavailable: ${req.error}`;
        if (pagesFetched === 0) return { ok: false as const, error };
        partialNote = `star history truncated after page ${pagesFetched}: ${error}`;
        break;
      }
      const { response } = req;
      if (response.status !== 200 || !Array.isArray(response.payload)) {
        const error = describeFailure(response, `star history page ${pagesFetched + 1}`);
        if (pagesFetched === 0) return { ok: false as const, error };
        partialNote = `star history truncated after page ${pagesFetched}: ${error}`;
        break;
      }
      pagesFetched++;
      for (const entry of response.payload) {
        const bucket = normalizeStarWeek(entry);
        if (!bucket) {
          return {
            ok: false as const,
            error:
              "GitHub star history returned a malformed bucket (missing numeric week or total); section withheld",
          };
        }
        const isCurrent = bucket.weekStartMs <= nowMs && nowMs < bucket.weekStartMs + WEEK_MS;
        const completeIndex = weeks.filter((week) => week.bucket !== "current").length;
        weeks.push({
          weekStart: new Date(bucket.weekStartMs).toISOString().slice(0, 10),
          weekEnd: fmtWeekEnd(bucket.weekStartMs),
          total: bucket.total,
          days: bucket.days,
          bucket: isCurrent
            ? "current"
            : completeIndex < weeksPerWindow
              ? "window"
              : completeIndex < weeksPerWindow * 2
                ? "prior"
                : "older",
        });
      }
      if (response.payload.length < STAR_HISTORY_PER_PAGE) {
        historyExhausted = true;
        break;
      }
    }

    const currentWeek = weeks.find((week) => week.bucket === "current");
    const window = weeks.filter((week) => week.bucket === "window");
    const prior = weeks.filter((week) => week.bucket === "prior");
    const data: StarHistory = {
      weeks,
      weeksPerWindow,
      current: currentWeek
        ? {
            ...currentWeek,
            daysElapsed: Math.min(7, Math.floor((nowMs - Date.parse(currentWeek.weekStart)) / DAY_MS) + 1),
          }
        : null,
      window: starSpan(window),
      prior: window.length === weeksPerWindow && prior.length === weeksPerWindow ? starSpan(prior) : null,
      historyExhausted,
      pagesFetched,
    };
    return partialNote ? { ok: true as const, data, partialNote } : { ok: true as const, data };
  });
}

function normalizeCommit(raw: unknown): CommitRecord | null {
  const record = asRecord(raw);
  const sha = asString(record?.sha);
  if (!record || !sha) return null;
  const commit = asRecord(record.commit);
  const commitAuthor = asRecord(commit?.author);
  const committer = asRecord(commit?.committer);
  const author = asRecord(record.author);
  const login = asString(author?.login);
  return {
    sha,
    date: asString(committer?.date),
    author: login ?? `${asString(commitAuthor?.name) ?? "unknown"} (no linked GitHub account)`,
    login,
    bot: isBotLogin(login, asString(author?.type)),
    merge: asArray(record.parents).length > 1,
    message: truncate(asString(commit?.message)?.split("\n")[0] ?? null, 100) ?? "(no message)",
  };
}

function fetchCommits(
  repo: RepoRef,
  auth: Auth,
  ctx: RequestContext,
  branch: string,
  windowStartIso: string,
): Effect.Effect<Section<CommitSummary>, never, FreeHttp> {
  return Effect.gen(function* () {
    const commits: CommitRecord[] = [];
    let capped = false;
    let partialNote: string | undefined;

    for (let page = 1; ; page++) {
      const req = yield* githubRequest(
        apiUrl(repoPath(repo, "/commits"), {
          sha: branch,
          since: windowStartIso,
          per_page: COMMITS_PER_PAGE,
          page,
        }),
        auth,
        ctx,
      );
      if (!req.ok) {
        const error = `Default-branch commits unavailable: ${req.error}`;
        if (page === 1) return { ok: false as const, error };
        partialNote = `commit listing truncated after page ${page - 1} (${commits.length} commits kept): ${error}`;
        break;
      }
      const { response } = req;
      if (response.status === 409) break;
      if (response.status !== 200 || !Array.isArray(response.payload)) {
        const error = describeFailure(response, `commits on ${branch}, page ${page}`);
        if (page === 1) return { ok: false as const, error };
        partialNote = `commit listing truncated after page ${page - 1} (${commits.length} commits kept): ${error}`;
        break;
      }
      for (const entry of response.payload) {
        const commit = normalizeCommit(entry);
        if (commit) commits.push(commit);
      }
      if (!hasNextPage(response.headers)) break;
      if (page === COMMITS_PAGE_CAP) {
        capped = true;
        break;
      }
    }

    let latestOutsideWindow: CommitSummary["latestOutsideWindow"] = null;
    if (commits.length === 0) {
      const req = yield* githubRequest(
        apiUrl(repoPath(repo, "/commits"), { sha: branch, per_page: 1 }),
        auth,
        ctx,
      );
      if (!req.ok) {
        return { ok: false as const, error: `Default-branch commits unavailable: ${req.error}` };
      }
      const { response } = req;
      if (response.status === 200 && Array.isArray(response.payload)) {
        const latest = normalizeCommit(response.payload[0]);
        if (latest) {
          latestOutsideWindow = {
            sha: latest.sha,
            date: latest.date,
            author: latest.author,
            message: latest.message,
          };
        }
      } else if (response.status !== 409) {
        return { ok: false as const, error: describeFailure(response, `latest commit on ${branch}`) };
      }
    }

    const humans = new Set<string>();
    const bots = new Set<string>();
    let unlinked = 0;
    for (const commit of commits) {
      if (commit.login === null) unlinked++;
      else if (commit.bot) bots.add(commit.login);
      else humans.add(commit.login);
    }
    const latest = commits[0];
    const data: CommitSummary = {
      count: commits.length,
      capped,
      mergeCommits: commits.filter((commit) => commit.merge).length,
      humanAuthors: [...humans],
      botAuthors: [...bots],
      unlinkedAuthors: unlinked,
      latest: latest
        ? { sha: latest.sha, date: latest.date, author: latest.author, message: latest.message }
        : null,
      latestOutsideWindow,
    };
    return partialNote ? { ok: true as const, data, partialNote } : { ok: true as const, data };
  });
}

function fetchReleases(
  repo: RepoRef,
  auth: Auth,
  ctx: RequestContext,
  windowStartMs: number,
): Effect.Effect<Section<ReleaseSummary>, never, FreeHttp> {
  return Effect.gen(function* () {
    const req = yield* githubRequest(
      apiUrl(repoPath(repo, "/releases"), { per_page: RELEASES_PER_PAGE }),
      auth,
      ctx,
    );
    if (!req.ok) return { ok: false as const, error: `Releases unavailable: ${req.error}` };
    const { response } = req;
    if (response.status !== 200 || !Array.isArray(response.payload)) {
      return { ok: false as const, error: describeFailure(response, "releases") };
    }
    const releases = response.payload
      .map((entry) => {
        const record = asRecord(entry);
        if (!record || record.draft === true) return null;
        return {
          tag: asString(record.tag_name) ?? asString(record.name) ?? "(untagged)",
          publishedAt: asString(record.published_at),
          prerelease: record.prerelease === true,
          url: asString(record.html_url),
        };
      })
      .filter((release): release is NonNullable<typeof release> => release !== null);

    let latest: ReleaseSummary["latest"] = null;
    let latestTime = -Infinity;
    for (const release of releases) {
      const time = Date.parse(release.publishedAt ?? "");
      if (Number.isFinite(time) && time > latestTime) {
        latest = release;
        latestTime = time;
      }
    }
    const inWindow = releases.filter(
      (release) => release.publishedAt !== null && Date.parse(release.publishedAt) >= windowStartMs,
    ).length;
    return {
      ok: true as const,
      data: {
        listed: releases.length,
        inWindow,
        latest,
        moreMayExist: response.payload.length === RELEASES_PER_PAGE,
      },
    };
  });
}

function fetchContributors(
  repo: RepoRef,
  auth: Auth,
  ctx: RequestContext,
): Effect.Effect<Section<ContributorSummary>, never, FreeHttp> {
  return Effect.gen(function* () {
    const req = yield* githubRequest(
      apiUrl(repoPath(repo, "/contributors"), { per_page: CONTRIBUTORS_PER_PAGE, anon: "false" }),
      auth,
      ctx,
    );
    if (!req.ok) return { ok: false as const, error: `Contributors unavailable: ${req.error}` };
    const { response } = req;
    if (response.status === 204) {
      return { ok: true as const, data: { listed: 0, moreExist: false, top: [], bots: 0 } };
    }
    if (
      response.status === 403 &&
      /too large/i.test(asString(asRecord(response.payload)?.message) ?? "")
    ) {
      return {
        ok: false as const,
        error: "GitHub declined to list contributors: the history is too large for the contributors endpoint",
      };
    }
    if (response.status !== 200 || !Array.isArray(response.payload)) {
      return { ok: false as const, error: describeFailure(response, "contributors") };
    }
    const contributors = response.payload
      .map((entry) => {
        const record = asRecord(entry);
        const login = asString(record?.login);
        if (!record || !login) return null;
        return {
          login,
          contributions: asNumber(record.contributions),
          bot: isBotLogin(login, asString(record.type)),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return {
      ok: true as const,
      data: {
        listed: contributors.length,
        moreExist: hasNextPage(response.headers),
        top: contributors.slice(0, CONTRIBUTORS_SHOWN),
        bots: contributors.filter((entry) => entry.bot).length,
      },
    };
  });
}

const EVIDENCE_QUERY = `
query($owner: String!, $name: String!, $samples: Int!, $comments: Int!, $reviews: Int!) {
  rateLimit { cost }
  repository(owner: $owner, name: $name) {
    isPrivate
    mergedPullRequests: pullRequests(states: MERGED, first: $samples, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes {
        number title url createdAt mergedAt authorAssociation
        author { __typename login }
        mergedBy { __typename login }
        reviews(first: $reviews) { totalCount nodes { state submittedAt url bodyText author { __typename login } } }
      }
    }
    openIssues: issues(states: OPEN, first: $samples, orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      nodes {
        number title url createdAt authorAssociation
        author { __typename login }
        comments(first: $comments) { totalCount nodes { createdAt authorAssociation url bodyText author { __typename login } } }
      }
    }
    closedIssues: issues(states: CLOSED, first: $samples, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes {
        number title url createdAt closedAt authorAssociation
        author { __typename login }
        comments(first: $comments) { totalCount nodes { createdAt authorAssociation url bodyText author { __typename login } } }
      }
    }
  }
}`;

function actorLogin(raw: unknown): { readonly login: string; readonly bot: boolean } {
  const record = asRecord(raw);
  const login = asString(record?.login);
  return { login: login ?? "(deleted account)", bot: isBotLogin(login, record?.__typename) };
}

function quote(raw: unknown): string | null {
  return truncate(asString(raw), QUOTE_MAX_CHARS);
}

function normalizePullSample(raw: unknown): PullSample | null {
  const record = asRecord(raw);
  const number = asNumber(record?.number);
  if (!record || number === null) return null;
  const author = actorLogin(record.author);
  const reviews = asRecord(record.reviews);
  const reviewNodes = asArray(reviews?.nodes).map(asRecord);
  const reviewTotal = asNumber(reviews?.totalCount);
  const humanReviewers = new Set<string>();
  const botReviewers = new Set<string>();
  let approvedByHuman = false;
  let approvedByBot = false;
  const quoted: ReviewQuote[] = [];
  for (const review of reviewNodes) {
    if (!review) continue;
    const reviewer = actorLogin(review.author);
    if (reviewer.login === author.login) continue;
    const state = asString(review.state) ?? "UNKNOWN";
    (reviewer.bot ? botReviewers : humanReviewers).add(reviewer.login);
    if (state === "APPROVED") {
      if (reviewer.bot) approvedByBot = true;
      else approvedByHuman = true;
    }
    if (quoted.length < REVIEWS_QUOTED_PER_PR) {
      quoted.push({
        reviewer: reviewer.login,
        bot: reviewer.bot,
        state,
        submittedAt: asString(review.submittedAt),
        url: asString(review.url),
        quote: quote(review.bodyText),
      });
    }
  }
  return {
    number,
    title: truncate(asString(record.title), 90) ?? "(untitled)",
    url: asString(record.url),
    author: author.login,
    authorBot: author.bot,
    association: asString(record.authorAssociation) ?? "NONE",
    mergedAt: asString(record.mergedAt),
    mergedBy: asString(asRecord(record.mergedBy)?.login),
    reviewCount: reviewTotal ?? reviewNodes.length,
    reviewsSampled: reviewNodes.length,
    reviewsCapped:
      reviewTotal === null ? reviewNodes.length >= PR_REVIEW_SAMPLE : reviewTotal > reviewNodes.length,
    humanReviewers: [...humanReviewers],
    botReviewers: [...botReviewers],
    approvedByHuman,
    approvedByBot,
    reviews: quoted,
  };
}

function normalizeIssueSample(raw: unknown): IssueSample | null {
  const record = asRecord(raw);
  const number = asNumber(record?.number);
  if (!record || number === null) return null;
  const author = actorLogin(record.author);
  const createdAt = asString(record.createdAt);
  const comments = asRecord(record.comments);
  const commentNodes = asArray(comments?.nodes).map(asRecord);
  let firstMaintainerResponse: IssueSample["firstMaintainerResponse"] = null;
  for (const comment of commentNodes) {
    if (!comment) continue;
    const commenter = actorLogin(comment.author);
    const association = asString(comment.authorAssociation) ?? "NONE";
    const commentedAt = asString(comment.createdAt);
    if (commenter.bot || !MAINTAINER_ASSOCIATIONS.has(association) || commenter.login === author.login) {
      continue;
    }
    if (createdAt && commentedAt) {
      const hours = (Date.parse(commentedAt) - Date.parse(createdAt)) / 3_600_000;
      firstMaintainerResponse = {
        login: commenter.login,
        association,
        hours: Math.max(0, Math.round(hours * 10) / 10),
        url: asString(comment.url),
        quote: quote(comment.bodyText),
      };
    }
    break;
  }
  return {
    number,
    title: truncate(asString(record.title), 90) ?? "(untitled)",
    url: asString(record.url),
    author: author.login,
    authorBot: author.bot,
    association: asString(record.authorAssociation) ?? "NONE",
    createdAt,
    closedAt: asString(record.closedAt),
    commentCount: asNumber(comments?.totalCount) ?? commentNodes.length,
    firstMaintainerResponse,
    commentsSampled: commentNodes.length,
  };
}

function connection(raw: unknown): { readonly totalCount: number; readonly nodes: unknown[] } | null {
  const record = asRecord(raw);
  const totalCount = asNumber(record?.totalCount);
  if (!record || totalCount === null || !Array.isArray(record.nodes)) return null;
  return { totalCount, nodes: record.nodes };
}

function fetchGraphqlEvidence(
  repo: RepoRef,
  auth: Auth,
  ctx: RequestContext,
  samples: number,
): Effect.Effect<Section<GraphqlEvidence>, never, FreeHttp> {
  return Effect.gen(function* () {
    if (!auth) {
      return {
        ok: false as const,
        limit: true as const,
        error:
          "needs a GitHub login; not fetched (PR review and issue-response samples are GraphQL-only, and no token was found in GH_TOKEN, GITHUB_TOKEN, or gh auth)",
      };
    }
    const req = yield* githubRequest(apiUrl("/graphql"), auth, ctx, {
      method: "POST",
      body: {
        query: EVIDENCE_QUERY,
        variables: {
          owner: repo.owner,
          name: repo.name,
          samples,
          comments: ISSUE_COMMENT_SAMPLE,
          reviews: PR_REVIEW_SAMPLE,
        },
      },
    });
    if (!req.ok) return { ok: false as const, error: `Collaboration samples unavailable: ${req.error}` };
    const { response } = req;
    const record = asRecord(response.payload);
    if (response.status !== 200 || !record) {
      return { ok: false as const, error: describeFailure(response, "GraphQL evidence") };
    }
    const errors = asArray(record.errors)
      .map((entry) => asString(asRecord(entry)?.message))
      .filter((entry): entry is string => entry !== null);
    if (errors.length) {
      return {
        ok: false as const,
        error: `GitHub GraphQL reported ${errors.length} error(s): ${truncate(redactSecrets(errors.join("; ")), 240)}`,
      };
    }
    const data = asRecord(record.data);
    const repository = asRecord(data?.repository);
    if (!repository) return { ok: false as const, error: "GitHub GraphQL returned no repository data" };
    if (repository.isPrivate !== false) {
      return {
        ok: false as const,
        error: "GraphQL did not confirm the repository as public; evidence withheld",
      };
    }
    const merged = connection(repository.mergedPullRequests);
    const open = connection(repository.openIssues);
    const closed = connection(repository.closedIssues);
    const missing = [
      !merged && "mergedPullRequests",
      !open && "openIssues",
      !closed && "closedIssues",
    ].filter((name): name is string => typeof name === "string");
    if (!merged || !open || !closed) {
      return {
        ok: false as const,
        error: `GitHub GraphQL returned malformed connection(s): ${missing.join(", ")}; evidence withheld`,
      };
    }
    return {
      ok: true as const,
      data: {
        mergedTotal: merged.totalCount,
        pulls: merged.nodes
          .map(normalizePullSample)
          .filter((entry): entry is PullSample => entry !== null),
        openTotal: open.totalCount,
        openIssues: open.nodes
          .map(normalizeIssueSample)
          .filter((entry): entry is IssueSample => entry !== null),
        closedTotal: closed.totalCount,
        closedIssues: closed.nodes
          .map(normalizeIssueSample)
          .filter((entry): entry is IssueSample => entry !== null),
        cost: asNumber(asRecord(data?.rateLimit)?.cost),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatMetadata(meta: RepoMetadata): string[] {
  const flags: string[] = [];
  if (meta.archived) flags.push("ARCHIVED");
  if (meta.disabled) flags.push("DISABLED");
  if (meta.fork) flags.push(`fork${meta.parent ? ` of ${meta.parent}` : ""}`);
  if (meta.template) flags.push("template");
  return [
    "Metadata (current totals, not growth):",
    `  ${meta.htmlUrl}${flags.length ? ` [${flags.join(", ")}]` : ""}`,
    meta.description ? `  ${truncate(meta.description, 240)}` : "  (no description)",
    `  Stars: ${fmtNum(meta.stars)} | Forks: ${fmtNum(meta.forks)} | Watchers: ${fmtNum(meta.subscribers)} | Open issues+PRs: ${fmtNum(meta.openIssuesAndPrs)}`,
    `  Language: ${meta.language ?? "n/a"} | License: ${meta.license ?? "none detected"} | Owner type: ${meta.ownerType ?? "n/a"} | Default branch: ${meta.defaultBranch}`,
    `  Created: ${fmtDate(meta.createdAt)} | Last push to any branch: ${fmtDate(meta.pushedAt)} (pushes include non-default branches; see default-branch commits below)`,
    meta.homepage ? `  Homepage: ${meta.homepage}` : null,
    meta.topics.length
      ? `  Topics: ${meta.topics.slice(0, 15).join(", ")}${meta.topics.length > 15 ? ", …" : ""}`
      : null,
  ].filter((line): line is string => line !== null);
}

function formatStars(section: Section<StarHistory>): string[] {
  const lines = [
    "Star history (weekly star-creation buckets from GitHub; gross stars created, unstars not subtracted — not net growth):",
  ];
  if (!section.ok) return [...lines, `  unavailable: ${section.error}`];
  const data = section.data;
  if (section.partialNote) lines.push(`  PARTIAL: ${section.partialNote}`);
  lines.push(
    data.current
      ? `  Current week (started ${data.current.weekStart}, about ${data.current.daysElapsed} of 7 days elapsed): ${fmtNum(data.current.total)} stars so far — partial, excluded from the windows below`
      : "  Current week: no bucket containing today was returned",
  );
  const missingReason = data.historyExhausted
    ? "history reaches the repository's creation"
    : section.partialNote
      ? "later pages unavailable"
      : `star-history pages capped at ${STAR_HISTORY_PAGE_CAP}`;
  lines.push(
    data.window
      ? `  Window (${data.window.weeks} of ${data.weeksPerWindow} complete weeks, ${data.window.start} → ${data.window.end}): ${fmtNum(data.window.total)} stars created${data.window.weeks < data.weeksPerWindow ? ` — short window (${missingReason})` : ""}`
      : `  Window: no complete weeks available (${missingReason})`,
  );
  lines.push(
    data.prior
      ? `  Prior window (${data.prior.weeks} complete weeks, ${data.prior.start} → ${data.prior.end}): ${fmtNum(data.prior.total)} stars created — same unit as the window above`
      : `  Prior window: not comparable — both runs must hold ${data.weeksPerWindow} complete weeks (${missingReason})`,
  );
  const shown = data.weeks.filter((week) => week.bucket === "window" || week.bucket === "current");
  if (shown.length) {
    lines.push(
      "  Weekly (most recent first; * = partial current week; week boundaries are GitHub's and may not align with UTC):",
    );
    lines.push(
      `    ${shown.map((week) => `${week.weekStart}: ${week.total}${week.bucket === "current" ? "*" : ""}`).join(" | ")}`,
    );
  }
  return lines;
}

function formatCommits(section: Section<CommitSummary>, branch: string, days: number): string[] {
  const lines = [
    `Default-branch activity (${branch}, commits whose committer date falls in the last ${days} days; merge commits included; up to ${COMMITS_PER_PAGE * COMMITS_PAGE_CAP} listed):`,
  ];
  if (!section.ok) return [...lines, `  unavailable: ${section.error}`];
  const data = section.data;
  if (section.partialNote) lines.push(`  PARTIAL: ${section.partialNote}`);
  if (data.count === 0) {
    lines.push(`  No commits on ${branch} in the window.`);
    lines.push(
      data.latestOutsideWindow
        ? `  Latest ${branch} commit: ${data.latestOutsideWindow.sha.slice(0, 10)} on ${fmtDate(data.latestOutsideWindow.date)} by ${data.latestOutsideWindow.author} — ${data.latestOutsideWindow.message}`
        : `  No commits found on ${branch} at all.`,
    );
    return lines;
  }
  lines.push(
    `  Commits: ${fmtNum(data.count)}${data.capped ? "+ (listing capped; more exist in the window)" : ""} | merge commits: ${data.mergeCommits} | authors with GitHub accounts: ${data.humanAuthors.length} human, ${data.botAuthors.length} bot | commits without a linked account: ${data.unlinkedAuthors}`,
  );
  if (data.latest) {
    lines.push(
      `  Latest: ${data.latest.sha.slice(0, 10)} on ${fmtDate(data.latest.date)} by ${data.latest.author} — ${data.latest.message}`,
    );
  }
  if (data.humanAuthors.length) {
    lines.push(
      `  Human authors: ${data.humanAuthors.slice(0, 15).join(", ")}${data.humanAuthors.length > 15 ? ", …" : ""}`,
    );
  }
  if (data.botAuthors.length) lines.push(`  Bot authors: ${data.botAuthors.join(", ")}`);
  return lines;
}

function formatReleases(section: Section<ReleaseSummary>, days: number): string[] {
  const lines = [
    `Releases (first ${RELEASES_PER_PAGE} GitHub API entries; rolling tags can affect API order; package-registry publishing is not checked here):`,
  ];
  if (!section.ok) return [...lines, `  unavailable: ${section.error}`];
  const data = section.data;
  if (data.listed === 0) return [...lines, "  No GitHub releases published."];
  lines.push(
    `  Published in the last ${days} days: ${data.inWindow}${data.moreMayExist ? " (within the retrieved page; further pages not fetched)" : ` of ${data.listed} total`}`,
  );
  if (data.latest) {
    lines.push(
      `  Latest publication in retrieved page: ${data.latest.tag} on ${fmtDate(data.latest.publishedAt)}${data.latest.prerelease ? " (pre-release)" : ""}${data.latest.url ? ` — ${data.latest.url}` : ""}`,
    );
  }
  return lines;
}

function formatContributors(section: Section<ContributorSummary>): string[] {
  const lines = [
    `Contributors (GitHub-reported commit counts, first ${CONTRIBUTORS_PER_PAGE}; not a count of unique people or a quality measure):`,
  ];
  if (!section.ok) return [...lines, `  unavailable: ${section.error}`];
  const data = section.data;
  if (data.listed === 0) return [...lines, "  None listed."];
  lines.push(
    `  Listed: ${data.listed}${data.moreExist ? "+ (more pages exist)" : ""} | bots among listed: ${data.bots}`,
  );
  lines.push(
    `  Top by commit count: ${data.top.map((entry) => `${entry.login}${entry.bot ? " [bot]" : ""} (${fmtNum(entry.contributions)})`).join(", ")}`,
  );
  return lines;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function formatIssueSample(issues: readonly IssueSample[]): string[] {
  return issues.flatMap((issue) => {
    const reply = issue.firstMaintainerResponse;
    const response = reply
      ? `first ${reply.association} reply by ${reply.login} after ${reply.hours}h`
      : `no owner/member/collaborator reply among the first ${issue.commentsSampled} of ${issue.commentCount} comment(s)`;
    const lines = [
      `    #${issue.number} ${issue.title} — ${issue.author}${issue.authorBot ? " [bot]" : ""} (${issue.association}) opened ${fmtDate(issue.createdAt)}${issue.closedAt ? `, closed ${fmtDate(issue.closedAt)}` : ""}${issue.url ? ` ${issue.url}` : ""}; ${response}`,
    ];
    if (reply?.quote) lines.push(`      reply: "${reply.quote}"${reply.url ? ` ${reply.url}` : ""}`);
    return lines;
  });
}

function formatEvidence(section: Section<GraphqlEvidence>, samples: number): string[] {
  const lines = [
    `Public collaboration samples (GraphQL; ${samples} items per sample — samples, not project-wide statistics):`,
  ];
  if (!section.ok) {
    return [...lines, section.limit ? `  ${section.error}` : `  unavailable: ${section.error}`];
  }
  const data = section.data;
  const external = data.pulls.filter(
    (pull) => !MAINTAINER_ASSOCIATIONS.has(pull.association) && !pull.authorBot,
  ).length;
  const humanReviewed = data.pulls.filter((pull) => pull.humanReviewers.length > 0).length;
  const humanApproved = data.pulls.filter((pull) => pull.approvedByHuman).length;
  const botOnlyReviewed = data.pulls.filter(
    (pull) => !pull.reviewsCapped && pull.humanReviewers.length === 0 && pull.botReviewers.length > 0,
  ).length;
  const unresolvedReview = data.pulls.filter(
    (pull) => pull.reviewsCapped && pull.humanReviewers.length === 0,
  ).length;
  const botPulls = data.pulls.filter((pull) => pull.authorBot).length;
  lines.push(
    `  Merged PRs (${data.pulls.length} most recently updated of ${fmtNum(data.mergedTotal)} merged): ${external} by contributors outside owner/member/collaborator, ${botPulls} by bots, ${humanReviewed} reviewed by another human (${humanApproved} human-approved), ${botOnlyReviewed} reviewed only by bots${unresolvedReview ? `, ${unresolvedReview} with no human review among the first ${PR_REVIEW_SAMPLE} of their reviews (later reviews not fetched, so not classified)` : ""}`,
  );
  for (const pull of data.pulls) {
    const parts: string[] = [];
    if (pull.humanReviewers.length) {
      parts.push(
        `human reviews by ${pull.humanReviewers.join(", ")}${pull.approvedByHuman ? " (approved)" : ""}`,
      );
    }
    if (pull.botReviewers.length) {
      parts.push(
        `bot reviews by ${pull.botReviewers.join(", ")}${pull.approvedByBot ? " (bot approval)" : ""}`,
      );
    }
    const reviewers = parts.length
      ? parts.join("; ")
      : `no review by another account${pull.reviewsCapped ? " in the fetched reviews" : ""}`;
    const coverage = pull.reviewsCapped
      ? `; only the first ${pull.reviewsSampled} of ${fmtNum(pull.reviewCount)} reviews were fetched — later reviews are unexamined`
      : "";
    lines.push(
      `    #${pull.number} ${pull.title} — ${pull.author}${pull.authorBot ? " [bot]" : ""} (${pull.association}), merged ${fmtDate(pull.mergedAt)}${pull.mergedBy ? ` by ${pull.mergedBy}` : ""}${pull.url ? ` ${pull.url}` : ""}; ${reviewers}${coverage}`,
    );
    for (const review of pull.reviews) {
      lines.push(
        `      ${review.state} by ${review.reviewer}${review.bot ? " [bot]" : ""}${review.submittedAt ? ` on ${fmtDate(review.submittedAt)}` : ""}: ${review.quote ? `"${review.quote}"` : "(no review text)"}${review.url ? ` ${review.url}` : ""}`,
      );
    }
  }
  const openHours = data.openIssues
    .map((issue) => issue.firstMaintainerResponse?.hours)
    .filter((hours): hours is number => hours !== undefined);
  const closedHours = data.closedIssues
    .map((issue) => issue.firstMaintainerResponse?.hours)
    .filter((hours): hours is number => hours !== undefined);
  lines.push(
    `  Open issues (${data.openIssues.length} newest of ${fmtNum(data.openTotal)} open): ${openHours.length} with a maintainer reply in the sampled comments${openHours.length ? `, median ${median(openHours)}h` : ""}`,
  );
  lines.push(...formatIssueSample(data.openIssues));
  lines.push(
    `  Closed issues (${data.closedIssues.length} most recently updated of ${fmtNum(data.closedTotal)} closed): ${closedHours.length} with a maintainer reply in the sampled comments${closedHours.length ? `, median ${median(closedHours)}h` : ""}`,
  );
  lines.push(...formatIssueSample(data.closedIssues));
  lines.push(
    `  Reviews are examined up to the first ${PR_REVIEW_SAMPLE} per PR; quotes are bounded to ${QUOTE_MAX_CHARS} characters of untrusted text, ${REVIEWS_QUOTED_PER_PR} quoted per PR. Association labels are GitHub's; they show repository affiliation, not employment or expertise.`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const githubInspectSchema = Schema.Struct({
  repo: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Public repository as owner/repo or a github.com URL.",
  }),
  days: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: INSPECT_MIN_DAYS, maximum: INSPECT_MAX_DAYS })).annotate({
      description:
        "Evidence window in days (default: 90). Use the same value across candidates being compared.",
    }),
  ),
  samples: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: INSPECT_MAX_SAMPLES })).annotate({
      description: "Merged-PR and issue sample size for the GraphQL section (default: 5).",
    }),
  ),
});

export const githubInspectAction = defineAction({
  name: "github_inspect",
  description:
    "Gather comparable public evidence for one GitHub repository over a window: metadata, weekly star-creation buckets (gross, not net growth; partial current week reported separately, equal runs of complete weeks compared), default-branch commits by committer date and authors, releases, contributors, and with a token merged-PR review samples (human vs bot reviewers, bounded quoted review text with links) and issue first-maintainer-reply samples (delay, bounded quote, link). " +
    "Every section states its window, cap, sampling, or failure; pages fetched before a failure are kept and labelled partial. No quality score is computed. Public repositories only. " +
    "5 to 10 REST calls per repository (more for a longer window or a busier repository), plus one GraphQL call with a GitHub login. " +
    "A section that failed makes the inspection partial; without a login the collaboration samples are not fetched, which the text states as a limit.",
  schema: githubInspectSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const repo = parseRepo(args.repo);
      if ("error" in repo) return failed(repo.error);
      const days = clampInt(args.days, INSPECT_DEFAULT_DAYS, INSPECT_MIN_DAYS, INSPECT_MAX_DAYS);
      const samples = clampInt(args.samples, INSPECT_DEFAULT_SAMPLES, 1, INSPECT_MAX_SAMPLES);
      const nowMs = Date.now();
      const windowStartMs = nowMs - days * DAY_MS;
      const windowStartIso = new Date(windowStartMs).toISOString();

      const gate = yield* loadPublicRepo(repo, ctx);
      if (!gate.ok) {
        return gate.cancelled
          ? outcome("cancelled", "GitHub inspect cancelled")
          : failed(gate.error);
      }
      const { auth, metadata: meta, rateLimit } = gate;

      const [stars, commits, releases, contributors, evidence] = yield* Effect.all(
        [
          fetchStarHistory(repo, auth, ctx, days, nowMs),
          fetchCommits(repo, auth, ctx, meta.defaultBranch, windowStartIso),
          fetchReleases(repo, auth, ctx, windowStartMs),
          fetchContributors(repo, auth, ctx),
          fetchGraphqlEvidence(repo, auth, ctx, samples),
        ],
        { concurrency: "unbounded" },
      );

      if (ctx.signal.aborted) {
        return outcome("cancelled", "GitHub inspect cancelled");
      }

      const sections: ReadonlyArray<readonly [string, Section<unknown>]> = [
        ["star history", stars],
        ["default-branch commits", commits],
        ["releases", releases],
        ["contributors", contributors],
        ["collaboration samples", evidence],
      ];
      const failures = sections.flatMap(([label, section]) =>
        section.ok
          ? section.partialNote
            ? [`${label} (partial): ${section.partialNote}`]
            : []
          : section.limit
            ? []
            : [`${label}: ${section.error}`],
      );
      const limited = sections
        .filter(([, section]) => !section.ok && section.limit)
        .map(([label]) => label);
      const caveats = [
        "Evidence, not a verdict: no automated quality or momentum score is computed; compare sections across candidates with the same window.",
        "Star buckets count star creation; GitHub's history does not subtract removed stars, so window sums are not net growth.",
        "pushed_at reflects any branch; use the default-branch commit section for development activity.",
        "Missing sections are missing evidence, not zeros.",
      ];

      const text = [
        `GitHub inspect: ${meta.fullName} — window ${fmtDate(windowStartIso)} → ${fmtDate(new Date(nowMs).toISOString())} (${days} days); ${authLabel(auth)}`,
        failures.length
          ? `Status: partial — ${failures.length} section(s) unavailable or truncated (see below)${limited.length ? `; not fetched without a GitHub login: ${limited.join(", ")}` : ""}`
          : limited.length
            ? `Status: complete — every section returned except the ${limited.join(", ")}, which need a GitHub login (not fetched)`
            : "Status: complete — all sections returned",
        "",
        ...formatMetadata(meta),
        "",
        ...formatStars(stars),
        "",
        ...formatCommits(commits, meta.defaultBranch, days),
        "",
        ...formatReleases(releases, days),
        "",
        ...formatContributors(contributors),
        "",
        ...formatEvidence(evidence, samples),
        "",
        "Caveats:",
        ...caveats.map((line) => `  - ${line}`),
        rateLimit.remaining !== null
          ? `Core rate limit remaining after metadata call: ${rateLimit.remaining}${rateLimit.resetAt ? ` (resets ${rateLimit.resetAt})` : ""}`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");

      return outcome(failures.length ? "partial" : "success", text, {
        provider: "github",
        auth: auth?.source ?? null,
        repo: meta.fullName,
        window: { days, start: windowStartIso, end: new Date(nowMs).toISOString() },
        partial: failures.length > 0,
        failures,
        metadata: meta,
        stars: stars.ok ? stars.data : null,
        commits: commits.ok ? commits.data : null,
        releases: releases.ok ? releases.data : null,
        contributors: contributors.ok ? contributors.data : null,
        collaboration: evidence.ok ? evidence.data : null,
        rate_limit: rateLimit,
      });
    }),
});
