// Asking the person, through the SDK's input-request support. On 2026-07-28 a tool call answers `input_required`
// with the question and the client calls again carrying the answer (and the requestState it was given); on a
// 2025-era session the service sends `elicitation/create` and waits, never longer than DIG_ASK_TIMEOUT_MS. Used by
// the gate before a paid call (the spending questions) and by the keys tool, whose page on this service takes
// credentials the person types, so a value never passes through the client or the model.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CLIENT_CAPABILITIES_META_KEY, SdkError, SdkErrorCode, createRequestStateCodec, inputRequired, inputResponse, type CallToolResult, type ClientCapabilities, type InputRequiredResult, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { loadConfig, stateDirectory } from '../config.mjs';
import { credentialNames, saveKeys } from '../catalog.mjs';
import { MODULES, type DigModule } from '../providers/modules.ts';
import { costSummary } from '../providers/library/cost.ts';
import { toolHistory } from '../ui/usage.mjs';
import { costAmounts, plural } from '../ui/format.mjs';
import { listing, readDigCalls, type Dig, type Prepared } from './calls.ts';

type Config = Awaited<ReturnType<typeof loadConfig>>;
const refused = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
/** How long the service waits for an answer it asked for on a 2025-era session, or for the key page to be sent. */
export const askTimeoutMs = () => { const ms = Number(process.env.DIG_ASK_TIMEOUT_MS); return Number.isFinite(ms) && ms > 0 ? ms : 5 * 60_000; };
/** How long a key page's code is valid. */
export const keyCodeMs = () => { const ms = Number(process.env.DIG_KEYS_TTL_MS); return Number.isFinite(ms) && ms > 0 ? ms : 10 * 60_000; };
const HISTORY_DAYS = 90;

