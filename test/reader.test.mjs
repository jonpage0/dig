import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createCatalog } from '../src/ui/catalog.mjs';
import { documentView, rawView } from '../src/ui/reader.mjs';
import { evidence, sentenceText } from '../src/ui/evidence/index.mjs';

// The shared reader islands the React library mounts for reports and retained originals, rendered into a real DOM.
const window = new Window({ url: 'http://dig.test/' });
globalThis.document = window.document;
const walk = root => [...root.querySelectorAll('*')];
const report = id => `p/digs/${id}/hackernews.md`;
const catalogOf = sources => createCatalog(sources ?? [{ id: 'hackernews', label: 'Hacker News' }, { id: 'commerce', label: 'Commerce' }]);
const rawCall = { id: 'call-1', at: '2026-10-04T12:01:00.000Z', ms: 900, tool: 'hackernews', source: 'hackernews', status: 'success', args: { query: 'sqlite' }, cost: [], session: 't', rawFile: 'p/sessions/t/raw/call-1.json', claimedBy: report('A') };

test('reports render Markdown structure without executing or loading report HTML, and the source card stays source-reported', () => {
  const body = ['---', 'title: "Hacker News research"', 'agent: hackernews', 'generated_at: "2026-10-04T12:02:00.000Z"', '---',
    '```yaml', 'source_card:', '  source: "hackernews"', '  status: "complete"', '  evidence_grade: "medium"', '  strongest_findings:', '    - "Three stories returned."', '  contradictions: []', '  confidence: "high"', '```',
    '## Summary', '', 'Some **bold** and `code` <script>alert(1)</script>', '', '| Title | Points |', '| --- | ---: |', '| WAL2 | 444 |', '',
    '[bad](javascript:alert(1)) [ok](https://example.com/a) ![pic](https://example.com/p.png) <img src=x onerror=alert(1)>'].join('\n');
  const doc = documentView(report('A'), body, catalogOf()); const elements = walk(doc);
  assert.ok(!elements.some(e => ['SCRIPT', 'IMG', 'IFRAME'].includes(e.tagName)));
  assert.match(doc.textContent, /<script>alert\(1\)<\/script>/);
  assert.deepEqual(elements.filter(e => e.tagName === 'A').map(e => e.href), ['https://example.com/a', 'https://example.com/p.png']);
  assert.ok(elements.some(e => e.tagName === 'STRONG' && e.textContent === 'bold'));
  assert.deepEqual(elements.filter(e => e.tagName === 'TH').map(e => e.textContent), ['Title', 'Points']);
  assert.equal(elements.find(e => e.tagName === 'TD' && e.textContent === '444').getAttribute('data-align'), 'right');
  const card = elements.find(e => e.className === 'source-card');
  assert.match(card.textContent, /Three stories returned\./);
  assert.match(doc.textContent, /Method Hacker News/);
});

test('retained responses read as source evidence and keep their original JSON', () => {
  const generic = { ...rawCall, id: 'call-2', tool: 'commerce_search', source: 'commerce', rawFile: 'p/sessions/t/raw/call-2.json' };
  const doc = rawView(rawCall.rawFile, JSON.stringify({ tool: 'hackernews', at: rawCall.at, responses: [{ label: 'search', status: 200, body: { nbHits: 108, hits: [{ objectID: '38988949', title: 'SQLite: Wal2 Mode', author: 'finallyy', points: 444, num_comments: 96, created_at: '2024-01-14T09:42:18Z' }] } }] }), rawCall, catalogOf());
  assert.match(doc.textContent, /Searched Hacker News for “sqlite” → 1 of 108 stories/);
  assert.ok(walk(doc).some(e => e.tagName === 'A' && e.href === 'https://news.ycombinator.com/item?id=38988949'));
  assert.ok(walk(doc).some(e => e.tagName === 'DETAILS' && /Original JSON/.test(e.textContent)));
  const plain = rawView(generic.rawFile, JSON.stringify({ tool: 'commerce_search', at: generic.at, responses: [{ label: 'search', status: 200, body: { products: [] } }] }), generic, catalogOf());
  assert.match(plain.textContent, /No source-specific view applies/);
  assert.equal(walk(plain).find(e => e.tagName === 'DETAILS' && /Original JSON/.test(e.textContent)).getAttribute('open'), '');
});

