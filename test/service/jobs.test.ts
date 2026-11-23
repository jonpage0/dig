// Jobs: a metered or slow call is a job the service owns, so a repeat never pays twice; a slow job answers with a task
// to a request that declares the Tasks extension and with its handle to any other after a bounded wait; jobs outlive a
// service stop as failed, with a receipt. The service runs as a child process with xAI's search mocked (and delayable,
// see jobs-preload.mjs); 2026-07-28 requests that carry or leave out the extension are sent as raw JSON-RPC, as a
// host sends them, since the SDK client refuses a task result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { argsHash, JobStore, STOPPED, type Job } from '../../src/service/jobs.ts';
import { readDigCalls, result as formatResult } from '../../src/service/calls.ts';
import { SOURCE_TOOLS } from '../../src/service/surface.ts';
import { loadConfig } from '../../src/config.mjs';
import { projectFolder, readLibraryFile, recordCall, safeSegment, SESSION_UNAVAILABLE, startDig } from '../../src/library.mjs';
import { cleanup, connectLegacy, connectModern, DIG, eventually, MODERN, node, run, text, workspace } from './helpers.mjs';

const PRELOAD = resolve('test/service/jobs-preload.mjs');
const TASKS = 'io.modelcontextprotocol/tasks';
const SETUP = { keys: 'XAI_API_KEY=xai-service-synthetic-value\n', config: '[sources]\nenabled = ["hackernews", "x"]\n' };
type Space = Awaited<ReturnType<typeof workspace>>;
type Rpc = { result?: any; error?: { code: number; message: string; data?: any } };

