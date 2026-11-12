// The call pipeline for source tools, and the dig handle every provider call and research_save carries.
// A call is three separate steps, kept apart so the job store (a job around the provider request) and asking the
// person (before a paid call) are added here and nowhere else: gate() decides whether the call may run and sends
// nothing, run() sends the provider request and keeps the receipt, result() shapes what the model gets.
import { resolve } from 'node:path';
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server';
import { loadConfig } from '../config.mjs';
import { assertDig, frontMatter, listLibrary, projectFolder, readLibraryFile, recordCall } from '../library.mjs';
import { executeSource, type ToolOutcome } from '../providers/outcome.ts';
import { knownSecrets, redactRecord, redactText, redactValue } from '../providers/secrets.ts';
import { costSummary } from '../providers/library/cost.ts';
import type { ToolSpec } from '../providers/types.ts';
import { costAmounts, costShort, costTotal, plural } from '../ui/format.mjs';
import { createCallActivity } from '../call-activity.mjs';
import { actionSchemas, parseAction, type SourceTool } from './surface.ts';
import { spendGate, type Asker } from './ask.ts';
import { argsHash, inlineWaitMs, isSlow, jobResult, jobs, REUSE_MS, repeated, stillRunning, taskAnswer } from './jobs.ts';

type Config = Awaited<ReturnType<typeof loadConfig>>;
// The library is plain JavaScript whose inferred types are too loose or too narrow here; these say what it returns.
type Priced = Parameters<typeof costSummary>[0][number];
export type Receipt = Priced & { id: string; at: string; tool: string; source: string; status: string; dig?: string; raw?: string };
export interface LibraryItem { id: string; project: string; title: string; displayTitle: string; snippet: string; answer: string | null; startedAt: string | null; finishedAt: string | null; sources: string[]; calls: Receipt[]; reportDetails: { file: string; source: string | null; method: string | null; summary: string; at: string | null }[] }
export const listing = async (c: Config) => (await listLibrary(c)) as unknown as { items: LibraryItem[]; live: (Receipt & { projectFolder: string })[] };
const record = recordCall as unknown as (c: Config, project: string, dig: string, receipt: Record<string, unknown>) => Promise<Receipt>;
/** Executing provider calls, in this process only: what `dig status` reports as running and the views will show. */
export const activity = createCallActivity();

// ---- Handles ----------------------------------------------------------------------------------------------------
/** The refusal for a call without a valid handle: one sentence telling the model to call dig_start. */
export const NO_DIG = 'This call needs the dig handle that dig_start returns: call dig_start with the absolute project directory and the question, then pass its dig.';
export class Refusal extends Error {}
/** A dig's handle: `<project folder>/<dig id>`, as the library names them. Opaque to the model. */
export const handleOf = (project: string, dig: string) => `${projectFolder(project)}/${dig}`;
export interface Dig { handle: string; project: string; dig: string; folder: string; path: string }
/**
 * Resolves a handle to its project and dig folder, from the dig's own dig.md: the project it names must hash to the
 * handle's project folder. Anything else, malformed or unknown, is refused with NO_DIG.
 */
export async function resolveHandle(c: Config, handle: unknown): Promise<Dig> {
  const match = typeof handle === 'string' ? /^([a-z0-9][a-z0-9-]{0,80})\/([a-zA-Z0-9_][a-zA-Z0-9._-]{0,180})$/.exec(handle) : null;
  if (!match) throw new Refusal(NO_DIG);
  const [, folder, dig] = match;
  try {
    const meta = (frontMatter as (text: string) => Record<string, unknown>)((await readLibraryFile(c, `${folder}/digs/${dig}/dig.md`, 0, Number.MAX_SAFE_INTEGER)).text);
    const project = typeof meta.project === 'string' ? meta.project : '';
    if (projectFolder(project) !== folder) throw new Error('project folder mismatch');
    const path = await assertDig(c, project, dig);
    return { handle: `${folder}/${dig}`, project: resolve(project), dig, folder, path };
  } catch { throw new Refusal(NO_DIG); }
}