// ---- Asking -----------------------------------------------------------------------------------------------------
/** What a tool handler needs to ask: its era, its context, and what the client declared it can do. */
export interface Asker { era: 'modern' | 'legacy'; ctx: ServerContext; capabilities: ClientCapabilities | undefined }
/** The request's own declaration on 2026-07-28; the handshake's on a 2025-era session. */
export const askerOf = (era: 'modern' | 'legacy', server: McpServer, ctx: ServerContext): Asker => ({
  era, ctx, capabilities: (era === 'modern' ? (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined : undefined) ?? server.server.getClientCapabilities(),
});
/** The person's answer, or why there is none. `unavailable`: the client declared no elicitation, or not this mode. */
export type Answer = { kind: 'answered'; choice: string; targetRaised?: number } | { kind: 'declined' } | { kind: 'cancelled' } | { kind: 'unanswered' } | { kind: 'unavailable' };
/** On 2026-07-28 the first round has no answer yet: the handler returns `result` and the client calls again. */
export type Asked = Answer | { kind: 'pending'; result: InputRequiredResult };
export interface Choice { value: string; title: string }
/** `key` names the question in the request; `bind` ties an answer to the call it was asked about. */
export interface FormQuestion { key: string; bind: string; title: string; message: string; choices: Choice[]; targetRaised?: number }
export interface UrlQuestion { key: string; bind: string; message: string; url: string }

// An empty elicitation declaration means form mode only (the spec's rule for older clients).
const modes = (capabilities: ClientCapabilities | undefined) => {
  const declared = capabilities?.elicitation as { form?: unknown; url?: unknown } | undefined;
  if (!declared) return { form: false, url: false };
  return { form: declared.form !== undefined || declared.url === undefined, url: declared.url !== undefined };
};
// requestState round-trips through the client, so it is sealed (HMAC) with a key that lives as long as this process;
// a retry after a restart is simply asked again. Each state is used once.
interface State { key: string; bind: string; nonce: string; targetRaised?: number }
const codec = createRequestStateCodec<State>({ key: randomBytes(32), ttlSeconds: 3600 });
const usedStates = new Map<string, number>();
const pendingStates = new Map<string, number>();
let activeWaits = 0;
const consume = (nonce: string) => { const now = Date.now(); for (const [id, at] of usedStates) if (now - at > 3_600_000) usedStates.delete(id); pendingStates.delete(nonce); if (usedStates.has(nonce)) return false; usedStates.set(nonce, now); return true; };
/** The verified requestState a retried 2026-07-28 call carries for this question, or null. */
async function priorState(asker: Asker, key: string): Promise<State | null> {
  if (asker.era !== 'modern') return null;
  const state = asker.ctx.mcpReq.requestState();
  if (typeof state !== 'string') return null;
  try {
    const payload = await codec.verify(state, asker.ctx);
    const validTarget = payload?.targetRaised === undefined || (typeof payload.targetRaised === 'number' && Number.isFinite(payload.targetRaised) && payload.targetRaised >= 0);
    return payload?.key === key && typeof payload.bind === 'string' && typeof payload.nonce === 'string' && validTarget ? payload : null;
  } catch { return null; }
}
const formSchema = (q: FormQuestion) => ({ type: 'object' as const, properties: { choice: { type: 'string' as const, title: q.title, oneOf: q.choices.map(c => ({ const: c.value, title: c.title })) } }, required: ['choice'] });

async function ask(asker: Asker, q: ({ mode: 'form' } & FormQuestion) | ({ mode: 'url' } & UrlQuestion)): Promise<Asked> {
  if (!modes(asker.capabilities)[q.mode]) return { kind: 'unavailable' };
  const read = (action: string, content: Record<string, unknown> | undefined): Answer | null => {
    if (action === 'decline') return { kind: 'declined' };
    if (action === 'cancel') return { kind: 'cancelled' };
    if (q.mode === 'url') return { kind: 'answered', choice: 'accept' };
    const choice = content?.choice; return typeof choice === 'string' && q.choices.some(c => c.value === choice) ? { kind: 'answered', choice } : null;
  };
  if (asker.era === 'legacy') {
    // A server request on the session; a client that never answers is given up on at the timeout.
    const params = q.mode === 'form' ? { mode: 'form' as const, message: q.message, requestedSchema: formSchema(q) } : { mode: 'url' as const, message: q.message, url: q.url, elicitationId: randomUUID() };
    activeWaits++;
    try {
      const answer = await asker.ctx.mcpReq.elicitInput(params, { timeout: askTimeoutMs(), signal: asker.ctx.mcpReq.signal, relatedRequestId: asker.ctx.mcpReq.id } as Parameters<ServerContext['mcpReq']['elicitInput']>[1]);
      return read(answer.action, answer.content) ?? { kind: 'cancelled' };
    } catch (error) {
      if (asker.ctx.mcpReq.signal.aborted) throw error;
      return error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout ? { kind: 'unanswered' } : { kind: 'unavailable' };
    } finally { activeWaits--; }
  }
  const prior = await priorState(asker, q.key);
  if (prior && prior.bind === q.bind) {
    const view = inputResponse(asker.ctx.mcpReq.inputResponses, q.key);
    const answer = view.kind === 'elicit' ? read(view.action, view.content) : null;
    if (answer && consume(prior.nonce)) return answer.kind === 'answered' && prior.targetRaised !== undefined ? { ...answer, targetRaised: prior.targetRaised } : answer;
  }
  const request = q.mode === 'form' ? inputRequired.elicit({ mode: 'form', message: q.message, requestedSchema: formSchema(q) }) : inputRequired.elicitUrl({ message: q.message, url: q.url });
  const minted: State = { key: q.key, bind: q.bind, nonce: randomUUID(), ...(q.mode === 'form' && q.targetRaised !== undefined ? { targetRaised: q.targetRaised } : {}) };
  pendingStates.set(minted.nonce, Date.now() + askTimeoutMs());
  return { kind: 'pending', result: inputRequired({ inputRequests: { [q.key]: request }, requestState: await codec.mint(minted) }) };
}
/** Asks a question with a small form: a title, a message, and one choice among `choices`. */
export const askForm = (asker: Asker, q: FormQuestion) => ask(asker, { mode: 'form', ...q });
/** Asks the client to open `url` for the person. An answer means only that the person agreed to open it. */
export const askUrl = (asker: Asker, q: UrlQuestion) => ask(asker, { mode: 'url', ...q });

// ---- What the person answered for a dig ----------------------------------------------------------------------------
/** Kept beside the jobs, one small file per dig, never in config.toml: how far the ceiling was raised, and "don't ask again". */
export interface DigAnswers { dig: string; raisedUsd: number; dontAsk: boolean; updatedAt: string | null }
const answersPath = (dig: Dig) => join(stateDirectory(), 'jobs', 'digs', dig.folder, `${dig.dig}.json`);
export async function digAnswers(dig: Dig): Promise<DigAnswers> {
  try {
    const value = JSON.parse(await readFile(answersPath(dig), 'utf8')) as Partial<DigAnswers>;
    return { dig: dig.handle, raisedUsd: typeof value.raisedUsd === 'number' && Number.isFinite(value.raisedUsd) && value.raisedUsd > 0 ? value.raisedUsd : 0, dontAsk: value.dontAsk === true, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null };
  } catch { return { dig: dig.handle, raisedUsd: 0, dontAsk: false, updatedAt: null }; }
}
// Per-dig read-modify-write serialization for remembered answers; never held across askForm/askUrl.
const rememberQueues = new Map<string, Promise<unknown>>();
function queueRemember<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = rememberQueues.get(key) ?? Promise.resolve();
  const next = prior.then(work);
  const settled = next.catch(() => {});
  rememberQueues.set(key, settled);
  settled.finally(() => { if (rememberQueues.get(key) === settled) rememberQueues.delete(key); });
  return next;
}
function remember(dig: Dig, change: (current: DigAnswers) => Partial<DigAnswers>): Promise<{ previous: DigAnswers; next: DigAnswers }> {
  const path = answersPath(dig);
  return queueRemember(resolve(path), async () => {
    const previous = await digAnswers(dig); const next = { ...previous, ...change(previous), updatedAt: new Date().toISOString() };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path);
    return { previous, next };
  });
}