/** `dig serve` with the jobs preload; resolves once it answers and has written service.json. */
async function serve(space: Space, env: Record<string, string> = {}) {
  const child = spawn(node, ['--import', PRELOAD, DIG, 'serve'], { env: { ...space.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; child.stderr.on('data', chunk => { log += chunk; });
  const file = await eventually(async () => { try { const value = await space.serviceFile(); return value.pid === child.pid ? value : null; } catch { return null; } }, `service did not start: ${log}`);
  return { child, token: file.token as string, pid: child.pid as number };
}
const delay = (space: Space, ms: number) => writeFile(join(space.state, 'provider-delay-ms'), String(ms));
/** The provider requests made so far, each with the job files that existed when it arrived. */
const requests = async (space: Space): Promise<{ jobs: string[] }[]> => { try { return (await readFile(join(space.state, 'provider-calls.log'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
const jobFiles = async (space: Space) => (await readdir(join(space.state, 'jobs')).catch(() => [] as string[])).filter(name => /^job-.*\.json$/.test(name));
const jobFile = async (space: Space, id: string): Promise<Job> => JSON.parse(await readFile(join(space.state, 'jobs', `${id}.json`), 'utf8'));
const receipts = async (space: Space, dig: string) => { const [folder, id] = dig.split('/'); try { return (await readFile(join(space.state, 'library', folder, 'sessions', id, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };

/** One 2026-07-28 request as a host sends it, with or without the Tasks extension in its own client capabilities. */
let ids = 0;
async function rpc(space: Space, token: string, method: string, params: Record<string, unknown>, { tasks = true } = {}): Promise<Rpc> {
  const _meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'dig-test-tasks', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': tasks ? { extensions: { [TASKS]: {} } } : {} };
  const name = method === 'tools/call' ? params.name : method.startsWith('tasks/') ? params.taskId : undefined;
  const response = await fetch(space.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(typeof name === 'string' ? { 'mcp-name': name } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++ids, method, params: { ...params, _meta } }) });
  const body = await response.text();
  return JSON.parse(response.headers.get('content-type')?.includes('text/event-stream') ? body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).at(-1)! : body);
}
const call = (space: Space, token: string, dig: string, args: Record<string, unknown>, options?: { tasks?: boolean }) => rpc(space, token, 'tools/call', { name: 'x', arguments: { dig, action: 'xsearch', args } }, options);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEAD = /^X · xsearch · success · receipt c-[^ ]+ · cost: \$0\.0123 · /;

test('two identical paid calls sent together reach the provider once, both get the same result, and one receipt is kept', async () => {
  const space = await workspace('jobs-together', SETUP);
  try {
    const { token } = await serve(space); await delay(space, 600);
    const client = await connectModern(space, token);
    try {
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Does a repeat pay twice?' } })).structuredContent as { dig: string };
      const [a, b] = await Promise.all([1, 2].map(() => client.callTool({ name: 'x', arguments: { dig, action: 'xsearch', args: { query: 'together' } } })));
      assert.match(text(a), HEAD); assert.equal(text(b), text(a)); assert.deepEqual(b.content, a.content);
      assert.equal((await requests(space)).length, 1);
      assert.equal((await receipts(space, dig)).length, 1);
      assert.equal((await jobFiles(space)).length, 1);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('an identical paid call after completion returns the earlier result with a line, sends nothing and keeps no receipt; fresh: true sends it again', async () => {
  const space = await workspace('jobs-repeat', SETUP);
  try {
    const { token } = await serve(space);
    const client = await connectLegacy(space, token);
    try {
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Is a repeat answered from the job?' } })).structuredContent as { dig: string };
      const xsearch = (args: Record<string, unknown>, fresh?: boolean) => client.callTool({ name: 'x', arguments: { dig, action: 'xsearch', args, ...(fresh === undefined ? {} : { fresh }) } });
      const first = await xsearch({ query: 'repeat', passLabel: 'p' });
      assert.match(text(first), HEAD);
      // The same arguments in another order are the same call.
      const again = await xsearch({ passLabel: 'p', query: 'repeat' });
      const [line, ...rest] = text(again).split('\n\n');
      assert.match(line, /^This is the result of an identical call that finished at \d{4}-\d{2}-\d{2}T[^ ]+Z \(job job-[A-Za-z0-9_-]{22}\); no request was sent now\. To send it again, and be charged again, repeat the call with fresh: true\.$/);
      assert.equal(rest.join('\n\n'), text(first));
      assert.deepEqual(again.content.slice(1), first.content.slice(1), 'the same links');
      assert.equal((await requests(space)).length, 1); assert.equal((await receipts(space, dig)).length, 1);
      // fresh: false is the default; fresh: true pays again.
      assert.match(text(await xsearch({ query: 'repeat', passLabel: 'p' }, false)), /^This is the result of an identical call/);
      const fresh = await xsearch({ query: 'repeat', passLabel: 'p' }, true);
      assert.match(text(fresh), HEAD);
      assert.equal((await requests(space)).length, 2); assert.equal((await receipts(space, dig)).length, 2);
      // A repeat now answers from the newest job.
      const newest = text(await xsearch({ query: 'repeat', passLabel: 'p' }));
      assert.match(newest, /^This is the result of an identical call/); assert.ok(newest.endsWith(text(fresh)));
      // Another dig is another call.
      const { dig: other } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'A second dig' } })).structuredContent as { dig: string };
      assert.match(text(await client.callTool({ name: 'x', arguments: { dig: other, action: 'xsearch', args: { query: 'repeat', passLabel: 'p' } } })), HEAD);
      assert.equal((await requests(space)).length, 3);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('a repeat that a job answers is not asked about or refused by the spending settings; fresh: true is', async () => {
  const space = await workspace('jobs-repeat-ask', SETUP);
  try {
    const { token } = await serve(space);
    // This client declares no way to be asked, so a spending question becomes a refusal.
    const client = await connectLegacy(space, token);
    try {
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Is a repeat asked about?' } })).structuredContent as { dig: string };
      const xsearch = (fresh?: boolean) => client.callTool({ name: 'x', arguments: { dig, action: 'xsearch', args: { query: 'asked' }, ...(fresh ? { fresh } : {}) } });
      assert.match(text(await xsearch()), HEAD);
      // From here every paid xsearch would be asked about, and the dig is over its ceiling.
      await client.callTool({ name: 'settings', arguments: { set: { spend_ask_above_usd: 0.001, spend_dig_ceiling_usd: 0.001 } } });
      const again = await xsearch();
      assert.notEqual(again.isError, true, text(again));
      assert.match(text(again), /^This is the result of an identical call/);
      const fresh = await xsearch(true);
      assert.equal(fresh.isError, true);
      assert.match(text(fresh), /spending ceiling/);
      assert.equal((await requests(space)).length, 1);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('a free, fast action creates no job', async () => {
  const space = await workspace('jobs-free', SETUP);
  try {
    const { token } = await serve(space);
    const client = await connectModern(space, token);
    try {
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Is a free call a job?' } })).structuredContent as { dig: string };
      const result = await client.callTool({ name: 'hackernews', arguments: { dig, action: 'hackernews', args: { query: 'free' } } });
      assert.match(text(result), /^Hacker News · hackernews · success · receipt /);
      // A second identical free call is sent again: only paid or slow calls are jobs.
      assert.match(text(await client.callTool({ name: 'hackernews', arguments: { dig, action: 'hackernews', args: { query: 'free' } } })), /^Hacker News · hackernews · success · /);
      assert.deepEqual(await jobFiles(space), []);
      assert.equal((await receipts(space, dig)).length, 2);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('a slow action, to a client without the Tasks extension: the handle after the inline wait, then job gives working and the result; the provider is called once', async () => {
  const space = await workspace('jobs-inline', SETUP);
  try {
    const { token } = await serve(space, { DIG_INLINE_WAIT_MS: '300' }); await delay(space, 2500);
    const client = await connectModern(space, token);
    try {
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Does a slow call hold the connection?' } })).structuredContent as { dig: string };
      const xsearch = () => client.callTool({ name: 'x', arguments: { dig, action: 'xsearch', args: { query: 'slow' } } });
      const started = Date.now(); const first = await xsearch();
      assert.ok(Date.now() - started < 2000, 'answered before the provider');
      assert.notEqual(first.isError, true); assert.equal(first.structuredContent, undefined);
      const id = /^xsearch is still running as job (job-[A-Za-z0-9_-]{22}) \(started \d+ s ago\); the work continues in Dig's service and its result is kept\. Call job with id "\1" for its status and result \(wait: true waits up to 0 seconds\)\. Do not call the tool again for this request\.$/.exec(text(first))?.[1];
      assert.ok(id, text(first));
      // The same call again attaches to the running job.
      assert.match(text(await xsearch()), new RegExp(`still running as job ${id} `));
      const status = await run(space, ['status']);
      assert.match(status.stdout, new RegExp(`Running jobs \\(1\\):\\n  ${id} xsearch \\(x\\) for \\d+ s\\n`));
      const pending = await client.callTool({ name: 'job', arguments: { id } });
      assert.match(text(pending), new RegExp(`^Job ${id} \\(xsearch\\) is working, started \\d+ s ago\\.`));
      const done = await eventually(async () => { const r = await client.callTool({ name: 'job', arguments: { id, wait: true } }); return /is working/.test(text(r)) ? null : r; }, 'the job did not finish');
      assert.match(text(done), HEAD); assert.notEqual(done.isError, true);
      assert.deepEqual(done.content.map((block: { type: string }) => block.type), ['text', 'resource_link', 'resource_link']);
      // job returns the same result again, and so does a repeat of the call.
      assert.deepEqual((await client.callTool({ name: 'job', arguments: { id } })).content, done.content);
      assert.match(text(await xsearch()), /^This is the result of an identical call/);
      assert.equal((await requests(space)).length, 1); assert.equal((await receipts(space, dig)).length, 1);
      assert.match((await run(space, ['status'])).stdout, /No running jobs\./);
      // Cancelling a finished job does nothing; an unknown id says so.
      assert.match(text(await client.callTool({ name: 'job', arguments: { id, cancel: true } })), new RegExp(`^Job ${id} had already finished \\(completed\\); there was nothing to cancel\\.\\n\\n`));
      const unknown = await client.callTool({ name: 'job', arguments: { id: 'job-AAAAAAAAAAAAAAAAAAAAAA' } });
      assert.equal(unknown.isError, true);
      assert.equal(text(unknown), 'No job job-AAAAAAAAAAAAAAAAAAAAAA is known. Dig keeps a job for 24 hours after it finishes; an older one has been removed.');
      // job({ cancel }) on a running job: the provider call is aborted and a cancelled receipt with an unknown cost is kept.
      await delay(space, 30_000);
      const slow = await client.callTool({ name: 'x', arguments: { dig, action: 'xsearch', args: { query: 'cancel me' } } });
      const second = /still running as job (job-\S+) /.exec(text(slow))![1];
      await eventually(async () => (await requests(space)).length === 2, 'the second request was not sent');
      const cancelled = await client.callTool({ name: 'job', arguments: { id: second, cancel: true } });
      assert.equal(cancelled.isError, true);
      assert.match(text(cancelled), /^X · xsearch · cancelled · receipt c-[^ ]+ · cost: cost unknown · /);
      assert.equal((await jobFile(space, second)).status, 'cancelled');
      const kept = (await receipts(space, dig)).at(-1);
      assert.deepEqual([kept.status, kept.cost], ['cancelled', null]);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('a slow action, to a client that declares the Tasks extension: a task, tasks/get from working to completed, tasks/cancel, and an unknown task', async () => {
  const space = await workspace('jobs-tasks', SETUP);
  try {
    const { token } = await serve(space); await delay(space, 1500);
    const client = await connectModern(space, token);
    try {
      assert.deepEqual(client.getServerCapabilities()?.extensions?.[TASKS], {}, 'server/discover declares the extension');
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Does a host with tasks get one?' } })).structuredContent as { dig: string };
      const answer = await call(space, token, dig, { query: 'tasks' });
      const task = answer.result;
      assert.equal(task.resultType, 'task');
      assert.match(task.taskId, /^job-[A-Za-z0-9_-]{22}$/);
      assert.equal(task.status, 'working');
      assert.match(task.createdAt, ISO); assert.equal(task.lastUpdatedAt, task.createdAt);
      assert.equal(task.ttlMs, null); assert.equal(task.pollIntervalMs, 3000);
      assert.equal(task.statusMessage, 'xsearch is running');
      const working = (await rpc(space, token, 'tasks/get', { taskId: task.taskId })).result;
      assert.deepEqual({ ...working, _meta: undefined }, { resultType: 'complete', taskId: task.taskId, status: 'working', statusMessage: 'xsearch is running', createdAt: task.createdAt, lastUpdatedAt: task.createdAt, ttlMs: null, pollIntervalMs: 3000, _meta: undefined });
      const completed = await eventually(async () => { const r = (await rpc(space, token, 'tasks/get', { taskId: task.taskId })).result; return r.status === 'working' ? null : r; }, 'the task did not complete');
      assert.equal(completed.resultType, 'complete'); assert.equal(completed.status, 'completed');
      assert.match(completed.lastUpdatedAt, ISO); assert.ok(completed.lastUpdatedAt > completed.createdAt);
      assert.equal(completed.ttlMs, Date.parse(completed.lastUpdatedAt) + 24 * 60 * 60_000 - Date.parse(completed.createdAt));
      assert.match(completed.result.content[0].text, HEAD);
      assert.deepEqual(completed.result.content.map((block: { type: string }) => block.type), ['text', 'resource_link', 'resource_link']);
      assert.equal(completed.result.isError, undefined); assert.equal('statusMessage' in completed, false);
      // The job tool reads the same job, with the same result.
      assert.deepEqual((await client.callTool({ name: 'job', arguments: { id: task.taskId } })).content, completed.result.content);
      // An identical call after it finished is answered at once from the job, not with a task.
      const repeat = (await call(space, token, dig, { query: 'tasks' })).result;
      assert.equal(repeat.resultType, 'complete'); assert.match(repeat.content[0].text, /^This is the result of an identical call/);
      assert.equal((await requests(space)).length, 1);

      await delay(space, 30_000);
      const second = (await call(space, token, dig, { query: 'cancel' })).result;
      assert.equal(second.resultType, 'task');
      // An identical request while it runs is answered with the same task, and sends nothing.
      assert.equal((await call(space, token, dig, { query: 'cancel' })).result.taskId, second.taskId);
      await eventually(async () => (await requests(space)).length === 2, 'the second request was not sent');
      const ack = await rpc(space, token, 'tasks/cancel', { taskId: second.taskId });
      assert.deepEqual({ ...ack.result, _meta: undefined }, { resultType: 'complete', _meta: undefined });
      const cancelled = await eventually(async () => { const r = (await rpc(space, token, 'tasks/get', { taskId: second.taskId })).result; return r.status === 'working' ? null : r; }, 'the task was not cancelled');
      assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.statusMessage, 'xsearch was cancelled');
      assert.equal('result' in cancelled || 'error' in cancelled, false);
      const kept = (await receipts(space, dig)).at(-1);
      assert.deepEqual([kept.tool, kept.status, kept.cost], ['xsearch', 'cancelled', null]);
      assert.equal((await requests(space)).length, 2);
      // tasks/update has no outstanding request to answer: it is acknowledged.
      assert.equal((await rpc(space, token, 'tasks/update', { taskId: second.taskId, inputResponses: {} })).result.resultType, 'complete');

      for (const method of ['tasks/get', 'tasks/cancel', 'tasks/update']) {
        const unknown = await rpc(space, token, method, { taskId: 'job-AAAAAAAAAAAAAAAAAAAAAA', ...(method === 'tasks/update' ? { inputResponses: {} } : {}) });
        assert.equal(unknown.error?.code, -32602, method);
        assert.match(unknown.error!.message, /^Unknown task job-AAAAAAAAAAAAAAAAAAAAAA: Dig keeps a task for 24 hours after it finishes\.$/);
        // A request that does not declare the extension is refused with the missing capability.
        const undeclared = await rpc(space, token, method, { taskId: task.taskId, ...(method === 'tasks/update' ? { inputResponses: {} } : {}) }, { tasks: false });
        assert.equal(undeclared.error?.code, -32021, method);
        assert.deepEqual(undeclared.error?.data?.requiredCapabilities, { extensions: { [TASKS]: {} } });
      }
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('the same client never receives a task for a request that did not carry the extension, nor does a 2025-era client', async () => {
  const space = await workspace('jobs-undeclared', SETUP);
  try {
    const { token } = await serve(space, { DIG_INLINE_WAIT_MS: '200' }); await delay(space, 1500);
    const modern = await connectModern(space, token);
    const legacy = await connectLegacy(space, token);
    try {
      const { dig } = (await modern.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Who gets a task?' } })).structuredContent as { dig: string };
      assert.equal((await call(space, token, dig, { query: 'with' })).result.resultType, 'task');
      const without = (await call(space, token, dig, { query: 'without' }, { tasks: false })).result;
      assert.equal(without.resultType, 'complete'); assert.equal('taskId' in without, false);
      assert.match(without.content[0].text, /^xsearch is still running as job job-\S+ /);
      // The same running job, asked for again without the extension, is still not a task.
      const again = (await call(space, token, dig, { query: 'with' }, { tasks: false })).result;
      assert.equal(again.resultType, 'complete'); assert.match(again.content[0].text, /^xsearch is still running as job /);
      const old = await legacy.callTool({ name: 'x', arguments: { dig, action: 'xsearch', args: { query: 'legacy' } } });
      assert.equal('taskId' in old, false); assert.match(text(old), /^xsearch is still running as job /);
      const capabilities = legacy.getServerCapabilities() as { extensions?: Record<string, unknown> };
      assert.equal(capabilities.extensions?.[TASKS], undefined, 'not declared on the handshake path');
    } finally { await modern.close(); await legacy.close(); }
  } finally { await cleanup(space); }
});

test('a job file exists before the provider request is made', async () => {
  const space = await workspace('jobs-first', SETUP);
  try {
    const { token } = await serve(space); await delay(space, 1000);
    const client = await connectModern(space, token);
    try {
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Which comes first?' } })).structuredContent as { dig: string };
      const { taskId } = (await call(space, token, dig, { query: 'first' })).result;
      const [seen] = await eventually(async () => { const r = await requests(space); return r.length ? r : null; }, 'no request');
      assert.deepEqual(seen.jobs, [`${taskId}.json`]);
      const job = await jobFile(space, taskId);
      assert.deepEqual([job.dig, job.tool, job.source, job.args.query, job.argsHash], [dig, 'xsearch', 'x', 'first', argsHash(job.args)]);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('restart: a job running when the service stopped reads failed with the sentence, has a receipt with an unknown cost, and nothing is sent again', async () => {
  const space = await workspace('jobs-restart', SETUP);
  try {
    const first = await serve(space); await delay(space, 600_000);
    const client = await connectModern(space, first.token);
    const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'What survives a stop?' } })).structuredContent as { dig: string };
    await client.close();
    const { taskId } = (await call(space, first.token, dig, { query: 'cut off' })).result;
    await eventually(async () => (await requests(space)).length === 1, 'the request was not sent');
    assert.equal((await jobFile(space, taskId)).status, 'working');
    assert.deepEqual(await receipts(space, dig), []);
    first.child.kill('SIGKILL');
    await eventually(async () => first.child.exitCode !== null || first.child.signalCode !== null, 'the service did not stop');

    const second = await serve(space);
    const job = await jobFile(space, taskId);
    assert.deepEqual([job.status, job.error], ['failed', STOPPED]);
    assert.equal(STOPPED, 'The service stopped while this job was running: its request may have been sent and charged, and its cost is unknown.');
    const kept = await receipts(space, dig);
    assert.equal(kept.length, 1);
    assert.deepEqual([kept[0].id, kept[0].tool, kept[0].source, kept[0].status, kept[0].cost, kept[0].error, kept[0].dig, kept[0].args.query], [job.receipt, 'xsearch', 'x', 'failed', null, STOPPED, dig.split('/')[1], 'cut off']);
    // The task id still answers after the restart.
    const state = (await rpc(space, second.token, 'tasks/get', { taskId })).result;
    assert.deepEqual([state.status, state.statusMessage, state.error], ['failed', STOPPED, { code: -32603, message: STOPPED }]);
    const client2 = await connectModern(space, second.token);
    try {
      const read = await client2.callTool({ name: 'job', arguments: { id: taskId } });
      assert.equal(read.isError, true);
      assert.equal(text(read), `xsearch · job ${taskId} · failed · receipt ${job.receipt}.\n\n${STOPPED}`);
      // An identical call within ten minutes is not sent again: the request may have been charged.
      assert.match(text(await client2.callTool({ name: 'x', arguments: { dig, action: 'xsearch', args: { query: 'cut off' } } })), new RegExp(`^This is the result of an identical call .*\\n\\nxsearch · job ${taskId} · failed`));
    } finally { await client2.close(); }
    await new Promise(done => setTimeout(done, 300));
    assert.equal((await requests(space)).length, 1, 'no provider request on restart');
    assert.equal((await receipts(space, dig)).length, 1);
  } finally { await cleanup(space); }
});

test('restart: a job whose run wrote its receipt before the stop adopts that receipt and keeps no second one; another receipt is never taken', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-jobs-adopt-')); const project = join(state, 'project'); await mkdir(project);
  const saved = process.env.DIG_STATE_DIR; process.env.DIG_STATE_DIR = state;
  try {
    const c = await loadConfig();
    const { dig } = await startDig(c, project, 'Which receipt is the job’s?', undefined, { ownSession: true });
    const handle = `${projectFolder(project)}/${dig}`; const t0 = Date.parse('2026-11-12T12:00:00Z'); const iso = (ms: number) => new Date(t0 + ms).toISOString();
    const receipt = (query: string, at: number) => recordCall(c, project, dig, { tool: 'xsearch', source: 'x', args: { query }, declared: ['query'], at: iso(at), ms: 900, status: 'success', cost: [{ amount: 0.01234, unit: 'USD' }], responses: [], session: dig });
    const working = (id: string, query: string, at: number): Job => ({ id, dig: handle, project, source: 'x', tool: 'xsearch', argsHash: argsHash({ query }), args: { query }, declared: ['query'], status: 'working', createdAt: iso(at), lastUpdatedAt: iso(at) });
    // An identical call made before the job, the job's own receipt, another query's, and the receipt of a later identical job.
    const earlier = await receipt('cut off', -60_000); const own = await receipt('cut off', 1000); const other = await receipt('another', 2000); const later = await receipt('cut off', 31_000);
    const [a, b, d] = ['job-AAAAAAAAAAAAAAAAAAAAAA', 'job-BBBBBBBBBBBBBBBBBBBBBB', 'job-DDDDDDDDDDDDDDDDDDDDDD'];
    await mkdir(join(state, 'jobs'));
    for (const job of [working(a, 'cut off', 0), working(b, 'never written', 500), working(d, 'cut off', 30_000)]) await writeFile(join(state, 'jobs', `${job.id}.json`), JSON.stringify(job));
    const store = await new JobStore(join(state, 'jobs')).open(t0 + 60_000);
    try {
      const kept = (await readFile(join(c.library, projectFolder(project), 'sessions', dig, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual([a, b, d].map(id => store.get(id)?.status), ['failed', 'failed', 'failed']);
      assert.equal(store.get(a)?.receipt, own.id, 'the job adopts the receipt its run wrote');
      assert.equal(store.get(d)?.receipt, later.id, 'a later identical job adopts its own, not the earlier job\'s');
      assert.deepEqual(kept.slice(0, 4).map(r => r.id), [earlier.id, own.id, other.id, later.id]);
      assert.equal(kept.length, 5, 'only the job with no receipt gets a new one');
      assert.deepEqual([kept[4].id, kept[4].status, kept[4].cost, kept[4].args], [store.get(b)?.receipt, 'failed', null, { query: 'never written' }]);
      assert.equal((JSON.parse(await readFile(join(state, 'jobs', `${a}.json`), 'utf8')) as Job).receipt, own.id, 'the job file records it');
    } finally { store.close(); }
  } finally {
    if (saved === undefined) delete process.env.DIG_STATE_DIR; else process.env.DIG_STATE_DIR = saved;
    await rm(state, { recursive: true, force: true });
  }
});

test('jobs that finished more than 24 hours ago are removed, at start and later; running and recent jobs are kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dig-jobs-age-'));
  try {
    const now = Date.parse('2026-11-12T12:00:00Z'); const hour = 60 * 60_000;
    const job = (id: string, finishedAgo: number | null): Job => {
      const at = new Date(now - (finishedAgo ?? 0) - 60_000).toISOString(); const end = finishedAgo === null ? undefined : new Date(now - finishedAgo).toISOString();
      return { id, dig: 'project-abcdef/2026-11-12-1200-q', project: '/nowhere', source: 'x', tool: 'xsearch', argsHash: argsHash({ query: id }), args: { query: id }, declared: ['query'], status: finishedAgo === null ? 'working' : 'completed', createdAt: at, lastUpdatedAt: end ?? at, ...(end ? { finishedAt: end, result: { content: [{ type: 'text', text: id }] }, receipt: 'c-1', cost: [] } : {}) };
    };
    const old = 'job-OOOOOOOOOOOOOOOOOOOOOO', recent = 'job-RRRRRRRRRRRRRRRRRRRRRR';
    for (const item of [job(old, 25 * hour), job(recent, 23 * hour)]) await writeFile(join(dir, `${item.id}.json`), JSON.stringify(item));
    await writeFile(join(dir, 'not-a-job.json'), '{}');
    const store = await new JobStore(dir).open(now);
    try {
      assert.deepEqual((await readdir(dir)).sort(), [`${recent}.json`, 'not-a-job.json']);
      assert.equal(store.get(old), undefined); assert.equal(store.get(recent)?.status, 'completed');
      await store.sweep(now + 2 * hour);
      assert.deepEqual(await readdir(dir), ['not-a-job.json']);
      assert.equal(store.get(recent), undefined);
      // A running job is never removed by age.
      let release!: () => void; const held = new Promise<void>(done => { release = done; });
      const running = await store.start({ dig: 'project-abcdef/2026-11-12-1200-q', project: '/nowhere', source: 'x', tool: 'xsearch', args: { query: 'held' }, redacted: { query: 'held' }, declared: ['query'] }, async () => { await held; return { result: { content: [{ type: 'text', text: 'done' }] }, status: 'completed', receipt: null, cost: [] }; });
      await store.sweep(Date.now() + 48 * hour);
      assert.equal(store.get(running.id)?.status, 'working');
      release(); assert.equal((await store.wait(running.id, Infinity))?.status, 'completed');
      await store.sweep(Date.now() + 25 * hour);
      assert.equal(store.get(running.id), undefined);
    } finally { store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pre-existing trailing-hyphen digs use safeSegment for receipt adoption, readDigCalls and resource links', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-jobs-trailing-')); const project = join(state, 'project'); await mkdir(project);
  const saved = process.env.DIG_STATE_DIR; process.env.DIG_STATE_DIR = state;
  try {
    const c = await loadConfig();
    const folder = projectFolder(project);
    const digId = `2026-11-12-1200-${'a'.repeat(48)}-`;
    const digDir = join(c.library, folder, 'digs', digId);
    await mkdir(digDir, { recursive: true });
    await writeFile(join(digDir, 'dig.md'), `---\ndig: ${JSON.stringify(digId)}\nquestion: "Pre-existing trailing hyphen"\nproject: ${JSON.stringify(project)}\nmode: composed\nstarted_at: "2026-11-12T12:00:00.000Z"\nsession: ${JSON.stringify(digId)}\n---\n# Pre-existing trailing hyphen\n`);
    const handle = `${folder}/${digId}`;
    const safeSession = safeSegment(digId, SESSION_UNAVAILABLE);
    assert.notEqual(safeSession, digId);
    const t0 = Date.parse('2026-11-12T12:00:00Z');
    const own = await recordCall(c, project, digId, { tool: 'xsearch', source: 'x', args: { query: 'legacy-hyphen' }, declared: ['query'], at: new Date(t0 + 1000).toISOString(), ms: 500, status: 'success', cost: [{ amount: 0.01, unit: 'USD' }], responses: [{ label: 'search', status: 200, body: { ok: true } }], session: digId });
    // JobStore.open() adopts the existing receipt stored under safeSegment(digId) without writing a duplicate.
    const jobId = 'job-TTTTTTTTTTTTTTTTTTTTTT';
    const working: Job = { id: jobId, dig: handle, project, source: 'x', tool: 'xsearch', argsHash: argsHash({ query: 'legacy-hyphen' }), args: { query: 'legacy-hyphen' }, declared: ['query'], status: 'working', createdAt: new Date(t0).toISOString(), lastUpdatedAt: new Date(t0).toISOString() };
    await mkdir(join(state, 'jobs'), { recursive: true });
    await writeFile(join(state, 'jobs', `${jobId}.json`), JSON.stringify(working));
    const store = await new JobStore(join(state, 'jobs')).open(t0 + 60_000);
    try {
      assert.equal(store.get(jobId)?.receipt, own.id);
      const calls = await readDigCalls(c, { handle, project, dig: digId, folder, path: digDir });
      assert.equal(calls?.length, 1);
      assert.equal(calls?.[0].id, own.id);
    } finally { store.close(); }
    // resource_link URIs use safeSegment so they resolve cleanly through readLibraryFile.
    const xTool = SOURCE_TOOLS.find(t => t.name === 'x')!;
    const formatted = formatResult({ c, tool: xTool, action: 'xsearch', spec: {} as never, args: { query: 'legacy-hyphen' }, dig: { handle, project, dig: digId, folder, path: digDir } }, { outcome: { status: 'success', text: 'ok' }, images: [], call: { id: own.id, raw: own.raw }, retentionError: null, digCost: null });
    const links = formatted.content.filter((b): b is { type: 'resource_link'; uri: string; name: string } => b.type === 'resource_link');
    assert.equal(links.length, 2);
    for (const link of links) {
      const rel = decodeURIComponent(link.uri.replace(/^dig:\/\/library\//, ''));
      assert.ok(rel.startsWith(`${folder}/sessions/${safeSession}/`), rel);
      const read = await readLibraryFile(c, rel);
      assert.ok(read.text.length > 0);
    }
  } finally {
    if (saved === undefined) delete process.env.DIG_STATE_DIR; else process.env.DIG_STATE_DIR = saved;
    await rm(state, { recursive: true, force: true });
  }
});

test('streaming xsearch rounds emit live MCP progress notifications and in-memory job/task/status updates without persisting new job fields', async () => {
  const space = await workspace('jobs-progress', SETUP);
  try {
    const { token } = await serve(space, { DIG_INLINE_WAIT_MS: '5000' });
    await writeFile(join(space.state, 'provider-sse-ms'), '120');

    // Legacy 2025-era client and modern 2026-07-28 client both receive notifications/progress when supplying onprogress.
    for (const [label, connect] of [['legacy', connectLegacy], ['modern', connectModern]] as const) {
      const client = await connect(space, token);
      try {
        const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: `Progress test ${label}` } })).structuredContent as { dig: string };
        const seen: Array<{ progress: number; message?: string }> = [];
        const onprogress = (p: { progress: number; message?: string }) => { seen.push({ progress: p.progress, message: p.message }); };
        const req = { name: 'x', arguments: { dig, action: 'xsearch', args: { query: `progress-${label}` } } };
        const res = label === 'legacy'
          ? await (client as any).callTool(req, undefined, { onprogress })
          : await (client as any).callTool(req, { onprogress });
        assert.match(text(res), HEAD);
        assert.equal(seen.length, 2, `${label} received both search rounds: ${JSON.stringify(seen)}`);
        assert.equal(seen[0].progress, 1);
        assert.equal(seen[0].message, 'Search round 1 (x_semantic_search): "local-first xsearch progress"');
        assert.equal(seen[1].progress, 2);
        assert.equal(seen[1].message, 'Search round 2 (x_keyword_search): "from:example dig"');
      } finally { await client.close(); }
    }

    // While a streaming task runs, tasks/get, job({ id }), /status and dig status surface live progress in memory only.
    await writeFile(join(space.state, 'provider-sse-ms'), '700');
    const client = await connectModern(space, token);
    try {
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Progress while running' } })).structuredContent as { dig: string };
      const started = await call(space, token, dig, { query: 'progress-task' }, { tasks: true });
      const id = started.result.taskId as string;
      const got = await eventually(async () => {
        const res = await rpc(space, token, 'tasks/get', { taskId: id });
        return typeof res.result?.statusMessage === 'string' && res.result.statusMessage.includes('Search round 1') ? res.result : null;
      }, 'tasks/get did not report live search round');
      assert.equal(got.status, 'working');
      assert.match(got.statusMessage, /xsearch: Search round \d+ \(x_(?:semantic|keyword)_search\):/);

      const pending = await client.callTool({ name: 'job', arguments: { id } });
      assert.match(text(pending), /Latest: Search round \d+ \(x_(?:semantic|keyword)_search\):/);

      const status = await run(space, ['status']);
      assert.match(status.stdout, new RegExp(`${id} xsearch \\(x\\) for \\d+ s — Search round \\d+ \\(x_(?:semantic|keyword)_search\\):`));

      // Durable job JSON on disk keeps its exact contract with no persisted progress field.
      const disk = await jobFile(space, id) as unknown as Record<string, unknown>;
      assert.equal('progress' in disk, false, 'progress stays in memory and is never persisted to job files');

      const done = await eventually(async () => {
        const res = await rpc(space, token, 'tasks/get', { taskId: id });
        return res.result?.status === 'completed' ? res.result : null;
      }, 'streaming task did not finish');
      assert.match(text(done.result), HEAD);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});
