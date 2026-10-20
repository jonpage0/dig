import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createCatalog, fileKind } from '../../ui/catalog.mjs';
import { setRetrievalsOpen } from '../../ui/retrievals.mjs';
import { VERSION } from '../../version.mjs';
import type { DigHost } from '../shared/host';

export const POLL_MS = 2000;
export const READ_LIMIT = 60000;
export const SCHEMA_MISSING = 'Settings arrived without their schema, so no controls can be shown. Reload Dig and try again.';
export const READ_ONLY = 'Browser preview is read-only. Open Dig in Codex to change settings.';

export function replacedMessage(value: any) {
  const installed = typeof value.replaced?.version === 'string' ? value.replaced.version : null;
  return `${installed ? `Dig ${installed} was installed` : 'Dig was updated or removed'} while Codex was running. Refresh Dig’s plugin connection, then refresh this view. If the connection still reports Dig ${value.version}, quit and reopen Codex as a fallback. This view currently uses Dig ${value.version}.`;
}

const emptySnapshot = { items: [], live: [] };
const emptyState = {
  mode: 'library', thread: null, connected: false, notice: '', failure: false, updatesFailed: false,
  current: null, document: null, evidence: null, returnFile: null, returnView: '/library',
  aboutReturn: '/library', usageDays: 30,
};

/** All queries are local read-only MCP operations. Mutations and refresh timing are explicit; Query never
 * retries, refetches on focus, or makes a provider call on behalf of this view. File reads page to completion. */
