import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, updateConfig } from '../src/config.mjs';
import { startDig, recordCall, saveReport, finishDig, listLibrary, readLibraryFile, projectFolder } from '../src/library.mjs';

import { report } from './report-fixture.mjs';

test('reports and answers never overwrite, projects stay isolated, and cards group by dig', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-library-'));
  const config = await loadConfig(state);
  const one = await startDig(config, state, 'One original question', 'thread-main');
  const two = await startDig(config, state, 'One original question', 'thread-other');
  assert.notEqual(one.dig, two.dig);
  const call = await recordCall(config, state, one.dig, { tool: 'hackernews', source: 'hackernews', cost: [], responses: [{ label: 'search', status: 200, body: { hits: [{ title: 'Original evidence' }] } }], at: new Date().toISOString(), ms: 42, status: 'success', args: { query: 'sample' }, session: 'thread-main' });
  assert.deepEqual(call.cost, []);
  const first = await saveReport(config, { project: state, dig: one.dig, source: 'hackernews', content: report });
  const second = await saveReport(config, { project: state, dig: one.dig, source: 'hackernews', content: report });
  assert.equal(first.report, 'hackernews.md'); assert.equal(second.report, 'hackernews-2.md');
  assert.match(await readFile(first.path, 'utf8'), /A small inspected sample/);
  await finishDig(config, { project: state, dig: one.dig, answer: 'Answer with limited evidence.', status: 'answered', reports: [first.report] });
  await assert.rejects(finishDig(config, { project: state, dig: one.dig, answer: 'Overwrite', status: 'answered', reports: [first.report] }), { code: 'EEXIST' });
  const { items } = await listLibrary(config);
  assert.equal(items.length, 2); assert.equal(items.find(i => i.id === one.dig).calls.length, 1); assert.equal(items.find(i => i.id === two.dig).calls.length, 0);
  const file = items.find(i => i.id === one.dig).reports[0];
  const part = await readLibraryFile(config, file, 0, 15); assert.equal(part.text.length, 15); assert.equal(part.nextOffset, 15);
  await assert.rejects(readLibraryFile(config, '../../private.json'));
  const outside = join(state, 'outside.json'); await writeFile(outside, 'private');
  await symlink(outside, join(config.library, 'escape.json'));
  await assert.rejects(readLibraryFile(config, 'escape.json'), /outside the library/);
  assert.throws(() => projectFolder('relative-project'), /absolute/);
  await assert.rejects(saveReport(config, { project: state, dig: one.dig, source: 'hackernews', content: '# No source card' }), /source_card/);
});

test('calls that name no dig belong to the session save that follows them; unclaimed calls stay visible as live activity', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-attribution-'));
  const config = await loadConfig(state); const pause = () => new Promise(resolve => setTimeout(resolve, 5));
  const receipt = (session, at = new Date().toISOString(), callId) => recordCall(config, state, undefined, { tool: 'hackernews', source: 'hackernews', cost: [], responses: [{ label: 'search', status: 200, body: { hits: [] } }], at, ms: 1, args: { query: `${session} query` }, status: 'success', session, callId });
  const main = await startDig(config, state, 'Attribution', 'thread-main'); await pause();
  const beforeStart = await receipt('thread-main', '2020-01-01T00:00:00.000Z');
  const workerCall = await receipt('worker-1', undefined, 'call_worker_1'); await pause();
  const saved = await saveReport(config, { project: state, dig: main.dig, source: 'hackernews', content: report, session: 'worker-1' }); await pause();
  const afterReport = await receipt('worker-1');
  const mainCall = await receipt('thread-main'); await pause();
  await finishDig(config, { project: state, dig: main.dig, answer: 'Composed.', status: 'answered', reports: [saved.report] }); await pause();
  const afterFinish = await receipt('thread-main');
  const { items, live } = await listLibrary(config);
  const prefix = `${projectFolder(state)}/digs/${main.dig}`;
  assert.equal(items[0].session, 'thread-main');
  assert.deepEqual(items[0].calls.map(c => [c.id, c.claimedBy]), [['call_worker_1', `${prefix}/hackernews.md`], [mainCall.id, 'main']]);
  assert.equal(items[0].calls[0].rawFile, `${projectFolder(state)}/sessions/worker-1/raw/call_worker_1.json`);
  assert.equal(workerCall.id, 'call_worker_1');
  assert.deepEqual(new Set(live.map(c => `${c.session}:${c.id}`)), new Set([`thread-main:${beforeStart.id}`, `worker-1:${afterReport.id}`, `thread-main:${afterFinish.id}`]));
});

