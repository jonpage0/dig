import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('direct social reads use existing source enablement, native receipt ownership and redaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-direct-social-'));
  const state = join(root, 'state'); await mkdir(state);
  const secret = 'native-social-test-secret';
  await writeFile(join(state, 'keys.env'), `SCRAPECREATORS_API_KEY=${secret}\n`, { mode: 0o600 });
  await writeFile(join(state, 'config.toml'), '[sources]\nenabled = ["tiktok", "instagram"]\n');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', resolve('test/direct-social-fetch.mjs'), resolve('plugin/dist/server.mjs')], cwd: root, env: { DIG_STATE_DIR: state, PATH: process.env.PATH }, stderr: 'pipe' });
  const client = new Client({ name: 'direct-social-proof', version: '1' });
  const call = (name, args) => client.callTool({ name, arguments: args, _meta: { threadId: 'direct-social-worker' } });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(t => t.name);
    assert(names.includes('tiktok_read')); assert(names.includes('instagram_read'));
    for (const source of ['tiktok', 'instagram']) {
      const info = (await call('source_info', { source })).structuredContent.sources[0];
      assert(info.methods[0].tools.includes(`${source}_read`));
    }
    const a = await call('tiktok_read', { project: root, kind: 'post', url: 'https://www.tiktok.com/@fixture/photo/12345' });
    const b = await call('instagram_read', { project: root, kind: 'posts', handle: 'fixture' });
    assert.equal(a.isError, undefined); assert.equal(a.structuredContent.status, 'success');
    assert.equal(b.isError, undefined); assert.equal(b.structuredContent.status, 'partial');
    const live = (await call('library_list', { project: root })).structuredContent.live;
    for (const result of [a, b]) {
      assert.deepEqual(result.structuredContent.call.cost, [{ amount: 1, unit: 'credits' }]);
      assert(!JSON.stringify(result).includes(secret));
      const rawFile = live.find(c => c.id === result.structuredContent.call.id).rawFile;
      const raw = (await call('library_read', { file: rawFile })).structuredContent;
      assert.equal(raw.nextOffset, null); assert(!raw.text.includes(secret)); assert(raw.text.includes('[redacted]'));
    }
    assert.deepEqual(live.map(c => c.source).sort(), ['instagram', 'tiktok']);
    await call('settings.update', { set: { tiktok_enabled: false } });
    const remaining = (await client.listTools()).tools.map(t => t.name);
    assert(!remaining.includes('tiktok_read')); assert(remaining.includes('instagram_read'));
    const disabled = await call('tiktok_read', { project: root, kind: 'post', url: 'https://www.tiktok.com/@fixture/photo/12345' });
    assert.equal(disabled.isError, true);
  } finally { await client.close(); }
});
