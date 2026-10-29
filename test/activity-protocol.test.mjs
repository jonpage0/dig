import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('native snapshot shows a running provider call before its receipt, then replaces it with the retained outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-active-protocol-'));
  await writeFile(join(root, 'config.toml'), '[sources]\nenabled = ["x"]\n');
  await writeFile(join(root, 'keys.env'), 'XAI_API_KEY=activity-fixture\n');
  const client = new Client({ name: 'activity-proof', version: '1' });
  let pending;
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args, _meta: { threadId: 'activity-chat' } })).structuredContent;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', resolve('test/activity-fetch.mjs'), resolve('plugin/dist/server.mjs')], cwd: root, env: { DIG_STATE_DIR: root, DIG_ACTIVITY_GATE: root, PATH: process.env.PATH }, stderr: 'pipe' }));
    const before = (await call('library_revision')).revision;
    pending = call('xsearch', { project: root, query: 'This query must not enter active metadata' });
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await access(join(root, 'started')); break; } catch {}
      assert.ok(Date.now() < deadline, 'fixture started');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const during = await call('library_snapshot');
    assert.equal(during.activeCalls.length, 1);
    assert.deepEqual([during.activeCalls[0].source, during.activeCalls[0].tool, during.activeCalls[0].session], ['x', 'xsearch', 'activity-chat']);
    assert.equal(during.activeCalls[0].args, undefined);
    assert.equal(during.live.length, 0, 'active observation is not a retained receipt');
    assert.notEqual((await call('library_revision')).revision, before);
    await writeFile(join(root, 'release'), 'go'); const result = await pending;
    assert.equal(result.status, 'success', result.text);
    const after = await call('library_snapshot');
    assert.deepEqual(after.activeCalls, []); assert.equal(after.live.length, 1); assert.equal(after.live[0].status, 'success');
  } finally {
    await writeFile(join(root, 'release'), 'go');
    await pending?.catch(() => {}); await client.close(); await rm(root, { recursive: true, force: true });
  }
});
