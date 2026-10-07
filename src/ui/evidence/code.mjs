// GitHub (repositories found, inspected and read) and DeepWiki (questions asked about a repository).
// Adapted from Dig's dashboard/ui/evidence/code.ts (MIT, same author).
import { bytes, compact, num, plural, shortDate } from '../format.mjs';
import { attempted, excerpt, failedCall, noItems, numv, obj, objs, query, scope, str } from './read.mjs';

const ANSWER_EXCERPT = 420;
const SORT = { stars: 'by stars', forks: 'by forks', updated: 'recently updated' };

function repo(r) {
  const name = str(r.full_name);
  if (!name) return undefined;
  const stars = numv(r.stargazers_count); const pushed = str(r.pushed_at);
  return { kind: 'repo', key: name.toLowerCase(), title: name, url: str(r.html_url) ?? `https://github.com/${name}`, meta: [stars === undefined ? undefined : `★ ${compact(stars)}`, str(r.language), pushed ? `pushed ${shortDate(pushed)}` : undefined].filter(Boolean), excerpt: str(r.description) };
}

/** What a read returned: a file's size, or a directory's entry count. */
function readSize(bodies) {
  for (const body of bodies) {
    if (typeof body === 'string') return bytes(body.length);
    if (Array.isArray(body)) return plural(body.length, 'entry', 'entries');
    const b = obj(body); const size = numv(b?.size) ?? str(b?.text)?.length;
    if (size !== undefined) return bytes(size);
  }
  return undefined;
}

export function readGithub(call, bodies) {
  const a = call.args; const failed = failedCall(call);
  if (call.tool === 'github_read') {
    const path = `${str(a.repo) ?? '?'}/${str(a.path) ?? ''}${str(a.ref) ? `@${str(a.ref)}` : ''}`;
    return { action: [attempted(call.status, 'read', 'read'), path], result: failed ? undefined : readSize(bodies), items: [] };
  }
  const repos = new Map(); let matches;
  for (const body of bodies) {
    const b = obj(body);
    if (!b) continue;
    matches ??= numv(b.total_count);
    for (const r of objs(b.items)) { const found = repo(r); if (found && !repos.has(found.key)) repos.set(found.key, found); }
    if (call.tool === 'github_inspect') { const inspected = repo(b); if (inspected) repos.set(inspected.key, inspected); }
  }
  const list = [...repos.values()];
  if (call.tool === 'github_inspect') return { action: [attempted(call.status, 'inspected', 'inspect'), str(a.repo) ?? list[0]?.title ?? 'a repository'], result: failed ? undefined : list[0]?.meta.slice(0, 2).join(', '), items: list };
  return {
    action: ['searched GitHub for', ...query(str(a.query)), ...scope([SORT[str(a.sort) ?? '']])],
    result: failed ? undefined : matches !== undefined && matches > list.length ? `${num(list.length)} of ${plural(matches, 'repository', 'repositories')}` : list.length ? plural(list.length, 'repository', 'repositories') : noItems(call),
    items: list,
  };
}

/** DeepWiki answers arrive as JSON-RPC `result.content[].text` (or plain text). */
function answerText(bodies) {
  for (const body of bodies) {
    if (typeof body === 'string') return body;
    const text = objs(obj(obj(body)?.result)?.content).flatMap(c => str(c.text) ?? []).join('\n');
    if (text) return text;
  }
  return '';
}
const words = value => value.split(/\s+/).filter(Boolean).length;

export function readDeepwiki(call, bodies) {
  const a = call.args;
  const name = str(a.repoName) ?? (Array.isArray(a.repoName) ? a.repoName.join(', ') : 'a repository');
  const failed = failedCall(call); const answer = answerText(bodies);
  if (call.tool === 'deepwiki_ask_question') return {
    action: [`asked DeepWiki about ${name}`, ...query(str(a.question))],
    result: failed || !answer ? undefined : `a ${num(words(answer))}-word answer`,
    items: answer && !failed ? [{ kind: 'answer', key: `${name}:${str(a.question) ?? ''}`, title: excerpt(answer, ANSWER_EXCERPT), meta: [name] }] : [],
  };
  const outline = call.tool === 'deepwiki_read_wiki_structure';
  const pages = outline ? answer.split('\n').filter(line => /^\s*-\s+\d/.test(line)).length : (answer.match(/^# Page:/gm) ?? []).length;
  const verb = outline ? 'read the DeepWiki outline of' : 'read the DeepWiki pages of';
  return { action: [attempted(call.status, verb, verb), name], result: failed || !answer ? undefined : pages ? `${plural(pages, 'page')}${outline ? '' : `, ${bytes(answer.length)}`}` : bytes(answer.length), items: [] };
}
