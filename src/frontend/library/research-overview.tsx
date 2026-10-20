import React, { useId, useMemo, useState } from 'react';
import { Badge, Button } from '../shared/components';
import { Frame, FrameHeader, FrameTitle, FrameDescription, FramePanel, FrameFooter } from '../shared/frame';
import { IconTile } from '../shared/icon-tile';
import { Timeline, TimelineItem, TimelineHeader, TimelineTitle, TimelineDate, TimelineContent, TimelineIndicator, TimelineSeparator } from '../shared/timeline';
import { MODULES } from '../../providers/modules.ts';
import { GLYPHS, glyphFor } from '../../glyphs.mjs';
import { costSummary } from '../../providers/library/cost.ts';
import { costAmounts, costShort, costTotal, COST_SCOPE, COST_CAVEAT, num, plural, shortDate, clock, basename } from '../../ui/format.mjs';
import { usageOf, outcomeCounts, WINDOWS } from '../../ui/usage.mjs';
import { callWord, patternOf } from '../../status.mjs';
import { projectResearch, projectMethodCoverage, projectConversation, projectRecordedActivity, canonicalResearchFile, CALL_OUTCOME_LABELS } from './research-state';
import { ResearchSteering } from './research-steering';
import type { DigHost } from '../shared/host';

type ViewProps = { app: any; host: DigHost; hidden: boolean };
const OUTCOMES = [{ id: 'results', label: 'Success / partial' }, { id: 'empty', label: 'Empty' }, { id: 'failed', label: 'Other outcomes' }];
const label = (catalog: any, id: string) => catalog?.label?.(id) || MODULES.find(module => module.id === id)?.label || id || 'Unknown source';
const date = (at: string) => Number.isFinite(Date.parse(at)) ? `${shortDate(at)} · ${clock(at)}` : 'Date not recorded';
const eventDate = (at: any) => Number.isFinite(Date.parse(at)) ? at : undefined;
const tone = (word: string) => patternOf(word) === 'warning' ? 'warning' : patternOf(word) === 'stripes' ? 'partial' : patternOf(word) === 'solid' ? 'success' : 'neutral';

/** Logos remain package-owned symbols on a light tile, never remote images. */
function SourceIcon({ id }: { id: string }) {
  const module = MODULES.find(module => module.id === id);
  return <IconTile size="sm" variant="outline" className="research-overview-icon">
    {module?.logo ? <svg aria-hidden="true" focusable="false"><use href={`#logo-${module.logo}`} /></svg>
      : <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className="research-overview-glyph">
        {GLYPHS[glyphFor(id)].map(([tag, attributes]: [string, Record<string, string>], index: number) => React.createElement(tag, {
          key: index,
          ...Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key.replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase()), value])),
        }))}
      </svg>}
  </IconTile>;
}

/** This disclosure is deliberately uncontrolled. Polling updates its text without replacing its node/focus. */
function ProviderUsage({ cost, total, scope }: { cost: any; total: number; scope: string }) {
  const amounts = costAmounts(cost);
  const heading = amounts.length && cost.unknownCalls ? 'Known provider subtotal' : cost.unknownCalls ? 'Unpriced provider usage' : 'Provider cost';
  return <div className="research-overview-usage-primary" data-incomplete={Boolean(cost.unknownCalls)}>
    <dt>{heading}</dt>
    <dd><div className="research-overview-amounts">{!total ? <span>No calls recorded</span> : amounts.length ? amounts.map((amount: string) => <span key={amount}>{amount}</span>) : cost.unknownCalls ? <span>{plural(cost.unknownCalls, 'call')}</span> : <span>No charge recorded</span>}</div>
    <details className="research-overview-pricing"><summary data-key={`pricing:${scope}`}>Pricing details</summary>
      <p>{!total ? 'There are no retained retrievals in this scope.' : cost.unknownCalls ? `${num(cost.unknownCalls)} of ${plural(total, 'retrieval')} incompletely priced. Unknown amounts are not zero.` : 'Every retrieval’s cost is known from its receipt.'}</p>
      <p>{COST_SCOPE}. {COST_CAVEAT} Different provider credits and currencies remain separate.</p>
    </details></dd>
  </div>;
}

