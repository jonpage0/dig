import React, { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useRouter, useRouterState } from '@tanstack/react-router';
import { httpUrl, node } from '../../ui/dom.mjs';
import { absTime, basename, plural, costShort } from '../../ui/format.mjs';
import { documentView, rawView } from '../../ui/reader.mjs';
import { Badge, Button, Disclosure } from '../shared/components';
import { Frame, FramePanel } from '../shared/frame';
import type { DigHost } from '../shared/host';
import { SourcesPage } from './sources';
import { SettingsPage } from './settings';
import { AboutPage } from './about';
import { ResearchOverview, ConversationOverview } from './research-overview';
import { ResearchDetail } from './research-detail';
import { projectResearch } from './research-state';
import { GuidePage } from './guide';
import { useLibraryController } from './controller';

type Controller = ReturnType<typeof useLibraryController>;

/** These small DOM islands retain the audited text-only Markdown/provider renderers during migration.
 * React owns when they render and the surrounding navigation/state; none accepts HTML strings. */
function Island({ build, deps, as: Tag = 'div', ...props }: any) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (ref.current) build(ref.current); }, deps);
  return <Tag ref={ref} {...props} />;
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

function DocumentNavigation({ files, opened, catalog, onOpen }: { files: string[]; opened?: string; catalog: any; onOpen: (file: string) => void }) {
  const list = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const maximum = element.scrollWidth - element.clientWidth;
      const next = { overflow: maximum > 1, left: element.scrollLeft > 1, right: element.scrollLeft < maximum - 1 };
      setEdges(previous => previous.overflow === next.overflow && previous.left === next.left && previous.right === next.right ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    element.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); element.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); };
  }, [files.join('\0'), catalog]);
  const scroll = (direction: number) => {
    const element = list.current;
    if (!element) return;
    element.scrollBy({ left: direction * Math.max(120, element.clientWidth * .75), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  return <div className="reader-file-navigation">
    <div className="reader-file-window" data-more-left={edges.left} data-more-right={edges.right}>
      <nav ref={list} id="files" className="files" aria-label="Files in this dig">{files.map(file => <Button key={file} variant="ghost" className="file-tab" data-key={`file:${file}`} title={basename(file)} aria-current={opened === file ? 'true' : 'false'} onClick={() => onOpen(file)}>{catalog.fileLabel(file)}</Button>)}</nav>
    </div>
    {edges.overflow && <div className="reader-scroll-controls" role="group" aria-label="Scroll documents">
      <Button variant="ghost" size="sm" disabled={!edges.left} aria-label="Scroll documents left" title="More documents to the left" onClick={() => scroll(-1)}><span aria-hidden="true">←</span></Button>
      <Button variant="ghost" size="sm" disabled={!edges.right} aria-label="Scroll documents right" title="More documents to the right" onClick={() => scroll(1)}><span aria-hidden="true">→</span></Button>
    </div>}
  </div>;
}

function Reader({ app, host, hidden }: { app: Controller; host: DigHost; hidden: boolean }) {
  const { current, catalog, document: opened, evidence } = app;
  const research = useMemo(() => projectResearch(current, catalog), [current, catalog]);
  const files = current ? [...current.files, ...(opened?.kind === 'raw' && !current.files.includes(opened.file) ? [opened.file] : [])] : [];
  useLayoutEffect(() => {
    if (opened && !opened.loading && !hidden) {
      document.querySelector('#files [aria-current="true"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
      document.getElementById('detail')?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    }
  }, [opened?.file, opened?.loading]);
  return <section id="detail" hidden={hidden}>
    <div className="detail-heading">
      <Button id="back" variant="ghost" onClick={() => { void app.back(); }}>← {app.returnView === '/trail' ? 'Research trail' : 'Library'}</Button>
      <h2 id="dig-title" tabIndex={-1} title={current?.title}>{current?.title}</h2>
      <div className="reader-summary"><Badge>{research.savedState}</Badge><span id="dig-meta">{current && <>{basename(current.project)} · {absTime(current.startedAt)}</>}</span><span className="reader-summary-cost">{costShort(research.cost, research.callCount)}</span></div>
    </div>
    <div className="research-record-inspection" hidden={!app.inspectionOpen}>
    <div className={`reader-layout${evidence ? ' has-evidence' : ''}`} id="reader-layout">
      <Frame className="reader-main reader-frame" spacing="sm">
        <div className="reader-navigation">
          <DocumentNavigation files={files} opened={opened?.file} catalog={catalog} onOpen={file => { void app.showFile(file); }} />
          <Button id="reader-evidence" variant="ghost" disabled={!current?.calls.length} onClick={() => { app.readerOrigin(); app.update({ callsOpen: true }); requestAnimationFrame(() => { const target = document.getElementById('research-calls'); target?.scrollIntoView?.({ block: 'start' }); target?.querySelector('button')?.focus(); }); }}>Retrievals</Button>
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
    </div>
    <Disclosure title="Research details & activity" className="reader-research-details" open={Boolean(app.detailsOpen || app.callsOpen || !app.inspectionOpen)} onOpenChange={value => app.update({ detailsOpen: value, ...(!value ? { callsOpen: false } : {}) })} keepMounted>
      <ResearchDetail app={app} host={host} />
    </Disclosure>
  </section>;
}

function LibraryShell({ host }: { host: DigHost }) {
  const router = useRouter();
  const view = useRouterState({ select: state => state.location.pathname });
  const app = useLibraryController(host, router, view);
  const navMore = useRef<HTMLDetailsElement>(null);
  const enabled = Array.isArray(app.snapshot.enabledSources) ? app.snapshot.enabledSources : null;
  const outbound = (event: React.MouseEvent) => {
    const anchor = (event.target as HTMLElement)?.closest<HTMLAnchorElement>('a[data-external]');
    if (!anchor || host.preview) return;
    event.preventDefault();
    const url = httpUrl(anchor.href);
    if (!url) { app.notify('This link is not an HTTP or HTTPS address.', true); return; }
    host.openLink(url).catch((error: any) => app.notify(`Unable to open ${url}: ${error.message}`, true));
  };
  return <main className={`dig-library${app.mode === 'panel' && view === '/trail' ? ' is-conversation' : ''}`} onClick={outbound} onPointerDown={event => { if (app.mode === 'panel' && navMore.current?.open && !navMore.current.contains(event.target as Node)) navMore.current.open = false; }}>
    <header className="masthead">
      <div className="brand"><h1>Dig</h1><p className="tagline" id="tagline">{app.mode === 'panel' ? 'Research trail' : 'Research state'}</p></div>
      <nav className="nav" aria-label="Dig views">
        <Button variant="ghost" id="nav-trail" hidden={app.mode !== 'panel'} aria-current={view === '/trail' ? 'page' : 'false'} onClick={() => { void app.go('/trail'); }}>This conversation</Button>
        <Button variant="ghost" id="nav-library" aria-current={view === '/library' ? 'page' : 'false'} onClick={() => { void app.go('/library'); }}>Library</Button>
        <details ref={navMore} key={app.mode} className="nav-more" open={app.mode === 'panel' ? undefined : true}
          onClick={event => { if (app.mode === 'panel' && (event.target as Element).closest('button')) event.currentTarget.open = false; }}
          onKeyDown={event => { if (app.mode === 'panel' && event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); event.preventDefault(); } }}>
          <summary hidden={app.mode !== 'panel'}>More</summary><div>
            <Button variant="ghost" id="nav-sources" aria-current={view === '/sources' ? 'page' : 'false'} onClick={() => { void app.go('/sources'); }}>Sources &amp; tools</Button>
            <Button variant="ghost" id="nav-guide" aria-current={view === '/guide' ? 'page' : 'false'} onClick={() => { void app.go('/guide'); }}>Start here</Button>
            <Button variant="ghost" id="nav-settings" aria-current={view === '/settings' ? 'page' : 'false'} onClick={() => { void app.go('/settings'); }}>Settings</Button>
          </div>
        </details>
      </nav>
    </header>
    <div className={`notice-row${app.notice ? ' has-notice' : ''}`} id="notice-row">
      <div id="notice" className={`notice${app.failure ? ' error' : ''}`} role="status" aria-live="polite">{app.notice}</div>
      <Button id="reload" variant="outline" hidden={!app.updatesFailed} onClick={() => { void app.poll(true); }}>Reload library</Button>
      <Button id="dismiss" variant="ghost" hidden={!app.notice} onClick={() => app.notify('')}>Dismiss</Button>
    </div>
    <ConversationOverview app={app} host={host} hidden={view !== '/trail'} />
    <ResearchOverview app={app} host={host} hidden={view !== '/library'} />
    <Reader app={app} host={host} hidden={view !== '/reader'} />
    <SourcesPage app={app} host={host} hidden={view !== '/sources'} />
    <GuidePage hidden={view !== '/guide'} onNavigate={path => { void app.go(path); }} />
    <SettingsPage app={app} host={host} hidden={view !== '/settings'} />
    <AboutPage app={app} host={host} hidden={view !== '/about'} />
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
    return createRouter({ routeTree: rootRoute.addChildren(children), history: createMemoryHistory({ initialEntries: [document.getElementById('root')?.dataset.digSurface === 'trail' ? '/trail' : '/library'] }), defaultPreload: false });
  }, [host]);
  return <QueryClientProvider client={queries}><RouterProvider router={router} /></QueryClientProvider>;
}
