import { costSummary } from '../../providers/library/cost.ts';

const array = (value: any): any[] => Array.isArray(value) ? value : [];
const names = (values: any[]): string[] => [...new Set(values.filter(value => typeof value === 'string' && value))];
const time = (value: any) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const methodLabel = (catalog: any, name: string) => catalog?.methodLabel?.(name) || name.replaceAll('-', ' ');
const sourceLabel = (catalog: any, name: string) => catalog?.label?.(name) || name;

export const CALL_OUTCOME_LABELS: Record<string, string> = {
  success: 'Succeeded', partial: 'Partial', empty: 'Empty', failed: 'Failed', cancelled: 'Stopped', skipped: 'Skipped',
};

/** A saved document state, never a worker/execution state. */
export function savedStateLabel(item: any): string {
  if (item?.answer) return ({ answered: 'Answer saved', 'partly answered': 'Answer has gaps', 'not answered': 'Question not answered' } as Record<string, string>)[item.status] || 'Answer saved';
  return array(item?.reports).length ? 'Source reports saved' : 'Question recorded';
}

/** Planned methods are intent. Only report.claimedBy establishes method-level call ownership. */
export function projectMethodCoverage(item: any, catalog?: any) {
  const reports = array(item?.reportDetails);
  const planned = names(array(item?.planned));
  const methods = names([...planned, ...array(item?.methods), ...reports.map(report => report.method)]);
  return methods.map(method => {
    const ownReports = reports.filter(report => report.method === method);
    const files = new Set(ownReports.map(report => report.file));
    return {
      method, label: methodLabel(catalog, method), planned: planned.includes(method), reports: ownReports,
      claimedCalls: array(item?.calls).filter(call => files.has(call.claimedBy)),
      reportState: ownReports.length ? 'report-saved' as const : 'no-report-saved' as const,
      latestReport: [...ownReports].sort((a, b) => time(b.at) - time(a.at))[0] ?? null,
    };
  });
}

/** Recorded timestamps retain their event grain. call.at is its start, not a heartbeat or completion time. */
export function projectRecordedActivity(item: any, catalog?: any) {
  const events: any[] = [];
  if (item?.startedAt) events.push({ id: 'question', kind: 'dig-started', at: item.startedAt, fileOrCallId: null, label: 'Question recorded', detail: 'Research scope saved in Dig.' });
  for (const report of array(item?.reportDetails)) events.push({
    id: 'report:' + report.file, kind: 'report-saved', at: report.at, fileOrCallId: report.file,
    label: methodLabel(catalog, report.method || report.source) + ' report saved',
    detail: report.status ? 'Author assessment: ' + report.status : 'No author assessment available.', report,
  });
  for (const call of array(item?.calls)) events.push({
    id: 'call:' + (call.session || '') + ':' + call.id, kind: 'recorded-call', at: call.at, fileOrCallId: call.id,
    label: sourceLabel(catalog, call.source) + ' · ' + (CALL_OUTCOME_LABELS[call.status] || 'Unknown outcome'),
    detail: call.tool + ' · recorded call start' + (Number.isFinite(call.ms) ? ' · ' + call.ms.toLocaleString() + ' ms elapsed' : ''), call,
  });
  if (item?.answer && item?.finishedAt) events.push({ id: 'answer:' + item.answer, kind: 'answer-saved', at: item.finishedAt, fileOrCallId: item.answer, label: savedStateLabel(item), detail: 'Saved answer outcome: ' + (item.status || 'unknown') });
  return events.sort((a, b) => time(b.at) - time(a.at) || a.id.localeCompare(b.id));
}

