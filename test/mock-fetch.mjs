globalThis.fetch = async url => {
  const query = new URL(url).searchParams.get('query');
  if (query === 'failure') return new Response(JSON.stringify({ error: 'Test provider outage' }), { status: 503 });
  if (query === 'malformed') return new Response(JSON.stringify({ message: 'not a search response' }));
  return new Response(JSON.stringify({ nbHits: query === 'empty' ? 0 : 1, hits: query === 'empty' ? [] : [{ objectID: '123', title: 'Test source item', author: 'test-user', points: 0, num_comments: 0, created_at: '2026-09-29T12:00:00Z', url: 'https://example.com/article' }] }), { headers: { 'Content-Type': 'application/json' } });
};