function RetainedFigures({ counts, reports, cost, scope }: { counts: any; reports: number; cost: any; scope: string }) {
  return <dl className="research-overview-figures">
    <ProviderUsage cost={cost} total={counts.total} scope={scope} />
    <div className="research-overview-figure"><dt>Retrievals</dt><dd>{num(counts.total)}<p>{num(counts.results)} success / partial</p></dd></div>
    <div className="research-overview-figure"><dt>Reports saved</dt><dd>{num(reports)}<p>Retained source reports</p></dd></div>
    <div className="research-overview-figure"><dt>Other call outcomes</dt><dd>{num(counts.failed)}<p>Failed, stopped or skipped</p></dd></div>
  </dl>;
}

function Patterns({ id }: { id: string }) {
  return <defs>
    <pattern id={`${id}-dots`} width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="var(--muted)" /><circle cx="2.5" cy="2.5" r="1" fill="var(--foreground)" /></pattern>
    <pattern id={`${id}-hatch`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="var(--muted)" /><rect width="1.7" height="5" fill="var(--foreground)" /></pattern>
  </defs>;
}
const fill = (id: string, outcome: string) => outcome === 'results' ? 'var(--primary)' : `url(#${id}-${outcome === 'empty' ? 'dots' : 'hatch'})`;
const breakdown = (counts: any) => OUTCOMES.filter(outcome => counts[outcome.id]).map(outcome => `${num(counts[outcome.id])} ${outcome.label.toLowerCase()}`).join(', ');
const bucketName = (usage: any, bucket: any) => `${usage.weekly ? 'Week of ' : ''}${shortDate(new Date(bucket.start).toISOString())}`;

function ActivityChart({ usage, expanded }: { usage: any; expanded: boolean }) {
  const id = `activity-${useId().replaceAll(':', '')}`;
  const width = 600; const height = expanded ? 190 : 130;
  const maximum = Math.max(1, ...usage.buckets.map((bucket: any) => bucket.total));
  const slot = width / Math.max(1, usage.buckets.length);
  const bar = Math.max(1, Math.min(slot * .68, 35));
  const busiest = usage.buckets.reduce((best: any, bucket: any) => !best || bucket.total > best.total ? bucket : best, null);
  const unit = usage.weekly ? 'week' : 'day';
  const summary = `${num(usage.totals.total)} retained retrievals per ${unit}. ${busiest?.total ? `Busiest ${unit}: ${bucketName(usage, busiest)}, ${plural(busiest.total, 'retrieval')}.` : 'No calls in this window.'} Call outcomes do not establish the quality or completion of research.`;
  return <figure className="research-overview-chart">
    <div className="research-overview-chart-head"><figcaption>Activity by {unit}</figcaption><span>{busiest?.total ? `Busiest: ${num(busiest.total)} calls` : 'No calls in this window'}</span></div>
    <svg className="research-overview-activity-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={summary}>
      <Patterns id={id} />
      {[.5, 1].map(ratio => <line key={ratio} x1="0" x2={width} y1={height * ratio - .5} y2={height * ratio - .5} stroke="var(--border)" strokeDasharray={ratio < 1 ? '2 5' : undefined} />)}
      {usage.buckets.map((bucket: any, index: number) => {
        let y = height;
        return <g key={bucket.start}><title>{bucketName(usage, bucket)}: {plural(bucket.total, 'retrieval')}{bucket.total ? ` (${breakdown(bucket)})` : ''}</title>
          {OUTCOMES.filter(outcome => bucket[outcome.id]).map(outcome => {
            const size = bucket[outcome.id] / maximum * height; y -= size;
            return <rect key={outcome.id} x={index * slot + (slot - bar) / 2} y={y} width={bar} height={size} fill={fill(id, outcome.id)} />;
          })}
        </g>;
      })}
    </svg>
    <div className="research-overview-axis"><span>{usage.buckets.length ? bucketName(usage, usage.buckets[0]) : ''}</span><span>{usage.weekly && usage.buckets.length ? bucketName(usage, usage.buckets.at(-1)) : 'Today'}</span></div>
  </figure>;
}

function SourceBar({ row, maximum, catalog }: any) {
  const id = `source-bar-${useId().replaceAll(':', '')}`;
  const width = 240; let x = 0;
  const module = MODULES.find(module => module.id === row.id);
  const description = `${label(catalog, row.id)}: ${plural(row.total, 'retrieval')}${row.total ? ` (${breakdown(row)})` : ''}; ${module?.kind === 'tool' ? 'shared tool' : plural(row.reports, 'report') + ' saved'}.`;
  return <li className="research-overview-source-row">
    <div className="research-overview-source-name"><SourceIcon id={row.id} /><span>{label(catalog, row.id)}</span><strong>{num(row.total)}</strong></div>
    <svg viewBox={`0 0 ${width} 7`} preserveAspectRatio="none" role="img" aria-label={description}><Patterns id={id} /><rect width={width} height="7" fill="var(--muted)" />
      {OUTCOMES.filter(outcome => row[outcome.id]).map(outcome => {
        const at = x; const size = row[outcome.id] / maximum * width; x += size;
        return <rect key={outcome.id} x={at} width={size} height="7" fill={fill(id, outcome.id)} />;
      })}
    </svg>
    <p>{row.cost.unknownCalls && !Object.keys(row.cost.byUnit).length ? `${plural(row.cost.unknownCalls, 'call')} without reported pricing` : costShort(row.cost, row.total) || `${plural(row.reports, 'report')} saved; no calls in this window`}</p>
  </li>;
}

function SourcesChart({ rows, catalog, expanded }: any) {
  const shown = expanded ? 6 : 4;
  const maximum = Math.max(1, ...rows.map((row: any) => row.total));
  return <figure className="research-overview-chart">
    <div className="research-overview-chart-head"><figcaption>Sources &amp; tools</figcaption><span>Calls and reported usage</span></div>
    {rows.length ? <>
      <ul className="research-overview-source-rows">{rows.slice(0, shown).map((row: any) => <SourceBar key={row.id} row={row} maximum={maximum} catalog={catalog} />)}</ul>
      {rows.length > shown && <details className="research-overview-more-sources"><summary>{rows.length - shown} more sources &amp; tools</summary><ul className="research-overview-source-rows">{rows.slice(shown).map((row: any) => <SourceBar key={row.id} row={row} maximum={maximum} catalog={catalog} />)}</ul></details>}
    </> : <p className="research-overview-empty-chart">No source was used in this window.</p>}
  </figure>;
}

function UsageOverview({ app }: { app: any }) {
  const [expanded, setExpanded] = useState(false);
  const today = new Date().toDateString();
  const usage = useMemo(() => usageOf(app.snapshot, { days: app.usageDays ?? 30 }), [app.snapshot, app.usageDays, today]);
  const scope = usage.days ? `Last ${usage.days} days` : `All time, since ${shortDate(new Date(usage.start).toISOString())}`;
  return <Frame className="research-overview-usage-frame">
    <section id="usage" className="research-overview-usage" aria-labelledby="usage-title" data-expanded={expanded}>
      <FrameHeader className="research-overview-usage-header"><div><FrameTitle><h2 id="usage-title">Provider usage</h2></FrameTitle><FrameDescription>{scope} · every project in this library</FrameDescription></div>
        <div className="research-overview-window" role="group" aria-label="Usage window">{WINDOWS.map(window => <Button key={window.days} size="sm" variant="ghost" data-key={`usage-window:${window.days}`} aria-pressed={window.days === usage.days} onClick={() => app.update({ usageDays: window.days })}>{window.label}</Button>)}</div>
      </FrameHeader>
      <FramePanel className="research-overview-usage-body">
        {!app.snapshotLoaded ? <p className="research-overview-loading" role="status">Reading retained usage…</p> : <>
          <RetainedFigures counts={usage.totals} reports={usage.totals.reports} cost={usage.totals.cost} scope="usage" />
          {usage.recorded ? <>
            <div className="research-overview-charts"><ActivityChart usage={usage} expanded={expanded} /><SourcesChart rows={usage.sources} catalog={app.catalog} expanded={expanded} /></div>
            <div className="research-overview-chart-footer"><div className="research-overview-legend" aria-label="Recorded call outcomes">{OUTCOMES.map(outcome => <span key={outcome.id}><i className={`research-overview-swatch research-overview-swatch-${outcome.id}`} aria-hidden="true" />{outcome.label}</span>)}</div><Button size="sm" variant="ghost" data-key="usage-size" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Compact charts' : 'Expand charts'}</Button></div>
          </> : <p className="research-overview-empty-chart">Provider receipts and dated reports will appear here when research is saved.</p>}
        </>}
      </FramePanel>
      <FrameFooter className="research-overview-usage-foot">{COST_SCOPE}. {COST_CAVEAT}</FrameFooter>
    </section>
  </Frame>;
}

function MethodLedger({ item, catalog }: any) {
  const methods = projectMethodCoverage(item, catalog);
  return <section className="research-overview-methods" aria-label="Method report coverage"><h4>Report coverage</h4>
    {methods.length ? <ul>{methods.map(method => <li key={method.method}>
      <div><strong>{method.label}</strong><span>{method.planned ? 'Planned method' : 'Recorded method'}</span></div>
      <div>{method.reports.length ? <><span>{plural(method.reports.length, 'report')} · {plural(method.claimedCalls.length, 'report-linked call')}</span>{method.latestReport?.status && <span className="research-overview-author-state">Latest author assessment: {method.latestReport.status}</span>}</> : <span className="research-overview-no-report">No report saved</span>}</div>
    </li>)}</ul> : <p>No research method has a saved report or recorded plan yet.</p>}
  </section>;
}

function RecordedMilestones({ item, catalog, app }: any) {
  const events = projectRecordedActivity(item, catalog).filter(event => event.kind !== 'recorded-call');
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 3);
  if (!events.length) return null;
  return <section className="research-overview-milestones" aria-label="Saved milestones"><h4>Saved milestones</h4>
    <Timeline value={shown.length} className="research-overview-timeline">
      {shown.map((event, index) => <TimelineItem step={index + 1} key={event.id} className="research-overview-event">
        <TimelineIndicator className="research-overview-event-marker" /><TimelineSeparator className="research-overview-event-line" />
        <TimelineHeader><TimelineDate dateTime={eventDate(event.at)}>{date(event.at)}</TimelineDate><TimelineTitle className="research-overview-event-title">{event.label}</TimelineTitle></TimelineHeader>
        <TimelineContent><p>{event.detail}</p>{event.fileOrCallId && <Button size="sm" variant="ghost" onClick={() => { void app.showDig(item, event.fileOrCallId); }}>Read saved {event.kind === 'answer-saved' ? 'answer' : 'report'}</Button>}</TimelineContent>
      </TimelineItem>)}
    </Timeline>
    {events.length > 3 && <Button size="sm" variant="ghost" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show fewer milestones' : `Show all ${events.length} saved milestones`}</Button>}
  </section>;
}

function ResearchRow({ item, app, host, trail = false }: { item: any; app: any; host: DigHost; trail?: boolean }) {
  const state = projectResearch(item, app.catalog);
  const recent = state.latestActivity;
  const sources = state.sourcesWithReports.length ? state.sourcesWithReports : state.sourcesAndToolsCalled;
  const missing = state.methods.filter(method => !method.reports.length);
  const cost = costShort(state.cost, state.callCount);
  return <article className={`research-overview-row${trail ? ' research-overview-trail-row' : ''}`} aria-label={state.question}>
    <Frame className="research-overview-question-frame" spacing="sm">
      <FramePanel className="research-overview-question-panel">
        <div className="research-overview-question-main"><div className="research-overview-question-copy">
          <div className="research-overview-subject"><div className="research-overview-marks">{sources.slice(0, 3).map(id => <SourceIcon key={id} id={id} />)}</div><p>{sources.length ? sources.map(id => label(app.catalog, id)).join(' · ') : 'No source report yet'}</p></div>
          <h3><Button variant="ghost" className="research-overview-question-button" data-key={`${trail ? 'trail' : 'dig'}:${item.project}:${item.id}`} title={state.question} onClick={() => { void app.showDig(item); }}>{state.displayTitle}</Button></h3>
          <p className="research-overview-project" title={item.project}>{basename(item.project) || item.project}</p>
        </div><div className="research-overview-question-state"><Badge tone={tone(item.status)} data-pattern={patternOf(item.status)}>{state.savedState}</Badge>
          <p>{plural(state.reportCount, 'report')} · {plural(state.callCount, 'retrieval')}</p>
          {cost && <strong title={costTotal(state.cost, state.callCount)}>{cost}</strong>}
        </div></div>
        <div className="research-overview-coverage-line"><span>{plural(state.reportedMethodCount, 'method')} with saved reports</span>{missing.length > 0 && <span>{missing.map(method => method.label).join(', ')}: No report saved</span>}{!state.hasAnswer && <span>No answer saved yet</span>}</div>
        {recent && <p className="research-overview-latest" title={recent.detail}>Latest recorded: {recent.label} <time dateTime={eventDate(recent.at)}>{date(recent.at)}</time>{recent.kind === 'recorded-call' && <span>Call start time</span>}</p>}
        {state.reviewSignals.length > 0 && <div className="research-overview-recorded-issues"><span>Recorded issues</span><ul>{state.reviewSignals.slice(0, 2).map(signal => <li key={signal}>{signal}</li>)}</ul>{state.reviewSignals.length > 2 && <span>{state.reviewSignals.length - 2} more in Details</span>}</div>}
        {trail && <MethodLedger item={item} catalog={app.catalog} />}
        {trail && <RecordedMilestones item={item} catalog={app.catalog} app={app} />}
      </FramePanel>
      <FrameFooter className="research-overview-question-footer">
        <details className="research-overview-question-details"><summary data-key={`preview:${item.project}:${item.id}`}>Details</summary><div>
          <h4>Original question</h4><p>{state.question}</p>
          {state.reviewSignals.length > 2 && <><h4>Recorded issues</h4><ul>{state.reviewSignals.map(signal => <li key={signal}>{signal}</li>)}</ul></>}
          {item.snippet && <><h4>Saved summary preview</h4><p>{item.snippet}</p></>}
          {!trail && <MethodLedger item={item} catalog={app.catalog} />}
          {state.callCount > 0 && <p className="research-overview-cost-detail">{costTotal(state.cost, state.callCount)}</p>}
        </div></details>
        <ResearchSteering host={host} item={item} library={app.snapshot.library} triggerLabel="Discuss next step" />
      </FrameFooter>
      {trail && item.calls?.length > 0 && <RecordedCalls calls={item.calls} app={app} host={host} item={item} scope="Saved with this question" />}
    </Frame>
  </article>;
}

function RecordedCall({ call, app, host, item, scope }: any) {
  const open = () => {
    if (item) { void app.showDig(item, call.rawFile); return; }
    const path = canonicalResearchFile(app.snapshot.library, call.rawFile);
    if (path) void host.openFile(path).catch((error: any) => app.notify?.(`Unable to open the original response: ${error.message}`, true));
  };
  const canOpen = Boolean(call.rawFile) && (item || (!host.preview && host.canOpenFile?.()));
  return <li className="research-overview-call"><div className="research-overview-call-head"><SourceIcon id={call.source} /><div><strong>{label(app.catalog, call.source)}</strong><span>{call.tool}</span></div><Badge tone={tone(callWord(call.status))}>Call: {CALL_OUTCOME_LABELS[call.status] ?? 'Unknown outcome'}</Badge></div>
    <p><time dateTime={eventDate(call.at)}>{date(call.at)}</time><span>Recorded call start</span><span>{scope}</span></p>
    {call.error && <p className="research-overview-call-error">Recorded error: {call.error}</p>}
    <div className="research-overview-call-foot"><span>{costShort(costSummary([call]), 1)}</span>{canOpen ? <Button size="sm" variant="ghost" onClick={open}>Open original response</Button> : <span>{call.rawFile ? 'Original response retained' : 'Original response not retained'}</span>}</div>
  </li>;
}

function RecordedCalls({ calls, app, host, item, scope, initiallyShown = 3 }: any) {
  const sorted = [...calls].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return <details className="research-overview-calls"><summary>{plural(calls.length, 'recorded retrieval')}</summary>
    <ul>{sorted.slice(0, initiallyShown).map(call => <RecordedCall key={`${call.session}:${call.id}`} call={call} app={app} host={host} item={item} scope={scope} />)}</ul>
    {calls.length > initiallyShown && <details className="research-overview-all-calls"><summary>Show all recorded activity</summary><ul>{sorted.slice(initiallyShown).map(call => <RecordedCall key={`${call.session}:${call.id}`} call={call} app={app} host={host} item={item} scope={scope} />)}</ul></details>}
  </details>;
}

export function ResearchOverview({ app, host, hidden }: ViewProps) {
  const items = app.snapshot.items ?? [];
  return <section id="browse" className="research-overview" hidden={hidden}>
    <header className="research-overview-heading"><h2>Research library</h2><p>Saved questions, their evidence and what is still open.</p></header>
    <UsageOverview app={app} />
    <div className="research-overview-recent-heading"><div><h2>Recent research</h2><p>Open a question to inspect its saved state and choose what to do next.</p></div><span>{plural(items.length, 'question')}</span></div>
    <div id="list" className="research-overview-list">{items.length ? items.map((item: any) => <ResearchRow key={`${app.snapshot.library}:${item.project}:${item.id}`} item={item} app={app} host={host} />) : <Frame className="research-overview-empty"><FramePanel><IconTile variant="frame"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4M9 3v6h6M9 3l6 6m-6 6h6" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg></IconTile><h3>{app.snapshotLoaded ? 'Your next question starts in the conversation' : 'Reading saved research…'}</h3><p>{app.snapshotLoaded ? 'Ask Dig to investigate a question. Its saved reports, source evidence and provider usage will appear here.' : 'The library is loading retained work.'}</p></FramePanel></Frame>}</div>
  </section>;
}

export function ConversationOverview({ app, host, hidden }: ViewProps) {
  const scope = projectConversation(app.snapshot, app.thread);
  const counts = outcomeCounts(scope.calls);
  const reports = scope.digs.flatMap(item => item.reportDetails ?? []);
  return <section id="panel" className="research-overview research-overview-conversation" hidden={hidden}>
    <header className="research-overview-heading"><h2 id="panel-scope">{scope.identified ? 'This conversation' : 'Conversation not identified'}</h2><p>Saved questions, reports and provider calls attributed to this conversation.</p></header>
    <Frame className="research-overview-usage-frame" hidden={!scope.identified || (!scope.calls.length && !reports.length)}><FramePanel><section id="panel-figures" aria-label="This conversation’s retrievals and provider cost"><RetainedFigures counts={counts} reports={reports.length} cost={scope.cost} scope="panel" /><p className="research-overview-scope-note">{COST_SCOPE}. {COST_CAVEAT}</p>{scope.otherUnassignedCallCount > 0 && <p className="research-overview-scope-note">Not included: {plural(scope.otherUnassignedCallCount, 'retrieval')} by workers or other conversations that no saved report has claimed yet.</p>}</section></FramePanel></Frame>
    <div id="panel-digs" className="research-overview-list">{!scope.identified ? <Frame><FramePanel><p className="research-overview-empty-message">Codex did not identify this conversation to Dig, so the trail cannot pick out its research. Use Library to browse everything.</p></FramePanel></Frame> : scope.digs.length ? scope.digs.map(item => <ResearchRow key={`${app.snapshot.library}:${item.project}:${item.id}`} item={item} app={app} host={host} trail />) : <Frame><FramePanel><p className="research-overview-empty-message">No question has been recorded for this conversation yet. Saved research appears here when it is attributed to this chat.</p></FramePanel></Frame>}</div>
    <Frame className="research-overview-unassigned"><FrameHeader><FrameTitle><h3>Retrievals not yet in a saved report or answer</h3></FrameTitle><FrameDescription>These are retained call receipts. Their presence does not establish whether any worker is currently active.</FrameDescription></FrameHeader>
      <FramePanel><div id="panel-live">
        {scope.ownUnassignedCalls.length > 0 && <section className="research-overview-unassigned-group"><h4>This conversation</h4><p>Included in this conversation’s provider usage.</p><RecordedCalls calls={scope.ownUnassignedCalls} app={app} host={host} scope="This conversation" /></section>}
        {scope.otherUnassignedCallCount > 0 && <section className="research-overview-unassigned-group"><h4>Other conversations or workers</h4><p id="live-caveat">Excluded from this conversation’s totals. A worker’s call is associated with its own conversation until the saved records attribute it to a question.</p><RecordedCalls calls={scope.otherUnassignedCalls} app={app} host={host} scope="Other conversation or worker; excluded from totals" /></section>}
        {!scope.ownUnassignedCalls.length && !scope.otherUnassignedCallCount && <p className="research-overview-empty-chart">No unassigned retrievals recorded.</p>}
      </div></FramePanel>
    </Frame>
  </section>;
}