/** View-only projection over existing records. No new lifecycle, score or truth judgment is created. */
export function projectResearch(item: any, catalog?: any) {
  const calls = array(item?.calls);
  const methods = projectMethodCoverage(item, catalog);
  const callOutcomes: Record<string, number> = { success: 0, partial: 0, empty: 0, failed: 0, cancelled: 0, skipped: 0, unknown: 0 };
  for (const call of calls) callOutcomes[Object.hasOwn(callOutcomes, call.status) ? call.status : 'unknown']++;
  const signals: string[] = [];
  if (item?.answer && item.status === 'partly answered') signals.push('The saved answer reports gaps.');
  if (item?.answer && item.status === 'not answered') signals.push('The saved answer says the question was not answered.');
  for (const method of methods) {
    if (['partial', 'failed'].includes(method.latestReport?.status)) signals.push(method.label + ': latest report marked ' + method.latestReport.status + ' by its author.');
  }
  if (callOutcomes.failed) signals.push(callOutcomes.failed + ' recorded call' + (callOutcomes.failed === 1 ? '' : 's') + ' failed; later research may have recovered.');
  const activity = projectRecordedActivity(item, catalog);
  return {
    question: item?.title || 'Untitled research', displayTitle: item?.displayTitle || item?.title || 'Untitled research',
    savedState: savedStateLabel(item), hasAnswer: Boolean(item?.answer), reportCount: array(item?.reports).length,
    sourcesWithReports: names(array(item?.reportDetails).map(report => report.source).concat(array(item?.sources))),
    sourcesAndToolsCalled: names(calls.map(call => call.source)),
    plannedMethodCount: methods.filter(method => method.planned).length,
    plannedMethodsWithReports: methods.filter(method => method.planned && method.reports.length).length,
    reportedMethodCount: methods.filter(method => method.reports.length).length,
    methods, callOutcomes, callCount: calls.length, cost: costSummary(calls),
    retainedOriginalCount: names(calls.map(call => call.rawFile)).length,
    latestActivity: activity[0] ?? null, activity, reviewSignals: signals,
  };
}

/** snapshot.live means unassigned retained receipts. Other conversations never enter these totals. */
export function projectConversation(snapshot: any, thread: string | null | undefined) {
  const identified = typeof thread === 'string' && Boolean(thread);
  const digs = identified ? array(snapshot?.items).filter(item => item.session === thread) : [];
  const ownUnassignedCalls = identified ? array(snapshot?.live).filter(call => call.session === thread) : [];
  const otherUnassignedCalls = array(snapshot?.live).filter(call => !identified || call.session !== thread);
  const calls = [...digs.flatMap(item => array(item.calls)), ...ownUnassignedCalls];
  return { identified, digs, calls, ownUnassignedCalls, otherUnassignedCalls, otherUnassignedCallCount: otherUnassignedCalls.length, cost: costSummary(calls) };
}

export function canonicalResearchFile(library: string, file?: string | null): string | null {
  if (!file) return null;
  return file.startsWith('/') ? file : library.replace(/\/+$/, '') + '/' + file;
}

export type SteeringIntent = 'continue' | 'gaps' | 'refresh' | 'refocus';
export const STEERING_LABELS: Record<SteeringIntent, string> = {
  continue: 'Choose the next step', gaps: 'Review gaps', refresh: 'Refresh the evidence', refocus: 'Refocus the question',
};
export function steeringPrompt(item: any, library: string, intent: SteeringIntent = 'continue') {
  const instruction = {
    continue: 'Review the current research and recommend the next useful step. Explain whether the retained evidence is sufficient for an answer or which focused question remains.',
    gaps: 'Review the reported limitations, contradictions and methods without a saved report. Separate what is known from what still needs checking, and propose focused next steps.',
    refresh: 'Review the saved dates and identify what would benefit from fresh evidence. Keep useful retained work, explain the fresh retrieval scope, and stay within the authorized sources and spending scope.',
    refocus: 'Help me narrow or redirect this question. Briefly explain the current research coverage and useful directions for the next step.',
  }[intent];
  const files = names([item?.answer, ...array(item?.reports).slice(-4)]).map(file => canonicalResearchFile(library, file));
  return [
    instruction, '', 'Recorded question: ' + (item?.title || 'Untitled research'),
    'Project: ' + (item?.project || 'unknown'), 'Dig: ' + (item?.id || 'unknown'),
    files.length ? 'Saved references to start from:\n' + files.map(file => '- ' + file).join('\n') : 'No source report or answer is saved yet.',
    '', 'Use Dig to inspect the saved research and read the relevant reports and originals before relying on them. A missing report does not establish whether a worker is running. Reuse existing evidence before making new provider calls.',
  ].join('\n');
}