test('a call that names its dig counts in that dig whichever conversation made it, even when no report saves it', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-named-dig-'));
  const config = await loadConfig(state); const pause = () => new Promise(resolve => setTimeout(resolve, 5));
  const call = (dig, session, callId) => recordCall(config, state, dig, { tool: 'xsearch', source: 'x', cost: [{ amount: 1.5, unit: 'USD' }], responses: [], at: new Date().toISOString(), ms: 1, args: { query: 'q' }, status: 'success', session, callId });
  const first = await startDig(config, state, 'First question', 'parent');
  const second = await startDig(config, state, 'Second question', 'parent'); await pause();
  // A worker stopped before saving: its calls named the dig, so the dig keeps them and their cost.
  const stopped = await call(first.dig, 'worker-stopped', 'call_stopped');
  const receipts = (await readFile(join(config.library, projectFolder(state), 'sessions', 'worker-stopped', 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual([stopped.dig, receipts.at(-1).dig], [first.dig, first.dig]);
  await call(first.dig, 'worker-saved', 'call_saved'); await pause();
  const saved = await saveReport(config, { project: state, dig: first.dig, source: 'x', agent: 'x-judge', content: report.replace('source: "hackernews"', 'source: "x"'), session: 'worker-saved' }); await pause();
  // Inline work for the second dig stays with it, although the parent's next save is a report for the first.
  await call(second.dig, 'parent', 'call_inline'); await pause();
  await saveReport(config, { project: state, dig: first.dig, source: 'hackernews', content: report, session: 'parent' }); await pause();
  await finishDig(config, { project: state, dig: first.dig, answer: 'Answered.', status: 'answered', reports: [saved.report] }); await pause();
  await call(first.dig, 'parent', 'call_after_answer');
  // A dig that is gone from the library cannot hold its calls; they stay live.
  const removed = await startDig(config, state, 'Removed question', 'parent');
  await call(removed.dig, 'parent', 'call_removed_dig'); await rm(removed.path, { recursive: true });
  const { items, live } = await listLibrary(config);
  const prefix = `${projectFolder(state)}/digs/${first.dig}`;
  assert.deepEqual(items.find(i => i.id === first.dig).calls.map(c => [c.id, c.claimedBy]), [['call_stopped', null], ['call_saved', `${prefix}/x-judge.md`], ['call_after_answer', null]]);
  assert.deepEqual(items.find(i => i.id === second.dig).calls.map(c => [c.id, c.claimedBy]), [['call_inline', 'main']]);
  assert.deepEqual(live.map(c => c.id), ['call_removed_dig']);
});

test('a report claims only its own source’s calls, and the conversation that started the dig keeps the rest', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-source-claims-'));
  const config = await loadConfig(state); const pause = () => new Promise(resolve => setTimeout(resolve, 5));
  const call = (dig, session, source, tool, callId) => recordCall(config, state, dig, { tool, source, cost: [], responses: [], at: new Date().toISOString(), ms: 1, args: { query: 'q' }, status: 'success', session, callId });
  const saved = (dig, session, source, agent = source, question) => saveReport(config, { project: state, dig, source, agent, question, content: report.replace('source: "hackernews"', `source: "${source}"`), session });
  const dig = await startDig(config, state, 'Composed question', 'parent'); await pause();
  // The parent searched Hacker News and X itself, then saved the X judge report.
  await call(dig.dig, 'parent', 'hackernews', 'hackernews', 'call_parent_hn'); await pause();
  await call(dig.dig, 'parent', 'x', 'xsearch', 'call_parent_x'); await pause();
  const judge = await saved(dig.dig, 'parent', 'x', 'x-judge'); await pause();
  // A Papers worker's Exa call has no report of its own.
  await call(dig.dig, 'worker-papers', 'papers', 'papers_openalex_search', 'call_papers'); await pause();
  await call(dig.dig, 'worker-papers', 'exa', 'exa_search', 'call_exa'); await pause();
  const papers = await saved(dig.dig, 'worker-papers', 'papers'); await pause();
  // A call that names no dig keeps the dig the session rule gives it; only which report claims it changes.
  await call(undefined, 'worker-single', 'exa', 'exa_search', 'call_single_exa'); await pause();
  const single = await saved(undefined, 'worker-single', 'hackernews', 'hackernews', 'Single-source question');
  const { items, live } = await listLibrary(config);
  const prefix = `${projectFolder(state)}/digs/${dig.dig}`;
  assert.deepEqual(items.find(i => i.id === dig.dig).calls.map(c => [c.id, c.claimedBy]), [
    ['call_parent_hn', 'main'], ['call_parent_x', `${prefix}/${judge.report}`],
    ['call_papers', `${prefix}/${papers.report}`], ['call_exa', null]]);
  assert.deepEqual(items.find(i => i.id === single.dig).calls.map(c => [c.id, c.claimedBy]), [['call_single_exa', null]]);
  assert.deepEqual(live, []);
});

test('an answer records whether the question was answered', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-answer-status-'));
  const config = await loadConfig(state);
  const answered = await startDig(config, state, 'Answered question', 'thread');
  const saved = await saveReport(config, { project: state, dig: answered.dig, source: 'hackernews', content: report, session: 'thread' });
  await assert.rejects(finishDig(config, { project: state, dig: answered.dig, answer: 'Yes.', status: 'complete', reports: [saved.report] }), /status must be one of answered, partly-answered, unanswered/);
  await assert.rejects(finishDig(config, { project: state, dig: answered.dig, answer: 'Yes.', status: 'answered', reports: [] }), /must name its source reports/);
  const done = await finishDig(config, { project: state, dig: answered.dig, answer: 'Yes.', status: 'answered', reports: [saved.report] });
  assert.match(await readFile(done.path, 'utf8'), /^status: answered$/m);
  const partly = await startDig(config, state, 'Partly answered question', 'thread');
  await finishDig(config, { project: state, dig: partly.dig, answer: 'Half of it.', status: 'partly-answered', reports: [] });
  const unanswered = await startDig(config, state, 'Unanswered question', 'thread');
  await finishDig(config, { project: state, dig: unanswered.dig, answer: 'No provider ran.', status: 'unanswered', reports: [] });
  await startDig(config, state, 'Started question', 'thread');
  await saveReport(config, { project: state, source: 'hackernews', question: 'Single-source question', content: report, session: 'thread' });
  const { items } = await listLibrary(config);
  assert.deepEqual(Object.fromEntries(items.map(i => [i.title, i.status])), {
    'Answered question': 'answered', 'Partly answered question': 'partly answered', 'Unanswered question': 'not answered',
    'Started question': 'started', 'Single-source question': 'report saved',
  });
  assert.equal(items.find(i => i.title === 'Answered question').reportDetails[0].status, 'complete', 'A report carries its own source-card run status');
});

