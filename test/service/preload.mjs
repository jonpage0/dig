// Provider hosts mocked, while requests to the service itself (127.0.0.1) go through: `dig mcp` started with this
// preload forwards to a real service, which it starts with the same preload. The mock is test/mock-fetch.mjs, or the
// file DIG_TEST_FETCH names (a test's own provider fixture).
import { pathToFileURL } from 'node:url';
const original = globalThis.fetch;
await import(process.env.DIG_TEST_FETCH ? pathToFileURL(process.env.DIG_TEST_FETCH).href : '../mock-fetch.mjs');
const mocked = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const target = new URL(url instanceof Request ? url.url : String(url));
  return ['127.0.0.1', 'localhost'].includes(target.hostname) ? original(url, init) : mocked(url, init);
};
