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

test('a Wayback Machine capture list reads as one row per capture, with its time, status, type, size and address', () => {
  const page = [['timestamp', 'original', 'mimetype', 'statuscode', 'length'], ['20100102003410', 'http://example.com/', 'text/html', '200', '700'], ['20110129014121', 'http://www.example.com/', 'unk', '302', '340'], [], ['eJxLzs_VSa1IzC3ISdXUVzAyMDQ0MDSyMDI2tTAwBgB_bweU']];
  const out = said({ tool: 'wayback_snapshots', source: 'wayback', args: { url: 'example.com', from: '2010', to: '2011' } }, [page]);
  assert.match(out.text, /^Listed Wayback Machine captures of example\.com \(from 2010 to 2011\) → 2 captures, more available$/);
  assert.deepEqual(out.items.map(i => [i.title, i.url, i.meta]), [['2010-01-02 00:34 UTC', 'https://web.archive.org/web/20100102003410/http://example.com/', ['HTTP 200', 'text/html', '700 B stored']], ['2011-01-29 01:41 UTC', 'https://web.archive.org/web/20110129014121/http://www.example.com/', ['HTTP 302', 'unk', '340 B stored']]]);
  assert.match(said({ tool: 'wayback_snapshots', source: 'wayback', status: 'empty', args: { url: 'example.com' } }, [[]]).text, /→ nothing found$/);
});

test('a Wayback Machine read is the capture it found, by its title, time and address', () => {
  const lookup = { url: 'example.com', archived_snapshots: { closest: { status: '200', available: true, url: 'http://web.archive.org/web/20060101213916/http://example.com:80/', timestamp: '20060101213916' } }, timestamp: '20060101' };
  const out = said({ tool: 'wayback_read', source: 'wayback', args: { url: 'example.com', date: '2006-01-01' } }, [lookup, '<HTML><HEAD><TITLE>Example Web Page</TITLE></HEAD><body><p>You have reached this web page.</p></BODY></HTML>']);
  assert.match(out.text, /^Read the Wayback Machine’s capture of example\.com as of 2006-01-01 → capture of 2006-01-01 21:39 UTC$/); assert.doesNotMatch(out.text, /[Ss]earched/);
  assert.deepEqual(out.items.map(i => [i.title, i.url, i.meta]), [['Example Web Page', 'https://web.archive.org/web/20060101213916/http://example.com:80/', ['2006-01-01 21:39 UTC', 'http://example.com:80/']]]);
  const none = said({ tool: 'wayback_read', source: 'wayback', status: 'empty', args: { url: 'example.com/gone' } }, [{ url: 'example.com/gone', archived_snapshots: {} }]);
  assert.match(none.text, /→ nothing found$/); assert.deepEqual(none.items, []);
});