test('under the session rule, an abandoned unfinished dig does not take a newer open dig’s inline retrievals', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-open-digs-')); const config = await loadConfig(state);
  const older = '2026-09-28-0900-abandoned'; const newer = '2026-09-29-1000-current';
  for (const [id, started] of [[older, '2026-09-28T09:00:00.000Z'], [newer, '2026-09-29T10:00:00.000Z']]) {
    const folder = join(config.library, projectFolder(state), 'digs', id); await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'dig.md'), `---\ndig: ${JSON.stringify(id)}\nquestion: ${JSON.stringify(id)}\nproject: ${JSON.stringify(state)}\nmode: composed\nstarted_at: ${JSON.stringify(started)}\nsession: "inline-thread"\nplanned: [hackernews]\n---\n`);
  }
  const call = await recordCall(config, state, undefined, { tool: 'hackernews', source: 'hackernews', cost: [], responses: [{ label: 'search', status: 200, body: { hits: [] } }], at: '2026-09-29T10:05:00.000Z', ms: 1, args: { query: 'current question' }, status: 'success', session: 'inline-thread' });
  const { items } = await listLibrary(config);
  assert.deepEqual(items.find(item => item.id === newer).calls.map(receipt => receipt.id), [call.id]);
  assert.deepEqual(items.find(item => item.id === older).calls, []);
});

