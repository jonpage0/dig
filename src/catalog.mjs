import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MODULES, ALL_MODULES, moduleAgents } from './providers/modules.ts';
import { WORKER_DEFAULTS, WORKER_EFFORTS, WORKER_TABLES, environmentValues, keysPath, loadKeys, sourceSetting, stateDirectory, workerGuidance, workerSetting } from './config.mjs';
import { findExecutable } from './providers/executables.ts';
import { paperSearchDirectory, paperSearchEnvValues, paperSearchInterpreter } from './providers/runtime-config.ts';

export const packageRoot = fileURLToPath(new URL(existsSync(new URL('../skills', import.meta.url)) ? '../' : '../plugin/', import.meta.url));
const executable = name => !!findExecutable(name);
const has = name => !!process.env[name]?.trim();
/**
 * How the environment Codex started Dig with relates to keys.env for one name, never the value: `absent` (no value
 * there), `unused` (a value Dig does not use because keys.env lacks the name), `same`, or `different`.
 */
function environmentState(name, env = process.env) {
  const starting = environmentValues(env).get(name);
  if (!starting) return 'absent';
  const current = env[name]?.trim();
  return !current ? 'unused' : current === starting ? 'same' : 'different';
}
/** A source's credential environment names: secret-shaped names plus any login its setup requires. GitHub's are optional. */
function credentialNames(m) {
  const required = new Set((m.id === 'github' ? [] : m.keys ?? []).flatMap(k => typeof k === 'string' ? [k] : k));
  return (m.env ?? []).filter(name => /_(KEY|TOKEN|SECRET|PASSWORD)$/.test(name) || required.has(name)).map(name => ({ name, required: required.has(name) }));
}
/**
 * Whether the Papers bridge's own `.env` assigns `name` a value. The bridge setup's `--email` writes the Unpaywall
 * address there, and the bridge reads that file when Dig's environment lacks the name. Presence only.
 */
