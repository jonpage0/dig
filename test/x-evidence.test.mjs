import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readX } from '../src/ui/evidence/x.mjs';

const xsearch = (args = {}) => ({ tool: 'xsearch', status: 'success', args: { query: 'demo', ...args } });
const answer = (text, citations) => ({ output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: [] }] }], citations });

test('Grok citations through x.com/i/ have no handle: posts by id, accounts as accounts, and no @i mention lends metrics', () => {
  const body = answer('@ilyasut posted the demo, 12K likes and 1.2M views. @jack replied with 40 likes.', [
    'https://x.com/i/status/1947000000000000000',
    'https://x.com/i/user/12345',
    'https://x.com/jack/status/1947000000000000001',
  ]);
  const { items } = readX(xsearch(), [body]);
  const [byId, user, byJack] = items;
  assert.equal(byId.kind, 'post');
  assert.equal(byId.key, '1947000000000000000');
  assert.equal(byId.title, 'Post 1947000000000000000');
  assert.ok(!byId.meta.some(m => m.includes('@i') || m.includes('as stated by Grok') || m === 'web page'), byId.meta.join(' | '));
  assert.equal(user.kind, 'account');
  assert.equal(user.title, 'Account 12345');
  assert.deepEqual(user.meta, ['account']);
  assert.equal(byJack.title, 'Post by @jack');
  assert.equal(byJack.key, 'jack/1947000000000000001');
  assert.ok(byJack.meta.includes('@jack'));
  assert.ok(byJack.meta.includes('40 likes (as stated by Grok)'));
});

test('a date-only end date is exclusive, so the window shows the last day included; an end with a time of day is left as it is', () => {
  assert.deepEqual(readX(xsearch({ fromDate: '2026-10-28', toDate: '2026-10-29' }), []).action.at(-1), '(Oct 28)');
  assert.deepEqual(readX(xsearch({ fromDate: '2026-10-28', toDate: '2026-11-01' }), []).action.at(-1), '(Oct 28–31)');
  assert.deepEqual(readX(xsearch({ toDate: '2026-10-29' }), []).action.at(-1), '(until Oct 28)');
  const timed = readX({ tool: 'x_search_posts', status: 'success', args: { query: 'demo', start_time: '2026-10-28T00:00:00Z', end_time: '2026-10-29T12:00:00Z' } }, []);
  assert.equal(timed.action.at(-1), '(last 7 days, Oct 28–29)');
});
