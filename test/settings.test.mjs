import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeConfig, loadConfig, updateConfig, workerGuidance } from '../src/config.mjs';
import { sourceInfo, settingsValues, settingsDocument } from '../src/catalog.mjs';

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

test('[spend] holds an optional per-dig ceiling in US dollars; 0 removes it and a file without one is written back without it', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-spend-'));
  const file = join(state, 'config.toml');
  assert.equal((await initializeConfig(state)).spend.dig_ceiling_usd, null);
  await updateConfig({ keep_raw: false }, state);
  assert.doesNotMatch(await readFile(file, 'utf8'), /\[spend\]/, 'Without a ceiling no table is written');
  assert.equal(settingsValues(await loadConfig(state)).spend_dig_ceiling_usd, 0);

  const c = await updateConfig({ spend_dig_ceiling_usd: 2.5 }, state);
  assert.equal(c.spend.dig_ceiling_usd, 2.5);
  assert.match(await readFile(file, 'utf8'), /\[spend\]\ndig_ceiling_usd = 2\.5\n/);
  assert.equal((await loadConfig(state)).spend.dig_ceiling_usd, 2.5, 'The table round-trips');
  assert.equal(settingsValues(c).spend_dig_ceiling_usd, 2.5);
  assert.equal((await updateConfig({ keep_raw: true }, state)).spend.dig_ceiling_usd, 2.5, 'Other changes keep it');

  assert.equal((await updateConfig({ spend_dig_ceiling_usd: 0 }, state)).spend.dig_ceiling_usd, null);
  assert.doesNotMatch(await readFile(file, 'utf8'), /\[spend\]|dig_ceiling_usd/, '0 removes the ceiling');
  for (const value of [-1, '5', Infinity, null]) await assert.rejects(updateConfig({ spend_dig_ceiling_usd: value }, state), /spend_dig_ceiling_usd must be/);

  // Hand edits: an unknown key, a nonpositive or a non-numeric ceiling is refused like any other field.
  const saved = await readFile(file, 'utf8');
  for (const [table, message] of [['[spend]\ndig_ceiling_usd = 5\nmonthly_usd = 9\n', /Unknown configuration field: spend\.monthly_usd/], ['[spend]\ndig_ceiling_usd = -1\n', /spend\.dig_ceiling_usd must be a positive number/], ['[spend]\ndig_ceiling_usd = 0\n', /spend\.dig_ceiling_usd must be a positive number/], ['[spend]\ndig_ceiling_usd = "5"\n', /spend\.dig_ceiling_usd must be a positive number/]]) {
    await writeFile(file, `${saved}\n${table}`);
    await assert.rejects(loadConfig(state), message);
  }
  await writeFile(file, `${saved}\n[spend]\ndig_ceiling_usd = 5\n`);
  assert.equal((await loadConfig(state)).spend.dig_ceiling_usd, 5, 'A whole number written by hand is accepted');
  const fields = settingsDocument(await loadConfig(state));
  assert.deepEqual([fields.schema.properties.spend_dig_ceiling_usd.type, fields.schema.properties.spend_dig_ceiling_usd.minimum], ['number', 0]);
  assert.deepEqual(fields.layout.find(group => group.title === 'Library').items.map(item => item.property), ['library', 'keep_raw', 'spend_dig_ceiling_usd', 'search_semantic']);
});
