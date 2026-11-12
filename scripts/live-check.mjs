// Calls each provider tool once for real through the built server, saves what came back and records when each tool
// last worked. The manifest is test/live/checks.mjs; captures go to verification/live (ignored) unless --out says
// otherwise; test/live/verified.json is the tracked record. Keyless by default: without --keys the server runs with no
// credentials, and a keys.env given with --keys is copied into a temporary state folder that is removed at the end.
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

await import('./typescript.mjs');
const { providerTools } = await import('../src/providers/index.ts');
const { MODULES } = await import('../src/providers/modules.ts');
const { costSummary } = await import('../src/providers/library/cost.ts');
const { costAmounts } = await import('../src/ui/format.mjs');
const { projectFolder } = await import('../src/library.mjs');
const { CHECKS, SKIPPED, EXPENSIVE } = await import('../test/live/checks.mjs');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(root, 'plugin/dist/server.mjs');
const VERIFIED = join(root, 'test/live/verified.json');
const SESSION = 'live-check';
const TIMEOUT_MS = 15 * 60_000;
const WORKED = ['success', 'partial', 'empty'];

const fail = message => { console.error(message); process.exit(2); };
let options;
try {
  ({ values: options } = parseArgs({ options: { paid: { type: 'boolean' }, tool: { type: 'string' }, source: { type: 'string' }, keys: { type: 'string' }, out: { type: 'string' }, list: { type: 'boolean' } } }));
} catch (error) { fail(`${error.message}\nUsage: npm run live-check -- [--paid] [--tool a,b] [--source id,id] [--keys keys.env] [--out dir] [--list]`); }
const names = value => (value ?? '').split(',').map(name => name.trim()).filter(Boolean);

const free = tool => providerTools[tool]?.billing === 'free';
const moduleOf = tool => MODULES.find(module => module.tools.includes(tool));
const checks = new Map(CHECKS.map(check => [check.tool, check]));
const skipped = new Map(SKIPPED.map(entry => [entry.tool, entry.reason]));
const unlisted = Object.keys(providerTools).filter(tool => !checks.has(tool) && !skipped.has(tool));

// What runs and what is left out, with why.
const run = []; const left = [];
const leave = (tool, reason) => { if (!left.some(entry => entry.tool === tool)) left.push({ tool, reason }); };
const take = tool => { if (!run.includes(tool)) run.push(tool); };
const consider = (tool, named) => {
  if (skipped.has(tool)) return leave(tool, skipped.get(tool));
  if (!checks.has(tool)) return leave(tool, 'No entry in test/live/checks.mjs.');
  if (EXPENSIVE.includes(tool) && !named) return leave(tool, 'Expensive: runs only when named with --tool.');
  take(tool);
};
const tools = names(options.tool); const sources = names(options.source);
for (const tool of tools) if (!providerTools[tool]) fail(`Unknown tool: ${tool}`);
for (const id of sources) if (!MODULES.some(module => module.id === id)) fail(`Unknown source: ${id}. Sources: ${MODULES.map(module => module.id).join(', ')}`);
if (tools.length || sources.length) {
  for (const tool of tools) consider(tool, true);
  for (const id of sources) for (const tool of MODULES.find(module => module.id === id).tools) consider(tool, tools.includes(tool));
} else {
  for (const tool of Object.keys(providerTools)) {
    if (!free(tool) && !options.paid && checks.has(tool)) leave(tool, EXPENSIVE.includes(tool) ? 'Paid and expensive: runs only when named with --tool.' : 'Paid: runs with --paid and --keys.');
    else consider(tool, false);
  }
}
const paid = run.filter(tool => !free(tool));

if (options.list) {
  const width = Math.max(...[...run, ...left.map(entry => entry.tool)].map(tool => tool.length));
  console.log(`Would run ${run.length}:`);
  for (const tool of run) console.log(`  ${tool.padEnd(width)}  ${free(tool) ? 'free' : 'paid'}  ${JSON.stringify(checks.get(tool).args)}`);
  console.log(`\nWould skip ${left.length}:`);
  for (const { tool, reason } of left) console.log(`  ${tool.padEnd(width)}  ${reason}`);
  if (paid.length && !options.keys) console.log(`\n${paid.length} paid tool${paid.length === 1 ? '' : 's'} selected: a run needs --keys.`);
  process.exit(0);
}
if (unlisted.length && !tools.length && !sources.length) console.error(`Not in test/live/checks.mjs (add a check or a skip reason): ${unlisted.join(', ')}`);
if (!run.length) fail('Nothing selected to run.');
if (paid.length && !options.keys) fail(`Paid tools need --keys <keys.env>: ${paid.join(', ')}`);
try { await access(SERVER); } catch { fail(`The built server is missing (${SERVER}). Run npm run build first.`); }
const out = resolve(options.out ?? join(root, 'verification/live'));