export function useLibraryController(host: DigHost, router: any, view: string) {
  const queries = useQueryClient();
  const snapshotQuery = useQuery({ queryKey: ['library'], queryFn: () => host.call('library_snapshot'), enabled: false });
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => host.call('settings.read'), enabled: false });
  const sourcesQuery = useQuery({ queryKey: ['sources'], queryFn: () => host.call('source_info'), enabled: false });
  const snapshot: any = snapshotQuery.data ?? emptySnapshot;
  const catalog = useMemo(() => createCatalog(snapshot.sources), [snapshot.sources]);
  const [state, setState] = useState<any>(emptyState);
  const latest = useRef<any>({});
  latest.current = { state, view, snapshot, catalog };
  const methods = useMemo(() => {
    let alive = true;
    let navigation = 0;
    let evidenceNavigation = 0;
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
    let noticedReplaced = false;
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
        wantsSettings ? read('settings', 'settings.read') : null,
        wantsSources ? read('sources', 'source_info') : null,
      ]);
    };
    const acceptSnapshot = (value: any) => {
      const normalized = { ...value, items: value.items ?? [], live: value.live ?? [] };
      const previousLibrary = latest.current.snapshot.library;
      if (typeof previousLibrary === 'string' && previousLibrary !== normalized.library) {
        libraryGeneration++; navigation++; evidenceNavigation++;
        evidenceOrigin = null; readerOrigin = null; browseScroll = 0;
        update({
          current: null, document: null, evidence: null, returnFile: null, returnView: '/library',
          ...(latest.current.state.aboutReturn === '/reader' ? { aboutReturn: '/library' } : {}),
        });
        queries.removeQueries({ queryKey: ['file'] });
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
      if (!noticedReplaced && value.replaced && typeof value.version === 'string') {
        noticedReplaced = true; noticedVersion = true; notify(replacedMessage(value));
      } else if (!noticedVersion && typeof value.version === 'string' && value.version !== VERSION) {
        noticedVersion = true;
        notify(`Dig ${value.version} is installed, but Codex is still showing the ${VERSION} view. Right-click Dig in the sidebar and choose Refresh to load the new one.`);
      }
      return normalized;
    };
    const poll = (force = false): Promise<void> => {
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
        setRetrievalsOpen(evidenceOrigin.reopen);
        globalThis.scrollTo?.({ top: evidenceOrigin.scroll, behavior: 'instant' });
        const target = evidenceOrigin.focus?.isConnected ? evidenceOrigin.focus : document.getElementById('reader-evidence');
        (target as HTMLElement)?.focus({ preventScroll: true });
      }
      evidenceOrigin = null; readerOrigin = null;
    };
    const showFile = async (file: string) => {
      closeEvidence(false);
      const request = ++navigation;
      const kind = fileKind(file);
      update({ document: { file, kind, loading: true } });
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
      if (latest.current.view !== '/reader') {
        browseScroll = globalThis.scrollY ?? 0;
        update({ returnView: latest.current.view === '/about' ? latest.current.state.aboutReturn : latest.current.view });
      }
      update({ current: item, document: null, returnFile: null });
      await navigate('/reader');
      if (!alive || request !== navigation) return;
      const shown = await showFile(file ?? item.answer ?? item.reports[0] ?? item.files.find((path: string) => path.endsWith('dig.md')));
      if (shown && latest.current.state.current?.id === item.id && latest.current.state.current?.project === item.project) {
        const completedNavigation = navigation;
        requestAnimationFrame(() => {
          if (!alive || completedNavigation !== navigation) return;
          document.getElementById('dig-title')?.focus({ preventScroll: true });
          globalThis.scrollTo?.({ top: 0, behavior: 'instant' });
        });
      }
    };
    const inspectRaw = async (file: string) => {
      const { current, document: opened, evidence } = latest.current.state;
      if (!current || !opened || opened.loading || opened.error || opened.kind === 'raw') return showFile(file);
      if (!evidence) {
        const wasOpen = setRetrievalsOpen(false);
        evidenceOrigin = {
          focus: readerOrigin?.focus ?? document.activeElement,
          scroll: readerOrigin?.scroll ?? globalThis.scrollY ?? 0,
          reopen: readerOrigin ? false : wasOpen,
        };
        readerOrigin = null;
      } else setRetrievalsOpen(false);
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
      closeEvidence(false); navigation++;
      update({ current: null, document: null, returnFile: null });
    };
    const go = async (to: string) => {
      if (to === '/about') update({ aboutReturn: latest.current.view });
      else if (to !== '/reader' && latest.current.state.current) leaveReader();
      await navigate(to);
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
      const work = saving.then(async () => (await host.call('settings.update', { set: { [key]: value } })).values);
      saving = work.catch(() => {});
      return work.then(async values => {
        // A save that overlaps an old poll queues a second snapshot/read after that poll completes.
        await queries.invalidateQueries({ queryKey: ['settings'], refetchType: 'none' });
        await poll(true);
        return values;
      }).catch((error: any) => { notify(`Not saved: ${error.message}`, true); throw error; });
    };
    const editKeys = async (source?: string) => {
      let path: string | null = null;
      try {
        const prepared = await host.call('prepare_keys_file', source ? { source } : {});
        path = prepared.path;
        const added = !prepared.added.length ? '' : prepared.added.length > 4 ? ` Added ${prepared.added.length} empty lines.` : ` Added empty lines for ${prepared.added.join(', ')}.`;
        if (!host.canOpenFile()) { notify(`Codex cannot open files from this view. Open ${path} in a text editor, fill in the values and save.${added}`); return; }
        await host.openFile(path!);
        notify(`Opened keys.env.${added} Fill in the values and save; Dig reloads the file and updates readiness here.`);
      } catch (error: any) { notify(path ? `Codex did not open ${path}: ${error.message}` : `Unable to prepare keys.env: ${error.message}`, true); }
    };
    const useEnvironment = async (source: string) => {
      try {
        const result = await host.call('use_environment_keys', { source });
        notify(result.copied.length ? `Copied ${result.copied.join(', ')} from Codex’s environment into keys.env.` : 'keys.env already matches Codex’s environment.');
        await poll(true);
      } catch (error: any) { notify(`Unable to copy the key into keys.env: ${error.message}`, true); }
    };
    const activate = async () => {
      const url = host.readDeepLink();
      if (!url || url === handledDeepLink) return;
      handledDeepLink = url;
      const route = new URL(url, 'https://dig.invalid');
      if (route.pathname === '/') return;
      const requested = route.searchParams.get('file');
      if (route.pathname !== '/read' || !requested) { notify(`Dig cannot open this link: ${url}`, true); return; }
      const request = ++navigation;
      try {
        // Activation always refreshes a hidden view before resolving its file.
        const fresh = await read('library', 'library_snapshot');
        if (!alive || request !== navigation) return;
        const prefix = `${fresh.library.replace(/\/+$/, '')}/`;
        const file = requested.startsWith(prefix) ? requested.slice(prefix.length)
          : requested.startsWith('/') ? (await host.call('library_read', { file: requested, offset: 0, limit: 1 })).file : requested;
        if (!alive || request !== navigation) return;
        const item = fresh.items.find((item: any) => item.files.includes(file) || item.calls.some((call: any) => call.rawFile === file));
        if (!item) throw new Error(`The linked file is not part of a dig in the selected library: ${requested}`);
        await showDig(item, file);
      } catch (error: any) { if (alive && request === navigation) notify(error.message, true); }
    };
    const setMode = (mode: string, thread: string | null) => {
      update({ mode, thread });
      if (['/library', '/trail'].includes(latest.current.view)) void navigate(mode === 'panel' ? '/trail' : '/library');
    };
    return {
      update, notify, poll, read, refreshPages, showFile, showDig, inspectRaw, closeEvidence, go, back, saveSetting, editKeys, useEnvironment, activate,
      readerOrigin: () => { readerOrigin = { focus: document.getElementById('reader-evidence'), scroll: globalThis.scrollY ?? 0 }; },
      backAbout: () => navigate(latest.current.state.aboutReturn === '/reader' && !latest.current.state.current ? '/library' : latest.current.state.aboutReturn),
      start: async () => {
        const offResult = host.subscribeResult(result => {
          const value = result?.structuredContent ?? result;
          if (value?.view === 'panel') setMode('panel', value.thread ?? null);
        });
        const offActivation = host.subscribeActivation(() => { void activate(); });
        const teardown = () => { offResult(); offActivation(); };
        try {
          await host.start();
          if (!alive) { teardown(); return teardown; }
          const params = new URLSearchParams(location.search);
          const context = host.getContext();
          if (host.preview) setMode(params.has('panel') ? 'panel' : 'library', params.get('panel'));
          else if (context?.toolInfo?.tool?.name === 'open_trail') setMode('panel', latest.current.state.thread);
          update({ connected: true });
          await poll(true);
          await activate();
        } catch (error: any) { notify(error.message, true); }
        return teardown;
      },
      stop: () => { alive = false; navigation++; evidenceNavigation++; },
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
