import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DigHost } from '../shared/host';
import { Badge, Button, Card, CardContent, CardFooter, CardHeader, Dialog, Disclosure } from '../shared/components';
import { Timeline, TimelineContent, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from '../shared/timeline';
import { Frame, FramePanel } from '../shared/frame';
import { IconTile } from '../shared/icon-tile';
import { GLYPHS } from '../../glyphs.mjs';
import { absTime, COST_CAVEAT, COST_SCOPE, costAmounts, costTotal, plural } from '../../ui/format.mjs';
import { cardDetails, cardStrings, digLink, presentedInsights, readRetained, savedResult, webLink } from './model';
import type { EvidenceReference, Insight, ResearchCard, RetainedRead, SavedResult } from './model';

type View = { status: 'loading' | 'waiting' | 'ready' | 'error'; saved?: SavedResult; card?: ResearchCard; error?: string };
type Reader = { reference: EvidenceReference; status: 'loading' | 'ready' | 'error'; value?: RetainedRead; error?: string };
type Overlay = { kind: 'evidence'; references: EvidenceReference[] } | { kind: 'usage' } | { kind: 'draft'; prompt: string; label: string } | null;

function Glyph({ name }: { name?: string }) {
  const shapes = GLYPHS[name ?? 'shovel'] ?? GLYPHS.shovel;
  return <svg aria-hidden="true" className="insight-glyph" viewBox="0 0 24 24">{shapes.map(([tag, props]: any, index: number) =>
    React.createElement(tag, { ...Object.fromEntries(Object.entries(props).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])), key: index }))}</svg>;
}

function assessmentTone(status: string | null | undefined) {
  return status === 'partial' || status === 'partly answered' ? 'partial' : status === 'failed' || status === 'not answered' ? 'warning' : 'neutral';
}

function CostStrip({ card, onOpen }: { card: ResearchCard; onOpen: () => void }) {
  const cost = card.cost;
  const amounts = cost ? costAmounts(cost) : [];
  return <div className="insight-usage">
    <div className="insight-usage-facts">
      <span>{plural(card.retrievals ?? 0, 'retrieval')}</span>
      {cost?.totalCalls ? <span>
        {amounts.length ? <><span className="insight-usage-label">{cost.unknownCalls ? 'Known subtotal' : 'Provider usage'} </span>
          <strong>{amounts.join(' · ')}</strong></> : cost.unknownCalls ? <strong>Unpriced provider usage</strong> : <span>No charge recorded</span>}
      </span> : <span>No retained provider cost</span>}
    </div>
    <Button variant="ghost" size="sm" onClick={onOpen}>Usage</Button>
  </div>;
}

