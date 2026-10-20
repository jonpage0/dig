import React, { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useRouter, useRouterState } from '@tanstack/react-router';
import { MODULES } from '../../providers/modules.ts';
import { costSummary } from '../../providers/library/cost.ts';
import { callWord, patternOf } from '../../status.mjs';
import { VERSION } from '../../version.mjs';
import { httpUrl, node, rebuild } from '../../ui/dom.mjs';
import { COST_CAVEAT, COST_SCOPE, absTime, basename, clock, costShort, costTotal, num, plural, shortDate } from '../../ui/format.mjs';
import { firstParagraph } from '../../ui/markdown.mjs';
import { callSentence, documentView, rawView } from '../../ui/reader.mjs';
import { renderRetrievals, revealRetrievals } from '../../ui/retrievals.mjs';
import { ownerOf, settingsGroups } from '../../ui/settings.mjs';
import { mark } from '../../ui/sources.mjs';
import { costMetric, metric, outcomeCounts, renderUsage, sourceRows, usageOf } from '../../ui/usage.mjs';
import { Button, Badge } from '../shared/components';
import { Frame, FrameHeader, FrameTitle, FrameDescription, FramePanel } from '../shared/frame';
import { IconTile } from '../shared/icon-tile';
import type { DigHost } from '../shared/host';
import { SourceSetting } from './source-controls';
import { SourcesPage } from './sources';
import { GuidePage } from './guide';
import { READ_ONLY, SCHEMA_MISSING, replacedMessage, useLibraryController } from './controller';

type Controller = ReturnType<typeof useLibraryController>;

/** These small DOM islands retain the audited text-only Markdown/provider renderers during migration.
 * React owns when they render and the surrounding navigation/state; none accepts HTML strings. */
function Island({ build, deps, as: Tag = 'div', ...props }: any) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (ref.current) build(ref.current); }, deps);
  return <Tag ref={ref} {...props} />;
}
const Status = ({ children }: { children: string }) => <Badge className="state" data-pattern={patternOf(children)}>{children}</Badge>;
const sourceLine = (item: any, catalog: any) => {
  const names = item.methods?.length ? item.methods.map(catalog.methodLabel) : (item.sources ?? []).map(catalog.label);
  return names.length ? [...new Set(names)].join(' · ') : 'No source report yet';
};
const projectName = (item: any) => basename(item.project) || item.project;
const startedLine = (item: any) => [item.startedAt ? `Started ${absTime(item.startedAt)}` : null, projectName(item)].filter(Boolean).join(' · ');
const costLine = (calls: any[]) => costTotal(costSummary(calls), calls.length);

function ResearchRow({ item, app, trail = false }: { item: any; app: Controller; trail?: boolean }) {
  const catalog = app.catalog;
  const fullCost = costLine(item.calls);
  const date = item.startedAt ? `${shortDate(item.startedAt)} · ${clock(item.startedAt)}` : '';
  let summary = item.snippet ? firstParagraph(item.snippet) || item.snippet : '';
  if ((item.snippet?.length ?? 0) >= 280) summary = `${summary.replace(/\s+\S*$/, '')}…`;
  const latest = item.calls.at(-1);
  return <article className={trail ? 'trail-card' : 'research-card research-row'}>
    <div className="card-head">
      <p className="eyebrow source-labels">
        {!trail && item.sources?.length > 0 && <IconTile variant="outline" size="sm" className="research-icon-tile"><Island as="span" deps={[item.sources?.join(',')]} build={(element: HTMLElement) => {
          element.replaceChildren(...(item.sources ?? []).slice(0, 1).map((id: string) => MODULES.find(source => source.id === id)).filter(Boolean).map((source: any) => mark(source, true)));
        }} /></IconTile>}
        {sourceLine(item, catalog)}
      </p>
      <Status>{item.status}</Status>
    </div>
    <h2><Button variant="ghost" className="card-open" title={item.title} data-key={`${trail ? 'trail' : 'dig'}:${item.project}:${item.id}`} onClick={() => { void app.showDig(item); }}>{trail ? item.title : item.displayTitle || item.title}</Button></h2>
    {!trail && <div className="research-meta"><span className="research-project" title={item.project}>{projectName(item)}</span><span title={startedLine(item)}>{date}</span></div>}
    <div className="research-foot">
      <p className="meta">{plural(item.reports.length, 'report')} · {plural(item.calls.length, trail ? 'retrieval' : 'call')}</p>
      {fullCost && <span className="research-cost" title={fullCost}>{costShort(costSummary(item.calls), item.calls.length)}</span>}
    </div>
    {trail ? latest && <p className="meta">Latest: {callSentence(latest, catalog)} ({callWord(latest.status)})</p> : <details className="research-preview">
      <summary data-key={`preview:${item.project}:${item.id}`}>Details</summary>
      <p className="eyebrow">Original question</p><p className="research-question">{item.title}</p>
      {summary && <><p className="eyebrow">Report preview</p><p className="summary">{summary}</p></>}
      {fullCost && <p className="meta">{fullCost}</p>}
    </details>}
  </article>;
}

