import { bytes, compact, num, plural, shortDate } from "../format.ts";
import {
  attempted,
  excerpt,
  failedCall,
  noItems,
  nonEmpty,
  numv,
  obj,
  objs,
  query,
  scope,
  str,
  type EvidenceCall,
  type EvidenceItem,
  type EvidenceResult,
} from "./read.ts";

const ANSWER_EXCERPT = 420;
const SORT: Record<string, string> = {
  stars: "by stars",
  forks: "by forks",
  updated: "recently updated",
};

function repo(r: Record<string, unknown>): EvidenceItem | undefined {
  const name = str(r.full_name);
  if (!name) return undefined;
  const stars = numv(r.stargazers_count);
  const pushed = str(r.pushed_at);
  return {
    kind: "repo",
    key: name.toLowerCase(),
    title: name,
    url: str(r.html_url) ?? `https://github.com/${name}`,
    meta: nonEmpty([
      stars === undefined ? undefined : `★ ${compact(stars)}`,
      str(r.language),
      pushed ? `pushed ${shortDate(pushed)}` : undefined,
    ]),
    excerpt: str(r.description),
  };
}

function readSize(responseBodies: readonly unknown[]): string | undefined {
  const contents = [...responseBodies]
    .reverse()
    .find((body) => Array.isArray(body) || str(obj(body)?.type));
  if (Array.isArray(contents)) return plural(contents.length, "entry", "entries");
  const b = obj(contents);
  if (!b) return undefined;
  if (str(b.type) === "dir") return plural(objs(b.entries).length, "entry", "entries");
  const size = numv(b.size);
  return size === undefined ? undefined : bytes(size);
}

export function readGithub(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  const a = call.args;
  const failed = failedCall(call);
  if (call.tool === "github_read") {
    const path = `${str(a.repo) ?? "?"}/${str(a.path) ?? ""}${str(a.ref) ? `@${str(a.ref)}` : ""}`;
    return {
      action: [attempted(call.status, "read", "read"), path],
      result: failed ? undefined : readSize(responseBodies),
      items: [],
    };
  }
  const repos = new Map<string, EvidenceItem>();
  let matches: number | undefined;
  for (const body of responseBodies) {
    const b = obj(body);
    if (!b) continue;
    matches ??= numv(b.total_count);
    for (const r of objs(b.items)) {
      const found = repo(r);
      if (found && !repos.has(found.key)) repos.set(found.key, found);
    }
    if (call.tool === "github_inspect") {
      const inspected = repo(b);
      if (inspected) repos.set(inspected.key, inspected);
    }
  }
  const list = [...repos.values()];
  if (call.tool === "github_inspect") {
    return {
      action: [
        attempted(call.status, "inspected", "inspect"),
        str(a.repo) ?? list[0]?.title ?? "a repository",
      ],
      result: failed ? undefined : list[0]?.meta.slice(0, 2).join(", "),
      items: list,
    };
  }
  return {
    action: [
      "searched GitHub for",
      ...query(str(a.query)),
      ...scope([SORT[str(a.sort) ?? ""]]),
    ],
    result: failed
      ? undefined
      : matches !== undefined && matches > list.length
        ? `${num(list.length)} of ${plural(matches, "repository", "repositories")}`
        : list.length
          ? plural(list.length, "repository", "repositories")
          : noItems(call),
    items: list,
  };
}

function answerText(responseBodies: readonly unknown[]): string {
  for (const body of responseBodies) {
    if (typeof body === "string") return body;
    const text = objs(obj(obj(body)?.result)?.content)
      .flatMap((c) => {
        const t = str(c.text);
        return t ? [t] : [];
      })
      .join("\n");
    if (text) return text;
  }
  return "";
}

const words = (value: string): number => value.split(/\s+/).filter(Boolean).length;

export function readDeepwiki(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  const a = call.args;
  const name = str(a.repoName) ?? "a repository";
  const failed = failedCall(call);
  const answer = answerText(responseBodies);
  if (call.tool === "deepwiki_ask_question") {
    return {
      action: [`asked DeepWiki about ${name}`, ...query(str(a.question))],
      result: failed || !answer ? undefined : `a ${num(words(answer))}-word answer`,
      items:
        answer && !failed
          ? [
              {
                kind: "answer",
                key: `${name}:${str(a.question) ?? ""}`,
                title: excerpt(answer, ANSWER_EXCERPT),
                meta: [name],
              },
            ]
          : [],
    };
  }
  const outline = call.tool === "deepwiki_read_wiki_structure";
  const pages = outline
    ? answer.split("\n").filter((line) => /^\s*-\s+\d/.test(line)).length
    : (answer.match(/^# Page:/gm) ?? []).length;
  const verb = outline ? "read the DeepWiki outline of" : "read the DeepWiki pages of";
  return {
    action: [attempted(call.status, verb, verb), name],
    result:
      failed || !answer
        ? undefined
        : pages
          ? `${plural(pages, "page")}${outline ? "" : `, ${bytes(answer.length)}`}`
          : bytes(answer.length),
    items: [],
  };
}