test('a failed source preview keeps the complete retained JSON readable', () => {
  const receipt = { ...rawCall, source: 'reddit', tool: 'reddit' };
  const original = { tool: 'reddit', responses: [{ label: 'search', status: 200, body: { posts: [{ id: 'malformed-date', title: 'Retained record', created_utc: 1e20 }] } }] };
  const doc = rawView(receipt.rawFile, JSON.stringify(original), receipt, catalogOf());
  const json = walk(doc).find(e => e.className === 'raw-json');
  assert.equal(json?.getAttribute('open'), '');
  assert.deepEqual(JSON.parse([...json.children].find(e => e.tagName === 'PRE').textContent), original);
});

test('X API responses preview as posts with author, time, text and counts, and the original JSON stays reachable', () => {
  const xCall = { ...rawCall, id: 'call-x', tool: 'x_post', source: 'x', args: { posts: ['https://x.com/jack/status/20'] }, rawFile: 'p/sessions/t/raw/call-x.json' };
  const doc = rawView(xCall.rawFile, JSON.stringify({ tool: 'x_post', at: xCall.at, responses: [{ label: 'post lookup', status: 200, body: {
    data: [{ id: '20', text: 'just setting up my twttr', author_id: '12', created_at: '2006-03-21T20:50:14.000Z', public_metrics: { like_count: 290000, repost_count: 120000, reply_count: 18000, quote_count: 5000, bookmark_count: 900, impression_count: 0 } }],
    includes: { users: [{ id: '12', username: 'jack', name: 'jack' }] },
  } }] }), xCall, catalogOf([{ id: 'hackernews', label: 'Hacker News' }, { id: 'x', label: 'X' }]));
  assert.match(doc.textContent, /Read X post https:\/\/x\.com\/jack\/status\/20 → 1 post/);
  const entry = walk(doc).find(e => e.className === 'evidence-item');
  assert.equal(entry.textContent, 'jack @jackMar 21, 2006 · 290K likes · 120K reposts · 18K replies · 5K quotes · 0 viewsjust setting up my twttr');
  assert.ok(walk(entry).some(e => e.tagName === 'A' && e.href === 'https://x.com/jack/status/20'));
  assert.equal(walk(doc).find(e => e.className === 'raw-json').getAttribute('open'), null);
});