function Browse({ app, hidden }: { app: Controller; hidden: boolean }) {
  const { snapshot } = app;
  const reports = snapshot.items.reduce((sum: number, item: any) => sum + item.reports.length, 0);
  const calls = snapshot.items.reduce((sum: number, item: any) => sum + item.calls.length, 0) + snapshot.live.length;
  return <section id="browse" hidden={hidden}>
    <Frame className="usage-frame" spacing="sm"><FramePanel><Island as="section" className="usage" id="usage" aria-labelledby="usage-title" deps={[snapshot, app.usageDays, hidden]}
      build={(element: HTMLElement) => { if (!hidden && app.snapshotLoaded) renderUsage(element, usageOf(snapshot, { days: app.usageDays }), (days: number) => app.update({ usageDays: days })); }} /></FramePanel></Frame>
    <div className="library-toolbar">
      <div><h2 className="library-title">Recent research</h2><p className="meta library-hint">Ask the conversation to find or narrow your saved research with Dig.</p></div>
      <div className="stats">
        <div className="stat"><strong id="questions">{snapshot.items.length}</strong><span>questions</span></div>
        <div className="stat"><strong id="reports">{reports}</strong><span>reports</span></div>
        <div className="stat"><strong id="retrievals">{calls}</strong><span>retrievals</span></div>
      </div>
    </div>
    <div id="list" className="library-list">
      {snapshot.items.length ? snapshot.items.map((item: any) => <ResearchRow key={`${item.project}:${item.id}`} item={item} app={app} />)
        : <div className="empty">{app.snapshotLoaded ? 'Your library is ready. Ask the conversation to research a question with one of Dig’s sources; it appears here as soon as it starts.' : 'Reading saved research…'}</div>}
    </div>
  </section>;
}

function Trail({ app, hidden }: { app: Controller; hidden: boolean }) {
  const { snapshot, thread, catalog } = app;
  const mine = thread ? snapshot.items.filter((item: any) => item.session === thread) : [];
  const elsewhere = thread ? snapshot.live.filter((call: any) => call.session !== thread).length : 0;
  const calls = thread ? [...mine.flatMap((item: any) => item.calls), ...snapshot.live.filter((call: any) => call.session === thread)] : [];
  const reports = mine.flatMap((item: any) => item.reportDetails ?? []);
  const live = snapshot.live.slice(0, 8);
  return <section id="panel" hidden={hidden}>
    <div className="panel-heading"><h2 id="panel-scope">{thread ? 'This conversation' : 'Conversation not identified'}</h2><p className="meta">Research started here, with its saved reports and retrievals.</p></div>
    <Island as="section" id="panel-figures" className="panel-figures" aria-label="This conversation’s retrievals and provider cost" hidden={!calls.length && !reports.length}
      deps={[snapshot, thread, catalog]} build={(element: HTMLElement) => {
        const counts = outcomeCounts(calls); const rows = sourceRows(calls, reports);
        rebuild(element, !calls.length && !reports.length ? [] : [
          node('dl', 'metrics',
            metric('Retrievals', num(counts.total), `${num(counts.results)} with results`),
            metric(catalog.groupLabel(rows.map((row: any) => row.id)), num(rows.length), `${plural(reports.length, 'report')} saved`),
            metric('Failed or stopped', num(counts.failed), counts.total ? `${Math.round((counts.failed / counts.total) * 100)}% of retrievals` : 'None yet'),
            costMetric(costSummary(calls), counts.total, 'panel')),
          elsewhere ? node('p', 'meta', `Not included: ${plural(elsewhere, 'retrieval')} by workers or other conversations that no saved report has claimed yet.`) : null,
          node('p', 'meta usage-scope', `${COST_SCOPE}. ${COST_CAVEAT}`),
        ].filter(Boolean));
      }} />
    <div id="panel-digs" className="panel-list">
      {!thread ? <p className="empty">Codex did not identify this conversation to Dig, so the trail cannot pick out its research. Use Library to browse everything.</p>
        : mine.length ? mine.map((item: any) => <ResearchRow key={`${item.project}:${item.id}`} item={item} app={app} trail />)
          : <p className="empty">No research started in this conversation yet. It appears here as soon as it starts.</p>}
    </div>
    <h3 className="section-title">Retrievals not yet in a saved report or answer</h3>
    <p className="meta" id="live-caveat" hidden={!live.some((call: any) => !thread || call.session !== thread)}>Workers run in their own conversations. Until a report claims their retrievals, they are labeled “another conversation or worker” and left out of this conversation’s provider costs.</p>
    <div id="panel-live">{live.length ? live.map((call: any) => <div className="call" key={call.id}>
      <Status>{callWord(call.status)}</Status><p>{callSentence(call, catalog)}</p><p className="meta">{clock(call.at)} · {thread && call.session === thread ? 'this conversation' : 'another conversation or worker'}</p>
    </div>) : <p className="meta">None right now.</p>}</div>
  </section>;
}