// ---- Spending ---------------------------------------------------------------------------------------------------
const usd = (amount: number) => costAmounts({ byUnit: { USD: amount } })[0];
const why = (answer: Answer, question: string) => answer.kind === 'declined' ? `The person declined the question ${question}.` : answer.kind === 'cancelled' ? `The person dismissed the question ${question} without answering.` : answer.kind === 'unanswered' ? `The question ${question} went unanswered for ${plural(Math.round(askTimeoutMs() / 60_000) || 1, 'minute')}.` : '';
/** Today's refusal at the ceiling, with what the person answered (if anything) first. */
const ceilingRefusal = (spent: number, limit: number, raised: number, others: string[], unknownCalls: number, reason = '') => refused(`${reason ? `${reason} ` : ''}This dig has reached its spending ceiling: its calls have recorded ${usd(spent)} in provider-reported US-dollar costs, and the ceiling is $${limit}${raised ? ` (raised by $${raised} for this dig)` : ''}.${others.length ? ` What its calls recorded in other units (${others.join(', ')}) is not part of that total.` : ''}${unknownCalls ? ` ${plural(unknownCalls, 'call')} in this dig ${unknownCalls === 1 ? 'has' : 'have'} an unknown cost that this total does not include.` : ''} No request was sent. The user can raise or remove the ceiling in Dig’s settings (dig_ceiling_usd under [spend] in config.toml). Tell the user; do not work around it by changing the setting yourself or using another tool for the same request.`);

/**
 * The spending step of the gate, for a paid call (the caller has already let free actions and no-charge calls through):
 * at the dig's ceiling ([spend] dig_ceiling_usd, plus what the person raised it by for this dig) the person is asked
 * whether to raise it or stop; else, when [spend] ask_above_usd is set and the action's typical US-dollar cost in this
 * library is at or above it, or the action has no priced call here yet, whether to send this call. Returns null when
 * the call may go ahead, the question to return on 2026-07-28, or the refusal. Sends nothing.
 */
