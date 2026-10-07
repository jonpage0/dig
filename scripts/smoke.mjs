import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve('verification'); await mkdir(root, { recursive: true });
const state = await mkdtemp(join(root, 'smoke-state-'));
const client = new Client({ name: 'live-native-proof', version: '0.2.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('plugin/dist/server.mjs')], cwd: resolve('plugin'), env: { DIG_STATE_DIR: state, PATH: process.env.PATH }, stderr: 'pipe' });
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args, _meta: { threadId: 'isolated-native-smoke' } });
  if (response.isError) throw new Error(response.content[0].text);
  return response;
};
const readWhole = async file => {
  let offset = 0; let text = ''; let path;
  do { const part = (await call('library_read', { file, offset })).structuredContent; text += part.text; path = part.path; offset = part.nextOffset; } while (offset !== null);
  return { path, text };
};
try {
  await client.connect(transport);
  const response = await call('hackernews', { project: process.cwd(), query: 'local-first', type: 'comment', sort: 'relevance', days: 365, limit: 3 });
  const receipt = response.structuredContent.call;
  if (!receipt || response.structuredContent.retentionError) throw new Error('Retrieval was not retained');
  const before = (await call('library_list', { project: process.cwd() })).structuredContent;
  const live = before.live.find(item => item.id === receipt.id);
  if (!live?.rawFile) throw new Error('Direct source call missing from live activity');
  const raw = await readWhole(live.rawFile);
  const hits = JSON.parse(raw.text).responses.find(entry => entry.label === 'search')?.body?.hits;
  if (!hits?.length) throw new Error('No returned comments; do not claim evidence');
  const rows = hits.map(hit => `- Comment ${hit.objectID} by ${hit.author ?? 'author unavailable'} on “${hit.story_title ?? 'story unavailable'}” — ${hit.created_at ?? 'date unavailable'}; https://news.ycombinator.com/item?id=${hit.objectID}`).join('\n');
  const content = '```yaml\nsource_card:\n  source: "hackernews"\n  status: "complete"\n  report_path: null\n  evidence_grade: "low"\n  strongest_findings: []\n  contradictions: []\n  negative_evidence: []\n  follow_up_targets: []\n  confidence: "low"\n```\n\n## Summary\nOne real, free Algolia comment search returned a bounded sample mentioning local-first software. This smoke establishes discovery, direct single-source saving and retained metadata, not representative sentiment or technical accuracy.\n\n## Evidence Highlights\n' + rows + '\n\n## Needs Follow-Up\nRead the surrounding threads before making substantive claims. The complete original response is retained at ' + live.rawFile + '.\n\n## Negative Evidence (when relevant)\nNo negative topic evidence established by this relevance-ranked sample.\n';
  const saved = (await call('research_save', { project: process.cwd(), source: 'hackernews', question: 'What do three returned Hacker News comments about local-first software establish?', content, topic: 'native-plugin-smoke' })).structuredContent;
  const after = (await call('library_list', { project: process.cwd(), query: 'three returned' })).structuredContent;
  const item = after.items.find(item => item.id === saved.dig);
  if (!item || item.calls.length !== 1 || item.calls[0].id !== receipt.id || item.mode !== 'single') throw new Error('Single-source report did not claim its retrieval');
  const report = await readWhole(saved.path);
  if (!report.text.includes(hits[0].objectID)) throw new Error('Report round trip failed');
  const evidence = { at: new Date().toISOString(), dig: saved.dig, source: 'hackernews', call: receipt.id, report: saved.path, raw: raw.path, results: hits.length, cost: receipt.cost, completeReportRead: true, completeRawRead: true, mode: item.mode, state };
  await writeFile(join(root, 'full-port-live-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await client.close(); }
