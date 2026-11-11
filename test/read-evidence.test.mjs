import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidence, sentenceText } from '../src/ui/evidence/index.mjs';
import { readHackerNews } from '../src/ui/evidence/hackernews.mjs';

const context = { label: source => source };
const said = (receipt, bodies) => { const e = evidence({ status: 'success', ...receipt }, bodies, context); return { text: sentenceText(e), items: e.items }; };
const repoMeta = { full_name: 'acme/widget', html_url: 'https://github.com/acme/widget', default_branch: 'main', private: false, visibility: 'public', size: 54321, stargazers_count: 10 };
const commit = { sha: '0123', commit: { committer: { date: '2026-09-05T00:30:56Z' } } };

test('github_read is sized by the file it read, or the entries of the directory, not by the repository', () => {
  const file = said({ tool: 'github_read', source: 'github', args: { repo: 'acme/widget', path: 'src/index.ts' } }, [repoMeta, commit, { type: 'file', encoding: 'base64', size: 49, sha: 'blob123', content: 'bGluZQ==' }]);
  assert.match(file.text, /49 B|49 bytes/); assert.doesNotMatch(file.text, /53 KB|KB/);
  const dir = said({ tool: 'github_read', source: 'github', args: { repo: 'acme/widget' } }, [repoMeta, commit, { type: 'dir', entries: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }]);
  assert.match(dir.text, /3 entries/);
});

test('hackernews_read reads as a read of the item and its comments, not a search', () => {
  const tree = { id: 1, title: 'Story', author: 'pg', points: 5, children: [{ id: 2, text: 'a', children: [{ id: 3, text: 'b', children: [] }] }, { id: 4, text: 'c', children: [] }] };
  const out = said({ tool: 'hackernews_read', source: 'hackernews', args: { item: '1' } }, [tree]);
  assert.doesNotMatch(out.text, /[Ss]earched/); assert.match(out.text, /read Hacker News item/i); assert.match(out.text, /3 comments/); assert.equal(out.items[0]?.title, 'Story');
});

test('the Polymarket history and resolution reads say what they read', () => {
  const history = said({ tool: 'polymarket_history', source: 'polymarket', args: { token_id: '123', interval: '1w' } }, [{ data: [{ price: 0.4, timestamp: 1 }, { price: 0.5, timestamp: 2 }], pagination: { has_more: true, next_cursor: 'n' } }]);
  assert.doesNotMatch(history.text, /[Ss]earched|no preview items/); assert.match(history.text, /price history/i); assert.match(history.text, /123/); assert.match(history.text, /2 price points/);
  const resolution = said({ tool: 'polymarket_resolution', source: 'polymarket', args: { event_id: '77' } }, [{ data: [{ status: 'resolved' }] }]);
  assert.doesNotMatch(resolution.text, /[Ss]earched|no preview items/); assert.match(resolution.text, /resolution/i); assert.match(resolution.text, /77/); assert.match(resolution.text, /resolved/);
});

test('a Hacker News search still marks the threads it read', () => {
  const e = readHackerNews({ tool: 'hackernews', status: 'success', args: { query: 'x' } }, [{ hits: [{ objectID: '1', title: 'T', points: 3 }], nbHits: 1 }, { id: 1, children: [{ id: 2, text: 'a', children: [] }] }]);
  assert.ok(e.items[0].meta.includes('thread read')); assert.match(e.result, /1 thread read/);
});
