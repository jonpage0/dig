// The durable job store. Every call to a metered or slow action is a job: one JSON file under <state>/jobs/, written
// before the provider request is sent, so the service and not the connection owns the work. Under 2026-07-28 a broken
// response stream loses the request and the client sends it again; an identical call then attaches to the running job
// or, within REUSE_MS of its end, gets its result back, so a repeat never pays twice. A slow action answers a client
// that declares the Tasks extension with a task (the job id is the task id), and any other client after a bounded wait
// with the job's handle for the `job` tool. Finished jobs are kept for KEEP_MS; a job found running when the service
// starts was cut off by a stop, so it is marked failed and given a receipt with an unknown cost, unless its run had
// already written one, which it then adopts.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MissingRequiredClientCapabilityError, ProtocolError, type CallToolResult } from '@modelcontextprotocol/server';
import { loadConfig, stateDirectory } from '../config.mjs';
import { projectFolder, readLibraryFile, recordCall, safeSegment, SESSION_UNAVAILABLE, withoutSecrets } from '../library.mjs';
import { MODULES } from '../providers/modules.ts';
import type { ToolProgress } from '../providers/types.ts';

type Config = Awaited<ReturnType<typeof loadConfig>>;
type Json = Record<string, unknown>;
export const TASKS = 'io.modelcontextprotocol/tasks';
/** Finished jobs are kept this long after they finish, then removed; a task id stays answerable as long. */
export const KEEP_MS = 24 * 60 * 60_000;
/** An identical call within this long after a job finished gets that job's result instead of a new request. */
export const REUSE_MS = 10 * 60_000;
const POLL_MS = 3000;
const SWEEP_MS = 60 * 60_000;
/** How long a slow action holds a client without the Tasks extension before answering with the job handle. */
export const inlineWaitMs = (env = process.env) => { const raw = env.DIG_INLINE_WAIT_MS; const ms = Number(raw); return raw && Number.isFinite(ms) && ms >= 0 ? ms : 40_000; };
export const STOPPED = 'The service stopped while this job was running: its request may have been sent and charged, and its cost is unknown.';
const SLOW = new Set<string>(MODULES.flatMap(m => ('slow' in m ? m.slow : []) as readonly string[]));
export const isSlow = (action: string) => SLOW.has(action);

export type JobStatus = 'working' | 'completed' | 'failed' | 'cancelled';
/**
 * One job, as its file holds it. `dig` is the handle, `tool` the action (the name receipts record), `argsHash` the
 * hash of the validated arguments. `args` (redacted, as the receipt keeps them), `project` and `declared` are what a
 * receipt needs when the service stopped before run() wrote one. At the end: `result` (what the call returns to the
 * model), the cost as the receipt priced it, and the receipt id; or `error` when the job produced no result.
 */
export interface Job {
  id: string; dig: string; project: string; source: string; tool: string; argsHash: string; args: Json; declared: string[];
  status: JobStatus; createdAt: string; lastUpdatedAt: string; finishedAt?: string;
  result?: CallToolResult; cost?: unknown; knownCost?: unknown; receipt?: string | null; error?: string;
}
/** Process-local live progress of a running job; never persisted into job files or receipts. */
export interface JobProgress extends ToolProgress { at: string }
/** What a run produces for its job: the model's result, and the receipt's id and pricing (null when none was kept). */
export interface Outcome { result: CallToolResult; status: 'completed' | 'cancelled'; receipt: string | null; cost?: unknown; knownCost?: unknown }
export interface NewJob { dig: string; project: string; source: string; tool: string; args: Json; redacted: Json; declared: string[] }

/** The arguments in a canonical form (object keys sorted, recursively), hashed: with the dig and action, a call's identity. */
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as Json).sort().map(key => [key, canonical((value as Json)[key])])) : value;
export const argsHash = (args: Json) => createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex');
const JOB_ID = /^job-[A-Za-z0-9_-]{22}$/;
const FILE = /^(job-[A-Za-z0-9_-]{22})\.json$/;
const finished = (job: Job) => job.status !== 'working';
const record = recordCall as unknown as (c: Config, project: string, dig: string, receipt: Json) => Promise<{ id: string }>;

export class JobStore {
  readonly dir: string;
  #jobs = new Map<string, Job>();
  #live = new Map<string, { done: Promise<Job>; controller: AbortController; progress?: JobProgress; listeners: Set<(p: JobProgress) => void> }>();
  #sweeper: ReturnType<typeof setInterval> | null = null;
  constructor(dir: string) { this.dir = dir; }

