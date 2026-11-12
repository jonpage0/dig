import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createCatalog, fileKind } from '../../ui/catalog.mjs';
import { VERSION } from '../../version.mjs';
import { hostWords } from '../../ui/host.mjs';
import type { DigHost } from '../shared/host';
import { canonicalResearchFile, primaryFile } from './research-state';

export const POLL_MS = 2000;
const READ_LIMIT = 60000;
export const SCHEMA_MISSING = 'Settings arrived without their schema, so no controls can be shown. Reload Dig and try again.';

export function versionMessage(value: any) {
  const words = hostWords(value.host);
  return `Dig ${value.version} is installed, but ${words.app} is still showing the ${VERSION} view. ${words.refresh}`;
}

const emptySnapshot = { items: [], live: [] };
const emptyState = {
  mode: 'library', dig: null, connected: false, notice: '', failure: false, updatesFailed: false,
  current: null, document: null, evidence: null, assessment: null, inspectionOpen: false, detailsOpen: false, callsOpen: false, returnFile: null, returnView: '/library',
  aboutReturn: '/library', usageDays: 30,
};

/** All queries are local read-only MCP operations. Mutations and refresh timing are explicit; Query never
 * retries, refetches on focus, or makes a provider call on behalf of this view. File reads page to completion. */
export function useLibraryController(host: DigHost, router: any, view: string) {
  const queries = useQueryClient();
  const snapshotQuery = useQuery({ queryKey: ['library'], queryFn: () => host.call('library_snapshot'), enabled: false });
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => host.call('view_settings'), enabled: false });
  const sourcesQuery = useQuery({ queryKey: ['sources'], queryFn: () => host.call('source_info'), enabled: false });
  const snapshot: any = snapshotQuery.data ?? emptySnapshot;
  const catalog = useMemo(() => createCatalog(snapshot.sources), [snapshot.sources]);
  const [state, setState] = useState<any>(() => ({ ...emptyState, ...(view === '/trail' ? { mode: 'panel' } : {}) }));
  const latest = useRef<any>({});
  latest.current = { state, view, snapshot, catalog };
  const methods = useMemo(() => {
    let alive = true;
    let navigation = 0;
    let evidenceNavigation = 0;
    let assessmentNavigation = 0;
    let libraryGeneration = 0;
    let revision: string | null = null;
    let pollTask: Promise<void> | null = null;
    let refreshQueued = false;
    let saving: Promise<any> = Promise.resolve();
    let handledDeepLink: string | null = null;
    let browseScroll = 0;
    let evidenceOrigin: { focus: Element | null; scroll: number; reopen: boolean } | null = null;
    let readerOrigin: { focus: Element | null; scroll: number } | null = null;
    let noticedVersion = false;
    const update = (patch: any) => {
      if (!alive) return;
      const next = { ...latest.current.state, ...patch };
      latest.current.state = next;
      setState(next);
    };
    const notify = (notice: string, failure = false) => update({ notice, failure });
    const navigate = (to: string) => router.navigate({ to });
    const read = (key: string, tool: string) => queries.fetchQuery({
      // Invalidate an old reader before Query publishes a different library's snapshot.
      queryKey: [key], queryFn: async () => {
        const value = await host.call(tool);
        return key === 'library' ? acceptSnapshot(value) : value;
      }, staleTime: 0,
    });
    const refreshPages = async () => {
      const currentView = latest.current.view;
      // Preserve already-mounted pages and drafts behind About, without probing providers.
      const wantsSettings = ['/sources', '/settings'].includes(currentView)
        || (currentView === '/about' && ['/sources', '/settings'].includes(latest.current.state.aboutReturn));
      const wantsSources = currentView === '/sources' || currentView === '/about';
      await Promise.all([
        wantsSettings ? read('settings', 'view_settings') : null,
        wantsSources ? read('sources', 'source_info') : null,
      ]);
    };
    const acceptSnapshot = (value: any) => {
      const normalized = { ...value, items: value.items ?? [], live: value.live ?? [] };
      const previousLibrary = latest.current.snapshot.library;
      if (typeof previousLibrary === 'string' && previousLibrary !== normalized.library) {
        libraryGeneration++; navigation++; evidenceNavigation++; assessmentNavigation++;
        evidenceOrigin = null; readerOrigin = null; browseScroll = 0;
        update({
          current: null, document: null, evidence: null, assessment: null, inspectionOpen: false, detailsOpen: false, callsOpen: false, returnFile: null, returnView: '/library',
          ...(latest.current.state.aboutReturn === '/reader' ? { aboutReturn: '/library' } : {}),
        });
        queries.removeQueries({ queryKey: ['file'] });
        queries.removeQueries({ queryKey: ['assessment'] });
        if (latest.current.view === '/reader') void navigate('/library');
        notify('The research library changed. Open a saved item from the selected library to read it.');
      }
      // A synchronous ref avoids an activation selecting from the preceding React render.
      latest.current.snapshot = normalized;
      latest.current.catalog = createCatalog(normalized.sources);
      const current = latest.current.state.current;
      if (current) {
        const found = normalized.items.find((item: any) => item.id === current.id && item.project === current.project);
        if (!found) notify('This dig is no longer in the selected library. The open file stays as it was read.', true);
        else {
          const added = found.files.filter((file: string) => !current.files.includes(file));
          update({ current: found });
          if (added.length) notify(`Saved to this dig: ${added.map(latest.current.catalog.fileLabel).join(', ')}. Open its tab to read it.`);
        }
      }
      if (!noticedVersion && typeof value.version === 'string' && value.version !== VERSION) {
        noticedVersion = true;
        notify(versionMessage(value));
      }
      return normalized;
    };
    const poll = (force = false): Promise<void> => {
      // Before the host connects a request can only fail; start() polls once connected.
      if (!latest.current.state.connected) return Promise.resolve();
      if (pollTask) { if (force) refreshQueued = true; return pollTask; }
      if (!force && document.visibilityState === 'hidden') return Promise.resolve();
      pollTask = (async () => {
        let refresh = force;
        try {
          do {
            refreshQueued = false;
            try {
              const next = (await queries.fetchQuery({ queryKey: ['revision'], queryFn: () => host.call('library_revision'), staleTime: 0 })).revision;
              if (refresh || revision !== next) {
                await read('library', 'library_snapshot');
                revision = next;
                await refreshPages();
              }
              if (latest.current.state.updatesFailed) notify('Automatic updates resumed.');
              update({ updatesFailed: false });
            } catch (error: any) {
              if (!latest.current.state.updatesFailed) notify(`Automatic updates paused: ${error.message}`, true);
              update({ updatesFailed: true });
            }
            refresh = refreshQueued;
          } while (refresh && alive);
        } finally { pollTask = null; }
      })();
      return pollTask;
    };
    const readAll = async (file: string) => {
      const library = latest.current.snapshot.library ?? '';
      const generation = libraryGeneration;
      return queries.fetchQuery({
        queryKey: ['file', library, file],
        staleTime: 0,
        gcTime: 0,
        queryFn: async () => {
          // Even the first request names the selected library, so a settings change before page one cannot
          // silently resolve the same relative file in another library. Later pages use the returned real path.
          let path = file.startsWith('/') ? file : `${library.replace(/\/+$/, '')}/${file}`;
          const expectedFile = file.startsWith('/') ? null : file;
          let identity: { path: string; file: string; total: number } | null = null;
          let offset: number | null = 0; let body = '';
          do {
            if (generation !== libraryGeneration) throw new Error('The selected library changed while this file was being read.');
            const part = await host.call('library_read', { file: path, offset, limit: READ_LIMIT });
            if (generation !== libraryGeneration) throw new Error('The selected library changed while this file was being read.');
            const validFile = typeof part.file === 'string' && part.file.length > 0 && !part.file.startsWith('/') && !part.file.split('/').some((segment: string) => segment === '.' || segment === '..' || !segment);
            const end = typeof part.text === 'string' ? offset + part.text.length : NaN;
            if (!validFile || typeof part.path !== 'string' || !part.path.startsWith('/') || !part.path.endsWith(`/${part.file}`)
              || part.offset !== offset || !Number.isSafeInteger(part.totalCharacters) || part.totalCharacters < end
              || typeof part.text !== 'string' || part.text.length > READ_LIMIT
              || (part.nextOffset === null ? end !== part.totalCharacters : part.nextOffset !== end || end <= offset || end >= part.totalCharacters)) {
              throw new Error('The retained file returned inconsistent pagination metadata; no partial document is shown.');
            }
            if (!identity) {
              if (expectedFile !== null && part.file !== expectedFile) throw new Error('The retained file response does not match the requested file.');
              identity = { path: part.path, file: part.file, total: part.totalCharacters };
              path = part.path;
            } else if (part.path !== identity.path || part.file !== identity.file || part.totalCharacters !== identity.total) {
              throw new Error('The retained file changed during pagination; no partial document is shown.');
            }
            body += part.text; offset = part.nextOffset;
          } while (offset !== null);
          return body;
        },
      });
    };
    const closeEvidence = (restore = true) => {
      evidenceNavigation++;
      const wasOpen = Boolean(latest.current.state.evidence);
      update({ evidence: null });
      if (restore && wasOpen && evidenceOrigin) {
        const origin = evidenceOrigin;
        update({ callsOpen: origin.reopen });
        requestAnimationFrame(() => {
          globalThis.scrollTo?.({ top: origin.scroll, behavior: 'instant' });
          const target = origin.focus?.isConnected ? origin.focus : document.getElementById('reader-evidence');
          (target as HTMLElement)?.focus({ preventScroll: true });
        });
      }
      evidenceOrigin = null; readerOrigin = null;
    };
    const loadAssessment = async (file: string) => {
      const item = latest.current.state.current;
      if (!item || (!item.reports.includes(file) && item.answer !== file)) return;
      const request = ++assessmentNavigation;
      const library = latest.current.snapshot.library;
      const generation = libraryGeneration;
      const same = () => alive && request === assessmentNavigation && generation === libraryGeneration
        && latest.current.state.current?.id === item.id && latest.current.state.current?.project === item.project;
      update({ assessment: { file, loading: true } });
      try {
        const value: any = await queries.fetchQuery({
          queryKey: ['assessment', library, file], staleTime: 0, gcTime: 0,
          queryFn: () => host.call('saved_research', { file: canonicalResearchFile(library, file) }),
        });
        if (!same()) return;
        if (value?.file !== file || typeof value.path !== 'string' || !value.path.startsWith('/') || !value.path.endsWith('/' + file)) throw new Error('The retained assessment does not match the selected file.');
        update({ assessment: { file, value } });
      } catch (error: any) { if (same()) update({ assessment: { file, error: error.message } }); }
    };
    const showFile = async (file: string) => {
      closeEvidence(false);
      const request = ++navigation;
      const kind = fileKind(file);
      update({ document: { file, kind, loading: true }, inspectionOpen: true });
      if (kind !== 'raw') void loadAssessment(file);
      try {
        const body = await readAll(file);
        if (!alive || request !== navigation || !latest.current.state.current) return false;
        const current = latest.current.state.current;
        const receipt = kind === 'raw' ? current.calls.find((call: any) => call.rawFile === file) : undefined;
        const back = kind === 'raw'
          ? latest.current.state.returnFile ?? (receipt?.claimedBy && current.files.includes(receipt.claimedBy) ? receipt.claimedBy : null)
          : null;
        update({ document: { file, kind, body, receipt, catalog: latest.current.catalog }, returnFile: back });
        return true;
      } catch (error: any) {
        if (request === navigation && alive) { update({ document: { file, kind, error: error.message } }); notify(error.message, true); }
        return false;
      }
    };
    const showDig = async (item: any, file?: string) => {
      closeEvidence(false);
      const request = ++navigation;
      assessmentNavigation++;
      if (latest.current.view !== '/reader') {
        browseScroll = globalThis.scrollY ?? 0;
        update({ returnView: latest.current.view === '/about' ? latest.current.state.aboutReturn : latest.current.view });
      }
      update({ current: item, document: null, assessment: null, inspectionOpen: false, detailsOpen: false, callsOpen: false, returnFile: null });
      await navigate('/reader');
      if (!alive || request !== navigation) return;
      // Open the result immediately. Accounting and recorded history stay available below the reader.
      const primary = file ?? primaryFile(item) ?? item.files.find((path: string) => path.endsWith('/dig.md'));
      const reading = primary ? showFile(primary) : null;
      const completedNavigation = navigation;
      // Move focus when the view opens, including while a local read is pending or fails. Do not steal it
      // again when the read finishes or let a late navigation focus a different question.
      requestAnimationFrame(() => {
        if (!alive || completedNavigation !== navigation || latest.current.state.current?.id !== item.id || latest.current.state.current?.project !== item.project) return;
        document.getElementById('dig-title')?.focus({ preventScroll: true });
        document.getElementById('detail')?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
      });
      if (reading) await reading;
    };
    const inspectRecords = async () => {
      const item = latest.current.state.current;
      if (!item) return;
      if (latest.current.state.document) { update({ inspectionOpen: true }); return; }
      const file = primaryFile(item) ?? item.files.find((path: string) => path.endsWith('dig.md'));
      if (file) await showFile(file);
    };
    const inspectRaw = async (file: string) => {
      const { current, document: opened, evidence } = latest.current.state;
      const wasOpen = Boolean(latest.current.state.callsOpen);
      update({ inspectionOpen: true, callsOpen: false });
      if (!current || !opened || opened.loading || opened.error || opened.kind === 'raw') return showFile(file);
      if (!evidence) {
        evidenceOrigin = {
          focus: readerOrigin?.focus ?? document.activeElement,
          scroll: readerOrigin?.scroll ?? globalThis.scrollY ?? 0,
          reopen: readerOrigin ? false : wasOpen,
        };
        readerOrigin = null;
      }
      const request = ++evidenceNavigation;
      update({ evidence: { file, loading: true } });
      try {
        const body = await readAll(file);
        if (!alive || request !== evidenceNavigation || !latest.current.state.current) return;
        update({ evidence: { file, body, receipt: current.calls.find((call: any) => call.rawFile === file), catalog: latest.current.catalog } });
      } catch (error: any) {
        if (!alive || request !== evidenceNavigation) return;
        update({ evidence: { file, error: error.message } });
      }
      requestAnimationFrame(() => {
        if (request !== evidenceNavigation) return;
        document.getElementById('evidence-title')?.focus({ preventScroll: true });
        document.getElementById('reader-layout')?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
      });
    };
    const leaveReader = () => {
      closeEvidence(false); navigation++; assessmentNavigation++;
      update({ current: null, document: null, assessment: null, inspectionOpen: false, detailsOpen: false, callsOpen: false, returnFile: null });
    };
    const go = async (to: string) => {
      if (to === '/about') update({ aboutReturn: latest.current.view });
      else if (to !== '/reader' && latest.current.state.current) leaveReader();
      if (to === '/trail' && latest.current.state.mode === 'panel') {
        try { await host.requestDisplayMode?.('inline'); }
        catch { notify('The host could not return Dig to inline mode.'); }
      }
      await navigate(to);
    };
    const expand = async (to: '/library' | '/sources' | '/settings') => {
      // Start the host request inside the click's user activation, before routing or other awaits.
      try { await host.requestDisplayMode?.('fullscreen'); }
      catch { notify('The host could not expand Dig. This page is available here.'); }
      await go(to);
    };
    const back = async () => {
      const { current, returnView } = latest.current.state;
      const key = current ? `${returnView === '/trail' ? 'trail' : 'dig'}:${current.project}:${current.id}` : null;
      leaveReader(); await navigate(returnView);
      const completedNavigation = navigation;
      requestAnimationFrame(() => {
        if (!alive || completedNavigation !== navigation || latest.current.view !== returnView) return;
        globalThis.scrollTo?.({ top: browseScroll, behavior: 'instant' });
        if (key) [...document.querySelectorAll<HTMLElement>('[data-key]')].find(node => node.dataset.key === key)?.focus({ preventScroll: true });
      });
    };
    const saveSetting = (key: string, value: unknown) => {
      // The settings tool's logic: the same file, the same checks, and the hosts told that the tools changed.
      const work = saving.then(async () => (await host.call('view_settings', { set: { [key]: value } })).values);
      saving = work.catch(() => {});
      return work.then(async values => {
        // A save that overlaps an old poll queues a second snapshot/read after that poll completes.
        await queries.invalidateQueries({ queryKey: ['settings'], refetchType: 'none' });
        await poll(true);
        return values;
      }).catch((error: any) => { notify(`Not saved: ${error.message}`, true); throw error; });
    };
    // Keys are typed into the one-time page the service serves, never into this view: it opens in the browser, and
    // saving it changes readiness here on the next update.
    const enterKeys = async (source?: string) => {
      let address: string | null = null;
      try {
        const page = await host.call('view_keys', source ? { source } : {});
        address = typeof page?.address === 'string' ? page.address : null;
        if (!address) { notify('Every credential the enabled sources use is already set. To replace one, use Enter keys on its source.'); return; }
        await host.openLink(address);
        notify(`Opened the key page for ${page.names.join(', ')}. Type the values there and save; readiness updates here. If it did not open, open ${address} in a browser on this computer.`);
      } catch (error: any) { notify(address ? `The key page did not open: ${error.message}. Open ${address} in a browser on this computer.` : `Unable to make a key page: ${error.message}`, true); }
    };
    const activate = async () => {
      const url = host.readDeepLink();
      if (!url || url === handledDeepLink || !latest.current.state.connected) return;
      handledDeepLink = url;
      const route = new URL(url, 'https://dig.invalid');
      if (route.pathname === '/') return;
      const requested = route.searchParams.get('file');
      if (route.pathname !== '/read' || !requested) { notify(`Dig cannot open this link: ${url}`, true); return; }
      const request = ++navigation;
      try {
        // Activation always refreshes a hidden view before resolving its file; a forced poll re-runs after one in flight.
        await poll(true);
        if (!alive || request !== navigation || latest.current.state.updatesFailed) return;
        const fresh = latest.current.snapshot;
        const prefix = `${fresh.library.replace(/\/+$/, '')}/`;
        const file = requested.startsWith(prefix) ? requested.slice(prefix.length)
          : requested.startsWith('/') ? (await host.call('library_read', { file: requested, offset: 0, limit: 1 })).file : requested;
        if (!alive || request !== navigation) return;
        const item = fresh.items.find((item: any) => item.files.includes(file) || item.calls.some((call: any) => call.rawFile === file));
        if (!item) throw new Error(`The linked file is not part of a dig in the selected library: ${requested}`);
        await showDig(item, file);
      } catch (error: any) { if (alive && request === navigation) notify(error.message, true); }
    };
    // The trail follows one dig, by the handle the service gives it.
    const setMode = (mode: string, dig: string | null) => {
      update({ mode, dig });
      if (['/library', '/trail'].includes(latest.current.view)) void navigate(mode === 'panel' ? '/trail' : '/library');
    };
    return {
      update, notify, poll, read, refreshPages, showFile, showDig, loadAssessment, inspectRecords, inspectRaw, closeEvidence, go, expand, back, saveSetting, enterKeys, activate,
      readerOrigin: () => { readerOrigin = { focus: document.getElementById('reader-evidence'), scroll: globalThis.scrollY ?? 0 }; },
      backAbout: () => navigate(latest.current.state.aboutReturn === '/reader' && !latest.current.state.current ? '/library' : latest.current.state.aboutReturn),
      start: async () => {
        const offResult = host.subscribeResult(result => {
          const value = result?.structuredContent ?? result;
          if (value?.view === 'panel') setMode('panel', typeof value.dig === 'string' ? value.dig : null);
        });
        const offActivation = host.subscribeActivation(() => { void activate(); });
        const teardown = () => { offResult(); offActivation(); };
        try {
          await host.start();
          if (!alive) { teardown(); return teardown; }
          const params = new URLSearchParams(location.search);
          const context = host.getContext();
          if (host.browser) setMode(context?.toolInfo?.tool?.name === 'open_trail' ? 'panel' : 'library', params.get('dig'));
          else if (context?.toolInfo?.tool?.name === 'open_trail') setMode('panel', latest.current.state.dig);
          update({ connected: true });
          await poll(true);
          await activate();
        } catch (error: any) { notify(error.message, true); }
        return teardown;
      },
      stop: () => { alive = false; navigation++; evidenceNavigation++; assessmentNavigation++; },
    };
  }, [host, queries, router]);

  useEffect(() => {
    let teardown: (() => void) | undefined;
    let disposed = false;
    methods.start().then(cleanup => { if (disposed) cleanup(); else teardown = cleanup; });
    const timer = setInterval(() => { void methods.poll(); }, POLL_MS);
    const visibility = () => { if (document.visibilityState === 'visible') void methods.poll(); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && latest.current.view === '/reader' && latest.current.state.evidence) {
        methods.closeEvidence(); event.preventDefault();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('keydown', keyboard);
    return () => {
      disposed = true; methods.stop(); teardown?.(); clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('keydown', keyboard);
      host.dispose();
    };
  }, [host, methods]);
  useEffect(() => {
    document.body.classList.toggle('panel-mode', state.mode === 'panel');
    return () => document.body.classList.remove('panel-mode');
  }, [state.mode]);
  useEffect(() => {
    if (!state.connected) return;
    methods.refreshPages().catch((error: any) => methods.notify(error.message, true));
  }, [view, state.connected, methods]);

  return {
    ...state, ...methods, snapshot, catalog, snapshotLoaded: Boolean(snapshotQuery.data),
    settings: settingsQuery.data as any, sources: sourcesQuery.data as any,
    settingsError: settingsQuery.error, sourcesError: sourcesQuery.error,
  };
}
