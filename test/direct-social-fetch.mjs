// Synthetic native-boundary responses. No network is available in this fixture.
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://api.scrapecreators.com' || init.redirect !== 'manual') throw new Error('Unexpected provider request');
  const secret = init.headers['x-api-key'];
  if (url.pathname === '/v2/tiktok/video') return Response.json({ success: true, credits_charged: 1, aweme_detail: { aweme_id: '12345', desc: `Synthetic caption ${secret}`, image_post_info: { images: [{ url: 'https://example.test/photo.jpg' }] } } });
  if (url.pathname === '/v2/instagram/user/posts') return Response.json({ success: true, credits_charged: 1, items: [{ id: 'ig1', code: 'Fixture', caption: { text: `Synthetic caption ${secret}` } }], next_max_id: 'next', more_available: true });
  throw new Error('Unexpected provider route');
};