// ---- Results ----------------------------------------------------------------------------------------------------
/** A dig:// resource URI for a library-relative file, read back through readLibraryFile. */
export const libraryUri = (file: string) => `dig://library/${encodeURIComponent(file)}`;
export const refused = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });
// The receipts the library attributes to one dig, or null when the dig is not listed.
const digCalls = async (c: Config, project: string, dig: string) => (await listing(c)).items.find(item => item.id === dig && item.project === resolve(project))?.calls ?? null;

/** A call that passed the gate: everything run() needs, nothing sent yet. */
export interface Prepared { c: Config; tool: SourceTool; action: string; spec: ToolSpec; args: Record<string, unknown>; dig: Dig }
type Gate = { ok: true; call: Prepared } | { ok: false; result: CallToolResult | InputRequiredResult };

/**
 * The checks before a call, in this order: the source is enabled, the handle names a dig, the args fit the action,
 * then for a paid call the spending questions (ask.ts: the dig's ceiling, then [spend] ask_above_usd). Free actions,
 * and calls a metered tool makes at no charge (a sandbox request, a stored answer read back), are never asked about
 * or refused. Sends nothing; on 2026-07-28 a question is returned as an input_required result and the call comes
 * back with the answer.
 */
export async function gate(tool: SourceTool, input: Record<string, unknown>, asker?: Asker): Promise<Gate> {
  const c = await loadConfig();
  if (!c.sources.enabled.includes(tool.module.id)) return { ok: false, result: refused(`${tool.module.label} is disabled in Dig settings.`) };
  let dig: Dig;
  try { dig = await resolveHandle(c, input.dig); } catch (e) { return { ok: false, result: refused(e instanceof Refusal ? e.message : NO_DIG) }; }
  const parsed = parseAction(tool, input.action, input.args);
  if (!parsed.ok) return { ok: false, result: refused(parsed.error) };
  const action = input.action as string; const { spec, args } = parsed;
  let unpaid = spec.billing === 'free';
  const billing = spec.billing;
  if (!unpaid && billing && billing !== 'free') try { unpaid = billing.noCharge?.(args) === true; } catch {}
  const call: Prepared = { c, tool, action, spec, args, dig };
  // A repeat that an existing job answers sends nothing, so nobody is asked about it and no ceiling refuses it.
  if (!unpaid && !(await answeredByJob(call, input.fresh === true))) { const stop = await spendGate(call, asker); if (stop) return { ok: false, result: stop }; }
  return { ok: true, call };
}
/** Whether the run step will answer this call from a job that exists: one still running, or one finished within REUSE_MS unless `fresh`. */
async function answeredByJob(call: Prepared, fresh: boolean): Promise<boolean> {
  const job = (await jobs()).find(call.dig.handle, call.action, argsHash(call.args));
  return !!job && (job.status === 'working' || (!fresh && job.status !== 'cancelled' && Date.now() - Date.parse(job.finishedAt ?? job.lastUpdatedAt) <= REUSE_MS));
}