// The loaded report's object changes only after an explicit file read. Snapshot polling and side-pane reads leave
// this DOM, text selection, open disclosures and heading focus intact.
const LoadedDocument = memo(function LoadedDocument({ value, evidence = false }: { value: any; evidence?: boolean }) {
  return <Island id={evidence ? 'evidence-body' : 'document'} deps={[value]} build={(element: HTMLElement) => {
    if (!value) { element.replaceChildren(); return; }
    if (value.loading) { element.replaceChildren(node('p', 'meta', evidence ? 'Reading retained evidence…' : 'Reading retained research…')); return; }
    if (value.error) { element.replaceChildren(node('p', 'meta', `Unable to read this ${evidence ? 'response' : 'file'}: ${value.error}`)); return; }
    element.replaceChildren(evidence || value.kind === 'raw'
      ? rawView(value.file, value.body, value.receipt, value.catalog)
      : documentView(value.file, value.body, value.catalog));
  }} />;
});

function Reader({ app, hidden }: { app: Controller; hidden: boolean }) {
  const { current, catalog, document: opened, evidence } = app;
  const files = current ? [...current.files, ...(opened?.kind === 'raw' && !current.files.includes(opened.file) ? [opened.file] : [])] : [];
  useLayoutEffect(() => {
    if (opened && !opened.loading && !hidden) document.getElementById('files')?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  }, [opened?.file, opened?.loading]);
  return <section id="detail" hidden={hidden}>
    <div className="detail-heading">
      <Button id="back" variant="ghost" onClick={() => { void app.back(); }}>← Back</Button>
      <h2 id="dig-title" tabIndex={-1}>{current?.title}</h2>
      <p id="dig-meta" className="meta">{current && <><Status>{current.status}</Status> {startedLine(current)}{current.finishedAt ? ` · Answer ${shortDate(current.finishedAt)}` : ''}</>}</p>
    </div>
    <Island as="section" id="dig-retrievals" className="usage retrievals" aria-labelledby="retrievals-title" deps={[current, catalog]}
      build={(element: HTMLElement) => { if (current) renderRetrievals(element, current, catalog, app.inspectRaw); else element.replaceChildren(); }} />
    <div className={`reader-layout${evidence ? ' has-evidence' : ''}`} id="reader-layout">
      <Frame className="reader-main reader-frame" spacing="sm">
        <div className="reader-navigation">
          <nav id="files" className="files" aria-label="Files in this dig">{files.map((file: string) => <Button key={file} variant="ghost" className="file-tab" data-key={`file:${file}`} title={basename(file)} aria-current={opened?.file === file ? 'true' : 'false'} onClick={() => { void app.showFile(file); }}>{catalog.fileLabel(file)}</Button>)}</nav>
          <Button id="reader-evidence" variant="ghost" disabled={!current?.calls.length} onClick={() => { app.readerOrigin(); revealRetrievals(); }}>Retrievals</Button>
        </div>
        <FramePanel className="reader-paper"><article className="document" aria-labelledby="file-title">
          <div className="document-head"><h3 id="file-title" className="sr-only">{opened ? catalog.fileLabel(opened.file) : ''}</h3>
            <details className="file-details"><summary>File details</summary><p className="path" id="file-name">{opened?.file}</p></details>
            <Button id="back-to-report" variant="outline" hidden={opened?.kind !== 'raw' || !app.returnFile} onClick={() => { if (app.returnFile) void app.showFile(app.returnFile); }}>← Back to {app.returnFile ? catalog.fileLabel(app.returnFile) : 'report'}</Button>
          </div>
          <LoadedDocument value={opened} />
        </article></FramePanel>
      </Frame>
      <aside id="evidence-pane" className="evidence-pane" aria-labelledby="evidence-title" hidden={!evidence}>
        <div className="evidence-head"><h3 id="evidence-title" tabIndex={-1}>Original response</h3><Button id="close-evidence" variant="outline" onClick={() => app.closeEvidence()}>Back to report</Button></div>
        <LoadedDocument value={evidence} evidence />
      </aside>
    </div>
  </section>;
}

