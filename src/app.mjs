import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { $, attr, button, externalLink, keyed, node, rebuild, tag, text } from './ui/dom.mjs';
import { COST_CAVEAT, COST_SCOPE, absTime, basename, clock, costTotal, num, plural, shortDate } from './ui/format.mjs';
import { costSummary } from './providers/library/cost.ts';
import { MODULES } from './providers/modules.ts';
import { createCatalog, fileKind } from './ui/catalog.mjs';
import { firstParagraph } from './ui/markdown.mjs';
import { callSentence, documentView, rawView } from './ui/reader.mjs';
import { renderRetrievals } from './ui/retrievals.mjs';
import { callWord } from './status.mjs';
import { renderSettings } from './ui/settings.mjs';
import { renderAccounts } from './ui/accounts.mjs';
import { renderSources } from './ui/sources.mjs';
import { costMetric, metric, outcomeCounts, renderUsage, sourceRows, usageOf } from './ui/usage.mjs';
import { VERSION } from './version.mjs';

const POLL_MS = 2000;
const READ_LIMIT = 60000;
const PANEL_LIVE_LIMIT = 8;
// App-relative deep link documented by the MCP Extensions spec: /read?file=<library-relative or absolute library file>.
const DEEP_LINK_ROUTE = '/read';

const params = new URLSearchParams(location.search);
const preview = params.has('preview');
let snapshot = { items: [], live: [] }; let catalog = createCatalog(); let extensions; let app;
let current = null; let open = null; let pendingFile = null; let returnFile = null; let navigation = 0;
let mode = 'library'; let thread = null; let view = 'browse'; let returnView = 'browse'; let aboutReturn = 'browse';
let revision = null; let polling = false; let updatesFailed = false; let staleViewNoticed = false; let replacedNoticed = false;
// The open Sources or Settings page: its renderer's update handle, which page it is, and the request that built it.
// About keeps it, so Back returns to a page that still refreshes.
let page = null; let pageView = null; let pageRequest = 0;
// The Library page's usage window in days (0 for all time). It lasts while the view is open and is never saved.
// Until the first snapshot arrives the section stays empty, so a library with research never flashes "No usage yet".
let usageDays = 30; let snapshotLoaded = false;
function showUsage() {
  if (view !== 'browse' || !snapshotLoaded) return;
  renderUsage($('usage'), usageOf(snapshot, { days: usageDays }), days => { usageDays = days; showUsage(); });
}
let handledDeepLink = null; let pendingDeepLink = null;
// Under the library field: the server reports whether the chosen path is a folder yet. A save never creates it, and
// neither does reading, so a mistyped path shows here instead of quietly becoming an empty library.
const LIBRARY_FOLDER_NOTES = {
  missing: 'This folder does not exist yet. Dig creates it when research is first saved here. If you meant a folder that already holds your research, check the path.',
  'not-folder': 'This path is not a folder, so research cannot be saved here. Choose a folder.',
};
const libraryNote = attr(attr(node('p', ''), 'id', 'setting-library-note'), 'aria-live', 'polite');
function showLibraryFolder() {
  const message = LIBRARY_FOLDER_NOTES[snapshot.libraryFolder] ?? '';
  text(libraryNote, message); libraryNote.hidden = !message;
}

