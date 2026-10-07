// Isolated provider responses for native boundary tests. No request reaches a network.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The post id whose lookup rotates X_BEARER_TOKEN in keys.env while the request is outstanding. */
const ROTATING_POST = '30';
const ROTATED_TOKEN = 'x-bearer-rotated-replacement-value';
const ROTATION_WAIT_MS = 5_000;
const POLL_MS = 50;

/** Rewrites keys.env with a new token and waits until the server's keys.env watcher has applied it. */
async function rotateBearerToken() {
  await writeFile(join(process.env.DIG_STATE_DIR, 'keys.env'), `X_BEARER_TOKEN=${ROTATED_TOKEN}\n`, { mode: 0o600 });
  for (let waited = 0; process.env.X_BEARER_TOKEN !== ROTATED_TOKEN; waited += POLL_MS) {
    if (waited > ROTATION_WAIT_MS) throw new Error('keys.env rotation was not applied');
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

globalThis.fetch = async (url, init) => {
  const target = new URL(String(url));
  if (target.origin === 'https://api.scrape.do' && target.pathname === '/plugin/amazon/pdp') {
    return Response.json({ status: 'success', asin: 'B000000001', name: 'Retained cost fixture' }, {
      headers: { 'scrape.do-request-cost': '1', 'scrape.do-remaining-credits': '999', 'set-cookie': `private=${process.env.SCRAPE_DO_API_KEY}` },
    });
  }
  if (target.origin === 'https://api.scrape.do' && target.pathname === '/plugin/amazon/offer-listing') {
    return Response.json({ message: 'Offers unavailable' }, { status: 400 });
  }
  if (target.origin === 'https://api.x.com' && target.pathname === '/2/tweets') {
    // The credential this request was sent with, which the response then echoes.
    const sent = init.headers.authorization.replace(/^Bearer /, '');
    if (target.searchParams.get('ids') === ROTATING_POST) await rotateBearerToken();
    return Response.json({
      data: [{ id: target.searchParams.get('ids'), text: `Retained post accidentally echoes ${sent}`, author_id: '12' }],
      includes: { users: [{ id: '12', username: 'fixture', name: 'Fixture account' }] },
    });
  }
  if (target.origin === 'https://api.x.com' && target.pathname === '/2/users/me') {
    return Response.json({ data: { id: '99', username: 'signed_in_fixture', name: 'Signed-in fixture' } });
  }
  if (target.origin === 'https://api.x.com' && target.pathname === '/2/users/99/liked_tweets') {
    // A liked post that echoes every sign-in key, as a careless provider error or post might.
    const keys = ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'].map(name => process.env[name]).join(' ');
    return Response.json({ data: [{ id: '41', text: `Liked post accidentally echoes ${keys}`, author_id: '12' }], includes: { users: [{ id: '12', username: 'fixture', name: 'Fixture account' }] } });
  }
  if (String(url) !== 'https://api.x.ai/v1/responses') throw new Error('Unexpected provider request');
  const input = JSON.parse(init.body).input.at(-1).content;
  return Response.json({
    id: 'fixture-response',
    output: [{ type: 'message', content: [{ type: 'output_text', text: `Returned evidence accidentally echoes ${process.env.XAI_API_KEY}` }] }],
    usage: { total_tokens: 12, ...(input.includes('unknown-cost') ? {} : { cost_in_usd_ticks: 123400000 }) },
  });
};