  /**
   * Reads every job file. A job still marked running was cut off when the service stopped: it is marked failed with
   * STOPPED, and given a receipt (failed, cost unknown) if run() had not written one. No request is sent again.
   */
  async open(now = Date.now()) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.dir)) {
      const id = FILE.exec(name)?.[1]; if (!id) continue;
      let job: Job; try { job = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as Job; } catch { continue; }
      if (job?.id !== id) continue;
      this.#jobs.set(id, job);
      if (job.status === 'working') await this.#fail(job, STOPPED, new Date(now).toISOString());
    }
    await this.sweep(now);
    this.#sweeper = setInterval(() => { void this.sweep(); }, SWEEP_MS); this.#sweeper.unref();
    return this;
  }
  close() { if (this.#sweeper) clearInterval(this.#sweeper); this.#sweeper = null; }

  /** Removes jobs that finished more than KEEP_MS ago. `now` is injectable so the age can be tested. */
  async sweep(now = Date.now()) {
    for (const job of [...this.#jobs.values()]) {
      if (!finished(job) || now - Date.parse(job.finishedAt ?? job.lastUpdatedAt) <= KEEP_MS) continue;
      this.#jobs.delete(job.id); await rm(join(this.dir, `${job.id}.json`), { force: true });
    }
  }

  get(id: unknown) { return typeof id === 'string' && JOB_ID.test(id) ? this.#jobs.get(id) : undefined; }
  running() { return [...this.#jobs.values()].filter(job => job.status === 'working'); }
  /** The newest job for the same dig, action and arguments. */
  find(dig: string, tool: string, hash: string) {
    let found: Job | undefined;
    for (const job of this.#jobs.values()) if (job.dig === dig && job.tool === tool && job.argsHash === hash && (!found || job.createdAt > found.createdAt)) found = job;
    return found;
  }

  /**
   * Creates a job, writes its file, and only then starts `execute` (which sends the provider request). Resolves once
   * the file exists, so a task answered with this job is answerable by tasks/get.
   */
  async start(spec: NewJob, execute: (signal: AbortSignal, reportProgress: (update: ToolProgress) => void) => Promise<Outcome>): Promise<Job> {
    const at = new Date().toISOString();
    const job: Job = { id: `job-${randomBytes(16).toString('base64url')}`, dig: spec.dig, project: spec.project, source: spec.source, tool: spec.tool, argsHash: argsHash(spec.args), args: spec.redacted, declared: spec.declared, status: 'working', createdAt: at, lastUpdatedAt: at };
    this.#jobs.set(job.id, job);
    // The job is live (attachable) at once; its request is sent only after its file is written.
    const controller = new AbortController(); const listeners = new Set<(p: JobProgress) => void>(); const written = this.#write(job);
    const reportProgress = (update: ToolProgress) => {
      const live = this.#live.get(job.id);
      if (!live || job.status !== 'working') return;
      const now = new Date().toISOString();
      const entry: JobProgress = { progress: update.progress, ...(update.total !== undefined ? { total: update.total } : {}), message: update.message, at: now };
      live.progress = entry;
      job.lastUpdatedAt = now;
      for (const listener of [...live.listeners]) { try { listener(entry); } catch {} }
    };
    const done = written.then(async () => {
      try {
        const out = await execute(controller.signal, reportProgress);
        const end = new Date().toISOString();
        Object.assign(job, { status: out.status, result: out.result, receipt: out.receipt, cost: out.cost ?? null, ...(out.knownCost ? { knownCost: out.knownCost } : {}), finishedAt: end, lastUpdatedAt: end });
        await this.#write(job).catch(error => console.error(`dig: job ${job.id} finished but its file was not updated: ${error instanceof Error ? error.message : error}`));
      } catch (error) {
        // run() keeps its own receipt; reaching here means it threw before the result existed.
        await this.#fail(job, `Dig could not finish this call (${error instanceof Error ? error.message : String(error)}): its request may have been sent and charged, and its cost is unknown.`);
      }
      return job;
    }, error => { this.#jobs.delete(job.id); throw error; }).finally(() => { this.#live.delete(job.id); });
    done.catch(() => {});
    this.#live.set(job.id, { done, controller, listeners });
    await written;
    return job;
  }

  /** Latest in-memory live progress of a running job, if any. */
  progressOf(id: string): JobProgress | undefined { return this.#live.get(id)?.progress; }
  /** Subscribes to live progress of a running job, replaying the latest update immediately when present. */
  subscribe(id: string, listener: (p: JobProgress) => void): () => void {
    const live = this.#live.get(id);
    if (!live) return () => {};
    if (live.progress) { try { listener(live.progress); } catch {} }
    live.listeners.add(listener);
    return () => { live.listeners.delete(listener); };
  }

  /** The job once it has finished, or as it stands after `ms`. */
  async wait(id: string, ms: number): Promise<Job | undefined> {
    const live = this.#live.get(id);
    const settled = live?.done.catch(() => {});
    if (settled && ms === Infinity) await settled;
    else if (settled && ms > 0) { let timer: ReturnType<typeof setTimeout> | undefined; await Promise.race([settled, new Promise(done => { timer = setTimeout(done, ms); })]); clearTimeout(timer); }
    return this.get(id);
  }
  /** Asks a running job to stop: the provider call is aborted, and a paid call then records an unknown cost. */
  cancel(id: string) { const live = this.#live.get(id); if (!live) return false; live.controller.abort(); return true; }

  async #fail(job: Job, error: string, at = new Date().toISOString()) {
    Object.assign(job, { status: 'failed', error, finishedAt: at, lastUpdatedAt: at });
    // The receipt, as run() would have written it for a call that failed with no usable response: status failed, cost
    // unknown. Only when run() kept none, so a call never has two: run() may have written its receipt just before the
    // service stopped (or before it threw), with the job file not yet saying so; that receipt is adopted instead.
    if (!job.receipt) try {
      const c = await loadConfig(); const digId = job.dig.split('/').at(-1) ?? job.dig;
      const kept = await this.#written(c, job, digId) ?? await record(c, job.project, digId, { tool: job.tool, source: job.source, args: job.args, declared: job.declared, at: job.createdAt, ms: Date.parse(at) - Date.parse(job.createdAt), status: 'failed', cost: null, responses: [], error, session: digId });
      job.receipt = kept.id;
    } catch (e) { console.error(`dig: no receipt for job ${job.id}: ${e instanceof Error ? e.message : e}`); }
    await this.#write(job).catch(() => {});
  }
  /**
   * The receipt this job's run wrote, if any: in the dig's calls.jsonl, the earliest receipt that names this dig, source
   * and action with this job's arguments as a receipt keeps them, written no earlier than the job was created and before
   * any later identical job was, and that no other job has as its receipt. Nothing else identifies the call, since a
   * receipt does not name its job.
   */
  async #written(c: Config, job: Job, digId: string): Promise<{ id: string } | undefined> {
    let text: string;
    try { text = (await readLibraryFile(c, `${projectFolder(job.project)}/sessions/${safeSegment(digId, SESSION_UNAVAILABLE)}/calls.jsonl`, 0, Number.MAX_SAFE_INTEGER)).text; } catch { return undefined; }
    const args = JSON.stringify(canonical(withoutSecrets(job.args, job.declared)));
    const from = Date.parse(job.createdAt);
    const until = Math.min(...[...this.#jobs.values()].filter(other => other !== job && other.dig === job.dig && other.tool === job.tool && other.argsHash === job.argsHash && Date.parse(other.createdAt) > from).map(other => Date.parse(other.createdAt)));
    const claimed = new Set([...this.#jobs.values()].map(other => other.receipt).filter(Boolean));
    let found: { id: string; at: number } | undefined;
    for (const line of text.split('\n')) {
      let receipt: Json; try { receipt = JSON.parse(line) as Json; } catch { continue; }
      const at = typeof receipt.at === 'string' ? Date.parse(receipt.at) : NaN;
      if (typeof receipt.id !== 'string' || claimed.has(receipt.id) || receipt.dig !== digId || receipt.source !== job.source || receipt.tool !== job.tool) continue;
      if (!(at >= from && at < until) || JSON.stringify(canonical(receipt.args)) !== args) continue;
      if (!found || at < found.at) found = { id: receipt.id, at };
    }
    return found && { id: found.id };
  }
  async #write(job: Job) {
    const path = join(this.dir, `${job.id}.json`); const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job)}\n`, { mode: 0o600 }); await rename(temporary, path);
  }
}

// One store per service process. The service opens it at start; anything that reaches it before then opens it lazily.
let opened: Promise<JobStore> | null = null;
export const jobsDirectory = (state = stateDirectory()) => join(state, 'jobs');
export function openJobs(state = stateDirectory()) { opened ??= new JobStore(jobsDirectory(state)).open(); return opened; }
export const jobs = () => openJobs();

// ---- What the model and the client receive -----------------------------------------------------------------------
const textOf = (result: CallToolResult) => result.content.find(block => block.type === 'text');
const ago = (from: string, now = Date.now()) => { const s = Math.max(0, Math.round((now - Date.parse(from)) / 1000)); return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`; };
/** A finished job's result: what the call itself returned, or the error when it produced none. */
export function jobResult(job: Job): CallToolResult {
  if (job.result) return job.result;
  return { content: [{ type: 'text', text: `${job.tool} · job ${job.id} · failed${job.receipt ? ` · receipt ${job.receipt}` : ''}.\n\n${job.error ?? 'The job produced no result.'}` }], isError: true };
}
/** A result with one line put before its text. */
export function withLine(base: CallToolResult, line: string): CallToolResult {
  const first = textOf(base);
  return { ...base, content: first ? base.content.map(block => block === first ? { ...first, text: `${line}\n\n${first.text}` } : block) : [{ type: 'text', text: line }, ...base.content] };
}
/** An identical earlier call's result, with one line saying so and how to send the request again. */
export const repeated = (job: Job) => withLine(jobResult(job), `This is the result of an identical call that finished at ${job.finishedAt} (job ${job.id}); no request was sent now. To send it again, and be charged again, repeat the call with fresh: true.`);
/** The answer to a client without the Tasks extension when a slow job is still running after the inline wait. */
export function stillRunning(job: Job, progress?: JobProgress): CallToolResult {
  const latest = progress?.message ? ` Latest: ${progress.message}.` : '';
  return { content: [{ type: 'text', text: `${job.tool} is still running as job ${job.id} (started ${ago(job.createdAt)} ago); the work continues in Dig's service and its result is kept. Call job with id "${job.id}" for its status and result (wait: true waits up to ${Math.round(inlineWaitMs() / 1000)} seconds). Do not call the tool again for this request.${latest}` }] };
}
/** The job tool's answer while a job runs. */
export function working(job: Job, progress?: JobProgress): CallToolResult {
  const latest = progress?.message ? ` Latest: ${progress.message}.` : '';
  return { content: [{ type: 'text', text: `Job ${job.id} (${job.tool}) is working, started ${ago(job.createdAt)} ago. Call job again with this id for the result; wait: true waits up to ${Math.round(inlineWaitMs() / 1000)} seconds.${latest}` }] };
}
export const unknownJob = (id: unknown) => `No job${typeof id === 'string' && id ? ` ${id}` : ''} is known. Dig keeps a job for 24 hours after it finishes; an older one has been removed.`;

/** The Tasks extension's fields for a job: a task's id is its job's id. ttlMs counts from creation to removal. */
export function taskFields(job: Job, progress?: JobProgress) {
  const ttlMs = job.finishedAt ? Date.parse(job.finishedAt) + KEEP_MS - Date.parse(job.createdAt) : null;
  const statusMessage = job.status === 'working' ? (progress?.message ? `${job.tool}: ${progress.message}` : `${job.tool} is running`) : job.status === 'failed' ? job.error : job.status === 'cancelled' ? `${job.tool} was cancelled` : undefined;
  return { taskId: job.id, status: job.status, ...(statusMessage ? { statusMessage } : {}), createdAt: job.createdAt, lastUpdatedAt: job.lastUpdatedAt, ttlMs, pollIntervalMs: POLL_MS };
}
/**
 * A tools/call answered with a task (CreateTaskResult): resultType "task" and the task's fields, no content. The
 * SDK passes a tools/call result's own resultType through on 2026-07-28; its CallToolResult type does not name the
 * task fields, hence the cast.
 */
export const taskAnswer = (job: Job, progress?: JobProgress) => ({ resultType: 'task', ...taskFields(job, progress) }) as unknown as CallToolResult;
/** A tasks/get response: the task's fields, and the result when completed or the error when failed. */
export function taskState(job: Job, progress?: JobProgress) {
  const base = taskFields(job, progress);
  if (job.status === 'completed') return { ...base, result: jobResult(job) };
  if (job.status === 'failed') return { ...base, error: { code: -32603, message: job.error ?? 'The job failed.' } };
  return base;
}

/** Whether this request's own client capabilities (its 2026-07-28 envelope) declare the Tasks extension. */
export function declaresTasks(envelope: unknown) {
  const capabilities = (envelope as Json | undefined)?.['io.modelcontextprotocol/clientCapabilities'] as { extensions?: Json } | undefined;
  return !!capabilities?.extensions && typeof capabilities.extensions[TASKS] === 'object' && capabilities.extensions[TASKS] !== null;
}
export const needsTasks = () => new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [TASKS]: {} } } }, 'This method needs the client to declare the io.modelcontextprotocol/tasks extension on the request.');
export const noSuchTask = (id: unknown) => new ProtocolError(-32602, `Unknown task ${typeof id === 'string' ? id : ''}: Dig keeps a task for 24 hours after it finishes.`);
