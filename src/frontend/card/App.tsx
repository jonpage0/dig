import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DigHost } from '../shared/host';
import { Button, Dialog } from '../shared/components';
import { Frame, FramePanel } from '../shared/frame';
import { absTime, costShort, costTotal } from '../../ui/format.mjs';
import { cardDetails, compactTitle, digLink, readRetained, savedResult } from './model';
import type { ResearchCard, RetainedRead, SavedResult } from './model';

type View = { status: 'loading' | 'waiting' | 'ready' | 'error'; saved?: SavedResult; card?: ResearchCard; error?: string };
type Reader = { status: 'loading' | 'ready' | 'error'; value?: RetainedRead; error?: string };
const sameSavedFile = (left?: SavedResult, right?: SavedResult) => !!left && !!right &&
  typeof left.path === 'string' && left.file === right.file && left.path === right.path;
const shortTime = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : 'numeric', hour: 'numeric', minute: '2-digit',
}) : null;

export function CardApp({ host, initialResult }: { host: DigHost; initialResult?: unknown }) {
  const [view, setView] = useState<View>({ status: 'waiting' });
  const [reader, setReader] = useState<Reader | null>(null);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const navigation = useRef(0);
  const alive = useRef(true);
  const opener = useRef<HTMLElement | null>(null);

  const show = useCallback(async (result: unknown) => {
    const version = ++generation.current;
    navigation.current++;
    setReader(null); setNotice('');
    let saved: SavedResult | undefined;
    try {
      saved = savedResult(result);
      setView(previous => ({ status: 'loading', saved, card: sameSavedFile(previous.saved, saved) ? previous.card : undefined }));
      const card = cardDetails(saved.card ?? await host.call('saved_research', { file: saved.path ?? saved.file }), saved.file, saved.path);
      if (alive.current && version === generation.current) setView({ status: 'ready', saved, card });
    } catch (error) {
      if (alive.current && version === generation.current) setView(previous => ({
        status: 'error', saved, card: sameSavedFile(previous.saved, saved) ? previous.card : undefined,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [host]);

  useEffect(() => {
    alive.current = true;
    const unsubscribe = host.subscribeResult(result => void show(result));
    void host.start().then(() => {
      if (!alive.current || initialResult !== undefined || !host.preview) return;
      const file = new URLSearchParams(window.location.search).get('file');
      if (file) void show({ file });
    }).catch(error => { if (alive.current) setNotice(`Dig could not connect: ${error.message}`); });
    return () => { alive.current = false; generation.current++; navigation.current++; unsubscribe(); host.dispose(); };
  }, [host, show]);
  useEffect(() => { if (initialResult !== undefined) void show(initialResult); }, [initialResult, show]);

  const closeReader = () => {
    const version = generation.current, interaction = ++navigation.current;
    setReader(null); setNotice('');
    window.requestAnimationFrame(() => {
      if (alive.current && version === generation.current && interaction === navigation.current && opener.current?.isConnected) opener.current.focus();
    });
  };
  const open = async () => {
    if (!view.saved) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const version = generation.current, interaction = ++navigation.current;
    const current = () => alive.current && version === generation.current && interaction === navigation.current;
    const file = view.card?.file ?? view.saved.file, path = view.card?.path ?? view.saved.path;
    const link = digLink(view.card?.link ?? view.saved.link);
    setNotice('');
    if (link) {
      try { await host.openLink(link); return; }
      catch { if (!current()) return; }
    }
    // A host without Dig deep links still opens the same retained file on demand.
    await host.requestDisplayMode('fullscreen').catch(() => null);
    if (!current()) return;
    setReader({ status: 'loading' });
    try {
      const value = await readRetained(host.call.bind(host), file, current,
        page => { if (current()) setReader({ status: page.nextOffset === null ? 'ready' : 'loading', value: page }); }, path);
      if (current() && value) setReader({ status: 'ready', value });
    } catch (error) {
      if (current()) setReader(previous => ({ status: 'error', value: previous?.value, error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const card = view.card;
  const title = compactTitle(card?.insights?.[0]?.title || card?.title || (view.status === 'error' ? view.saved ? 'Saved research' : 'Save failed' : 'Dig'));
  const sourceNames = card?.kind === 'answer' ? [...new Set(card.reports ?? [])] : card ? [card.label] : [];
  const sources = sourceNames.length > 2 ? `${sourceNames.slice(0, 2).join(' + ')} +${sourceNames.length - 2}` : sourceNames.join(' + ');
  const usage = card?.cost ? costShort(card.cost, card.cost.totalCalls) : '';
  const outcome = card?.kind === 'answer' ? card.status === 'partly answered' ? 'Answer has gaps' : card.status === 'not answered' ? 'Question unanswered' : 'Answer saved'
    : card ? card.status === 'failed' ? 'Report saved · failed search' : card.status === 'partial' ? 'Report saved · partial' : 'Report saved' : null;

  return <main className="dig-inline-card">
    <Frame variant="ghost" dense spacing="xs" className="insight-frame" role="article" aria-busy={view.status === 'loading'} aria-labelledby="insight-title">
      <FramePanel fit className="insight-card">
        <div className="insight-main">
          <h2 id="insight-title" title={card?.question || card?.title}>{title}</h2>
          <div className="insight-meta">
            {outcome && <span>{outcome}</span>}
            {sources && <span title={sourceNames.join(' + ')}>{sources}</span>}
            {card?.savedAt && shortTime(card.savedAt) && <time dateTime={card.savedAt} title={absTime(card.savedAt)}>{shortTime(card.savedAt)}</time>}
            {usage && <span className="insight-cost" title={`${card?.cost?.scope === 'dig' ? 'This dig' : 'This report'} · ${costTotal(card!.cost, card!.cost!.totalCalls)}. Provider-reported usage; excludes model costs.`}>{usage}</span>}
          </div>
          {view.status === 'loading' && <p className="insight-local-status" role="status">Reading details…</p>}
          {view.status === 'waiting' && <p className="insight-local-status">Waiting for a result…</p>}
          {view.status === 'error' && <p role="alert" className="insight-error">{view.error}</p>}
        </div>
        {view.saved && <Button size="sm" variant="outline" onClick={() => void open()}>Open</Button>}
      </FramePanel>
    </Frame>
    {notice && <p className="insight-error" role="status">{notice}</p>}
    <Dialog open={reader !== null} onOpenChange={opened => { if (!opened) closeReader(); }}
      title={card?.title ? compactTitle(card.title) : 'Saved research'} description="Retained research">
      {reader?.status === 'loading' && <p role="status">Reading retained research…</p>}
      {reader?.status === 'error' && <p role="alert">The retained file could not be read completely. {reader.error}</p>}
      {reader?.value && <pre className="insight-original" tabIndex={0}>{reader.value.text || 'The retained file is empty.'}</pre>}
      {reader?.status === 'ready' && <p className="insight-reader-note">Complete retained file</p>}
    </Dialog>
  </main>;
}