test('native preferences have one TOML authority and raw-off calls never claim a raw file', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-config-'));
  const updated = await updateConfig({ keep_raw: false, hackernews_enabled: false }, state);
  assert.equal(updated.keep_raw, false); assert.deepEqual(updated.sources.enabled, []);
  const fresh = await loadConfig(state); assert.deepEqual(fresh, updated);
  const dig = await startDig(fresh, state, 'Raw retention disabled');
  const receipt = await recordCall(fresh, state, dig.dig, { tool: 'hackernews', source: 'hackernews', cost: [], responses: [{ label: 'search', status: 200, body: { hits: [] } }], at: new Date().toISOString(), ms: 1, args: {}, status: 'empty' });
  assert.equal(receipt.raw, undefined);
  await writeFile(fresh.path, 'keep_raw = "no"\n');
  await assert.rejects(loadConfig(state), /keep_raw must be boolean/);
});

test('discovery and every write path refuse symlinks outside the chosen library', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-confinement-'));
  const config = await loadConfig(state); const dig = await startDig(config, state, 'Confinement');
  const outside = join(state, 'outside'); await mkdir(outside);
  const externalReport = join(outside, 'hackernews.md'); await writeFile(externalReport, '## Summary\nOUTSIDE_MARKER\n');
  await symlink(externalReport, join(dig.path, 'hackernews.md'));
  await assert.rejects(listLibrary(config), /outside the library/);
  const moved = join(outside, 'moved-dig'); await rename(dig.path, moved); await symlink(moved, dig.path);
  await assert.rejects(saveReport(config, { project: state, dig: dig.dig, source: 'hackernews', content: report }), /outside the library/);
  const safe = await startDig(config, state, 'Safe dig with redirected sessions');
  await symlink(outside, join(config.library, projectFolder(state), 'sessions'));
  await assert.rejects(recordCall(config, state, safe.dig, { tool: 'hackernews', source: 'hackernews', cost: [], responses: [{ label: 'search', status: 200, body: { hits: [] } }], at: new Date().toISOString(), ms: 1, args: {}, status: 'empty' }), /outside the library/);
});

