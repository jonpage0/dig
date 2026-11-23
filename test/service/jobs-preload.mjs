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
    const signal = init?.signal;
    const sseDelayRaw = await readFile(join(state, 'provider-sse-ms'), 'utf8').catch(() => '');
    const sseDelay = Number(sseDelayRaw);
    if (sseDelayRaw.trim() && Number.isFinite(sseDelay) && sseDelay >= 0) {
      const encoder = new TextEncoder();
      const sleep = (wait) => new Promise((done, fail) => {
        if (wait <= 0) return done();
        const timer = setTimeout(done, wait);
        signal?.addEventListener('abort', () => { clearTimeout(timer); fail(signal.reason ?? new DOMException('The operation was aborted', 'AbortError')); }, { once: true });
      });
      const events = [
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { id: 'c1', call_id: 'call-1', type: 'custom_tool_call', name: 'x_semantic_search', input: JSON.stringify({ query: 'local-first xsearch progress' }), status: 'completed' } })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { id: 'c2', call_id: 'call-2', type: 'custom_tool_call', name: 'x_keyword_search', input: JSON.stringify({ query: 'from:example dig' }), status: 'completed' } })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_sse_1', status: 'completed', output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Streamed X search finding.' }] }], usage: { total_tokens: 42, cost_in_usd_ticks: 123000000 } } })}\n\n`,
      ];
      const stream = new ReadableStream({
        async start(controller) {
          try {
            controller.enqueue(encoder.encode(events[0]));
            await sleep(sseDelay);
            controller.enqueue(encoder.encode(events[1]));
            await sleep(sseDelay);
            controller.enqueue(encoder.encode(events[2]));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const ms = Number(await readFile(join(state, 'provider-delay-ms'), 'utf8').catch(() => '0'));
    if (ms > 0) await new Promise((done, fail) => {
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); fail(signal.reason ?? new DOMException('The operation was aborted', 'AbortError')); }, { once: true });
    });
  }
  return inner(url, init);
};