/** What one provider call produced: the redacted outcome, its receipt (or why none was kept), and the dig's running cost. */
export interface Ran { outcome: ToolOutcome; images: { data: string; mimeType: string }[]; call: { id: string; raw?: string } | null; retentionError: string | null; digCost: { calls: number; byUnit: Record<string, number>; unknownCalls: number; freeCalls: number } | null }
const NEVER_ABORT = new AbortController().signal;
/** Sends the provider request once, keeps the receipt (and the original response as settings say), and reads the dig's cost. */
export async function run({ c, tool, action, spec, args, dig }: Prepared, signal: AbortSignal = NEVER_ABORT): Promise<Ran> {
  return activity.run({ library: c.library, project: dig.project, dig: dig.dig, session: dig.dig, source: tool.module.id, tool: action }, async () => {
    const at = new Date().toISOString(); const begin = Date.now(); const responses: { label: string; status: number | string; body: unknown; headers?: unknown }[] = [];
    // Pictures are taken off the outcome here, so they never pass through redaction, the receipt or the retained
    // original, and go only to the model at the end; a tool without returnsImages never returns any.
    const { images, ...raw } = await executeSource(spec, args, { directory: dig.project, worktree: dig.project, sessionID: dig.dig, abort: signal, keep: (label, status, body, headers) => { responses.push({ label, status, body, ...(headers ? { headers } : {}) }); } });
    const secrets = knownSecrets(); const outcome = redactValue(raw, secrets) as ToolOutcome; const details = outcome.details ?? {};
    const failed = ['failed', 'cancelled'].includes(outcome.status);
    let call: Ran['call'] = null; let retentionError: string | null = null;
    // A receipt is filed under sessions/<dig id> and names its dig, which the library reader treats as decisive.
    try {
      call = await record(c, dig.project, dig.dig, { tool: action, source: tool.module.id, args: redactRecord(args, secrets), declared: Object.keys((actionSchemas[action].properties as object | undefined) ?? {}), at, ms: Date.now() - begin, status: outcome.status, cost: details.cost, ...(details.knownCost ? { knownCost: details.knownCost } : {}), responses: redactValue(responses, secrets), ...(failed ? { error: outcome.text.split('\n', 1)[0].slice(0, 300) } : {}), session: dig.dig });
    } catch (error) { retentionError = redactText(`Evidence receipt not saved: ${error instanceof Error ? error.message : String(error)}`, secrets); }
    // The dig's running cost, from every receipt the library attributes to it. Reading it never fails the call.
    let digCost: Ran['digCost'] = null;
    try { const calls = await digCalls(c, dig.project, dig.dig); if (calls) digCost = { calls: calls.length, ...costSummary(calls) }; } catch {}
    return { outcome, images: failed ? [] : images ?? [], call, retentionError, digCost };
  });
}

/**
 * The model's result, content only: one text block (a first line with the source, action, status, receipt, the
 * call's cost and the dig's running cost, then the tool's text), links to the dig's receipts and the call's retained
 * original, then any pictures. No structuredContent, so every host hands the model the same thing.
 */
export function result({ tool, action, dig }: Prepared, { outcome, images, call, retentionError, digCost }: Ran): CallToolResult {
  const details = outcome.details ?? {};
  const cost = costShort(costSummary([{ cost: details.cost, ...(details.knownCost ? { knownCost: details.knownCost } : {}) } as Parameters<typeof costSummary>[0][number]]), 1);
  const sofar = digCost ? costTotal(digCost, digCost.calls) : null;
  const head = [tool.module.label, action, outcome.status, call ? `receipt ${call.id}` : retentionError ?? 'no receipt saved', `cost: ${cost}`, ...(sofar ? [`dig so far: ${sofar}`] : [])].join(' · ');
  const sessions = `${dig.folder}/sessions/${dig.dig}`;
  const links = call ? [
    { type: 'resource_link' as const, uri: libraryUri(`${sessions}/calls.jsonl`), name: 'calls.jsonl', title: `Receipts of dig ${dig.dig}`, description: `This call's receipt is ${call.id}.`, mimeType: 'application/jsonl' },
    ...(call.raw ? [{ type: 'resource_link' as const, uri: libraryUri(`${sessions}/${call.raw}`), name: call.raw.split('/').at(-1) ?? call.raw, title: `Original response of ${call.id}`, mimeType: 'application/json' }] : []),
  ] : [];
  const failed = ['failed', 'cancelled'].includes(outcome.status);
  return { content: [{ type: 'text', text: `${head}.\n\n${outcome.text}${detailsText(details)}` }, ...links, ...images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType }))], ...(failed ? { isError: true } : {}) };
}
const DETAILS_LIMIT = 20_000;
/**
 * What an action returned beside its text (a structured answer, ids, counts, a cursor), as JSON after the text: a
 * content-only result has no structured part, and the model must not lose what a structured one carried. The cost is
 * on the first line, so it is left out here. Cut at DETAILS_LIMIT; the retained original holds the response.
 */
