import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { startDig, recordCall, projectFolder, finishDig, listLibrary } from '../src/library.mjs';

test('dangling receipt links cannot create an outside file, and unanswered digs remain visibly unanswered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dig-native-dangling-'));
  const c = await loadConfig(root); const dig = await startDig(c, root, 'Denied research', 'thread-denied');
  const session = join(c.library, projectFolder(root), 'sessions', 'thread-denied');
  await mkdir(session, { recursive: true });
  const outside = join(root, 'outside-receipt.jsonl'); await symlink(outside, join(session, 'calls.jsonl'));
  await assert.rejects(recordCall(c, root, dig.dig, { tool: 'hackernews', source: 'hackernews', cost: [], responses: [{ label: 'search', status: 200, body: { hits: [] } }], at: new Date().toISOString(), ms: 1, args: {}, status: 'empty', session: 'thread-denied' }), /symbolic link/);
  await assert.rejects(stat(outside), { code: 'ENOENT' });
  await finishDig(c, { project: root, dig: dig.dig, answer: 'Search requires host approval. No provider request ran.', status: 'unanswered', reports: [] });
  const item = (await listLibrary(c)).items[0]; assert.equal(item.status, 'not answered'); assert.match(item.snippet, /requires host approval/);
});