const bridgeHas = name => paperSearchEnvValues(name).length > 0;
const PAPERS_SETTINGS = (MODULES.find(m => m.id === 'papers')?.envSettings ?? []).map(s => s.name);
export function sourceInfo(config, source) {
  const allMethods = moduleAgents(ALL_MODULES);
  const sources = MODULES.filter(m => !source || m.id === source).map(m => {
    const enabled = config.sources.enabled.includes(m.id);
    const credentials = credentialNames(m).map(({ name, required }) => ({ name, available: has(name), required, environment: environmentState(name) }));
    const prerequisites = [];
    let status = 'ready'; let message = 'Local prerequisites available; provider availability is checked only by a real request.';
    const groups = (m.keys ?? []).map(k => typeof k === 'string' ? [k] : k);
    const missing = groups.filter(names => !names.some(has));
    const unused = missing.flat().filter(name => environmentState(name) === 'unused');
    if (missing.length) { status = missing.length < groups.length ? 'partial' : 'setup-required'; message = `Missing ${missing.map(names => names.join(' or ')).join('; ')} in Dig’s keys.env. ${unused.length ? `Codex’s environment has ${unused.join(' and ')}; Use existing key on Dig’s Sources page copies ${unused.length > 1 ? 'them' : 'it'} into keys.env.` : `The user adds ${missing.length > 1 ? 'them' : 'it'} outside chat with Edit keys.env on Dig’s Sources page; Dig reloads keys.env when it is saved.`}`; }
    if (m.id === 'github' && missing.length) { status = 'partial'; message = executable('gh') ? 'Public REST tools work anonymously or through an existing gh login. No token in keys.env; gh authentication has not been probed. GraphQL requires a valid login.' : 'Public REST discovery/read works at anonymous limits. GraphQL collaboration evidence requires a GitHub token in keys.env or a gh login.'; }
    if (m.id === 'papers') {
      const bridge = paperSearchDirectory();
      const available = existsSync(paperSearchInterpreter()) && executable('uv');
      prerequisites.push({ name: 'Papers bridge and uv', available, detail: `Independent bridge at ${bridge}. Setup: node ${join(packageRoot, 'bridges', 'papers', 'setup.mjs')} --email <your contact address>. Run --help before installation.` });
      if (!available) { status = 'partial'; message = 'Direct Semantic Scholar/OpenAlex discovery is available; federated search and full text require uv and the optional Papers bridge.'; }
      // Setup clones the bridge, so git is needed to install or update it; searches never run it, so it leaves readiness alone.
      prerequisites.push({ name: 'git', available: executable('git'), detail: 'Needed to install or update the Papers bridge, whose setup clones it; searches don’t use it.' });
    }
    if (m.id === 'youtube') {
      const available = executable('yt-dlp');
      prerequisites.push({ name: 'yt-dlp', available, detail: 'Install yt-dlp explicitly for keyless search and full transcripts; no automatic installation.' });
      if (!available) { status = has('OPENCODE_RESEARCH_GOOGLE_API_KEY') ? 'partial' : 'setup-required'; message = 'yt-dlp is absent. A Google key supports metadata search only; transcripts and keyless search need yt-dlp.'; }
    }
    if (m.id === 'commerce') {
      const current = has('SCRAPE_DO_API_KEY') || has('SCRAPEDO_API_TOKEN'); const history = has('NEXSCOPE_API_KEY');
      status = current && history ? 'ready' : current || history ? 'partial' : 'setup-required';
      message = `Product/search/discovery: ${current ? 'credential present' : 'needs Scrape.do'}; reviews/history: ${history ? 'credential present' : 'needs Nexscope'}. Credential validity is not checked.`;
    }
    if (!enabled) { message = `Disabled in Dig settings. ${message}`; status = 'disabled'; }
    return {
      id: m.id, label: m.label, description: m.description, enabled, tools: [...m.tools],
      methods: allMethods.filter(method => method.module === m.id).map(method => ({
        name: method.name, helper: method.helper, skillPath: join(packageRoot, 'skills', method.skill, 'SKILL.md'),
        tools: method.helper ? ['library_read'] : ['source_info', 'library_list', 'library_read', 'research_save', ...m.tools],
        workerDefault: workerDefault(config, method.name),
      })),
      credentials, credentialGuidance: m.credential ?? 'No API key required', prerequisites,
      // Settings such as a contact email: `available` when Dig's environment (keys.env, else Codex's) has a value;
      // `bridge` when only the Papers bridge's own .env does.
      envSettings: (m.envSettings ?? []).map(({ name, label, purpose }) => ({ name, label, purpose, available: has(name), bridge: !has(name) && m.id === 'papers' && bridgeHas(name) })),
      readiness: { status, message },
    };
  });
  return { sources, library: config.library, configPath: config.path, keysPath: keysPath(), credentialsChecked: 'presence-only' };
}
/**
 * Presence and environment comparison, never values, of every catalog name, and whether the Papers bridge's own .env
 * holds each Papers setting: part of the view's revision, so readiness refreshes when keys.env or that file changes.
 */
export const environmentPresence = (env = process.env) => [
  ...[...new Set(MODULES.flatMap(m => m.env ?? []))].map(name => [Boolean(env[name]?.trim()), environmentState(name, env)]),
  ...PAPERS_SETTINGS.map(bridgeHas),
];