export async function spendGate({ c, tool, action, args, dig }: Prepared, asker: Asker | undefined): Promise<CallToolResult | InputRequiredResult | null> {
  const ceiling = c.spend.dig_ceiling_usd as number | null; const askAbove = (c.spend as { ask_above_usd?: number | null }).ask_above_usd ?? null;
  if (ceiling === null && askAbove === null) return null;
  const answers = await digAnswers(dig);
  const subject = `${tool.module.label}’s ${action} action`;
  const bind = hash([dig.handle, tool.name, action, args]);
  const unavailable: Answer = { kind: 'unavailable' };
  if (ceiling !== null) {
    // Only US-dollar amounts count, including the known part of an incompletely priced call; credits, read counts and
    // unknown costs are named, never added. So the call that crosses the ceiling completes and the next paid call stops.
    const { byUnit, unknownCalls } = costSummary((await readDigCalls(c, dig)) ?? []);
    const spent = byUnit.USD ?? 0; const limit = ceiling + answers.raisedUsd;
    const { USD: _usd, ...otherUnits } = byUnit; const others = costAmounts({ byUnit: otherUnits });
    if (spent >= limit) {
      const targetRaised = answers.raisedUsd + ceiling;
      const message = `This dig has reached its spending ceiling: its calls have recorded ${usd(spent)} in provider-reported US-dollar costs, and the ceiling is $${limit}${answers.raisedUsd ? ` (raised by $${answers.raisedUsd} for this dig)` : ''}.${others.length ? ` Its calls also recorded ${others.join(', ')}, which ${others.length === 1 ? 'is' : 'are'} not part of that total.` : ''}${unknownCalls ? ` ${plural(unknownCalls, 'call')} in this dig ${unknownCalls === 1 ? 'has' : 'have'} an unknown cost, not included.` : ''} The next call is ${subject}, a paid request. Raise the ceiling for this dig, or stop its paid calls here?`;
      const answer = asker ? await askForm(asker, { key: 'ceiling', bind, title: 'Dig: spending ceiling reached', message, choices: [{ value: 'raise', title: `Raise the ceiling for this dig by $${ceiling}` }, { value: 'stop', title: 'Stop here' }], targetRaised }) : unavailable;
      if (answer.kind === 'pending') return answer.result;
      if (answer.kind === 'answered' && answer.choice === 'raise') {
        const raised = answer.targetRaised ?? targetRaised;
        const { previous, next } = await remember(dig, current => ({ raisedUsd: Math.max(current.raisedUsd, raised) }));
        if (previous.raisedUsd >= raised) {
          // A stale raise whose target was already applied: re-check current spend against the active limit.
          const latest = costSummary((await readDigCalls(c, dig)) ?? []);
          const freshSpent = latest.byUnit.USD ?? 0;
          const activeLimit = ceiling + next.raisedUsd;
          if (freshSpent >= activeLimit) {
            const { USD: _latestUsd, ...latestOthers } = latest.byUnit;
            return ceilingRefusal(freshSpent, activeLimit, next.raisedUsd, costAmounts({ byUnit: latestOthers }), latest.unknownCalls, 'This ceiling raise was already applied and spend has reached the current limit.');
          }
        }
        return null;
      }
      const reason = answer.kind === 'answered' ? 'The person chose to stop here when asked whether to raise this dig’s spending ceiling.' : why(answer, 'whether to raise this dig’s spending ceiling');
      return ceilingRefusal(spent, limit, answers.raisedUsd, others, unknownCalls, reason);
    }
  }
  if (askAbove !== null && !answers.dontAsk) {
    const library = await listing(c);
    const row = toolHistory([...library.items.flatMap(item => item.calls), ...library.live], { days: HISTORY_DAYS }).find((entry: { tool: string }) => entry.tool === action) as { typicalCost: { amount: number; unit: string }[] | null; pricedCalls: number } | undefined;
    // The median US-dollar cost of the action's priced calls; null when this library has none.
    const typical = !row || row.typicalCost === null ? null : row.typicalCost.find(entry => entry.unit === 'USD')?.amount ?? 0;
    if (typical === null || typical >= askAbove) {
      const cost = typical === null ? 'This library has no priced call of it yet, so what it will cost is unknown.' : `Its calls in this library have typically cost ${usd(typical)} each (the median of ${plural(row!.pricedCalls, 'priced call')} in the last ${HISTORY_DAYS} days), at or above the $${askAbove} from which Dig asks first.`;
      const answer = asker ? await askForm(asker, { key: 'spend', bind, title: 'Dig: send a paid call?', message: `Dig is about to send a paid request: ${subject}. ${cost}`, choices: [{ value: 'send', title: 'Send it' }, { value: 'send-dig', title: 'Send it, and don’t ask again for this dig' }, { value: 'stop', title: 'Don’t send it' }] }) : unavailable;
      if (answer.kind === 'pending') return answer.result;
      if (answer.kind === 'answered' && answer.choice === 'send') return null;
      if (answer.kind === 'answered' && answer.choice === 'send-dig') { await remember(dig, () => ({ dontAsk: true })); return null; }
      const call = `this ${tool.module.label} ${action} call`;
      if (answer.kind === 'answered') return refused(`The person chose not to send ${call}, so no request was sent; do not send it another way.`);
      if (answer.kind === 'unavailable') return refused(`${call[0].toUpperCase()}${call.slice(1)} needs the person’s go-ahead first (${typical === null ? 'this library has no priced call of it yet' : `it has typically cost ${usd(typical)}, at or above ask_above_usd of $${askAbove}`}), but this client cannot ask them, so no request was sent; tell the user, who can change ask_above_usd under [spend] in Dig’s settings.`);
      return refused(`${why(answer, `whether to send ${call}`).slice(0, -1)}, so no request was sent.`);
    }
  }
  return null;
}