const LIBRARY_FOLDER_NOTES: Record<string, string> = {
  missing: 'This folder does not exist yet. Dig creates it when research is first saved here. If you meant a folder that already holds your research, check the path.',
  'not-folder': 'This path is not a folder, so research cannot be saved here. Choose a folder.',
};

function Settings({ app, host, hidden }: { app: Controller; host: DigHost; hidden: boolean }) {
  const read = app.settings;
  const properties = read?.schema?.properties ?? {};
  const groups = read ? settingsGroups(read).map((group: any) => ({ ...group, keys: group.keys.filter((key: string) => !ownerOf(key, MODULES.map(module => module.id))) })).filter((group: any) => group.keys.length) : [];
  const error = app.settingsError?.message || (read && (!read.schema?.properties || !read.values) ? SCHEMA_MISSING : '');
  const libraryNote = LIBRARY_FOLDER_NOTES[app.snapshot.libraryFolder];
  return <section id="settings" className="preferences-page" hidden={hidden}>
    <div className="page-heading"><p className="eyebrow">Preferences</p><h2>Settings</h2><p className="meta">Your library, evidence retention, and suggested source workers. Changes save automatically.</p></div>
    <div id="settings-fields" className="preferences-groups">{groups.map((group: any) => <Frame className="preferences-frame" spacing="sm" key={group.title}>
      <FrameHeader className="preferences-group-heading"><FrameTitle role="heading" aria-level={3}>{group.title}</FrameTitle><FrameDescription>{group.title === 'Library' ? 'Keep research and its original evidence together.' : group.title === 'Source workers' ? 'Defaults for the conversation. Each source can have its own suggestions.' : 'Defaults shared across Dig.'}</FrameDescription></FrameHeader>
      <FramePanel className="preferences-fields">{group.keys.map((key: string) => <SourceSetting key={key} settingKey={key} schema={properties[key]} value={read.values?.[key]} save={host.preview ? undefined : app.saveSetting} note={key === 'library' && libraryNote ? <p aria-live="polite">{libraryNote}</p> : undefined} />)}</FramePanel>
    </Frame>)}</div>
    <div className="preferences-authority"><span className="eyebrow">Settings file</span><p className="meta">Dig and the host’s plugin settings edit this same file. Source-specific settings are in Sources &amp; tools.</p><p id="config-path" className="path">{app.snapshot.configPath || 'config.toml'}</p></div>
    <p id="settings-status" className="meta" role="status" aria-live="polite">{error || (!read ? 'Reading settings…' : host.preview ? READ_ONLY : '')}</p>
  </section>;
}