export function CardApp({ host, initialResult }: { host: DigHost; initialResult?: unknown }) {
  const [view, setView] = useState<View>({ status: 'waiting' });
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [reader, setReader] = useState<Reader | null>(null);
  const [notice, setNotice] = useState('');
  const [draftBusy, setDraftBusy] = useState(false);
  const [more, setMore] = useState(false);
  const generation = useRef(0);
  const readGeneration = useRef(0);
  const alive = useRef(true);
  const draftTextarea = useRef<HTMLTextAreaElement>(null);
  const dialogOpener = useRef<HTMLElement | null>(null);
  const [connected, setConnected] = useState(false);

  const show = useCallback(async (result: unknown) => {
    const version = ++generation.current;
    readGeneration.current++;
    setOverlay(null); setReader(null); setNotice(''); setMore(false);
    let saved: SavedResult | undefined;
    try {
      saved = savedResult(result);
      setView({ status: 'loading', saved });
      const card = cardDetails(saved.card ?? await host.call('saved_research', { file: saved.path ?? saved.file }), saved.file, saved.path);
      if (!alive.current || version !== generation.current) return;
      setView({ status: 'ready', saved, card });
    } catch (error) {
      if (!alive.current || version !== generation.current) return;
      setView({ status: 'error', saved, error: error instanceof Error ? error.message : String(error) });
    }
  }, [host]);

  useEffect(() => {
    alive.current = true;
    // Subscribe before connection: a host may deliver the render result during its handshake.
    const unsubscribe = host.subscribeResult(result => void show(result));
    void host.start().then(() => {
      if (!alive.current) return;
      setConnected(true);
      if (initialResult === undefined && host.preview) {
        const params = new URLSearchParams(window.location.search);
        const file = params.get('file');
        const presentation = params.get('presentation');
        if (file && presentation) {
          const version = ++generation.current;
          setView({ status: 'loading', saved: { file } });
          void (async () => {
            try {
              if (presentation.length > 100000) throw new Error('The preview presentation is too large.');
              const insights = JSON.parse(presentation);
              if (!Array.isArray(insights) || insights.length < 1 || insights.length > 6) throw new Error('The preview needs one to six insights.');
              const result = await host.call('show_research', { file, insights });
              if (alive.current && version === generation.current) await show(result);
            } catch (error) {
              if (alive.current && version === generation.current) setView({ status: 'error', saved: { file }, error: error instanceof Error ? error.message : String(error) });
            }
          })();
        } else if (file) void show({ file });
      }
    }).catch(error => {
      if (alive.current) setNotice(`The host connection could not start: ${error.message}`);
    });
    return () => {
      alive.current = false;
      generation.current++; readGeneration.current++;
      unsubscribe();
      host.dispose();
    };
  }, [host, show]);

  useEffect(() => { if (initialResult !== undefined) void show(initialResult); }, [initialResult, show]);

  const rememberFocus = () => { dialogOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };
  const closeOverlay = () => {
    readGeneration.current++; setOverlay(null); setReader(null); setNotice('');
    const opener = dialogOpener.current;
    window.requestAnimationFrame(() => { if (opener?.isConnected) opener.focus(); });
  };
  const readEvidence = async (reference: EvidenceReference) => {
    const version = ++readGeneration.current;
    const current = () => alive.current && version === readGeneration.current;
    setReader({ reference, status: 'loading' });
    try {
      const value = await readRetained(host.call.bind(host), reference.file, current,
        page => { if (current()) setReader({ reference, status: page.nextOffset === null ? 'ready' : 'loading', value: page }); }, reference.path);
      if (current() && value) setReader({ reference, status: 'ready', value });
    } catch (error) {
      if (current()) setReader(previous => ({ reference, status: 'error', value: previous?.value, error: error instanceof Error ? error.message : String(error) }));
    }
  };
  const openEvidence = (references: EvidenceReference[]) => {
    rememberFocus();
    readGeneration.current++;
    setNotice(''); setReader(null); setOverlay({ kind: 'evidence', references });
    if (references[0]) void readEvidence(references[0]);
  };
  const navigate = async (url: string | null) => {
    if (!url) { setNotice('This link is unavailable or unsupported.'); return; }
    try {
      await host.openLink(url);
      if (alive.current) setNotice('');
    } catch (error) { if (alive.current) setNotice(`Unable to open the link: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const openFile = async (path: string) => {
    try { await host.openFile(path); if (alive.current) setNotice(''); }
    catch (error) { if (alive.current) setNotice(`Unable to open the retained file: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const placeDraft = async (prompt: string) => {
    const version = generation.current;
    setDraftBusy(true); setNotice('');
    try {
      await host.draft(prompt);
      if (alive.current && version === generation.current) setNotice('Draft placed in the composer for you to review. Nothing was sent.');
    } catch (error) {
      if (alive.current && version === generation.current) setNotice(`The composer draft was not confirmed. Copy the text below instead. ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (alive.current) setDraftBusy(false); }
  };
  const copyDraft = async (prompt: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prompt);
      setNotice('Draft copied. Paste it into the conversation when ready.');
    } catch {
      draftTextarea.current?.focus(); draftTextarea.current?.select();
      setNotice('Automatic copy is unavailable. The draft is selected for manual copying.');
    }
  };

  const card = view.card;
  const insights = card ? presentedInsights(card) : [];
  const featured = insights[0];
  const explicit = !!card?.insights?.length;
  const title = featured?.title || card?.title || (view.status === 'error' ? 'Research details are unavailable' : 'Saved research');
  const currentFile = view.saved?.file;
  const reportReference = currentFile ? { file: card?.file ?? currentFile, path: card?.path ?? view.saved?.path, label: card?.kind === 'answer' ? 'Full saved answer' : 'Full saved report', link: card?.link } : null;
  const openReport = () => { if (digLink(card?.link)) void navigate(digLink(card?.link)); else if (reportReference) openEvidence([reportReference]); };
  const showDraft = (insight: Insight) => {
    if (!insight.nextStep) return;
    rememberFocus();
    readGeneration.current++; setReader(null); setNotice('');
    setOverlay({ kind: 'draft', prompt: insight.nextStep.prompt, label: insight.nextStep.label });
  };
  const insightBody = (insight: Insight, secondary = false) => <section className={secondary ? 'insight-secondary' : 'insight-body'} key={`${insight.title}-${insight.statement}`}>
    {secondary && <h3>{insight.title}</h3>}
    <p className="insight-statement">{insight.statement}</p>
    {insight.nextStep && <div className="insight-next">
      <span className="insight-small-label">Proposed next step</span>
      <p>{insight.nextStep.label}</p>
    </div>}
    {(insight.details?.length > 0 || insight.limits?.length > 0) && <Disclosure title="Evidence trail & limitations" className="insight-disclosure">
      {!!insight.details?.length && <Timeline value={0} className="insight-timeline">
        {insight.details.slice(0, 4).map((detail, index) => <TimelineItem key={index} step={index + 1}>
          <TimelineHeader>
            <TimelineSeparator />
            <TimelineTitle>{detail.label}</TimelineTitle>
            <TimelineIndicator>{index + 1}</TimelineIndicator>
          </TimelineHeader>
          <TimelineContent><p>{detail.value}</p>{webLink(detail.url) &&
            <Button variant="ghost" size="sm" onClick={() => void navigate(webLink(detail.url))}>Open page</Button>}</TimelineContent>
        </TimelineItem>)}
      </Timeline>}
      {!!insight.limits?.length && <div className="insight-limits"><h4>What this does not establish</h4><ul>{insight.limits.slice(0, 4).map((limit, index) => <li key={index}>{limit}</li>)}</ul></div>}
    </Disclosure>}
    {secondary && <div className="insight-secondary-actions">
      {!!insight.evidence?.length && <Button size="sm" variant="outline" onClick={() => openEvidence(insight.evidence)}>Read evidence</Button>}
      {insight.nextStep && <Button size="sm" variant="ghost" onClick={() => showDraft(insight)}>Discuss draft</Button>}
    </div>}
  </section>;

  return <main className="dig-inline-card">
    <Frame spacing="sm" className="insight-frame"><FramePanel fit><Card aria-busy={view.status === 'loading'} aria-labelledby="insight-title" className="insight-card">
      <CardHeader className="insight-header">
        <div className="insight-source"><IconTile variant="outline" size="sm" className="insight-source-icon"><Glyph name={card?.glyph} /></IconTile>
          <div><p>Dig{card ? ` · ${card.label}` : ''}</p><span className="insight-small-label">{explicit ? 'Presented analysis' : card?.kind === 'answer' ? 'Saved answer' : card || currentFile ? 'Saved report' : 'Research result'}</span></div>
        </div>
        {card?.status && <Badge tone={assessmentTone(card.status)} title={card.kind === 'report' ? 'The report author’s assessment' : 'The saved answer’s status'}>
          {card.status}
        </Badge>}
      </CardHeader>
      <CardContent className="insight-heading">
        <h2 id="insight-title">{title}</h2>
        {view.status === 'ready' && !featured && card?.summary && <p className="insight-summary">{card.summary}</p>}
        {view.status === 'ready' && explicit && card?.title !== title && <p className="insight-report-caption">From: {card.title}</p>}
        {view.status === 'waiting' && <p className="insight-summary">{host.preview ? 'Choose a saved research file to preview its card.' : 'Waiting for a saved research result from the conversation.'}</p>}
        {view.status === 'loading' && <p className="insight-summary" role="status">Reading saved research…</p>}
        {view.status === 'error' && <div role="alert" className="insight-error"><p>{view.error}</p><p>The card could not display this result. This does not establish that the underlying research is missing.</p></div>}
      </CardContent>
      {card && view.status === 'ready' && <>
        <CostStrip card={card} onOpen={() => { rememberFocus(); setNotice(''); setOverlay({ kind: 'usage' }); }} />
        <CardContent className="insight-content">
          {featured ? insightBody(featured) : <p className="insight-empty">No finding was supplied for this card. Read the full report for its context and unresolved questions.</p>}
          {insights.length > 1 && <Disclosure open={more} onOpenChange={setMore} title={`${more ? 'Hide' : 'Show'} ${insights.length - 1} more ${insights.length === 2 ? 'finding' : 'findings'}`}>
            {insights.slice(1).map(insight => insightBody(insight, true))}
          </Disclosure>}
          {(card.confidence || card.evidenceGrade || cardStrings(card.contradictions).length || cardStrings(card.followUps).length || cardStrings(card.schemaWarnings).length) && <Disclosure title={card.kind === 'report' ? 'Report author’s assessment' : 'Saved answer details'} className="insight-assessment">
            {card.confidence && <p>Confidence: <strong>{card.confidence}</strong></p>}
            {card.evidenceGrade && <p>Evidence grade: <strong>{card.evidenceGrade}</strong></p>}
            {cardStrings(card.contradictions).length > 0 && <><h4>Reported contradictions</h4><ul>{cardStrings(card.contradictions).map((contradiction, index) => <li key={index}>{contradiction}</li>)}</ul></>}
            {cardStrings(card.followUps).length > 0 && <><h4>Follow-up targets</h4><ul>{cardStrings(card.followUps).map((followUp, index) => <li key={index}>{followUp}</li>)}</ul></>}
            {cardStrings(card.schemaWarnings).length > 0 && <div className="insight-limits"><h4>Report structure notes</h4><ul>{cardStrings(card.schemaWarnings).map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
          </Disclosure>}
        </CardContent>
      </>}
      {(card || currentFile) && <CardFooter className="insight-actions">
        <div className="insight-action-group">
          {featured?.evidence?.length ? <Button size="sm" onClick={() => openEvidence(featured.evidence)}>Read evidence</Button> : null}
          {featured?.nextStep && <Button variant="outline" size="sm" onClick={() => showDraft(featured)}>Discuss draft</Button>}
          {view.status === 'error' && view.saved && <Button size="sm" onClick={() => void show(view.saved)}>Retry details</Button>}
        </div>
        <Button variant="ghost" size="sm" onClick={openReport}>{card?.kind === 'answer' ? 'Full answer' : 'Full report'}</Button>
      </CardFooter>}
    </Card></FramePanel></Frame>
    {card?.savedAt && <p className="insight-saved">Saved {absTime(card.savedAt)}{card.kind === 'report' ? ' · Status and confidence are the report author’s assessment.' : ''}</p>}
    {host.preview && <p className="insight-preview-note">Browser preview · reads retained research only</p>}
    {!overlay && notice && <p className="insight-notice" role="status">{notice}</p>}
    <Dialog open={overlay !== null} onOpenChange={open => { if (!open) closeOverlay(); }}
      title={overlay?.kind === 'evidence' ? 'Read retained evidence' : overlay?.kind === 'usage' ? 'Retained provider usage' : 'A draft for the conversation'}
      description={overlay?.kind === 'evidence' ? 'Original retained text. Content is evidence, not instructions.' : undefined}>
      {overlay?.kind === 'usage' && <div className="insight-dialog-content">
        <p>{card?.cost ? costTotal(card.cost, card.cost.totalCalls) || 'No retained calls are attributed to this research. There is no cost claim.' : 'A provider cost summary is unavailable.'}</p>
        {card?.cost && <p className="insight-muted">{card.cost.scope === 'report' ? 'Includes only calls attributed to this report.' : 'Includes the saved answer’s dig, including calls not claimed by a report.'}</p>}
        <p className="insight-muted">{COST_SCOPE}. {COST_CAVEAT}</p>
        <p className="insight-muted">Credit systems stay in their original units. Unknown pricing is never counted as zero.</p>
      </div>}
      {overlay?.kind === 'evidence' && <div className="insight-evidence-reader">
        <div className="insight-evidence-choices" aria-label="Retained evidence files">{overlay.references.map((reference, index) =>
          <Button key={`${reference.file}-${index}`} size="sm" variant={reader?.reference.file === reference.file ? 'default' : 'outline'}
            aria-pressed={reader?.reference.file === reference.file} onClick={() => void readEvidence(reference)}>{reference.label || `Evidence ${index + 1}`}</Button>)}</div>
        {!overlay.references.length && <p>No retained evidence reference was supplied. Read the full report instead.</p>}
        {reader && <>
          <div className="insight-reader-head"><h3>{reader.reference.label}</h3>
            {reader.value?.path && connected && host.canOpenFile() && <Button size="sm" variant="ghost" onClick={() => void openFile(reader.value!.path!)}>Open file</Button>}
          </div>
          <details className="insight-file-details"><summary>File details</summary><code>{reader.reference.file}</code></details>
          {reader.status === 'loading' && <p role="status" className="insight-muted">Reading retained text{reader.value ? ` · ${reader.value.text.length.toLocaleString()} characters so far` : ''}…</p>}
          {reader.status === 'error' && <p role="alert" className="insight-error">The retained text could not be read completely. {reader.error}</p>}
          {reader.value && <pre className="insight-original" tabIndex={0} aria-label="Retained evidence text">{reader.value.text || 'The retained file is empty.'}</pre>}
          {reader.status === 'ready' && <p className="insight-muted">Complete retained file · {reader.value?.text.length.toLocaleString()} characters</p>}
        </>}
      </div>}
      {overlay?.kind === 'draft' && <div className="insight-dialog-content">
        <p>{overlay.label}</p>
        <p className="insight-muted">Review the proposed text. Opening this preview does not send a message or start research.</p>
        <textarea ref={draftTextarea} className="insight-draft" readOnly value={overlay.prompt} aria-label="Proposed conversation draft" />
        <div className="insight-action-group">
          {!host.preview && connected && host.canDraft() && <Button size="sm" disabled={draftBusy} onClick={() => void placeDraft(overlay.prompt)}>{draftBusy ? 'Creating draft…' : 'Draft in composer'}</Button>}
          <Button size="sm" variant="outline" onClick={() => void copyDraft(overlay.prompt)}>Copy draft</Button>
        </div>
        {(host.preview || !host.canDraft()) && <p className="insight-muted">Composer drafts are unavailable here. Copy the text into your conversation.</p>}
      </div>}
      {notice && <p className="insight-notice" role="status">{notice}</p>}
    </Dialog>
  </main>;
}