// ---- Keys -------------------------------------------------------------------------------------------------------
interface KeyName { name: string; labels: string[]; guidance: string }
interface KeyCode { names: KeyName[]; expires: number; used: boolean; saved: string[]; settle(): void; settled: Promise<void> }
// One-time codes for the key page, in this process only: a page outlives no restart.
const codes = new Map<string, KeyCode>();
const isSet = (name: string) => !!process.env[name]?.trim();
/** Credential names of one source, or of every enabled source, each with the sources that use it and the first one's guidance. */
function keyNames(enabled: string[], source?: string): KeyName[] {
  const names = new Map<string, KeyName>();
  for (const m of (MODULES as readonly DigModule[]).filter(m => (source ? m.id === source : enabled.includes(m.id)))) for (const { name } of credentialNames(m) as { name: string }[]) {
    const entry = names.get(name); if (entry) entry.labels.push(m.label); else names.set(name, { name, labels: [m.label], guidance: m.credential ?? name });
  }
  return [...names.values()];
}
function newCode(names: KeyName[]) {
  const now = Date.now(); for (const [code, entry] of codes) if (now > entry.expires + 3_600_000) codes.delete(code);
  const code = randomBytes(24).toString('base64url'); let settle = () => {};
  const settled = new Promise<void>(done => { settle = done; });
  codes.set(code, { names, expires: now + keyCodeMs(), used: false, saved: [], settle, settled });
  return code;
}
const until = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * The keys tool: a one-time page on this service, opened through a URL-mode request, where the person types the
 * credentials of `source` (or the missing ones of every enabled source). The result names which are set and which are
 * still missing, never a value. Where the client cannot open a page, the result gives the address for the person.
 */
export async function keysTool(asker: Asker | undefined, source: string | undefined, origin: string): Promise<CallToolResult | InputRequiredResult> {
  const c = await loadConfig();
  const scope = keyNames(c.sources.enabled, source); const label = MODULES.find(m => m.id === source)?.label;
  const report = (line: string, extra: Record<string, unknown> = {}): CallToolResult => {
    const set = scope.filter(entry => isSet(entry.name)).map(entry => entry.name); const missing = scope.filter(entry => !isSet(entry.name)).map(entry => entry.name);
    return { content: [{ type: 'text', text: `${line}\nSet: ${set.join(', ') || 'none'}.\nStill missing: ${missing.join(', ') || 'none'}.` }], structuredContent: { set, missing, ...extra } };
  };
  if (!scope.length) return report(source ? `${label} needs no credential.` : 'The enabled sources need no credential.');
  const page = source ? scope : scope.filter(entry => !isSet(entry.name));
  if (!page.length) return report('Every credential the enabled sources use is already set.');
  // A retried 2026-07-28 call carries the code of the page it asked the client to open, which may already have been sent.
  const prior = asker ? await priorState(asker, 'keys') : null;
  const code = prior && codes.has(prior.bind) ? prior.bind : newCode(page);
  const entry = codes.get(code)!; const url = `${origin}/keys/${code}`;
  const message = `Dig would like you to type ${source ? `${label}’s credentials` : 'the missing credentials of your enabled sources'} into a page on this computer (${page.map(e => e.name).join(', ')}). They are saved in Dig’s keys.env and never pass through the conversation.`;
  const answer = asker ? await askUrl(asker, { key: 'keys', bind: code, message, url }) : { kind: 'unavailable' } as Answer;
  if (answer.kind === 'pending') return answer.result;
  if (answer.kind === 'unavailable') return report(`This client cannot open a page for the person. Give them this address to open in a browser on this computer: ${url} . It works for one submission and expires in ${plural(Math.round(keyCodeMs() / 60_000) || 1, 'minute')} (at ${until(entry.expires)}); call source_info afterwards to see which are set.`, { address: url, expiresAt: new Date(entry.expires).toISOString() });
  if (answer.kind !== 'answered') { codes.delete(code); return report(answer.kind === 'declined' ? 'The person declined to open the key page; nothing was changed.' : answer.kind === 'cancelled' ? 'The person dismissed the key page request; nothing was changed.' : 'The request to open the key page went unanswered; nothing was changed.'); }
  // The person agreed to open the page: wait, within bounds, for them to send it.
  const signal = asker!.ctx.mcpReq.signal;
  activeWaits++;
  try {
    await new Promise<void>(done => {
      const timer = setTimeout(done, Math.max(0, Math.min(askTimeoutMs(), entry.expires - Date.now())));
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); };
      void entry.settled.then(finish); signal.addEventListener('abort', finish);
    });
  } finally { activeWaits--; }
  if (entry.used) return report(entry.saved.length ? `The person saved ${entry.saved.join(', ')} on the key page; Dig is using ${entry.saved.length === 1 ? 'it' : 'them'} now.` : 'The person sent the key page without filling anything in; nothing was changed.', { saved: entry.saved });
  return report(`The person has not sent the key page yet; it stays open until ${until(entry.expires)}. Call source_info afterwards to see which are set.`);
}