function About({ app, host, hidden }: { app: Controller; host: DigHost; hidden: boolean }) {
  const snapshot = app.snapshot; const info = app.sources; const server = typeof snapshot.version === 'string' ? snapshot.version : null;
  const open = (path: string) => { void host.openFile(path).catch((error: any) => app.notify(`Codex did not open ${path}: ${error.message}`, true)); };
  const path = (label: string, value: string, action?: React.ReactNode) => <div className="about-path"><p className="eyebrow">{label}</p><p className="path">{value || 'Unknown'}</p>{action}</div>;
  const canOpen = !host.preview && host.canOpenFile();
  const configPath = info?.configPath ?? snapshot.configPath;
  return <section id="about" className="about-page" hidden={hidden}>
    <div className="detail-heading"><Button id="about-back" variant="ghost" onClick={() => { void app.backAbout(); }}>← Back</Button><h2>About Dig</h2></div>
    <div id="about-body">
      <p className="lede">Dig researches a question with source-specific methods and keeps the evidence. Each source saves a report together with the original responses it retrieved, and this library lets you read both. Research runs in the conversation; this view only reads and never starts research.</p>
      <h3 className="section-title">Version</h3><p>{snapshot.replaced && server ? replacedMessage(snapshot) : server && server !== VERSION ? `Dig ${server} is installed, but this view is ${VERSION}. Right-click Dig in the sidebar and choose Refresh to load the new view.` : `Dig ${VERSION}.`}</p>
      <h3 className="section-title">Where your things live</h3>
      {path('Research library', snapshot.library)}
      {path('Settings file', configPath, canOpen && configPath ? <Button variant="outline" onClick={() => open(configPath)}>Open</Button> : null)}
      {info?.keysPath && path('Keys file', info.keysPath, <Button variant="outline" disabled={host.preview} onClick={() => { void app.editKeys(); }}>Edit keys.env</Button>)}
      <h3 className="section-title">Keys and privacy</h3><p>Provider keys stay in keys.env, outside the conversation. Dig never asks for a key in chat, and keys never pass through this view: its buttons send only source names, Dig copies values on its own side, and Codex opens the file itself. Provider responses are kept as evidence and treated as untrusted text, never as instructions.</p>
      <h3 className="section-title">Costs</h3><p>Amounts are what each provider reported for a call, kept with that call’s receipt. They are usage, not a reconciled bill, and they leave out Codex’s own model usage. A call whose cost was not reported shows as unknown, never as free.</p>
      <h3 className="section-title">Help</h3><p>Type $dig:setup in the composer to choose sources and see what each still needs. $dig:library finds research you have already saved.</p>
      <Button variant="outline" size="sm" onClick={() => { void app.go('/guide'); }}>Start here: learn what Dig can do</Button>
      <h3 className="section-title">Credits</h3><ul className="credits">
        <li>Dig by Jon Page, MIT License.</li>
        <li>React, Base UI, selected ReUI components and TanStack power the interface. Dig owns its shadcn-style wrappers; host styles and native actions use OpenAI’s MCP Extensions.</li>
        <li>Interface glyphs from <a href="https://lucide.dev" data-external="" target="_blank" rel="noopener noreferrer">Lucide</a> (ISC License).</li>
        <li>The Papers bridge uses <a href="https://github.com/openags/paper-search-mcp" data-external="" target="_blank" rel="noopener noreferrer">paper-search-mcp</a> by P.S Zhang (MIT License).</li>
        <li>Source logos are trademarks of their owners and identify each service; Dig is not affiliated with or endorsed by them. They come from <a href="https://svgl.app" data-external="" target="_blank" rel="noopener noreferrer">svgl</a>, <a href="https://simpleicons.org" data-external="" target="_blank" rel="noopener noreferrer">Simple Icons</a> (CC0) and the Polymarket and Exa websites.</li>
      </ul>
    </div>
  </section>;
}

