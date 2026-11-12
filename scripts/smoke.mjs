// One keyless call through the service, as a host makes it, in a temporary state folder and on a free port: start
// `dig mcp` (which starts the service), dig_start, one Hacker News action, check its receipt, its retained original
// and the links in its result, save a report, read it back, stop the service. Needs npm run build first.
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const DIG = resolve('dist/dig.mjs');
try { await access(DIG); } catch { console.error(`The dig command is missing (${DIG}). Run npm run build first.`); process.exit(2); }
const root = resolve('verification'); await mkdir(root, { recursive: true });
const state = await mkdtemp(join(root, 'smoke-state-'));
const port = await new Promise((done, fail) => { const server = createServer(); server.once('error', fail); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); }); });
const env = { DIG_STATE_DIR: state, DIG_PORT: String(port), PATH: process.env.PATH, HOME: process.env.HOME };
const dig = args => new Promise((done, fail) => { const child = spawn(process.execPath, [DIG, ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] }); let out = ''; child.stdout.on('data', chunk => { out += chunk; }); child.once('error', fail); child.once('exit', code => done({ code, out })); });
const client = new Client({ name: 'dig-smoke', version: '1.0.0' });
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content.find(block => block.type === 'text')?.text ?? `${name} failed`);
  return response;
};
const readWhole = async file => {
  let offset = 0; let text = ''; let path;
  do { const part = (await call('library_read', { file, offset })).structuredContent; text += part.text; path = part.path; offset = part.nextOffset; } while (offset !== null);
  return { path, text };
};
// A passing run removes its state folder (its evidence summary stays in full-port-live-smoke.json); a failing run keeps
// the folder and prints its path for inspection. The service is stopped either way.
let passed = false;
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIG, 'mcp'], env, stderr: 'inherit' }));
  const question = 'What do three returned Hacker News comments about local-first software establish?';
  const started = (await call('dig_start', { project: process.cwd(), question })).structuredContent;
  const response = await call('hackernews', { dig: started.dig, action: 'hackernews', args: { query: 'local-first', type: 'comment', sort: 'relevance', days: 365, limit: 3 } });
  // Content only: the first line names the status and the receipt, then come the links to the receipts and the original.
  const first = response.content[0].text.split('\n', 1)[0];
  const receiptId = /^Hacker News · hackernews · success · receipt (c-\S+) · cost: no charge recorded · dig so far: /.exec(first)?.[1];
  if (!receiptId) throw new Error(`Retrieval did not succeed with a receipt: ${first}`);
  const [calls, rawLink] = response.content.filter(block => block.type === 'resource_link');
  if (!calls?.uri.endsWith(encodeURIComponent('/calls.jsonl')) || !rawLink?.uri.endsWith(encodeURIComponent(`/raw/${receiptId}.json`))) throw new Error('The result does not link its receipts and its retained original');
  const receipt = (await client.readResource({ uri: calls.uri })).contents[0].text.trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.id === receiptId);
  if (!receipt || receipt.dig !== started.dig.split('/')[1] || receipt.tool !== 'hackernews' || receipt.status !== 'success') throw new Error('The receipt is missing or does not name its dig');
  const linked = (await client.readResource({ uri: rawLink.uri })).contents[0].text;
  const rawFile = decodeURIComponent(rawLink.uri.slice('dig://library/'.length));
  const raw = await readWhole(rawFile);
  if (raw.text !== linked) throw new Error('The linked original and library_read differ');
  const hits = JSON.parse(raw.text).responses.find(entry => entry.label === 'search')?.body?.hits;
  if (!hits?.length) throw new Error('No returned comments; do not claim evidence');
  const rows = hits.map(hit => `- Comment ${hit.objectID} by ${hit.author ?? 'author unavailable'} on “${hit.story_title ?? 'story unavailable'}” — ${hit.created_at ?? 'date unavailable'}; https://news.ycombinator.com/item?id=${hit.objectID}`).join('\n');
  const content = '```yaml\nsource_card:\n  source: "hackernews"\n  status: "complete"\n  report_path: null\n  evidence_grade: "low"\n  strongest_findings: []\n  contradictions: []\n  negative_evidence: []\n  follow_up_targets: []\n  confidence: "low"\n```\n\n## Summary\nOne real, free Algolia comment search returned a bounded sample mentioning local-first software. This smoke establishes the service round trip, saving and retained metadata, not representative sentiment or technical accuracy.\n\n## Evidence Highlights\n' + rows + '\n\n## Needs Follow-Up\nRead the surrounding threads before making substantive claims. The complete original response is retained at ' + rawFile + '.\n\n## Negative Evidence (when relevant)\nNo negative topic evidence established by this relevance-ranked sample.\n';
  const saved = (await call('research_save', { dig: started.dig, source: 'hackernews', content, topic: 'service-smoke' })).structuredContent;
  const listed = (await call('library_list', { project: process.cwd(), query: 'three returned' })).structuredContent;
  const item = listed.items.find(entry => entry.dig === started.dig);
  if (!item || item.calls.length !== 1 || item.calls[0].id !== receiptId || item.calls[0].claimedBy !== saved.file) throw new Error('The saved report did not claim its retrieval');
  const report = await readWhole(saved.path);
  if (!report.text.includes(hits[0].objectID)) throw new Error('Report round trip failed');
  const evidence = { at: new Date().toISOString(), version: client.getServerVersion()?.version, dig: started.dig, source: 'hackernews', call: receiptId, report: saved.path, raw: raw.path, results: hits.length, cost: receipt.cost, completeReportRead: true, completeRawRead: true, state };
  await writeFile(join(root, 'full-port-live-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  passed = true;
} finally {
  await client.close().catch(() => {});
  const stopped = await dig(['stop']);
  if (stopped.code !== 0) { passed = false; console.error('Could not stop the service.'); }
  if (passed) await rm(state, { recursive: true, force: true }); else { console.error(`Smoke run failed; its state folder is kept at ${state}`); process.exitCode = 1; }
}
