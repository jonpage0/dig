// Replays the responses `npm run live-check` saved through each tool's parser: no network, no build. Captures are read
// from DIG_LIVE_CAPTURES, else verification/live; without any, one skipped test says where they are looked for.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHECKS } from './live/checks.mjs';

const folder = resolve(process.env.DIG_LIVE_CAPTURES || 'verification/live');
const WORKED = ['success', 'partial', 'empty'];
const NULL_BODY = [101, 204, 205, 304];
let captures = [];
try {
  for (const name of (await readdir(folder)).filter(name => name.endsWith('.json') && !name.endsWith('.failed.json')).sort()) {
    const capture = JSON.parse(await readFile(join(folder, name), 'utf8'));
    if (WORKED.includes(capture.status) && Array.isArray(capture.responses)) captures.push(capture);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

if (!captures.length) test(`replays live captures (none found in ${folder}; run npm run live-check, or set DIG_LIVE_CAPTURES)`, { skip: true }, () => {});
else {
  // Tools write their libraries and transcripts under Dig's state folder: an isolated one, set before they load.
  const state = await mkdtemp(join(tmpdir(), 'dig-live-replay-'));
  const project = join(state, 'project'); const home = join(state, 'home');
  await mkdir(project); await mkdir(home);
  process.env.DIG_STATE_DIR = state;
  after(() => rm(state, { recursive: true, force: true }));
  const { providerTools } = await import('../src/providers/index.ts');
  const { MODULES } = await import('../src/providers/modules.ts');
  const { executeSource } = await import('../src/providers/outcome.ts');
  const checks = new Map(CHECKS.map(check => [check.tool, check]));
  const SECRET = /_(KEY|TOKEN|SECRET|PASSWORD)$/;
  const CREDENTIALS = [...new Set(MODULES.flatMap(module => [...(module.env ?? []), ...(module.keys ?? []).flat()]))];
  const credentialsOf = tool => { const module = MODULES.find(m => m.tools.includes(tool)); return [...new Set([...(module.keys ?? []).flat(), ...(module.env ?? []).filter(name => SECRET.test(name))])]; };

  /** A fetch that serves the capture's responses in order and notes a request beyond them. */
  function serve(capture) {
    const state = { served: 0, overflow: null };
    state.fetch = async () => {
      if (state.served >= capture.responses.length) { state.overflow = `${capture.tool} asked for response ${state.served + 1}, but the capture holds ${capture.responses.length}`; throw new TypeError('fetch failed'); }
      const { status, body, headers } = capture.responses[state.served++];
      // A request that got no response was kept with a non-HTTP status: it failed in transport.
      if (!Number.isInteger(status) || status < 200 || status > 599) throw new TypeError('fetch failed');
      const text = typeof body === 'string';
      const init = { status, headers: { 'content-type': text ? 'text/plain; charset=utf-8' : 'application/json', ...(headers?.['scrape.do-request-cost'] !== undefined ? { 'scrape.do-request-cost': headers['scrape.do-request-cost'] } : {}) } };
      return new Response(NULL_BODY.includes(status) ? null : text ? body : JSON.stringify(body ?? null), init);
    };
    return state;
  }

  for (const capture of captures) {
    const check = checks.get(capture.tool);
    const reason = !providerTools[capture.tool] ? 'not a provider tool' : check?.replay === false ? check.replayNote : null;
    test(`${capture.tool} replays its ${capture.status} live capture to the same status`, { skip: reason ?? false }, async () => {
      const saved = { fetch: globalThis.fetch, env: { ...process.env } };
      // Free tools ran without credentials; a paid tool gets a placeholder for each credential name its source uses,
      // so it does not stop at a missing key. HOME points at an empty folder, so gh offers no login of its own.
      for (const name of [...CREDENTIALS, 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) delete process.env[name];
      process.env.HOME = home;
      if (providerTools[capture.tool].billing !== 'free') for (const name of credentialsOf(capture.tool)) process.env[name] = `replay-placeholder-${name.toLowerCase()}`;
      const replay = serve(capture);
      globalThis.fetch = replay.fetch;
      try {
        const outcome = await executeSource(providerTools[capture.tool], capture.args, { sessionID: 'live-replay', directory: project, worktree: project, abort: new AbortController().signal, keep() {} });
        assert.equal(replay.overflow, null, replay.overflow);
        assert.equal(outcome.status, capture.status, `${capture.tool}: replay ${outcome.status}, live ${capture.status} (${capture.at}, Dig ${capture.version})\n${outcome.text.slice(0, 600)}`);
        assert.ok(outcome.text.trim(), `${capture.tool}: the replay returned no text`);
      } finally {
        globalThis.fetch = saved.fetch;
        for (const name of Object.keys(process.env)) if (!(name in saved.env)) delete process.env[name];
        Object.assign(process.env, saved.env);
      }
    });
  }
}