/** Whether a spending question or key-entry page is still waiting on the person in this service process. */
export function hasPendingPrompts(): boolean {
  const now = Date.now();
  for (const [nonce, until] of pendingStates) if (now > until) pendingStates.delete(nonce);
  if (activeWaits > 0 || pendingStates.size > 0) return true;
  for (const entry of codes.values()) if (!entry.used && now <= entry.expires) return true;
  return false;
}

/**
 * The same one-time key page, for a view's button: the person asked for it by clicking, so nothing is asked first.
 * Names `source`'s credentials, or the missing ones of every enabled source; null when there is nothing to type.
 */
export async function keyAddress(source: string | undefined, origin: string): Promise<{ address: string; expiresAt: string; names: string[] } | null> {
  const c = await loadConfig();
  const scope = keyNames(c.sources.enabled, source); const page = source ? scope : scope.filter(entry => !isSet(entry.name));
  if (!page.length) return null;
  const code = newCode(page);
  return { address: `${origin}/keys/${code}`, expiresAt: new Date(codes.get(code)!.expires).toISOString(), names: page.map(entry => entry.name) };
}

// ---- The library in a browser -----------------------------------------------------------------------------------
/** How long a one-time address for the views in a browser is valid (service.ts issues and redeems it). */
export const OPEN_CODE_MS = 5 * 60_000;
export interface BrowserAddress { address: string; expiresAt: string }
/** What open_library adds for a client that shows no views: whether the host opened the page, else an address to give. */
export interface BrowserOpen { opened: boolean; address?: string; expiresAt?: string }
/**
 * open_library for a client that shows no views: a one-time address for the views in a browser (`issue`), which the
 * client is asked to open with a URL-mode request. Where the page was not confirmed opened (the client cannot open
 * pages, or the person declined, dismissed or did not answer), the result carries a fresh address for the person.
 */
export async function openInBrowser(asker: Asker, issue: () => BrowserAddress): Promise<{ line: string; value: BrowserOpen } | { pending: InputRequiredResult }> {
  // A retried 2026-07-28 call carries the address it asked the client to open, which the person may already have used.
  const prior = await priorState(asker, 'library');
  const first = prior ? null : issue(); const url = prior?.bind ?? first!.address;
  const answer = await askUrl(asker, { key: 'library', bind: url, message: 'Dig would like to open its research library in your browser, from a page Dig serves on this computer.', url });
  if (answer.kind === 'pending') return { pending: answer.result };
  if (answer.kind === 'answered') return { line: 'The host was asked to open Dig’s library in the person’s browser, and the person agreed.', value: { opened: true } };
  const page = answer.kind === 'unavailable' && first ? first : issue();
  const reason = answer.kind === 'unavailable' ? 'This client cannot open pages.' : answer.kind === 'declined' ? 'The person declined to open Dig’s library.' : answer.kind === 'cancelled' ? 'The person dismissed the request to open Dig’s library.' : 'The request to open Dig’s library went unanswered.';
  return { line: `${reason} Give the person this address to open it in a browser: ${page.address} . It works once, for ${plural(Math.round(OPEN_CODE_MS / 60_000), 'minute')}, and only on this computer.`, value: { opened: false, ...page } };
}

