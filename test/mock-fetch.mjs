globalThis.fetch = async (url, init) => {
  const target = new URL(url);
  if (target.origin === 'https://api.typesafe.ai' && target.pathname === '/v1/systemone') {
    const body = JSON.parse(init.body);
    if ('project' in body || 'dig' in body || init.body.includes(process.env.TYPESAFE_API_KEY)) throw new Error('Local identity or credential reached provider state');
    return Response.json({ model: body.model, answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => [key, q.type === 'score'
      ? { type: 'score', score: 3, confidence: 1, legend: Object.fromEntries(q.criteria.map((v,i) => [String(i),v])), probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } }
      : { type: 'choice', choice: 'insufficient', confidence: 1, probabilities: { supported: 0, contradicted: 0, insufficient: 1 } }])), usage: { input_tokens: 100, output_tokens: 20 } });
  }
  if (target.origin === 'https://generativelanguage.googleapis.com' && target.pathname.startsWith('/v1beta/interactions')) {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (body && ('project' in body || 'dig' in body)) throw new Error('Local research identity reached the provider');
    return Response.json({
      id: 'interaction_protocol_fixture',
      status: target.pathname.endsWith('/cancel') ? 'cancelled' : 'completed',
      model: body?.model ?? 'gemini-3.8-flash',
      usage: { total_input_tokens: 100, total_output_tokens: 20, total_tokens: 120 },
      steps: [{ type: 'model_output', content: [{ type: 'text', text: `At 00:10 the door closes. Synthetic provider echo ${process.env.GEMINI_API_KEY}` }] }],
    });
  }
  const query = new URL(url).searchParams.get('query');
  if (query === 'failure') return new Response(JSON.stringify({ error: 'Test provider outage' }), { status: 503 });
  if (query === 'malformed') return new Response(JSON.stringify({ message: 'not a search response' }));
  return new Response(JSON.stringify({ nbHits: query === 'empty' ? 0 : 1, hits: query === 'empty' ? [] : [{ objectID: '123', title: 'Test source item', author: 'test-user', points: 0, num_comments: 0, created_at: '2026-09-29T12:00:00Z', url: 'https://example.com/article' }] }), { headers: { 'Content-Type': 'application/json' } });
};