async function call(name, args = {}) {
  const result = preview ? await (await fetch(`/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })).json() : await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || 'Cannot read research');
  return result.structuredContent ?? result;
}
function notify(value, failure = false) {
  text($('notice'), value); $('notice').className = failure ? 'notice error' : 'notice';
  $('notice-row').classList.toggle('has-notice', Boolean(value)); $('dismiss').hidden = !value;
}

function show(next) {
  view = next;
  for (const id of ['panel', 'browse', 'detail', 'sources', 'settings', 'about']) $(id).hidden = id !== next;
  for (const [id, target] of [['nav-trail', 'panel'], ['nav-library', 'browse'], ['nav-sources', 'sources'], ['nav-settings', 'settings']]) $(id).setAttribute('aria-current', target === next ? 'page' : 'false');
  if (next !== 'about' && next !== pageView) { page = null; pageView = null; }
  // Usage is drawn only while the Library shows, so it is brought up to date on the way back to it.
  if (next === 'browse') showUsage();
}
function setMode(nextMode, nextThread) {
  mode = nextMode; thread = nextThread ?? null;
  document.body?.classList?.toggle('panel-mode', mode === 'panel');
  $('nav-trail').hidden = mode !== 'panel';
  text($('tagline'), mode === 'panel' ? 'Research trail' : 'Saved research');
  text($('host-state'), preview ? 'Browser preview (read-only)' : mode === 'panel' ? 'Conversation panel' : 'Native library');
  if (view === 'browse' || view === 'panel') show(mode === 'panel' ? 'panel' : 'browse');
  renderPanel();
}

function render(value) {
  snapshot = { ...value, items: value.items ?? [], live: value.live ?? [] }; snapshotLoaded = true;
  if (Array.isArray(value.sources)) catalog = createCatalog(value.sources);
  const reports = snapshot.items.reduce((sum, item) => sum + item.reports.length, 0);
  const calls = snapshot.items.reduce((sum, item) => sum + item.calls.length, 0) + snapshot.live.length;
  text($('questions'), snapshot.items.length); text($('reports'), reports); text($('retrievals'), calls);
  const enabled = Array.isArray(snapshot.enabledSources) ? snapshot.enabledSources : null;
  text($('source-status'), enabled ? (catalog.size ? `${enabled.length} of ${plural(catalog.size, 'source')} on` : `${plural(enabled.length, 'source')} on`) : '');
  text($('retention'), snapshot.keepRaw ? 'Original responses retained' : 'Original responses not retained');
  text($('library-path'), snapshot.library || ''); showLibraryFolder();
  filter(); renderPanel(); showUsage();
  if (current) refreshCurrent();
  applyDeepLink();
  // A later install removed this server's files while Codex kept it running. Refresh reloads this server's own
  // view, so only reopening Codex loads the new version.
  if (!replacedNoticed && value.replaced && typeof value.version === 'string') {
    replacedNoticed = true; staleViewNoticed = true;
    notify(replacedMessage(value));
  }
  // Codex can keep showing a cached view after Dig is updated; the server's version reveals it.
  if (!staleViewNoticed && typeof value.version === 'string' && value.version !== VERSION) {
    staleViewNoticed = true;
    notify(`Dig ${value.version} is installed, but Codex is still showing the ${VERSION} view. Right-click Dig in the sidebar and choose Refresh to load the new one.`);
  }
}
function replacedMessage(value) {
  const installed = typeof value.replaced?.version === 'string' ? value.replaced.version : null;
  return `${installed ? `Dig ${installed} was installed` : 'Dig was updated or removed'} while Codex was running. Quit and reopen Codex to load ${installed ? 'it' : 'the change'}; until then this view keeps running Dig ${value.version}, and Refresh cannot load the new version.`;
}

const projectName = item => basename(item.project) || item.project;
function sourcesLine(item) {
  const methods = Array.isArray(item.methods) && item.methods.length ? item.methods.map(catalog.methodLabel) : Array.isArray(item.sources) ? item.sources.map(catalog.label) : [];
  return methods.length ? [...new Set(methods)].join(' · ') : 'No source report yet';
}
const startedLine = item => [item.startedAt ? `Started ${absTime(item.startedAt)}` : null, projectName(item)].filter(Boolean).join(' · ');
const snippet = item => (item.snippet ? firstParagraph(item.snippet) || item.snippet : '');
const countsLine = item => `${plural(item.reports.length, 'report')} · ${plural(item.calls.length, 'retrieval')}`;
const costLine = calls => costTotal(costSummary(calls), calls.length);
const cardCost = item => { const total = costLine(item.calls); return total ? node('p', 'meta', total) : null; };
/**
 * The figures at the top of the conversation panel, over the same calls as the conversation's cost: its digs' calls
 * (a worker's once it names the dig or its report claims it) and its own unclaimed calls, never another thread's.
 * `elsewhere` counts unclaimed calls from workers and other conversations, which are named but not counted. With no
 * calls and no reports the block is hidden rather than reading as no charge.
 */
function showPanelFigures(element, calls, reports, elsewhere) {
  element.hidden = !calls.length && !reports.length;
  if (element.hidden) { element.replaceChildren(); return; }
  const counts = outcomeCounts(calls);
  rebuild(element, [
    node('dl', 'metrics',
      metric('Retrievals', num(counts.total), `${num(counts.results)} with results`),
      metric('Sources', num(sourceRows(calls, reports).length), `${plural(reports.length, 'report')} saved`),
      metric('Failed or stopped', num(counts.failed), counts.total ? `${Math.round((counts.failed / counts.total) * 100)}% of retrievals` : 'None yet'),
      costMetric(costSummary(calls), counts.total)),
    elsewhere ? node('p', 'meta', `Not included: ${plural(elsewhere, 'retrieval')} by workers or other conversations that no saved report has claimed yet.`) : null,
    node('p', 'meta usage-scope', `${COST_SCOPE}. ${COST_CAVEAT}`),
  ].filter(Boolean));
}

function card(item) {
  const opener = keyed(button('card-open', item.title, () => showDig(item).catch(e => notify(e.message, true))), `dig:${item.project}:${item.id}`);
  const summary = snippet(item);
  return node('article', 'research-card',
    node('div', 'card-head', node('p', 'eyebrow', sourcesLine(item)), tag(item.status)),
    node('h2', '', opener),
    attr(node('p', 'meta', startedLine(item)), 'title', item.project),
    summary ? node('p', 'summary', summary) : null,
    node('p', 'meta', countsLine(item)),
    cardCost(item));
}
function filter() {
  const query = $('search').value.trim().toLowerCase();
  const items = snapshot.items.filter(item => `${item.title} ${item.project} ${item.snippet ?? ''} ${(item.reportDetails ?? []).map(r => r.summary).join(' ')} ${sourcesLine(item)}`.toLowerCase().includes(query));
  rebuild($('list'), items.length ? items.map(card) : [node('div', 'empty', snapshot.items.length ? `No research matches “${$('search').value.trim()}”. Clear the search to see everything.` : 'Your library is ready. Ask the conversation to research a question with one of Dig’s sources; it appears here as soon as it starts.')]);
}

function trailCard(item) {
  const latest = item.calls.at(-1);
  const opener = keyed(button('card-open', item.title, () => showDig(item).catch(e => notify(e.message, true))), `trail:${item.project}:${item.id}`);
  return node('article', 'trail-card',
    node('div', 'card-head', node('p', 'eyebrow', sourcesLine(item)), tag(item.status)),
    node('h3', '', opener),
    node('p', 'meta', countsLine(item)),
    cardCost(item),
    latest ? node('p', 'meta', `Latest: ${callSentence(latest, catalog)} (${callWord(latest.status)})`) : null);
}
function liveRow(receipt) {
  const here = thread && receipt.session === thread;
  return node('div', 'call', tag(callWord(receipt.status)), node('p', '', callSentence(receipt, catalog)), node('p', 'meta', `${clock(receipt.at)} · ${here ? 'this conversation' : 'another conversation or worker'}`));
}
function renderPanel() {
  if (mode !== 'panel') return;
  const mine = thread ? snapshot.items.filter(item => item.session === thread) : [];
  text($('panel-scope'), thread ? 'This conversation' : 'Conversation not identified');
  rebuild($('panel-digs'), !thread ? [node('p', 'empty', 'Codex did not identify this conversation to Dig, so the trail cannot pick out its research. Use Library to browse everything.')] : mine.length ? mine.map(trailCard) : [node('p', 'empty', 'No research started in this conversation yet. It appears here as soon as it starts.')]);
  const elsewhere = thread ? snapshot.live.filter(receipt => receipt.session !== thread).length : 0;
  showPanelFigures($('panel-figures'), thread ? [...mine.flatMap(item => item.calls), ...snapshot.live.filter(receipt => receipt.session === thread)] : [], mine.flatMap(item => item.reportDetails ?? []), elsewhere);
  const live = snapshot.live.slice(0, PANEL_LIVE_LIMIT);
  $('live-caveat').hidden = !live.some(receipt => !thread || receipt.session !== thread);
  rebuild($('panel-live'), live.length ? live.map(liveRow) : [node('p', 'meta', 'None right now.')]);
}

// Updates rebuild the header, file tabs and Retrievals summary without replacing the open document or selection.
function fileTab(file) {
  const tab = keyed(button('file-tab', catalog.fileLabel(file), () => showFile(file).catch(e => notify(e.message, true))), `file:${file}`);
  attr(tab, 'title', basename(file));
  return attr(tab, 'aria-current', open?.file === file || (!open && pendingFile === file) ? 'true' : 'false');
}
function renderDigChrome(item) {
  text($('dig-title'), item.title);
  $('dig-meta').replaceChildren(tag(item.status), ` ${startedLine(item)}${item.finishedAt ? ` · Answer ${shortDate(item.finishedAt)}` : ''}`);
  renderRetrievals($('dig-retrievals'), item, catalog, rawFile => inspectRaw(rawFile).catch(e => notify(e.message, true)));
  const viewing = open?.kind === 'raw' ? [open.file] : pendingFile && fileKind(pendingFile) === 'raw' ? [pendingFile] : [];
  rebuild($('files'), [...item.files, ...viewing].map(fileTab));
}
function refreshCurrent() {
  const updated = snapshot.items.find(item => item.id === current.id && item.project === current.project);
  if (!updated) { notify('This dig is no longer in the selected library. The open file stays as it was read.', true); return; }
  const added = updated.files.filter(file => !current.files.includes(file));
  current = updated; renderDigChrome(updated);
  if (added.length) notify(`Saved to this dig: ${added.map(catalog.fileLabel).join(', ')}. Open its tab to read it.`);
}
async function readAll(file) {
  let offset = 0; let body = '';
  do { const part = await call('library_read', { file, offset, limit: READ_LIMIT }); body += part.text; offset = part.nextOffset; } while (offset !== null);
  return body;
}
async function showFile(file) {
  const request = ++navigation;
  open = null; pendingFile = file;
  if (current) renderDigChrome(current);
  const kind = fileKind(file);
  text($('file-title'), catalog.fileLabel(file)); text($('file-name'), file);
  $('back-to-report').hidden = true;
  $('document').replaceChildren(node('p', 'meta', 'Reading retained research…'));
  let body;
  try { body = await readAll(file); } catch (e) {
    if (request === navigation) $('document').replaceChildren(node('p', 'meta', `Unable to read this file: ${e.message}`));
    throw e;
  }
  if (request !== navigation || !current) return;
  const receipt = kind === 'raw' ? current.calls.find(c => c.rawFile === file) : undefined;
  open = { file, kind };
  pendingFile = null;
  $('document').replaceChildren(kind === 'raw' ? rawView(file, body, receipt, catalog) : documentView(file, body, catalog));
  // From an original response, return to the file the reader came from, or else to the report that saved this retrieval.
  const back = kind === 'raw' ? returnFile ?? (receipt?.claimedBy && current.files.includes(receipt.claimedBy) ? receipt.claimedBy : null) : null;
  if (back) { returnFile = back; text($('back-to-report'), `← Back to ${catalog.fileLabel(back)}`); $('back-to-report').hidden = false; }
  renderDigChrome(current);
}
function inspectRaw(rawFile) {
  if (open && open.kind !== 'raw') returnFile = open.file;
  return showFile(rawFile);
}
async function showDig(item, file) {
  if (view !== 'detail') returnView = view;
  current = item; open = null; returnFile = null; show('detail');
  await showFile(file ?? item.answer ?? item.reports[0] ?? item.files.find(f => f.endsWith('dig.md')));
}
function leaveDetail() { navigation++; current = null; open = null; pendingFile = null; returnFile = null; }

// Exact-file deep links: the host supplies the app-relative URL on connect and in host-context changes.
function readDeepLink() {
  const url = extensions?.deepLink?.getCurrent()?.url;
  if (!url || url === handledDeepLink) return;
  handledDeepLink = url;
  const route = new URL(url, 'https://dig.invalid');
  if (route.pathname === '/') return; // The entrypoint's default page: nothing to open.
  const file = route.searchParams.get('file');
  if (route.pathname !== DEEP_LINK_ROUTE || !file) { notify(`Dig cannot open this link: ${url}`, true); return; }
  pendingDeepLink = file;
  applyDeepLink();
}
// An absolute path is resolved by the server's confined read, which reports the library-relative name.
async function deepLinkFile(file) {
  const prefix = `${snapshot.library.replace(/\/+$/, '')}/`;
  if (file.startsWith(prefix)) return file.slice(prefix.length);
  return file.startsWith('/') ? (await call('library_read', { file, offset: 0, limit: 1 })).file : file;
}
function applyDeepLink() {
  if (!pendingDeepLink || !snapshot.library) return;
  const requested = pendingDeepLink; pendingDeepLink = null;
  const request = ++navigation;
  // A hidden app can receive a link before its visibility poll refreshes the library.
  call('library_snapshot').then(async latest => {
    if (request !== navigation) return;
    render(latest);
    const file = await deepLinkFile(requested);
    if (request !== navigation) return;
    const item = snapshot.items.find(entry => entry.files.includes(file) || entry.calls.some(receipt => receipt.rawFile === file));
    if (!item) throw new Error(`The linked file is not part of a dig in the selected library: ${requested}`);
    return showDig(item, file);
  }).catch(e => notify(e.message, true));
}

// Credential values never pass through this view or the conversation: the server writes only empty NAME= lines
// for names the file lacks (of one source, or of every source), and Codex opens the file itself.
async function editKeys(source) {
  let path = null;
  try {
    const prepared = await call('prepare_keys_file', source ? { source } : {});
    path = prepared.path;
    const added = !prepared.added.length ? '' : prepared.added.length > 4 ? ` Added ${prepared.added.length} empty lines.` : ` Added empty lines for ${prepared.added.join(', ')}.`;
    const files = extensions?.files;
    if (!files) { notify(`Codex cannot open files from this view. Open ${path} in a text editor, fill in the values and save.${added}`); return; }
    await files.open(path);
    notify(`Opened keys.env.${added} Fill in the values and save; Dig reloads the file and updates readiness here.`);
  } catch (e) { notify(path ? `Codex did not open ${path}: ${e.message}` : `Unable to prepare keys.env: ${e.message}`, true); }
}
// The server copies the key Codex's environment gave Dig into keys.env; the view only learns which names moved.
async function useEnvironmentKeys(source) {
  try {
    const result = await call('use_environment_keys', { source });
    notify(result.copied.length ? `Copied ${result.copied.join(', ')} from Codex’s environment into keys.env.` : 'keys.env already matches Codex’s environment.');
    await refreshPage();
  } catch (e) { notify(`Unable to copy the key into keys.env: ${e.message}`, true); }
}
// Readiness depends on enablement and keys.env, so source_info is read with the page and again whenever either changes.
const readSourceInfo = () => call('source_info').catch(e => ({ error: e.message }));
const SCHEMA_MISSING = 'Settings arrived without their schema, so no controls can be shown. Reload Dig and try again.';
const READ_ONLY = 'Browser preview is read-only. Open Dig in Codex to change settings.';

// One setting at a time, in order, through the same settings.update Codex's plugin settings use. The returned
// values are the file's; a refresh then brings readiness, the footer and the other page up to date.
let saving = Promise.resolve();
function saveSetting(key, value) {
  const work = saving.then(async () => (await call('settings.update', { set: { [key]: value } })).values);
  saving = work.catch(() => {});
  work.then(() => poll(true)).catch(e => notify(`Not saved: ${e.message}`, true));
  return work;
}
// Accounts and keys shows with source_info: the keys file's path and its Edit button, then the accounts fold.
function showKeys(info) {
  const path = info?.keysPath;
  $('keys-section').hidden = !path && !(Array.isArray(info?.sources) && info.sources.length);
  $('keys-path').hidden = !path;
  if (path) text($('keys-path'), path);
  $('edit-keys').disabled = preview || !path;
  renderAccounts($('accounts'), info?.sources);
}
// The heading counts what is on and names only the exceptions; each card and the index carry the details.
function sourcesSummary(info) {
  const sources = Array.isArray(info?.sources) ? info.sources : [];
  const on = sources.filter(s => s.enabled);
  const count = status => on.filter(s => s.readiness?.status === status).length;
  const partly = count('partial'); const setup = count('setup-required');
  text($('sources-summary'), sources.length ? [`${on.length} of ${plural(sources.length, 'source')} on`, partly ? `${partly} partly ready` : null, setup ? `${setup} ${setup === 1 ? 'needs' : 'need'} setup` : null].filter(Boolean).join(' · ') : '');
}
async function openSources() {
  show('sources'); const request = ++pageRequest;
  text($('sources-status'), 'Reading sources…');
  const [read, info] = await Promise.all([call('settings.read'), readSourceInfo()]);
  if (request !== pageRequest || view !== 'sources') return;
  if (!read.schema?.properties || !read.values) throw new Error(SCHEMA_MISSING);
  if (Array.isArray(info.sources)) catalog = createCatalog(info.sources);
  showKeys(info); sourcesSummary(info);
  page = renderSources($('sources-list'), $('sources-toc'), read, info.sources ?? [], preview ? null : saveSetting, preview ? null : { editKeys, useEnvironment: useEnvironmentKeys }); pageView = 'sources';
  text($('sources-status'), preview ? READ_ONLY : info.error ? `Source readiness is unavailable: ${info.error}` : '');
}
async function openSettings() {
  show('settings'); const request = ++pageRequest;
  text($('config-path'), snapshot.configPath || 'config.toml'); text($('settings-status'), 'Reading settings…');
  const read = await call('settings.read');
  if (request !== pageRequest || view !== 'settings') return;
  if (!read.schema?.properties || !read.values) throw new Error(SCHEMA_MISSING);
  page = renderSettings($('settings-fields'), read, MODULES.map(m => m.id), preview ? null : saveSetting, { library: libraryNote }); pageView = 'settings';
  text($('settings-status'), preview ? READ_ONLY : '');
}
// A change from Codex's settings page, a hand edit or keys.env updates the open page in place; a field being typed
// in and focus are kept.
async function refreshPage() {
  const handle = page; const onSources = pageView === 'sources';
  if (!handle) return;
  const [read, info] = await Promise.all([call('settings.read').catch(() => null), onSources ? readSourceInfo() : null]);
  if (handle !== page) return;
  handle.update(read?.values ? read : null, info && !info.error ? info.sources : null);
  if (onSources && info && !info.error) { showKeys(info); sourcesSummary(info); }
}

function aboutPath(label, path, action) {
  return node('div', 'about-path', node('p', 'eyebrow', label), node('p', 'path', path || 'Unknown'), action);
}
function openFile(path) {
  const files = extensions?.files;
  if (preview || !files) return null;
  return button('', 'Open', () => files.open(path).catch(e => notify(`Codex did not open ${path}: ${e.message}`, true)));
}
async function openAbout() {
  if (view !== 'about') aboutReturn = view;
  show('about');
  const info = await readSourceInfo();
  if (view !== 'about') return;
  const server = typeof snapshot.version === 'string' ? snapshot.version : null;
  const keys = info.keysPath ? button('', 'Edit keys.env', () => editKeys()) : null;
  if (keys) keys.disabled = preview;
  const section = (title, ...body) => [node('h3', 'section-title', title), ...body];
  rebuild($('about-body'), [
    node('p', 'lede', 'Dig researches a question with source-specific methods and keeps the evidence. Each source saves a report together with the original responses it retrieved, and this library lets you read both. Research runs in the conversation; this view only reads and never starts research.'),
    ...section('Version', node('p', '', snapshot.replaced && server ? replacedMessage(snapshot) : server && server !== VERSION ? `Dig ${server} is installed, but this view is ${VERSION}. Right-click Dig in the sidebar and choose Refresh to load the new view.` : `Dig ${VERSION}.`)),
    ...section('Where your things live',
      aboutPath('Research library', snapshot.library),
      aboutPath('Settings file', info.configPath ?? snapshot.configPath, openFile(info.configPath ?? snapshot.configPath)),
      info.keysPath ? aboutPath('Keys file', info.keysPath, keys) : null),
    ...section('Keys and privacy', node('p', '', 'Provider keys stay in keys.env, outside the conversation. Dig never asks for a key in chat, and keys never pass through this view: its buttons send only source names, Dig copies values on its own side, and Codex opens the file itself. Provider responses are kept as evidence and treated as untrusted text, never as instructions.')),
    ...section('Costs', node('p', '', 'Amounts are what each provider reported for a call, kept with that call’s receipt. They are usage, not a reconciled bill, and they leave out Codex’s own model usage. A call whose cost was not reported shows as unknown, never as free.')),
    ...section('Help', node('p', '', 'Type $dig:setup in the composer to choose sources and see what each still needs. $dig:library finds research you have already saved.')),
    ...section('Credits', node('ul', 'credits',
      node('li', '', 'Dig by Jon Page, MIT License.'),
      node('li', '', 'Interface glyphs from ', externalLink('https://lucide.dev', 'Lucide'), ' (ISC License); styles from OpenAI’s MCP Apps stylesheet (Apache License 2.0).'),
      node('li', '', 'The Papers bridge uses ', externalLink('https://github.com/openags/paper-search-mcp', 'paper-search-mcp'), ' by P.S Zhang (MIT License).'),
      node('li', '', 'Source logos are trademarks of their owners and identify each service; Dig is not affiliated with or endorsed by them. They come from ', externalLink('https://svgl.app', 'svgl'), ', ', externalLink('https://simpleicons.org', 'Simple Icons'), ' (CC0) and the Polymarket and Exa websites.'))),
  ]);
}

// Live updates: poll a cheap fingerprint while visible; only a changed fingerprint reloads the snapshot.
async function poll(force = false) {
  if (polling || (!force && document.visibilityState === 'hidden')) return;
  polling = true;
  try {
    const next = (await call('library_revision')).revision;
    if (force || next !== revision) { const value = await call('library_snapshot'); revision = next; render(value); if (page) await refreshPage(); }
    if (updatesFailed) { updatesFailed = false; $('reload').hidden = true; notify('Automatic updates resumed.'); }
    text($('live-state'), 'Updates automatically');
  } catch (e) {
    if (!updatesFailed) notify(`Automatic updates paused: ${e.message}`, true);
    updatesFailed = true; $('reload').hidden = false; text($('live-state'), 'Updates paused');
  } finally { polling = false; }
}

// Outbound links open through the host when it offers that; a refusal is reported, never silently dropped.
function openExternal(event) {
  const anchor = event.target?.closest?.('a[data-external]');
  if (!anchor || preview || !app?.getHostCapabilities?.()?.openLinks) return;
  event.preventDefault();
  app.openLink({ url: anchor.href }).then(result => { if (result?.isError) notify(`The host did not open ${anchor.href}.`, true); }).catch(e => notify(`Unable to open ${anchor.href}: ${e.message}`, true));
}

$('search').oninput = filter;
$('back').onclick = () => { leaveDetail(); show(returnView); };
$('back-to-report').onclick = () => { if (returnFile) showFile(returnFile).catch(e => notify(e.message, true)); };
$('nav-trail').onclick = () => { if (current) leaveDetail(); show('panel'); };
$('nav-library').onclick = () => { if (current) leaveDetail(); show('browse'); };
$('nav-sources').onclick = () => { if (current) leaveDetail(); openSources().catch(e => { text($('sources-status'), e.message); notify(e.message, true); }); };
$('nav-settings').onclick = () => { if (current) leaveDetail(); openSettings().catch(e => { text($('settings-status'), e.message); notify(e.message, true); }); };
// About keeps an open dig, so Back returns to it as it was.
$('nav-about').onclick = () => openAbout().catch(e => notify(e.message, true));
$('about-back').onclick = () => show(aboutReturn === 'detail' && !current ? (mode === 'panel' ? 'panel' : 'browse') : aboutReturn);
$('edit-keys').onclick = () => editKeys();
$('reload').onclick = () => poll(true);
$('dismiss').onclick = () => notify('');

async function start() {
  document.addEventListener('click', openExternal);
  if (preview) {
    setMode(params.has('panel') ? 'panel' : 'library', params.get('panel') || null);
    await poll(true);
  } else {
    app = new App({ name: 'Dig Library', version: VERSION }); extensions = new OpenAIExtensions(app);
    // Entrypoint results only name the requested view; the library itself arrives through library_snapshot and polling.
    app.ontoolresult = result => { const value = result.structuredContent; if (value?.view === 'panel') setMode('panel', value.thread ?? null); };
    const apply = context => { if (context?.theme) applyDocumentTheme(context.theme); if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables); };
    app.addEventListener('hostcontextchanged', context => { apply(context); readDeepLink(); });
    await app.connect(); apply(app.getHostContext());
    setMode(mode === 'panel' || app.getHostContext()?.toolInfo?.tool?.name === 'open_trail' ? 'panel' : 'library', thread);
    if (!snapshot.library) render(await call('library_snapshot'));
    readDeepLink();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  setInterval(() => poll(), POLL_MS);
}
start().catch(e => notify(e.message, true));