test('Google ads read as advertiser rows, ad rows and one ad with its fields, from the retained originals', () => {
  const advertisers = said({ tool: 'google_ad_library', source: 'google-ads', args: { action: 'advertisers', query: 'lululemon', country: 'CA' } }, [{ success: true, advertisers: [{ name: 'lululemon athletica canada inc.', advertiser_id: 'AR01614014350098432001', region: 'CA', number_of_ads_estimate: 7000 }, { name: 'no id' }], websites: [{ domain: 'lululemon.com' }] }]);
  assert.match(advertisers.text, /^Searched google-ads for advertisers named “lululemon” \(CA\) → 1 advertiser$/);
  assert.deepEqual(advertisers.items.map(i => [i.kind, i.title, i.url, i.meta.slice(0, 2)]), [['advertiser', 'lululemon athletica canada inc.', 'https://adstransparency.google.com/advertiser/AR01614014350098432001', ['AR01614014350098432001', 'CA']]]);
  const listed = { advertiserId: 'AR01614014350098432001', creativeId: 'CR08567627846124568577', format: 'image', adUrl: 'https://adstransparency.google.com/advertiser/AR01614014350098432001/creative/CR08567627846124568577', advertiserName: 'lululemon athletica canada inc.', imageUrl: null, firstShown: '2026-03-11T17:08:22.000Z', lastShown: '2026-05-04T17:59:12.000Z' };
  const ads = said({ tool: 'google_ad_library', source: 'google-ads', args: { action: 'ads', domain: 'lululemon.com', format: 'image' } }, [{ success: true, ads: [listed, listed], cursor: 'c' }]);
  assert.match(ads.text, /^Listed google-ads for lululemon\.com \(image\) → 1 ad$/);
  assert.equal(ads.items[0].kind, 'ad'); assert.equal(ads.items[0].url, listed.adUrl); assert.equal(ads.items[0].meta[0], 'image'); assert.equal(ads.items[0].meta.length, 2);
  const detail = said({ tool: 'google_ad_library', source: 'google-ads', args: { action: 'detail', url: 'https://adstransparency.google.com/advertiser/AR07541154843046445057/creative/CR17778900238552006657' } }, [{ success: true, advertiserId: 'AR07541154843046445057', creativeId: 'CR17778900238552006657', url: 'https://adstransparency.google.com/advertiser/AR07541154843046445057/creative/CR17778900238552006657', format: 'image', firstShown: '2026-06-05T21:52:15.000Z', lastShown: '2026-06-24T19:04:54.000Z', overallImpressions: { min: '500000', max: '600000' }, creativeRegions: [{ regionCode: 'US', regionName: 'United States' }], variations: [{ destinationUrl: 'shop.gop.com', headline: 'Classic GOP Quarter - Zip Pullover', allText: 'Official GOP Shop shop.gop.com Classic GOP Quarter - Zip Pullover' }] }]);
  assert.match(detail.text, /^Read the google-ads ad https:\/\/adstransparency\.google\.com\/.+ → 1 ad$/);
  assert.equal(detail.items.length, 1); assert.equal(detail.items[0].title, 'Classic GOP Quarter - Zip Pullover');
  assert.deepEqual([detail.items[0].meta[0], detail.items[0].meta[1], detail.items[0].meta.at(-2), detail.items[0].meta.at(-1)], ['AR07541154843046445057', 'image', 'United States', '500000–600000 impressions']);
  assert.deepEqual(detail.items[0].links, [{ label: 'Destination', url: 'https://shop.gop.com' }]);
  assert.match(said({ tool: 'google_ad_library', source: 'google-ads', status: 'empty', args: { action: 'ads', domain: 'example.com' } }, [{ success: true, ads: [] }]).text, /→ nothing found$/);
});

test('LinkedIn ads read as ad rows, and one ad with its payer, dates and media links', () => {
  const ad = { id: '1629532086', description: 'Offensive security for Insurance Brokers.', headline: 'Meet us at Booth 3240', url: 'https://www.linkedin.com/ad-library/detail/1629532086', adType: 'Video Ad', advertiser: 'CodeAnt AI', adDuration: '', startDate: null, endDate: null, imageSources: [], videoSources: [{ src: 'https://dms.licdn.com/v.mp4', type: 'video/mp4', bitrate: 124294 }] };
  const search = said({ tool: 'linkedin_ad_library', source: 'linkedin-ads', args: { action: 'search', company_name: 'CodeAnt AI', countries: 'US' } }, [{ success: true, ads: [ad, { headline: 'no id' }], paginationToken: 'p', isLastPage: false }]);
  assert.match(search.text, /^Searched linkedin-ads for CodeAnt AI \(US\) → 1 ad$/);
  assert.deepEqual(search.items.map(i => [i.kind, i.title, i.url, i.meta]), [['ad', 'Meet us at Booth 3240', ad.url, ['CodeAnt AI', 'Video Ad']]]);
  const detail = said({ tool: 'linkedin_ad_library', source: 'linkedin-ads', args: { action: 'detail', ad_id: '1629532086' } }, [{ success: true, ...ad, paidForBy: 'CodeAnt AI Inc.', startDate: '2026-03-01', endDate: '2026-04-15' }]);
  assert.match(detail.text, /^Read the linkedin-ads ad 1629532086 → 1 ad$/);
  assert.ok(detail.items[0].meta.includes('paid for by CodeAnt AI Inc.')); assert.equal(detail.items[0].excerpt, ad.description);
  assert.deepEqual(detail.items[0].links, [{ label: 'Video 1', url: 'https://dms.licdn.com/v.mp4' }]);
});
