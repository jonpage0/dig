import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidence, sentenceText } from '../src/ui/evidence/index.mjs';

const context = { label: source => ({ tiktok: 'TikTok', instagram: 'Instagram', linkedin: 'LinkedIn', telegram: 'Telegram' })[source] ?? source };
const said = (receipt, bodies) => { const e = evidence({ status: 'success', ...receipt }, bodies, context); return { text: sentenceText(e), items: e.items, result: e.result }; };

// Response shapes as the tools read them today (scrapecreators.ts, social_read.ts, social_evidence.ts).
const aweme = { aweme_id: '7', desc: 'Video caption #tag', create_time: 1757980800, share_url: 'https://www.tiktok.com/@creator/video/7', author: { unique_id: 'creator' }, statistics: { play_count: 50, digg_count: 10 } };

test('TikTok and Instagram responses this view cannot read get the plain reading and their original JSON, as Facebook does', () => {
  for (const [receipt, body] of [
    [{ tool: 'scrapecreators_tiktok', source: 'tiktok', args: { query: 'robots' } }, { success: true, search_item_list: [{ aweme_info: aweme }], cursor: 20 }],
    [{ tool: 'tiktok_read', source: 'tiktok', args: { kind: 'post', url: 'https://www.tiktok.com/@creator/video/7' } }, { success: true, aweme_detail: aweme }],
    [{ tool: 'tiktok_read', source: 'tiktok', args: { kind: 'posts', handle: 'creator' } }, { success: true, aweme_list: [aweme], max_cursor: 5 }],
    [{ tool: 'tiktok_top', source: 'tiktok', args: { query: 'robots' } }, { success: true, items: [aweme] }],
    [{ tool: 'scrapecreators_instagram', source: 'instagram', args: { query: 'dogs' } }, { success: true, reels: [{ id: '1', shortcode: 'abc', caption: 'Dogs', like_count: 3 }] }],
    [{ tool: 'scrapecreators_instagram', source: 'instagram', args: { query: 'dogs', mode: 'popular' } }, { success: true, posts: [{ id: '1', caption: 'Dogs', play_count: 9 }] }],
    [{ tool: 'instagram_read', source: 'instagram', args: { kind: 'posts', handle: 'fixture' } }, { success: true, items: [{ id: '1', code: 'abc', caption: { text: 'Feed caption' }, like_count: 4 }], next_max_id: 'n' }],
  ]) {
    const out = said(receipt, [body]);
    assert.deepEqual(out.items, [], receipt.tool);
    assert.equal(out.result, undefined, receipt.tool);
    assert.match(out.text, new RegExp(`^Called ${receipt.tool}`), receipt.tool);
    assert.doesNotMatch(out.text, /[Ss]earched|no preview items/, receipt.tool);
  }
});

test('TikTok and Instagram comment pages keep their rows', () => {
  const tiktok = said({ tool: 'tiktok_comments', source: 'tiktok', args: { url: 'https://www.tiktok.com/@creator/video/7' } }, [{ success: true, comments: [{ cid: '1', text: 'Great video', digg_count: 12, create_time: 1757980800 }], cursor: 20 }]);
  assert.equal(tiktok.items.length, 1); assert.equal(tiktok.items[0].title, 'Great video'); assert.match(tiktok.text, /1 comment/);
  assert.doesNotMatch(tiktok.text, /[Ss]earched/);
  const replies = said({ tool: 'instagram_read', source: 'instagram', args: { kind: 'replies', url: 'https://www.instagram.com/p/abc/', commentId: '1' } }, [{ success: true, comments: [{ id: '2', text: 'Reply', like_count: 3 }] }]);
  assert.equal(replies.items[0]?.title, 'Reply');
});

test('LinkedIn post rows carry the figures the tool reads, and other LinkedIn kinds get the plain reading', () => {
  const search = said({ tool: 'scrapecreators_linkedin', source: 'linkedin', args: { kind: 'search', query: 'ai agents' } }, [{ success: true, posts: [{ url: 'https://www.linkedin.com/posts/1', description: 'A post about agents', author: { name: 'Ada Lovelace' }, likeCount: 1200, commentCount: 34, datePublished: '2026-09-01T10:00:00Z' }] }]);
  assert.match(search.text, /^Searched LinkedIn for “ai agents” → 1 post/);
  assert.equal(search.items[0].title, 'A post about agents'); assert.equal(search.items[0].url, 'https://www.linkedin.com/posts/1');
  assert.deepEqual(search.items[0].meta.slice(0, 3), ['Ada Lovelace', '1.2K likes', '34 comments']); assert.equal(search.items[0].meta.length, 4);
  const company = said({ tool: 'scrapecreators_linkedin', source: 'linkedin', args: { kind: 'company_posts', url: 'https://www.linkedin.com/company/example' } }, [{ success: true, posts: [{ text: 'Company news', url: 'https://www.linkedin.com/posts/2', datePublished: '2026-09-02T10:00:00Z' }] }]);
  assert.equal(company.items[0].title, 'Company news'); assert.equal(company.items[0].meta.length, 1); assert.doesNotMatch(company.text, /[Ss]earched/);
  const profile = said({ tool: 'scrapecreators_linkedin', source: 'linkedin', args: { kind: 'profile', url: 'https://www.linkedin.com/in/ada' } }, [{ success: true, name: 'Ada Lovelace', recentPosts: [{ text: 'x' }] }]);
  assert.deepEqual(profile.items, []); assert.match(profile.text, /^Called scrapecreators_linkedin/);
});

test('Telegram post rows carry the figures the tool reads, and a channel or single post gets the plain reading', () => {
  const posts = said({ tool: 'scrapecreators_telegram', source: 'telegram', args: { kind: 'posts', handle: 'durov' } }, [{ success: true, posts: [{ id: '543', url: 'https://t.me/durov/543', author_name: 'Pavel Durov', text: 'Telegram news', published_at: '2026-08-18T17:37:31+00:00', view_count: 1210000, reaction_count: 89300 }], cursor: '523' }]);
  assert.equal(posts.items[0].title, 'Telegram news'); assert.equal(posts.items[0].url, 'https://t.me/durov/543');
  assert.deepEqual(posts.items[0].meta.slice(0, 3), ['Pavel Durov', '1.2M views', '89.3K reactions']); assert.equal(posts.items[0].meta.length, 4);
  assert.doesNotMatch(posts.text, /[Ss]earched/); assert.match(posts.text, /1 post/);
  for (const [args, body] of [[{ kind: 'channel', handle: 'durov' }, { success: true, handle: 'durov', name: 'Pavel Durov' }], [{ kind: 'post', url: 'https://t.me/durov/543' }, { success: true, id: '543', text: 'Telegram news' }]]) {
    const out = said({ tool: 'scrapecreators_telegram', source: 'telegram', args }, [body]);
    assert.deepEqual(out.items, []); assert.match(out.text, /^Called scrapecreators_telegram/);
  }
});

test('an empty recognised page is still nothing found', () => {
  const out = evidence({ status: 'empty', tool: 'scrapecreators_telegram', source: 'telegram', args: { kind: 'posts', handle: 'durov' } }, [{ success: true, posts: [] }], context);
  assert.equal(out.result, 'nothing found');
});