function LibraryShell({ host }: { host: DigHost }) {
  const router = useRouter();
  const view = useRouterState({ select: state => state.location.pathname });
  const app = useLibraryController(host, router, view);
  const enabled = Array.isArray(app.snapshot.enabledSources) ? app.snapshot.enabledSources : null;
  const outbound = (event: React.MouseEvent) => {
    const anchor = (event.target as HTMLElement)?.closest<HTMLAnchorElement>('a[data-external]');
    if (!anchor || host.preview) return;
    event.preventDefault();
    const url = httpUrl(anchor.href);
    if (!url) { app.notify('This link is not an HTTP or HTTPS address.', true); return; }
    host.openLink(url).catch((error: any) => app.notify(`Unable to open ${url}: ${error.message}`, true));
  };
  return <main className="dig-library" onClick={outbound}>
    <header className="masthead">
      <div className="brand"><h1>Dig</h1><p className="tagline" id="tagline">{app.mode === 'panel' ? 'Research trail' : 'Saved research'}</p></div>
      <nav className="nav" aria-label="Dig views">
        <Button variant="ghost" id="nav-trail" hidden={app.mode !== 'panel'} aria-current={view === '/trail' ? 'page' : 'false'} onClick={() => { void app.go('/trail'); }}>This conversation</Button>
        <Button variant="ghost" id="nav-library" aria-current={view === '/library' ? 'page' : 'false'} onClick={() => { void app.go('/library'); }}>Library</Button>
        <Button variant="ghost" id="nav-sources" aria-current={view === '/sources' ? 'page' : 'false'} onClick={() => { void app.go('/sources'); }}>Sources &amp; tools</Button>
        <Button variant="ghost" id="nav-guide" aria-current={view === '/guide' ? 'page' : 'false'} onClick={() => { void app.go('/guide'); }}>Start here</Button>
        <Button variant="ghost" id="nav-settings" aria-current={view === '/settings' ? 'page' : 'false'} onClick={() => { void app.go('/settings'); }}>Settings</Button>
      </nav>
    </header>
    <div className={`notice-row${app.notice ? ' has-notice' : ''}`} id="notice-row">
      <div id="notice" className={`notice${app.failure ? ' error' : ''}`} role="status" aria-live="polite">{app.notice}</div>
      <Button id="reload" variant="outline" hidden={!app.updatesFailed} onClick={() => { void app.poll(true); }}>Reload library</Button>
      <Button id="dismiss" variant="ghost" hidden={!app.notice} onClick={() => app.notify('')}>Dismiss</Button>
    </div>
    <Trail app={app} hidden={view !== '/trail'} />
    <Browse app={app} hidden={view !== '/library'} />
    <Reader app={app} hidden={view !== '/reader'} />
    <SourcesPage app={app} host={host} hidden={view !== '/sources'} />
    <GuidePage hidden={view !== '/guide'} onNavigate={path => { void app.go(path); }} />
    <Settings app={app} host={host} hidden={view !== '/settings'} />
    <About app={app} host={host} hidden={view !== '/about'} />
    <footer className="foot">
      <span id="host-state">{!app.connected ? 'Connecting…' : host.preview ? 'Browser preview (read-only)' : app.mode === 'panel' ? 'Conversation panel' : 'Native library'}</span>
      <span id="live-state">{app.connected ? app.updatesFailed ? 'Updates paused' : 'Updates automatically' : ''}</span>
      <span id="source-status">{enabled ? app.catalog.size ? `${enabled.length} of ${app.catalog.size} ${app.catalog.groupLabel().toLowerCase()} on` : `${plural(enabled.length, 'source')} on` : ''}</span>
      <span id="retention">{app.snapshotLoaded ? app.snapshot.keepRaw ? 'Original responses retained' : 'Original responses not retained' : ''}</span>
      <Button id="nav-about" variant="ghost" className="foot-link" onClick={() => { void app.go('/about'); }}>About Dig</Button>
      <details className="library-location"><summary>Library location</summary><p id="library-path" className="path">{app.snapshot.library}</p></details>
    </footer>
  </main>;
}

export function createLibraryQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: false }, mutations: { retry: false } } });
}

export function LibraryApp({ host, queryClient }: { host: DigHost; queryClient?: QueryClient }) {
  const [queries] = useState(() => queryClient ?? createLibraryQueryClient());
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: () => <LibraryShell host={host} /> });
    const children = ['/library', '/trail', '/reader', '/sources', '/guide', '/settings', '/about'].map(path => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
    return createRouter({ routeTree: rootRoute.addChildren(children), history: createMemoryHistory({ initialEntries: ['/library'] }), defaultPreload: false });
  }, [host]);
  return <QueryClientProvider client={queries}><RouterProvider router={router} /></QueryClientProvider>;
}