test('library reads return only Dig research files, even after the library is pointed at another folder', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-research-only-'));
  const config = await loadConfig(state); const dig = await startDig(config, state, 'What may be read?');
  const saved = await saveReport(config, { project: state, dig: dig.dig, source: 'hackernews', content: report });
  const call = await recordCall(config, state, dig.dig, { tool: 'hackernews', source: 'hackernews', cost: [], responses: [{ label: 'search', status: 200, body: { hits: [] } }], at: new Date().toISOString(), ms: 1, args: {}, status: 'empty', session: 'worker' });
  await mkdir(join(config.library, 'youtube-transcripts')); await writeFile(join(config.library, 'youtube-transcripts', 'abc123.md'), 'Transcript');
  const sessions = join(projectFolder(state), 'sessions', 'worker');
  for (const file of [join(dig.path, 'dig.md'), saved.path, join(sessions, 'calls.jsonl'), join(sessions, call.raw), 'youtube-transcripts/abc123.md']) await readLibraryFile(config, file);
  // Markdown and JSON that are not Dig's records stay unreadable, inside the library or in a folder it is pointed at.
  await writeFile(join(config.library, 'notes.md'), 'PRIVATE'); await writeFile(join(config.library, projectFolder(state), 'auth.json'), '{"token":"PRIVATE"}');
  for (const file of ['notes.md', join(projectFolder(state), 'auth.json')]) await assert.rejects(readLibraryFile(config, file), /Only Dig research files/);
  const elsewhere = join(state, 'elsewhere'); await mkdir(join(elsewhere, 'config'), { recursive: true });
  await writeFile(join(elsewhere, 'auth.json'), '{"token":"PRIVATE"}'); await writeFile(join(elsewhere, 'config', 'settings.json'), '{}');
  const moved = await updateConfig({ library: elsewhere }, state);
  for (const file of ['auth.json', 'config/settings.json']) await assert.rejects(readLibraryFile(moved, file), /Only Dig research files/);
});

test('single-source saves claim earlier calls without inventing a composed answer; corrections and refreshes keep prior records', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-single-')); const config = await loadConfig(state);
  const session = 'source-worker';
  const inventory = report.replace('source: "hackernews"', 'source: "x"');
  const call = await recordCall(config, state, undefined, { tool: 'xsearch', source: 'x', cost: null, responses: [], at: '2020-01-01T00:00:00.000Z', ms: 1, args: { query: 'sample' }, status: 'success', session });
  const first = await saveReport(config, { project: state, source: 'x', agent: 'x-breadth', question: 'Which accounts discuss this?', content: inventory, session });
  const original = await readFile(first.path, 'utf8');
  const corrected = await saveReport(config, { project: state, dig: first.dig, source: 'x', agent: 'x-breadth', content: inventory, supersedes: first.report, session });
  const refreshed = await startDig(config, state, 'Refresh the account inventory', 'parent', { planned: ['x-breadth', 'x-judge'], refreshes: first.dig });
  const saved = (await listLibrary(config)).items;
  const item = saved.find(item => item.id === first.dig);
  assert.equal(item.mode, 'single'); assert.equal(item.answer, null);
  assert.deepEqual(item.sources, ['x']); assert.deepEqual(item.methods, ['x-breadth']);
  assert.deepEqual(item.calls.map(c => [c.id, c.cost]), [[call.id, null]]);
  assert.equal(item.reportDetails.find(r => r.file.endsWith(`/${corrected.report}`)).supersedes, first.report);
  assert.equal(saved.find(item => item.id === refreshed.dig).refreshes, first.dig);
  assert.equal(await readFile(first.path, 'utf8'), original);
  assert.equal((await readLibraryFile(config, first.path)).text, original);
  await assert.rejects(finishDig(config, { project: state, dig: first.dig, answer: 'Unexpected answer', status: 'answered', reports: [first.report] }), /only digs created with dig_start/);
  await assert.rejects(saveReport(config, { project: state, dig: first.dig, source: 'x', agent: 'hackernews', content: inventory }), /source method/);
});

test('a rejected settings update leaves the authority unchanged', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dig-native-rejected-'));
  const enabled = await updateConfig({ papers_enabled: true }, state);
  assert.deepEqual(enabled.sources.enabled, ['hackernews', 'papers']);
  const before = await readFile(enabled.path, 'utf8');
  await assert.rejects(updateConfig({ papers_enabled: false, x_depth: 'deepest' }, state), /x\.depth must be quick, standard, max or ultra/);
  assert.equal(await readFile(enabled.path, 'utf8'), before);
  const disabled = await updateConfig({ papers_enabled: false, x_depth: 'max' }, state);
  assert.deepEqual(disabled.sources.enabled, ['hackernews']);
  assert.equal((await loadConfig(state)).x.depth, 'max');
});