function detailsText(details: Record<string, unknown>): string {
  const { cost: _cost, knownCost: _known, ...rest } = details;
  if (!Object.keys(rest).length) return '';
  let json: string; try { json = JSON.stringify(rest, null, 1); } catch { return ''; }
  return `\n\nDetails:\n${json.length > DETAILS_LIMIT ? `${json.slice(0, DETAILS_LIMIT)}\n… cut at ${DETAILS_LIMIT.toLocaleString('en-US')} of ${json.length.toLocaleString('en-US')} characters; the retained original holds the response.` : json}`;
}

/** How this request may be answered: `tasks` when it declared the Tasks extension, so a slow job may answer with a task. */
export interface Answering { tasks?: boolean }
/** One source-tool call: gate, then the run step, whose result is the model's. */
export async function callSource(tool: SourceTool, input: Record<string, unknown>, signal?: AbortSignal, answering: Answering = {}, asker?: Asker): Promise<CallToolResult | InputRequiredResult> {
  const checked = await gate(tool, input, asker);
  if (!checked.ok) return checked.result;
  return runStep(checked.call, input.fresh === true, signal, answering);
}

// A call that can be charged: a metered action, unless this call is one it makes at no charge.
const paid = ({ spec, args }: Prepared) => { const billing = spec.billing; if (billing === 'free') return false; try { return billing?.noCharge?.(args) !== true; } catch { return true; } };
/**
 * The run step, from the moment a call is allowed until its result exists. A free, fast action runs as before, tied
 * to its request. A metered or slow action runs as a job that the service owns, not the request, so a dropped
 * connection neither stops it nor sends it twice (it is stopped with job cancel or tasks/cancel). The same dig,
 * action and arguments as a running job attaches to it; as a job finished within REUSE_MS, gets that job's result
 * again unless `fresh` (a cancelled job is not reused); otherwise a new job is written and then sent. A slow job
 * answers a request that declared the Tasks extension with a task at once, and any other after inlineWaitMs with its
 * handle; a paid, fast job is waited for.
 */
async function runStep(call: Prepared, fresh: boolean, signal: AbortSignal | undefined, { tasks = false }: Answering): Promise<CallToolResult> {
  const slow = isSlow(call.action);
  if (!slow && !paid(call)) return result(call, await run(call, signal));
  const store = await jobs();
  let job = store.find(call.dig.handle, call.action, argsHash(call.args));
  if (job && job.status !== 'working') {
    if (!fresh && job.status !== 'cancelled' && Date.now() - Date.parse(job.finishedAt ?? job.lastUpdatedAt) <= REUSE_MS) return repeated(job);
    job = undefined;
  }
  job ??= await store.start({ dig: call.dig.handle, project: call.dig.project, source: call.tool.module.id, tool: call.action, args: call.args, redacted: redactRecord(call.args, knownSecrets()), declared: Object.keys((actionSchemas[call.action].properties as object | undefined) ?? {}) }, async jobSignal => {
    const ran = await run(call, jobSignal); const details = ran.outcome.details ?? {};
    return { result: result(call, ran), status: ran.outcome.status === 'cancelled' ? 'cancelled' : 'completed', receipt: ran.call?.id ?? null, cost: details.cost, ...(details.knownCost ? { knownCost: details.knownCost } : {}) };
  });
  if (slow && tasks) return taskAnswer(job);
  const settled = await store.wait(job.id, slow ? inlineWaitMs() : Infinity);
  if (!settled) return refused(`Dig could not keep a job for this ${call.action} call. No request was sent.`);
  return settled.status === 'working' ? stillRunning(settled) : jobResult(settled);
}
