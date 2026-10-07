import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeConfig, loadConfig, updateConfig, workerGuidance } from '../src/config.mjs';
import { sourceInfo } from '../src/catalog.mjs';

test('[workers] stores only suggestions that differ from what a method inherits, and X methods keep their own', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-workers-'));
  const file = join(state, 'config.toml');
  await initializeConfig(state);
  await updateConfig({ worker_model: 'gpt-6.1-sol', x_judge_worker_effort: 'high' }, state);
  assert.doesNotMatch(await readFile(file, 'utf8'), /\[workers/, 'Echoing the built-in suggestions writes no table');

  const c = await updateConfig({ worker_model: 'gpt-7-sol', x_judge_worker_effort: 'xhigh' }, state);
  assert.deepEqual(c.workers, { default: { model: 'gpt-7-sol' }, 'x-judge': { effort: 'xhigh' } });
  assert.match(await readFile(file, 'utf8'), /\[workers\.default\]\nmodel = "gpt-7-sol"\n\n\[workers\.x-judge\]\neffort = "xhigh"/);
  assert.deepEqual(workerGuidance(c, 'reddit'), { model: 'gpt-7-sol', effort: 'medium', configured: true });
  assert.deepEqual(workerGuidance(c, 'x-judge'), { model: 'gpt-6-astra', effort: 'xhigh', configured: true });
  assert.deepEqual(workerGuidance(c, 'x-breadth'), { model: 'gpt-6-luna', effort: 'high', configured: false }, 'X breadth keeps its own suggestion when the Dig-wide one changes');
  const methods = Object.fromEntries(sourceInfo(c, 'x').sources[0].methods.map(m => [m.name, m.workerDefault]));
  assert.match(methods['x-judge'].basis, /^Set in Dig’s settings by the user; guidance, not an enforced pin/);
  assert.match(methods['x-breadth'].basis, /^Guidance, not an enforced pin/);

  // Setting a method back to what it would inherit removes its entry.
  assert.deepEqual((await updateConfig({ x_judge_worker_effort: 'high' }, state)).workers, { default: { model: 'gpt-7-sol' } });
  for (const [set, message] of [[{ worker_effort: 'extreme' }, /worker_effort must be one of none, minimal, low, medium, high, xhigh, max, ultra/], [{ reddit_worker_model: '  ' }, /reddit_worker_model must be a nonempty model name/], [{ x_worker_model: 'gpt-7' }, /Unknown setting: x_worker_model/]]) {
    await assert.rejects(updateConfig(set, state), message);
  }

  // Hand edits: unknown tables and fields fail like any other field; a value equal to the inherited one stays as written.
  const saved = await readFile(file, 'utf8');
  await writeFile(file, `${saved}\n[workers.not-a-method]\nmodel = "gpt-7-sol"\n`);
  await assert.rejects(loadConfig(state), /Unknown configuration field: workers\.not-a-method/);
  await writeFile(file, `${saved}\n[workers.reddit]\ntemperature = 1\n`);
  await assert.rejects(loadConfig(state), /Unknown configuration field: workers\.reddit\.temperature/);
  await writeFile(file, `${saved}\n[workers.reddit]\nmodel = "gpt-7-sol"\n`);
  assert.deepEqual((await updateConfig({ keep_raw: false }, state)).workers.reddit, { model: 'gpt-7-sol' });
});