// ---- The key page -----------------------------------------------------------------------------------------------
const escape = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[ch]!);
const STYLE = 'body{margin:0;font:16px/1.5 system-ui,-apple-system,sans-serif;color-scheme:light dark;background:Canvas;color:CanvasText}main{max-width:36rem;margin:0 auto;padding:24px 16px}h1{font-size:1.4rem;margin:0 0 12px}label{display:block;font-weight:600;margin-top:20px;overflow-wrap:anywhere}.state{font-weight:400;font-size:.875rem;opacity:.75}p.note{margin:4px 0 6px;font-size:.875rem;opacity:.8;overflow-wrap:anywhere}input{box-sizing:border-box;width:100%;font:inherit;padding:10px;border:1px solid GrayText;border-radius:6px;background:Field;color:FieldText}button{margin-top:24px;font:inherit;font-weight:600;padding:10px 20px;border-radius:6px;border:1px solid GrayText;cursor:pointer}footer{margin-top:24px;font-size:.875rem;opacity:.75}ul{padding-left:20px}';
const html = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
export interface PageReply { status: number; html: string }
const notice = (status: number, heading: string, text: string): PageReply => ({ status, html: html(`Dig · ${heading}`, `<h1>${escape(heading)}</h1><p>${escape(text)}</p>`) });
const AGAIN = 'Ask for a new link with Dig’s keys tool.';
function open(code: string): { entry: KeyCode } | { reply: PageReply } {
  const entry = codes.get(code);
  if (!entry) return { reply: notice(404, 'Link not valid', `This key page link is not valid. ${AGAIN}`) };
  if (entry.used) return { reply: notice(410, 'Link already used', `This key page link has already been used, and accepts nothing more. ${AGAIN}`) };
  if (Date.now() > entry.expires) return { reply: notice(410, 'Link expired', `This key page link has expired, and accepts nothing. ${AGAIN}`) };
  return { entry };
}
/** The page: one password field per credential name, its guidance, and whether it is set, never its value. */
export function keyPage(code: string): PageReply {
  const found = open(code); if ('reply' in found) return found.reply;
  const fields = found.entry.names.map(({ name, labels, guidance }) => `<label for="${escape(name)}">${escape(name)} <span class="state">· ${isSet(name) ? 'set; a new value replaces it' : 'not set'}</span></label><p class="note">${escape(labels.join(', '))}: ${escape(guidance)}</p><input type="password" id="${escape(name)}" name="${escape(name)}" autocomplete="off" autocapitalize="off" spellcheck="false">`).join('');
  return { status: 200, html: html('Dig · Keys', `<h1>Dig keys</h1><p>Type the credentials Dig should use. Dig saves them in keys.env on this computer and uses them at once; they are never shown to the conversation. Leave a field empty to keep it as it is.</p><form method="post" action="/keys/${escape(code)}">${fields}<button type="submit">Save</button></form><footer>This page works for one submission and expires at ${until(found.entry.expires)}.</footer>`) };
}
/** The page's submission: writes the filled fields to keys.env and shows which names are now set. */
export async function keySubmit(code: string, form: URLSearchParams): Promise<PageReply> {
  const found = open(code); if ('reply' in found) return found.reply;
  const { entry } = found;
  const values: Record<string, string> = {};
  for (const { name } of entry.names) { const value = form.get(name)?.trim(); if (value) values[name] = value; }
  entry.used = true;
  // saveKeys is plain JavaScript whose queued result TypeScript reads as void.
  try { entry.saved = ((await saveKeys(values)) as unknown as { saved: string[] }).saved; } catch (error) {
    // Only Dig's own messages, which name a credential, never a value.
    entry.used = false;
    return notice(400, 'Not saved', `${error instanceof Error && /^(?:[A-Z0-9_]+ is not a credential|The value for [A-Z0-9_]+ spans)/.test(error.message) ? error.message : 'keys.env could not be written'}. Nothing was saved; go back and correct it.`);
  }
  entry.settle();
  const missing = entry.names.filter(({ name }) => !isSet(name)).map(({ name }) => name);
  const list = (names: string[]) => `<ul>${names.map(name => `<li>${escape(name)}</li>`).join('')}</ul>`;
  return { status: 200, html: html('Dig · Keys saved', `<h1>${entry.saved.length ? 'Saved' : 'Nothing saved'}</h1>${entry.saved.length ? `<p>Dig saved these in keys.env and is using them now:</p>${list(entry.saved)}` : '<p>No field was filled in, so keys.env is unchanged.</p>'}${missing.length ? `<p>Still not set:</p>${list(missing)}` : ''}<p>You can close this page and return to the conversation.</p>`) };
}
