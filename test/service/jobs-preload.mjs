// The service preload for the job tests: test/service/preload.mjs, with xAI's search answered after the delay a test
// writes to <state>/provider-delay-ms. Each request is noted in <state>/provider-calls.log when it arrives, before the
// delay, with the job files that existed then, so a test sees a request that never got its answer and what the job
// store held before it was sent. The delay ends early when the request is aborted.
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import './preload.mjs';

const inner = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url instanceof Request ? url.url : url) === 'https://api.x.ai/v1/responses') {
    const state = process.env.DIG_STATE_DIR;
    const jobs = (await readdir(join(state, 'jobs')).catch(() => [])).filter(name => /^job-.*\.json$/.test(name)).sort();
    await appendFile(join(state, 'provider-calls.log'), `${JSON.stringify({ jobs })}\n`);
    const ms = Number(await readFile(join(state, 'provider-delay-ms'), 'utf8').catch(() => '0'));
    const signal = init?.signal;
    if (ms > 0) await new Promise((done, fail) => {
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); fail(signal.reason ?? new DOMException('The operation was aborted', 'AbortError')); }, { once: true });
    });
  }
  return inner(url, init);
};
