import { mkdir, readFile, writeFile, appendFile, readdir, realpath, stat, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, basename, dirname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MODULES, moduleAgents, ALL_MODULES, reportSources } from './providers/modules.ts';
import { receiptCost } from './providers/library/cost.ts';
import { ANSWER_STATUSES, digWord } from './status.mjs';
import { reportParts, frontMatter as readFrontMatter } from './ui/markdown.mjs';

const methods = moduleAgents(ALL_MODULES).filter(m => !m.helper);
const sourceLabels = Object.fromEntries(MODULES.map(m => [m.id, m.label]));
// A report accounts for its own source's calls.
const accountsFor = (report, call) => call.source === report;
const reportName = name => typeof name === 'string' && /^[a-z0-9][a-z0-9-]*\.md$/.test(name) && !['dig.md', 'answer.md'].includes(name);
const REPORT_SECTIONS = ['Summary', 'Evidence Highlights', 'Needs Follow-Up', 'Negative Evidence (when relevant)'];

const quote = value => JSON.stringify(value);
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,180}$/.test(value);
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 65) || 'research';
const time = value => { const at = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
// A compact view label from saved report metadata or a composed answer H1. The original question stays title.
export function displayTitle(question, mode, reports, answerTitle) {
  if (mode !== 'single') return typeof answerTitle === 'string' && answerTitle.trim() && answerTitle.trim().length <= 140 && answerTitle.trim().length < question.length ? answerTitle.trim() : question;
  if (!reports.length) return question;
  const report = reports.at(-1);
  const title = typeof report.title === 'string' ? report.title.trim() : '';
  if (title && title !== question && title.length <= 140 && title.length < question.length && title !== `${sourceLabels[report.source]} research`) return title;
  const topic = typeof report.topic === 'string' ? report.topic : '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic)) return question;
  const label = topic.replaceAll('-', ' ').replace(/\b(ai|api|mcp|ui|ux|seo|pdf|hn)\b/g, word => word.toUpperCase()).replace(/\bgithub\b/g, 'GitHub');
  return label[0].toUpperCase() + label.slice(1);
}
export const SESSION_UNAVAILABLE = 'session-unavailable';
// The approved Dig contract: the session is the host conversation (Codex thread) that made the call or save; its folder name is a filesystem-safe form of it.
export function safeSegment(value, fallback) {
  const cleaned = typeof value === 'string' ? value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 120) : '';
  return cleaned || fallback;
}
// The library, search and the views read front matter with one parser (ui/markdown.mjs), which accepts CRLF.
export const frontMatter = text => readFrontMatter(text).meta;
const withoutFrontMatter = text => readFrontMatter(text).body;
function within(base, target) {
  const path = relative(base, target);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Path is outside the library');
  return target;
}
async function contained(config, target) {
  return within(await realpath(config.library), await realpath(target));
}
async function directory(config, parts) {
  await mkdir(config.library, { recursive: true });
  const base = await realpath(config.library);
  let path = base;
  for (const part of parts) {
    if (!token(part)) throw new Error('Invalid library directory identity');
    path = join(path, part);
    try { await mkdir(path); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    path = within(base, await realpath(path));
  }
  return path;
}
export function projectFolder(project) {
  if (!isAbsolute(project)) throw new Error('project must be an explicit absolute project path');
  const root = resolve(project);
  return `${slug(basename(root))}-${createHash('sha256').update(root).digest('hex').slice(0, 6)}`;
}
function digPath(config, project, dig) {
  if (!token(dig)) throw new Error('Invalid dig id');
  return join(config.library, projectFolder(project), 'digs', dig);
}
export async function startDig(config, project, question, session = SESSION_UNAVAILABLE, { planned = [], refreshes, mode = 'composed' } = {}) {
  session = safeSegment(session, SESSION_UNAVAILABLE);
  if (!question.trim()) throw new Error('The original question is required');
  if (!(await stat(await realpath(project))).isDirectory()) throw new Error('project must be an existing directory');
  if (planned.some(name => !methods.some(method => method.name === name))) throw new Error('planned must name source methods from source_info');
  if (refreshes) await assertDig(config, project, refreshes);
  const at = new Date().toISOString();
  const base = `${at.slice(0, 10)}-${at.slice(11, 16).replace(':', '')}-${slug(question)}`;
  for (let n = 1; n < 1000; n++) {
    const dig = n === 1 ? base : `${base}-${n}`;
    const path = join(await directory(config, [projectFolder(project), 'digs']), dig);
    try { await mkdir(path); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    await writeFile(join(path, 'dig.md'), `---\ndig: ${quote(dig)}\nquestion: ${quote(question)}\nproject: ${quote(resolve(project))}\nmode: ${mode}\nstarted_at: ${quote(at)}\nsession: ${quote(session)}\n${planned.length ? `planned: ${JSON.stringify(planned)}\n` : ''}${refreshes ? `refreshes: ${quote(refreshes)}\n` : ''}---\n# ${question.replaceAll('\n', ' ')}\n`, { flag: 'wx' });
    return { dig, project: resolve(project), path, session };
  }
  throw new Error('Cannot allocate a unique dig id');
}
export async function assertDig(config, project, dig) {
  const path = await contained(config, digPath(config, project, dig));
  const text = await readFile(await contained(config, join(path, 'dig.md')), 'utf8');
  if (!text.includes(`project: ${quote(resolve(project))}\n`)) throw new Error('Project does not match this dig');
  if (!text.includes(`dig: ${quote(dig)}\n`)) throw new Error('Dig metadata does not match the requested dig');
  return path;
}
// A receipt names the dig its call named, so the call counts toward that dig even if no report is ever saved with it.
export async function recordCall(config, project, dig, { tool, source, args, declared = [], at, ms, status, cost, knownCost, responses, error, session = SESSION_UNAVAILABLE, callId }) {
  const pricing = receiptCost({ cost, knownCost });
  if (dig) await assertDig(config, project, dig);
  const generated = () => `c-${at.replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
  let id = callId ? safeSegment(callId, generated()) : generated();
  const sessionFolder = safeSegment(session, SESSION_UNAVAILABLE);
  const folder = await directory(config, [projectFolder(project), 'sessions', sessionFolder]);
  const receipt = { id, at, ms, tool, source, status, ...(dig ? { dig } : {}), args: withoutSecrets(args, declared), ...pricing, ...(responses.length ? { attempts: responses.length } : {}), ...(error ? { error } : {}) };
  if (config.keep_raw && responses.length) {
    await directory(config, [projectFolder(project), 'sessions', sessionFolder, 'raw']);
    const raw = JSON.stringify({ tool, at, responses: responses.map(({ label, status, body, headers }) => ({
      label, status, body,
      ...(typeof headers?.['scrape.do-request-cost'] === 'string' ? { headers: { 'scrape.do-request-cost': headers['scrape.do-request-cost'] } } : {}),
    })) }, null, 2);
    for (let attempt = 0; ; attempt++) {
      try { await writeFile(join(folder, 'raw', `${id}.json`), raw, { flag: 'wx' }); break; } catch (e) { if (e.code !== 'EEXIST' || attempt > 2) throw e; id = generated(); }
    }
    receipt.id = id; receipt.raw = `raw/${id}.json`;
  }
  const callsPath = join(folder, 'calls.jsonl');
  try {
    if ((await lstat(callsPath)).isSymbolicLink()) throw new Error('Call receipts cannot be a symbolic link');
    await contained(config, callsPath);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await appendFile(callsPath, `${JSON.stringify(receipt)}\n`);
  return receipt;
}
// A report opens with its source card (a closed ```yaml block whose text begins source_card:) and carries every required
// section as a top-level level-2 heading. reportParts reads it as the rendered report and every reader of the card,
// title and Summary do, so a saved report reads as it was checked.
function assertReport(parts) {
  if (!parts.card) throw new Error('The report must begin with its source_card block: a ```yaml fenced block whose first line is source_card:, closed by its fence');
  const sections = new Set(parts.headings.filter(heading => heading.depth === 2).map(heading => heading.text));
  for (const section of REPORT_SECTIONS) if (!sections.has(section)) throw new Error(`Missing report section: ${section} (a "## ${section}" heading of the report itself, outside code, lists and quotes)`);
}
export async function saveReport(config, { project, dig, source, agent = source, content, topic, question, topic_volatility, supersedes, session = SESSION_UNAVAILABLE }) {
  session = safeSegment(session, SESSION_UNAVAILABLE);
  if (!reportSources(ALL_MODULES).includes(source)) throw new Error('source must name a report source from source_info');
  if (!methods.some(m => m.module === source && m.name === agent)) throw new Error(`agent must name a ${source} source method from source_info`);
  if (supersedes && !dig) throw new Error('supersedes requires an existing dig');
  const parts = reportParts(content);
  assertReport(parts);
  if (topic && (topic.length > 50 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic))) throw new Error('topic must be lowercase, hyphenated and at most 50 characters');
  if (!dig && !question?.trim()) throw new Error('question is required when saving without a dig');
  const createdDig = !dig;
  if (!dig) dig = (await startDig(config, project, question, session, { mode: 'single' })).dig;
  const folder = await assertDig(config, project, dig);
  if (supersedes) {
    if (!reportName(supersedes)) throw new Error('Invalid supersedes report reference');
    await readFile(await contained(config, join(folder, supersedes)));
  }
  const title = parts.headings.find(heading => heading.depth === 1)?.text ?? question ?? topic ?? `${sourceLabels[source]} research`;
  const at = new Date().toISOString();
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${agent}.md` : `${agent}-${n}.md`;
    const path = join(folder, name);
    const head = `---\ntitle: ${quote(title)}\ndig: ${quote(dig)}\nsource: ${source}\nagent: ${agent}\n${topic ? `topic: ${quote(topic)}\n` : ''}${topic_volatility ? `topic_volatility: ${quote(topic_volatility)}\n` : ''}generated_at: ${quote(at)}\nproject: ${quote(resolve(project))}\nsession: ${quote(session)}\n${supersedes ? `supersedes: ${quote(supersedes)}\n` : ''}---\n`;
    try { await writeFile(path, head + content, { flag: 'wx' }); return { path, dig, report: name, createdDig }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('Cannot allocate report filename');
}
export async function finishDig(config, { project, dig, answer, status, reports }) {
  const folder = await assertDig(config, project, dig);
  const metadata = frontMatter(await readFile(join(folder, 'dig.md'), 'utf8'));
  if (metadata.mode !== 'composed') throw new Error('dig_finish answers only digs created with dig_start');
  const names = [];
  for (const report of reports) {
    // Saves and discovery return canonical paths; accept those only for this dig.
    // The durable answer still stores the established report basenames.
    let name = report;
    if (typeof report === 'string' && !reportName(report)) {
      const path = await contained(config, isAbsolute(report) ? report : resolve(config.library, report));
      if (dirname(path) !== folder) throw new Error('Report reference must belong to this dig');
      name = basename(path);
    }
    if (!reportName(name)) throw new Error('reports must name saved source reports in this dig, for example github.md');
    const target = await contained(config, join(folder, name));
    if (dirname(target) !== folder) throw new Error('Report reference must belong to this dig');
    await readFile(target);
    names.push(name);
  }
  reports = names;
  if (!ANSWER_STATUSES.includes(status)) throw new Error(`status must be one of ${ANSWER_STATUSES.join(', ')}`);
  if (status === 'answered' && reports.length === 0) throw new Error('An answered dig must name its source reports');
  const path = join(folder, 'answer.md');
  await writeFile(path, `---\ndig: ${quote(dig)}\nfinished_at: ${quote(new Date().toISOString())}\nstatus: ${status}\nreports: ${JSON.stringify(reports)}\n---\n${answer}`, { flag: 'wx' });
  return { path, dig };
}
async function entries(config, path) {
  try { return await readdir(await contained(config, path), { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
// Each library file's parse, kept in memory by path and checked against its size and modification time, so a
// refresh reads and parses only files that changed. Nothing is written; a file that changes, appears or disappears
// shows on the next refresh, and entries for files a listing no longer finds are dropped.
const parsedFiles = new Map();
async function parsed(path, parse, seen) {
  const { size, mtimeMs } = await stat(path); seen.add(path);
  const hit = parsedFiles.get(path);
  if (hit?.parse === parse && hit.size === size && hit.mtimeMs === mtimeMs) return hit.value;
  const value = parse(await readFile(path, 'utf8'));
  parsedFiles.set(path, { parse, size, mtimeMs, value });
  return value;
}
const parseReport = text => {
  const head = frontMatter(text); const parts = reportParts(withoutFrontMatter(text));
  return { summary: parts.summary.trim().slice(0, 280), title: head.title, topic: head.topic, source: head.source ?? null, method: head.agent ?? null, supersedes: head.supersedes ?? null, at: head.generated_at ?? null, session: typeof head.session === 'string' ? head.session : null, status: parts.card?.fields?.status };
};
const parseAnswer = text => ({ meta: frontMatter(text), snippet: withoutFrontMatter(text).trim().slice(0, 280), title: reportParts(withoutFrontMatter(text)).headings.find(h => h.depth === 1)?.text });
// A line that does not parse (a write cut short by a crash or a full disk) is skipped, not fatal to every view.
const parseReceipts = text => text.trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
// Calls belong to research by two rules. A receipt that names its dig (0.2.20 onward) belongs to that dig, whichever
// conversation made it. A receipt without one follows the approved session rule: within one session it belongs to the
// first later save point's dig; a report's dig takes it, and a composed dig takes it only when made after the dig
// started. Unclaimed receipts are live activity. Within its dig, a call is claimed by that dig's next save in the call's
// own session that accounts for it: a report of the call's source, else the dig's finish when that session started the
// dig. A call with neither is in the dig without a saved report.
// Reading never creates the library: a mistyped path stays absent until research is saved there, so the Settings page
// can say it does not exist yet.
export async function listLibrary(config) {
  let projects;
  try { projects = await readdir(config.library, { withFileTypes: true }); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return { items: [], live: [] }; throw e; }
  const items = []; const live = []; const seen = new Set();
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const points = new Map(); const digs = new Map();
    const point = (session, value) => { const key = safeSegment(session, SESSION_UNAVAILABLE); if (!points.has(key)) points.set(key, []); points.get(key).push(value); };
    for (const dir of await entries(config, join(config.library, project.name, 'digs'))) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      const prefix = `${project.name}/digs/${dir.name}`;
      const folder = await contained(config, join(config.library, prefix));
      // A dig folder without its dig.md (a crash between mkdir and write, or a dig_start still writing) is skipped.
      let meta; try { meta = await parsed(await contained(config, join(folder, 'dig.md')), frontMatter, seen); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      const names = (await readdir(folder)).filter(f => f.endsWith('.md'));
      const reports = [];
      for (const name of names.filter(f => f !== 'dig.md' && f !== 'answer.md')) {
        reports.push({ name, ...await parsed(await contained(config, join(folder, name)), parseReport, seen) });
      }
      reports.sort((a, b) => (time(a.at) ?? 0) - (time(b.at) ?? 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      const answer = names.includes('answer.md') ? `${prefix}/answer.md` : null;
      const answered = answer ? await parsed(await contained(config, join(config.library, answer)), parseAnswer, seen) : null;
      const answerMeta = answered?.meta ?? {};
      const snippet = reports[0]?.summary || (answered ? answered.snippet : 'Research started; no report saved yet.');
      const files = [...(names.includes('dig.md') ? ['dig.md'] : []), ...reports.map(r => r.name), ...(answer ? ['answer.md'] : [])];
      const item = { id: dir.name, project: typeof meta.project === 'string' ? meta.project : project.name, title: typeof meta.question === 'string' ? meta.question : dir.name, snippet, answer, session: typeof meta.session === 'string' ? meta.session : null, startedAt: meta.started_at ?? null, finishedAt: answerMeta.finished_at ?? null, files: files.map(file => `${prefix}/${file}`), reports: reports.map(r => `${prefix}/${r.name}`), calls: [], status: digWord(answerMeta.status, { answer, reports: reports.length }) };
      item.sources = [...new Set(reports.map(r => r.source).filter(Boolean))];
      item.methods = [...new Set(reports.map(r => r.method).filter(Boolean))];
      item.mode = meta.mode;
      item.displayTitle = displayTitle(item.title, item.mode, reports, answered?.title);
      item.planned = Array.isArray(meta.planned) ? [...meta.planned] : [];
      item.refreshes = meta.refreshes ?? null;
      // `status` is the report's own source-card run status as its worker wrote it.
      item.reportDetails = reports.map(r => ({ file: `${prefix}/${r.name}`, source: r.source, method: r.method, supersedes: r.supersedes, summary: r.summary, at: r.at, status: typeof r.status === 'string' ? r.status : null }));
      items.push(item); digs.set(dir.name, item);
      for (const report of reports) if (report.session && time(report.at) !== null) point(report.session, { at: time(report.at), item, report: `${prefix}/${report.name}`, source: report.source });
      if (item.session && meta.mode === 'composed') point(item.session, { at: time(item.finishedAt) ?? Infinity, startedAt: time(item.startedAt) ?? -Infinity, item });
    }
    for (const dir of await entries(config, join(config.library, project.name, 'sessions'))) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      const callsPath = `${project.name}/sessions/${dir.name}/calls.jsonl`;
      let receipts = []; try { receipts = await parsed(await contained(config, join(config.library, callsPath)), parseReceipts, seen); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      // Unfinished digs share an infinite endpoint; the newest-started dig wins that tie, matching the approved reader.
      const saves = (points.get(dir.name) ?? []).sort((a, b) => a.at - b.at || (time(b.item.startedAt) ?? 0) - (time(a.item.startedAt) ?? 0) || (a.item.id < b.item.id ? 1 : a.item.id > b.item.id ? -1 : 0));
      const claimant = (item, call, at, named) => {
        const owner = saves.find(save => save.item === item && save.at > at && (save.report ? accountsFor(save.source, call) : named || at >= save.startedAt));
        return owner ? owner.report ?? 'main' : null;
      };
      for (const receipt of receipts) {
        const call = { ...receipt, session: dir.name, rawFile: receipt.raw ? `${project.name}/sessions/${dir.name}/${receipt.raw}` : null };
        const at = time(receipt.at) ?? -Infinity;
        if (typeof receipt.dig === 'string') {
          const item = digs.get(receipt.dig);
          // A dig no longer in this library cannot hold its calls; they stay visible as live activity.
          if (item) item.calls.push({ ...call, claimedBy: claimant(item, receipt, at, true) });
          else live.push({ ...call, projectFolder: project.name });
          continue;
        }
        const owner = saves.find(save => save.at > at);
        const item = owner && (owner.report || at >= owner.startedAt) ? owner.item : null;
        if (item) item.calls.push({ ...call, claimedBy: claimant(item, receipt, at, false) });
        else live.push({ ...call, projectFolder: project.name });
      }
    }
  }
  for (const path of parsedFiles.keys()) if (!seen.has(path)) parsedFiles.delete(path);
  const byTime = (a, b) => (time(a.at) ?? 0) - (time(b.at) ?? 0);
  for (const item of items) item.calls.sort(byTime);
  return { items: items.sort((a, b) => b.id.localeCompare(a.id)), live: live.sort(byTime).reverse() };
}
/** Whether the chosen library is a folder yet: `missing` until research is first saved there, `not-folder` when it can never hold research. */
export async function libraryFolder(config) {
  try { return (await stat(config.library)).isDirectory() ? 'folder' : 'not-folder'; } catch (e) { if (e.code === 'ENOENT') return 'missing'; if (e.code === 'ENOTDIR') return 'not-folder'; throw e; }
}
// A cheap change fingerprint for live updates: names, sizes and modification times only, never file contents.
export async function libraryRevision(config) {
  const hash = createHash('sha256');
  const list = async path => { try { return await readdir(path, { withFileTypes: true }); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return []; throw e; } };
  const add = async path => { try { const s = await lstat(path); hash.update(`${path}\0${s.size}\0${s.mtimeMs}\n`); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
  for (const project of await list(config.library)) {
    if (!project.isDirectory()) continue;
    const base = join(config.library, project.name);
    for (const dig of await list(join(base, 'digs'))) {
      if (!dig.isDirectory()) continue;
      const folder = join(base, 'digs', dig.name); await add(folder);
      for (const file of await list(folder)) if (file.isFile() && file.name.endsWith('.md')) await add(join(folder, file.name));
    }
    for (const session of await list(join(base, 'sessions'))) if (session.isDirectory()) await add(join(base, 'sessions', session.name, 'calls.jsonl'));
  }
  return hash.digest('hex').slice(0, 24);
}
// The only files library reads return: a dig's Markdown (dig.md, reports, answer), a session's receipts and original
// responses, and shared YouTube transcripts. The library folder is a model-visible setting, so a read that accepted
// any Markdown or JSON under it would let a model pointed at another folder read that folder's files.
function isResearchFile(segments) {
  const [first, second, , fourth, fifth] = segments;
  if (segments.length === 2) return first === 'youtube-transcripts' && second.endsWith('.md');
  if (segments.length === 4) return (second === 'digs' && fourth.endsWith('.md')) || (second === 'sessions' && fourth === 'calls.jsonl');
  return segments.length === 5 && second === 'sessions' && fourth === 'raw' && fifth.endsWith('.json');
}
export async function readLibraryFile(config, file, offset = 0, limit = 60000) {
  const refused = 'Only Dig research files can be read: a dig’s reports and answer, a session’s calls.jsonl and original responses (raw/*.json), and YouTube transcripts.';
  if (!/\.(md|json|jsonl)$/.test(file)) throw new Error(refused);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid read bounds');
  const base = await realpath(config.library);
  const target = await contained(config, resolve(base, file));
  if (!isResearchFile(relative(base, target).split(sep))) throw new Error(refused);
  const text = await readFile(target, 'utf8');
  const end = Math.min(offset + limit, text.length);
  return { file: relative(base, target), path: target, text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length };
}

const SECRET_NAME_PARTS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'credential', 'credentials', 'authorization', 'auth', 'cookie']);
// Known credential values are already redacted from args by value. By name, an argument the tool's own input schema
// declares (`declared`: Polymarket's token_id, paging tokens) is kept whatever it is called; undeclared names and every
// nested name that looks like a credential are dropped.
function withoutSecrets(value, declared = []) {
  if (Array.isArray(value)) return value.map(item => withoutSecrets(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => declared.includes(name) || !name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).some(part => SECRET_NAME_PARTS.has(part)))
    .map(([name, item]) => [name, withoutSecrets(item)]));
}