test('X API accounts, counts, News stories, trends, Spaces, Communities and TikHub copies read as source evidence', () => {
  const read = (tool, args, body, status = 'success') => evidence({ tool, source: 'x', status, args }, [body], { label: id => id });
  const accounts = read('x_users', { handles: ['jack'] }, { data: [{ id: '12', username: 'jack', name: 'jack', description: 'Bio text', verified: true, verified_type: 'blue', public_metrics: { followers_count: 6500000, post_count: 29000 } }] });
  assert.equal(sentenceText(accounts), 'Looked up X accounts @jack → 1 account');
  assert.deepEqual([accounts.items[0].title, accounts.items[0].url, accounts.items[0].meta, accounts.items[0].excerpt], ['jack @jack', 'https://x.com/jack', ['6.5M followers', '29K posts', 'verified blue'], 'Bio text']);
  const counts = read('x_count_posts', { query: 'dig' }, { data: [{ start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z', post_count: 120 }, { start: '2026-10-02T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z', post_count: 30 }], meta: { total_post_count: 150 } });
  assert.equal(sentenceText(counts), 'Counted X posts for “dig” (last 7 days, per day) → 150 posts counted in 2 time buckets');
  assert.deepEqual(counts.items.map(i => i.title), ['2026-10-01 00:00 UTC: 120 posts', '2026-10-02 00:00 UTC: 30 posts']);
  const stories = read('x_news', { query: 'nebius' }, { data: [{ id: '1', name: 'Nebius stock plunges', hook: 'A hook.', summary: 'Shares fell.', category: 'News', cluster_posts_results: [{ post_id: '9' }] }] });
  assert.equal(sentenceText(stories), 'Searched X News for “nebius” → 1 story');
  assert.deepEqual([stories.items[0].excerpt, stories.items[0].meta, stories.items[0].links], ['A hook.', ['News', '1 post'], [{ label: 'Post 1', url: 'https://x.com/i/status/9' }]]);
  const trends = read('x_explore', { kind: 'trends' }, { data: [{ trend_name: '#Dig', tweet_count: 12345 }] });
  assert.equal(sentenceText(trends), 'Read X trends worldwide → 1 trend');
  assert.deepEqual([trends.items[0].url, trends.items[0].meta], ['https://x.com/search?q=%23Dig', ['12.3K posts']]);
  const spaces = read('x_explore', { kind: 'spaces', query: 'ai', state: 'live' }, { data: [{ id: '1zqKVXPQhvZJB', title: 'AI talk', state: 'live', participant_count: 420, host_ids: ['12'] }], includes: { users: [{ id: '12', username: 'jack' }] } });
  assert.equal(sentenceText(spaces), 'Searched X Spaces for “ai” (live) → 1 Space');
  assert.deepEqual([spaces.items[0].url, spaces.items[0].meta], ['https://x.com/i/spaces/1zqKVXPQhvZJB', ['live', '420 participants', 'hosts @jack']]);
  const communities = read('x_explore', { kind: 'communities', query: 'anime' }, { data: [{ id: 'Q29tbXVuaXR5OjE=', name: 'Anime Community', member_count: 39915, access: 'Public', join_policy: 'Open', description: 'Welcome' }] });
  assert.equal(sentenceText(communities), 'Searched X Communities for “anime” → 1 Community');
  assert.deepEqual([communities.items[0].meta, communities.items[0].excerpt], [['Public', '39.9K members', 'Open'], 'Welcome']);
  const tikhub = read('x_post', { posts: ['20'] }, { code: 200, data: { id: '20', text: 'TikHub copy', author: { screen_name: 'jack', name: 'jack' }, likes: 5 } });
  assert.equal(sentenceText(tikhub), 'Read X post 20 → 1 post via TikHub');
  assert.deepEqual([tikhub.items[0].title, tikhub.items[0].excerpt], ['jack @jack', 'TikHub copy']);
  // Signed-in reads keep the account and folder lookups beside the posts; only the posts are preview items.
  const saved = evidence({ tool: 'x_bookmarks', source: 'x', status: 'success', args: { folder: 'Tools', match: 'shovel' } }, [{ data: { id: '99', username: 'me', name: 'Me' } }, { data: [{ id: '7', name: 'Tools' }] }, { data: [{ id: '31', text: 'A shovel', author_id: '12' }], includes: { users: [{ id: '12', username: 'jack', name: 'jack' }] } }], { label: id => id });
  assert.equal(sentenceText(saved), 'Read X bookmark folder “Tools” (matching “shovel”) → 1 post');
  const liked = read('x_likes', { limit: 50 }, { data: [{ id: '32', text: 'Liked', author_id: '12' }], includes: { users: [{ id: '12', username: 'jack', name: 'jack' }] } });
  assert.equal(sentenceText(liked), 'Read X liked posts (up to 50 posts) → 1 post');
  const found = read('x_explore', { kind: 'communities', query: 'shovels' }, { code: 200, data: { communities: [{ community_id: '18', name: 'Shovel Makers', member_count: 1200 }], next_cursor: '' } });
  assert.equal(sentenceText(found), 'Searched X Communities for “shovels” → 1 Community via TikHub');
  assert.deepEqual([found.items[0].url, found.items[0].meta], ['https://x.com/i/communities/18', ['via TikHub', '1.2K members']]);
  const signedSearch = read('x_explore', { kind: 'communities', query: 'shovels' }, { data: [{ id: '18', name: 'Shovel Makers' }] });
  assert.equal(sentenceText(signedSearch), 'Searched X Communities for “shovels” → 1 Community');
  const timeline = read('x_community', { community: '18' }, { code: 200, data: { timeline: [{ tweet_id: '33', text: 'Community post', author: { screen_name: 'jack', name: 'jack' }, favorites: 4 }], cursor: 'next' } });
  assert.equal(sentenceText(timeline), 'Read X Community 18 (25 posts) → 1 post via TikHub');
  assert.deepEqual([timeline.items[0].url, timeline.items[0].excerpt], ['https://x.com/jack/status/33', 'Community post']);
  const info = read('x_community', { community: '18', posts: 0 }, { code: 200, data: { id: '18', name: 'Shovel Makers', member_count: 1200, description: 'People who make shovels', status: 'failed' } });
  assert.equal(sentenceText(info), 'Read X Community 18 (details only) → 1 Community via TikHub');
  // An unreadable shape is not called empty: the reader says so and the view opens the original JSON.
  assert.equal(sentenceText(read('x_search_posts', { query: 'dig' }, { unexpected: true })), 'Searched X posts for “dig” (last 7 days) → no preview items recognized; inspect the original response');
});

test('a retained response names its call’s outcome in the same words as the other pages, with its status fill', () => {
  const doc = rawView(rawCall.rawFile, JSON.stringify({ tool: 'hackernews', responses: [] }), { ...rawCall, status: 'partial' }, catalogOf());
  const state = walk(doc).find(e => e.className === 'state');
  assert.deepEqual([state.textContent, state.getAttribute('data-pattern')], ['Partial', 'stripes']);
});
