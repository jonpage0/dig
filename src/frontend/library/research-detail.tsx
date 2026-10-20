import React, { useMemo } from 'react';
import { Badge, Button, Disclosure } from '../shared/components';
import { Frame, FrameHeader, FramePanel, FrameFooter } from '../shared/frame';
import { Timeline, TimelineContent, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from '../shared/timeline';
import { costAmounts, absTime, plural } from '../../ui/format.mjs';
import { projectResearch, CALL_OUTCOME_LABELS } from './research-state';
import { ResearchSteering } from './research-steering';
import type { DigHost } from '../shared/host';

const strings = (value: any) => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [];
const stamp = (value: any) => value && Number.isFinite(Date.parse(value)) ? absTime(value) : 'Time not recorded';
const tone = (value: string) => ['failed', 'not answered'].includes(value) ? 'warning' : ['partial', 'partly answered'].includes(value) ? 'partial' : 'neutral';

/** The selected question is an observation surface. Reading records is an explicit secondary action. */
export function ResearchDetail({ app, host }: { app: any; host: DigHost }) {
  const item = app.current;
  const research = useMemo(() => projectResearch(item, app.catalog), [item, app.catalog]);
  if (!item) return null;
  const assessment = app.assessment;
  const card = assessment?.value;
  const followUps = strings(card?.followUps);
  const contradictions = strings(card?.contradictions);
  const findings = strings(card?.findings);
  const warnings = strings(card?.schemaWarnings);
  const amounts = costAmounts(research.cost);
  const latestCalls = [...item.calls].sort((a: any, b: any) => Date.parse(b.at) - Date.parse(a.at));
  const sourceLevelCalls = item.calls.filter((call: any) => !item.reportDetails.some((report: any) => report.file === call.claimedBy)).length;
  const recordsToggle = () => {
    if (app.inspectionOpen) { app.closeEvidence(false); app.update({ inspectionOpen: false }); }
    else void app.inspectRecords();
  };
  return <div className="research-detail-state">
    <div className="research-detail-status">
      <div><Badge tone={tone(item.status)}>{research.savedState}</Badge><span>{research.hasAnswer ? 'Recorded answer outcome: ' + item.status : 'No answer saved'}</span></div>
      <ResearchSteering host={host} item={item} library={app.snapshot.library} />
    </div>
    <div className="research-detail-figures">
      <Frame spacing="sm" className="research-detail-spend"><FramePanel>
        <span className="research-label">{research.cost.unknownCalls ? 'Known provider usage' : 'Reported provider usage'}</span>
        <div className="research-detail-amounts">{amounts.length ? amounts.map(amount => <strong key={amount}>{amount}</strong>) : <strong>{research.callCount ? research.cost.unknownCalls ? 'Price not reported' : 'No charge recorded' : 'No calls recorded'}</strong>}</div>
        <p>{plural(research.callCount, 'retained call')} for this question</p>
        <details className="research-pricing"><summary>Pricing details</summary><p>{research.cost.unknownCalls ? plural(research.cost.unknownCalls, 'call') + ' incompletely priced. Known amounts are a subtotal.' : 'Amounts retain the units reported by each provider.'} Provider usage excludes the chat model and is not a reconciled invoice.</p></details>
      </FramePanel></Frame>
      <Frame spacing="sm" className="research-detail-counts"><FramePanel><dl>
        <div><dt>Source reports</dt><dd>{research.reportCount}</dd><span>{plural(research.sourcesWithReports.length, 'source')} represented</span></div>
        <div><dt>Methods with reports</dt><dd>{research.reportedMethodCount}</dd><span>{research.plannedMethodCount ? research.plannedMethodsWithReports + ' of ' + research.plannedMethodCount + ' planned methods' : 'No method plan recorded'}</span></div>
        <div><dt>Originals retained</dt><dd>{research.retainedOriginalCount}</dd><span>Response bundles, not website count</span></div>
      </dl></FramePanel></Frame>
    </div>

    <div className="research-detail-grid">
      <Frame spacing="sm" className="research-methods-frame">
        <FrameHeader><div><span className="research-eyebrow">Research coverage</span><h3>What has been reported</h3></div><span className="research-label">Saved records</span></FrameHeader>
        <FramePanel>
          {research.methods.length ? <ul className="research-method-ledger">{research.methods.map(method => <li key={method.method}>
            <div className="research-method-identity"><strong>{method.label}</strong><span>{method.planned ? 'In the recorded plan' : 'Additional saved method'}</span></div>
            <div className="research-method-outcome"><Badge tone={method.latestReport?.status ? tone(method.latestReport.status) : 'muted'}>{method.reports.length ? plural(method.reports.length, 'report') + ' saved' : 'No report saved'}</Badge>
              {method.latestReport?.status && <span>Author: {method.latestReport.status}</span>}
              {!!method.claimedCalls.length && <span>{plural(method.claimedCalls.length, 'linked call')}</span>}
            </div>
            {method.latestReport && <Button size="sm" variant="ghost" aria-label={'Inspect ' + method.label + ' report'} onClick={() => { void app.showFile(method.latestReport.file); }}>Inspect</Button>}
          </li>)}</ul> : <p className="research-empty-copy">The question is recorded. No method plan or source report is saved yet.</p>}
          <p className="research-context-note">A missing report does not show whether an agent is working. Report assessments belong to their authors.</p>
          {!!sourceLevelCalls && <p className="research-context-note">{plural(sourceLevelCalls, 'call')} recorded at source/tool level without a saved-method link.</p>}
        </FramePanel>
      </Frame>
      <Frame spacing="sm" className="research-next-frame">
        <FrameHeader><div><span className="research-eyebrow">Direction</span><h3>Questions to take back</h3></div></FrameHeader>
        <FramePanel>
          {!!item.reportDetails.length && <div className="research-assessment-picker" role="group" aria-label="Report assessment to inspect">{item.reportDetails.map((report: any) => <Button key={report.file} size="sm" variant={assessment?.file === report.file ? 'default' : 'ghost'} aria-pressed={assessment?.file === report.file} onClick={() => { void app.loadAssessment(report.file); }}>{app.catalog.fileLabel(report.file)}</Button>)}</div>}
          {assessment?.loading ? <p className="research-empty-copy" role="status">Reading the selected report’s assessment…</p>
            : assessment?.error ? <div className="research-local-error"><p>The assessment could not be read. Saved research remains available to inspect.</p><Button variant="ghost" size="sm" onClick={() => { void app.loadAssessment(assessment.file); }}>Retry assessment</Button></div>
            : card ? <>
              <p className="research-assessment-source">From {card.label} · {stamp(card.savedAt)}</p>
              {warnings.length > 0 ? <div className="research-local-error" role="status"><p>The assessment could not be fully projected.</p>{warnings.map(warning => <p key={warning}>{warning}</p>)}<Button variant="ghost" size="sm" onClick={() => { void app.showFile(assessment.file); }}>Inspect full report</Button></div> : card.kind === 'answer' ? <p className="research-empty-copy">The saved answer has no source-author assessment. Choose a source report to inspect its stated findings and follow-up targets.</p> : <>
              {!!findings.length && <div className="research-reported-finding"><span className="research-label">Reported finding</span><p>{findings[0]}</p></div>}
              {!!contradictions.length && <div className="research-reported-limit"><span className="research-label">Reported contradiction</span><p>{contradictions[0]}</p></div>}
              {followUps.length ? <div className="research-followups"><span className="research-label">Author’s follow-up targets</span><ul>{followUps.slice(0, 3).map(value => <li key={value}>{value}</li>)}</ul></div>
                : <p className="research-empty-copy">No follow-up targets are available in this view. The full report may contain additional context; this does not establish that the question is settled.</p>}
              {(findings.length > 1 || contradictions.length > 1 || followUps.length > 3) && <Disclosure title="More reported context"><ul className="research-context-list">{[...findings.slice(1), ...contradictions.slice(1), ...followUps.slice(3)].map((value, index) => <li key={index}>{value}</li>)}</ul></Disclosure>}
              </>}
            </> : <p className="research-empty-copy">Once a source report is saved, its stated findings and follow-up targets can appear here. Ask the conversation to choose the next useful step.</p>}
        </FramePanel>
        <FrameFooter><ResearchSteering host={host} item={item} library={app.snapshot.library} intent="gaps" triggerLabel="Review the next questions" /><span>Prepares an unsent instruction</span></FrameFooter>
      </Frame>
    </div>

    <Frame spacing="sm" className="research-records-frame">
      <FrameHeader><div><span className="research-eyebrow">Observation</span><h3>Recorded activity</h3></div><span className="research-label">{plural(research.callCount, 'call')} · {plural(research.reportCount, 'report')}</span></FrameHeader>
      <FramePanel><Timeline value={0} className="research-event-timeline">{research.activity.slice(0, 4).map((event, index) => <TimelineItem key={event.id} step={index + 1}><TimelineHeader><TimelineSeparator /><TimelineTitle>{event.label}</TimelineTitle><TimelineIndicator>{index + 1}</TimelineIndicator></TimelineHeader><TimelineContent><p>{stamp(event.at)}</p><p>{event.detail}</p></TimelineContent></TimelineItem>)}</Timeline>
        {research.activity.length > 4 && <Disclosure title={'Show all ' + research.activity.length + ' recorded events'}><ul className="research-event-list">{research.activity.map(event => <li key={event.id}><strong>{event.label}</strong><span>{stamp(event.at)}</span><p>{event.detail}</p></li>)}</ul></Disclosure>}
        {!!latestCalls.length && <div id="research-calls"><Disclosure title="Inspect retained calls" open={Boolean(app.callsOpen)} onOpenChange={value => app.update({ callsOpen: value })} keepMounted><div className="research-call-ledger">{latestCalls.map((call: any, index: number) => <div key={(call.session || '') + ':' + call.id + ':' + index}>
          <div><strong>{app.catalog.label(call.source)}</strong><span>{call.tool}</span><span>Started {stamp(call.at)}</span></div><Badge tone={tone(call.status)}>{CALL_OUTCOME_LABELS[call.status] || 'Unknown'}</Badge>
          {call.rawFile ? <Button variant="ghost" size="sm" data-key={'raw:' + call.rawFile} onClick={() => { void app.inspectRaw(call.rawFile); }}>Inspect original</Button> : <span className="research-label">Original not retained</span>}
        </div>)}</div><p className="research-context-note">These are recorded tool outcomes, including any accepted or pending provider operation. They do not certify an answer.</p></Disclosure></div>}
      </FramePanel>
      <FrameFooter><div><strong>Inspect the underlying records</strong><span>Full reports, the saved answer, and retained originals</span></div><Button id="inspect-records" variant={app.inspectionOpen ? 'ghost' : 'outline'} size="sm" onClick={recordsToggle}>{app.inspectionOpen ? 'Hide records' : 'Inspect records'}</Button></FrameFooter>
    </Frame>
  </div>;
}
