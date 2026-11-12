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

test('a follows read lists the accounts X returned as account rows, without the account whose list it is', () => {
  const call = { tool: 'x_follows', status: 'success', args: { handle: '@NASA', direction: 'following', limit: 2 } };
  const lookup = { data: [{ id: '11348282', username: 'NASA', name: 'NASA', public_metrics: { followers_count: 89000000, following_count: 300 } }] };
  const list = { data: [{ id: '500', username: 'follow_0', name: 'Follow 0', description: 'Bio 0', verified: true, verified_type: 'blue', public_metrics: { followers_count: 1000, post_count: 42 } }, { id: '501', username: 'follow_1', name: 'Follow 1' }], meta: { result_count: 2, next_token: 'next' } };
  const read = readX(call, [lookup, list]);
  assert.deepEqual(read.action, ['listed accounts @NASA follows', '(up to 2 accounts)']);
  assert.equal(read.result, '2 accounts');
  assert.deepEqual(read.items.map(item => [item.kind, item.key, item.url]), [['account', '@follow_0', 'https://x.com/follow_0'], ['account', '@follow_1', 'https://x.com/follow_1']]);
  assert.deepEqual(read.items[0].meta, ['1K followers', '42 posts', 'verified blue']);
  assert.deepEqual(readX({ ...call, args: { handle: 'NASA', direction: 'followers', cursor: 'next' } }, [lookup, list]).action, ['listed accounts following @NASA', '(next page)']);
});

test('a pictures call reads each kept note as a picture by its link, saying how many were shown and that none is retained', () => {
  const call = { tool: 'x_images', status: 'partial', args: { images: ['https://pbs.twimg.com/media/A.jpg', 'https://pbs.twimg.com/media/B.jpg'], size: 'large' } };
  const read = readX(call, ['[picture not retained] https://pbs.twimg.com/media/A.jpg?name=large · image/jpeg · 92,711 bytes · shown', '[picture not retained] https://pbs.twimg.com/media/B.jpg?name=large · no media type · size unknown · not shown: the host answered HTTP 404']);
  assert.deepEqual(read.action, ['looked at', '2 X pictures', '(large)']);
  assert.equal(read.result, '1 of 2 pictures shown; pictures are not retained');
  assert.deepEqual(read.items.map(item => [item.kind, item.title, item.url, item.meta]), [
    ['image', 'A.jpg', 'https://pbs.twimg.com/media/A.jpg?name=large', ['shown', 'image/jpeg', '92,711 bytes']],
    ['image', 'B.jpg', 'https://pbs.twimg.com/media/B.jpg?name=large', ['not shown: the host answered HTTP 404', 'no media type', 'size unknown']],
  ]);
  assert.deepEqual(readX({ ...call, status: 'failed' }, []).action[0], 'tried to look at');
});