// The temporary state folder holds credentials when --keys is given: it is removed however the run ends.
const state = await mkdtemp(join(tmpdir(), 'dig-live-check-'));
const removeState = () => rmSync(state, { recursive: true, force: true });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { removeState(); process.exit(130); });
const rows = []; const verified = [];
let version = null;
try {
  await chmod(state, 0o700);
  const project = join(state, 'project'); const home = join(state, 'home');
  await mkdir(project); await mkdir(home);
  const enabled = [...new Set(run.map(tool => moduleOf(tool).id))];
  await writeFile(join(state, 'config.toml'), `[sources]\nenabled = ${JSON.stringify(enabled)}\n`, { mode: 0o600 });
  if (options.keys) {
    try { await copyFile(resolve(options.keys), join(state, 'keys.env')); } catch (error) { throw new Error(`Cannot copy the --keys file (${error.code ?? 'error'})`); }
    await chmod(join(state, 'keys.env'), 0o600);
  }
  // HOME points into the state folder, so a local program such as gh finds no login of its own: credentials come
  // only from --keys.
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: join(root, 'plugin'), env: { DIG_STATE_DIR: state, PATH: process.env.PATH, HOME: home }, stderr: 'ignore' });
  const client = new Client({ name: 'dig-live-check', version: '1' });
  await client.connect(transport);
  try {
    version = client.getServerVersion()?.version ?? null;
    const call = (name, args) => client.callTool({ name, arguments: args, _meta: { threadId: SESSION } }, undefined, { timeout: TIMEOUT_MS });
    const readWhole = async file => {
      let offset = 0; let text = '';
      do { const part = (await call('library_read', { file, offset })).structuredContent; text += part.text; offset = part.nextOffset; } while (offset !== null);
      return text;
    };
    await mkdir(out, { recursive: true });
    for (const tool of run) {
      const { args } = checks.get(tool); const begin = Date.now();
      process.stdout.write(`${tool} … `);
      let result; let error = null;
      try { result = await call(tool, { ...args, project }); } catch (e) { error = e.message; }
      const value = result?.structuredContent; const receipt = value?.call ?? null;
      const status = value?.status ?? 'failed';
      const text = value?.text ?? result?.content?.find(part => part.type === 'text')?.text ?? error ?? '';
      let responses = [];
      if (receipt?.raw) responses = JSON.parse(await readWhole(`${projectFolder(project)}/sessions/${SESSION}/${receipt.raw}`)).responses;
      if (receipt) {
        const capture = { tool, args, at: receipt.at, version, status, ms: receipt.ms, cost: receipt.cost, ...(receipt.knownCost ? { knownCost: receipt.knownCost } : {}), responses };
        const worked = WORKED.includes(status);
        await writeFile(join(out, `${tool}${worked ? '' : '.failed'}.json`), `${JSON.stringify(capture, null, 2)}\n`);
        if (worked) { await unlink(join(out, `${tool}.failed.json`)).catch(() => {}); verified.push({ tool, at: receipt.at.slice(0, 10) }); }
      }
      const row = { tool, status, seconds: ((receipt?.ms ?? Date.now() - begin) / 1000).toFixed(1), receipt, line: WORKED.includes(status) ? '' : String(text).split('\n', 1)[0].slice(0, 200) };
      rows.push(row);
      console.log(`${status} · ${row.seconds}s`);
    }
  } finally { await client.close(); }
} catch (error) {
  console.error(`Live check stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(state, { recursive: true, force: true });
}

if (verified.length) {
  let record = {};
  try { record = JSON.parse(await readFile(VERIFIED, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const { tool, at } of verified) record[tool] = { at, version };
  const sorted = Object.fromEntries(Object.keys(record).sort().map(tool => [tool, record[tool]]));
  await writeFile(VERIFIED, `${JSON.stringify(sorted, null, 2)}\n`);
}

const costOf = receipt => {
  if (!receipt) return 'no receipt';
  if (receipt.cost === null) return `unknown${receipt.knownCost?.length ? ` (at least ${costAmounts(costSummary([{ cost: receipt.knownCost }])).join(' + ')})` : ''}`;
  return receipt.cost.length ? costAmounts(costSummary([receipt])).join(' + ') : 'free';
};
if (rows.length) {
  const width = Math.max(...rows.map(row => row.tool.length)); const statusWidth = Math.max(...rows.map(row => row.status.length));
  console.log('');
  for (const row of rows) console.log(`${row.tool.padEnd(width)}  ${row.status.padEnd(statusWidth)}  ${row.seconds.padStart(6)}s  ${costOf(row.receipt)}${row.line ? `  ${row.line}` : ''}`);
  const counts = {}; for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const summary = costSummary(rows.filter(row => row.receipt).map(row => row.receipt));
  const amounts = costAmounts(summary);
  console.log(`\n${rows.length} call${rows.length === 1 ? '' : 's'}: ${Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(', ')}.`);
  console.log(`Reported cost: ${amounts.length ? amounts.join(' + ') : 'none'}; ${summary.unknownCalls} call${summary.unknownCalls === 1 ? '' : 's'} with unknown cost.`);
  console.log(`Captures: ${out}`);
}
if (rows.some(row => !WORKED.includes(row.status))) process.exitCode = 1;