const KEYS_HEADER = `# Dig provider credentials, and a few provider settings such as a contact email: one NAME=value line each.
# Keep this file private, and keep its values out of chat and version control.
# Dig takes credentials only from this file; Dig's Sources page can copy in a key Codex's environment already has.
# Dig reloads this file whenever it is saved.
`;
// keys.env writes run one at a time.
let keysWork = Promise.resolve();
const queueKeysWrite = write => { const work = keysWork.then(write); keysWork = work.catch(() => {}); return work; };
const readKeys = async path => { try { return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const ensureNewline = text => (text === '' || text.endsWith('\n') ? text : `${text}\n`);
/**
 * The Sources page's "Edit keys.env": creates the file (mode 600) if it is missing, then appends an empty `NAME=` line,
 * under a comment naming the source and its guidance, for each credential name of `source` (or of every source) that
 * the file does not already assign, commented out or not, so the file always shows everything Dig can use. A source's
 * settings (`envSettings`, such as the Unpaywall contact email) follow, each under a comment saying what it is for. An
 * empty assignment is ignored until the user fills it in. Existing lines and file mode are left alone, and values are
 * never returned.
 */
export function prepareKeysFile(source, state = stateDirectory()) {
  return queueKeysWrite(async () => {
    const path = keysPath(state);
    const text = await readKeys(path);
    const assigned = new Set([...(text ?? '').matchAll(/^[ \t]*(?:#[ \t]*)?(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)].map(match => match[1]));
    const selected = MODULES.filter(m => !source || m.id === source);
    const added = []; const blocks = [];
    for (const m of selected) {
      const names = credentialNames(m).map(c => c.name).filter(name => !assigned.has(name) && !added.includes(name));
      const settings = (m.envSettings ?? []).filter(s => !assigned.has(s.name) && !added.includes(s.name));
      if (!names.length && !settings.length) continue;
      added.push(...names, ...settings.map(s => s.name));
      // A name shared by several selected sources is written once, under every label that uses it.
      const labels = selected.filter(other => credentialNames(other).some(c => names.includes(c.name))).map(other => other.label);
      blocks.push([
        ...(names.length ? [`# ${labels.join(', ')}: ${m.credential ?? names.join(', ')}`, ...names.map(name => `${name}=`)] : []),
        ...settings.flatMap(s => [`# ${s.label} (${m.label}): ${s.purpose}`, `${s.name}=`]),
      ].join('\n'));
    }
    await mkdir(state, { recursive: true });
    if (text === null) await writeFile(path, `${KEYS_HEADER}${blocks.map(block => `\n${block}\n`).join('')}`, { flag: 'wx', mode: 0o600 });
    else if (blocks.length) await appendFile(path, `${ensureNewline(text) === text ? '' : '\n'}${blocks.map(block => `\n${block}\n`).join('')}`);
    return { path, added, created: text === null };
  });
}
/**
 * The Sources page's "Use existing key" / "Update key from env": copies into keys.env each credential of `source` that
 * Codex's environment holds and keys.env lacks (`unused`) or holds differently (`different`). The first active
 * assignment of a name is replaced; otherwise the line is appended under the source's comment. The file is written
 * atomically at mode 600 and applied at once. Returns the names copied, never values.
 */
export function copyEnvironmentKeys(source, state = stateDirectory(), env = process.env) {
  return queueKeysWrite(async () => {
    const path = keysPath(state);
    const m = MODULES.find(candidate => candidate.id === source);
    if (!m) throw new Error(`Unknown source: ${source}`);
    const names = credentialNames(m).map(c => c.name).filter(name => ['unused', 'different'].includes(environmentState(name, env)));
    if (!names.length) return { path, copied: [] };
    let text = (await readKeys(path)) ?? KEYS_HEADER;
    const appended = [];
    for (const name of names) {
      const value = environmentValues(env).get(name);
      if (/[\r\n]/.test(value)) throw new Error(`${name} in Codex’s environment spans several lines; copy it into keys.env by hand`);
      const line = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'm');
      if (line.test(text)) text = text.replace(line, () => `${name}=${value}`);
      else appended.push(`${name}=${value}`);
    }
    if (appended.length) text = `${ensureNewline(text)}\n# ${m.label}: ${m.credential ?? appended.map(line => line.split('=')[0]).join(', ')}\n${appended.join('\n')}\n`;
    await mkdir(state, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
    loadKeys(env, state);
    return { path, copied: names };
  });
}
/** A method's suggested worker for source_info: the effective guidance and what decided it. */
function workerDefault(config, method) {
  const { model, effort, configured } = workerGuidance(config, method);
  return { model, effort, basis: configured ? 'Set in Dig’s settings by the user; guidance, not an enforced pin. The initiating thread chooses the model and effort.' : 'Guidance, not an enforced pin. The initiating thread chooses the model and effort.' };
}
const METHODS = moduleAgents(ALL_MODULES);
/** `x-judge` → "X judge", `youtube-summarizer` → "YouTube summarizer"; a method named after its source takes its label. */
const methodLabel = agent => { const m = MODULES.find(candidate => candidate.id === agent.module); return agent.name === m.id ? m.label : `${m.label} ${agent.name.slice(m.id.length + 1).replaceAll('-', ' ')}`; };
const workerFields = agent => {
  const label = methodLabel(agent); const own = WORKER_DEFAULTS[agent.name];
  return {
    [workerSetting(agent.name, 'model')]: { schema: z.string().min(1), title: `${label} worker model`, description: own ? `Dig suggests ${own.model} for ${label}. The conversation chooses each worker’s model and may choose another.` : `Follows the Dig-wide source worker model until you set a different one here. The conversation chooses each worker’s model and may choose another.` },
    [workerSetting(agent.name, 'effort')]: { schema: z.enum(WORKER_EFFORTS), title: `${label} worker effort`, description: own ? `Dig suggests ${own.effort} effort for ${label}.` : 'Follows the Dig-wide source worker effort until you set a different one here.' },
  };
};
export const settingsFields = {
  library: { schema: z.string().min(1), title: 'Research library', description: 'Absolute directory outside the plugin cache. Changing it selects a library; it does not move research.' },
  keep_raw: { schema: z.boolean(), title: 'Retain original provider responses' },
  worker_model: { schema: z.string().min(1), title: 'Source worker model', description: `The Codex model Dig suggests for source workers, ${WORKER_DEFAULTS.default.model} unless you change it. The conversation chooses each worker’s model and may choose another; Dig does not check that your account offers it. Each method follows this until it has its own suggestion on the Sources page; X judge and X breadth start with their own.` },
  worker_effort: { schema: z.enum(WORKER_EFFORTS), title: 'Source worker effort', description: `The reasoning effort Dig suggests for source workers, ${WORKER_DEFAULTS.default.effort} unless you change it. Each method follows this until it has its own suggestion on the Sources page; X judge and X breadth start with their own.` },
  ...Object.fromEntries(MODULES.map(m => [sourceSetting(m.id), { schema: z.boolean(), title: `Enable ${m.label}`, description: m.description }])),
  x_model: { schema: z.string().min(1), title: 'X provider model', description: 'xAI retrieval model, not the Codex source-worker model.' },
  x_depth: { schema: z.enum(['quick', 'standard', 'max', 'ultra']), title: 'Starting X search depth', description: 'X passes use this depth unless a pass needs another: X judge may run one max pass for a nuanced or disputed question, X breadth one max pass for a final sweep, and a quick existence check runs quick. A max or ultra starting depth applies to every pass.' },
  x_web_search: { schema: z.boolean(), title: 'Include web search in X retrieval', description: 'Off keeps X research to X posts. A request can still turn web search on or off for a single pass.' },
  x_code_execution: { schema: z.boolean(), title: 'Allow provider code execution in X retrieval' },
  ...Object.fromEntries(METHODS.flatMap(agent => Object.entries(workerFields(agent)))),
};
const properties = names => names.map(property => ({ kind: 'property', property }));
// Native layouts have no nested groups, so a source's own settings follow its Enable control in the Sources group:
// X's retrieval settings, then the worker suggestion of each of its methods.
const X_SETTINGS = ['x_model', 'x_depth', 'x_web_search', 'x_code_execution'];
const ownSettings = m => [...(m.id === 'x' ? X_SETTINGS : []), ...METHODS.filter(agent => agent.module === m.id).flatMap(agent => [workerSetting(agent.name, 'model'), workerSetting(agent.name, 'effort')])];
export const settingsLayout = [
  { kind: 'group', title: 'Library', items: properties(['library', 'keep_raw']) },
  { kind: 'group', title: 'Source workers', items: properties(['worker_model', 'worker_effort']) },
  { kind: 'group', title: 'Sources', items: [...properties(MODULES.flatMap(m => [sourceSetting(m.id), ...ownSettings(m)])), { kind: 'tool', tool: 'source_readiness', title: 'Check source readiness', description: 'Credential names and local prerequisites for every source. Does not call providers.' }] },
];
/** Each worker field shows the guidance in effect: its own stored value, else what it inherits. */
export const settingsValues = c => ({
  library: c.library, keep_raw: c.keep_raw,
  ...Object.fromEntries(MODULES.map(m => [sourceSetting(m.id), c.sources.enabled.includes(m.id)])),
  ...Object.fromEntries(Object.entries(c.x).map(([key, value]) => [`x_${key}`, value])),
  ...Object.fromEntries(WORKER_TABLES.flatMap(name => { const { model, effort } = workerGuidance(c, name); return [[workerSetting(name, 'model'), model], [workerSetting(name, 'effort'), effort]]; })),
});
export const settingsDocument = c => ({ schema: { type: 'object', properties: Object.fromEntries(Object.entries(settingsFields).map(([key, { schema, title, description }]) => [key, { ...z.toJSONSchema(schema), title, description }])) }, layout: settingsLayout, values: settingsValues(c) });
