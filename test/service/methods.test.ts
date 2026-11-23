// The methods in skills/ and how the service serves them: the Skills extension, prompts and the `method` tool.
// Plain functions are tested directly; one in-process server (no port, no service) checks the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { MODULES, moduleSkills } from '../../src/providers/modules.ts';
import { createSchemas } from '../../src/providers/schemas.ts';
import { loadConfig } from '../../src/config.mjs';
import { SKILLS_ROOT, listedMethods, loadMethods, methodFile, methodText, promptMessage, promptedMethods, readMethod, registerMethods } from '../../src/service/methods.ts';

const state = await mkdtemp(join(tmpdir(), 'dig-methods-'));
process.env.DIG_STATE_DIR = state;
test.after(() => rm(state, { recursive: true, force: true }));

const all = await loadMethods();
const NAMES = (await readdir(SKILLS_ROOT, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort();

// The design's surface: one tool per catalog entry, its actions (today's provider tool names), and the core tools.
const CORE = ['dig_start', 'dig_finish', 'research_save', 'library_list', 'library_search', 'library_read', 'source_info', 'method', 'job', 'settings', 'keys'];
const TOOLS = new Set([...MODULES.map(m => m.id.replaceAll('-', '_')), ...CORE]);
const ACTIONS = new Set(MODULES.flatMap(m => [...m.tools]));
// Field names: every property and enumerated value of the actions' schemas, plus the fields of results, receipts,
// reports and settings the methods name, and provider-side names they name as such.
const FIELDS = new Set<string>();
const collect = (s: unknown): void => {
  if (!s || typeof s !== 'object') return;
  if (Array.isArray(s)) { s.forEach(collect); return; }
  for (const [k, v] of Object.entries(s)) {
    if (k === 'properties' && v && typeof v === 'object') for (const p of Object.keys(v)) FIELDS.add(p);
    if (k === 'const' || k === 'enum') for (const x of [v].flat()) if (typeof x === 'string') FIELDS.add(x);
    collect(v);
  }
};
collect(createSchemas(Type));
for (const name of [
  'source_card', 'report_path', 'strongest_findings', 'topic_volatility', 'generated_at', 'keep_raw', 'worker_model', 'worker_effort', 'mode_used', // reports, settings, library results
  'total_count', 'incomplete_results', 'pushed_at', 'status_code', 'source_status', 'video_seconds', 'max_cursor', 'max_id', 'next_max_id', 'no_more', 'continue_flag', 'estimated_paid_traffic_cost', 'location_code', 'language_code', 'web_search', // provider response fields
  'task_post', 'task_get', 'google_scholar', 'google_trends_queries_list', 'google_trends_topics_list', 'advertiser_ids', 'most_helpful', 'min_faves', 'min_retweets', 'strip_thinking', 'reasoning_effort', // provider endpoints, connectors, operators and retired arguments
  'serp_organic_live_advanced', // named as a per-endpoint tool that does not exist
]) FIELDS.add(name);
const BANNED = ['$dig:', '/dig:', 'skillPath', 'helperSkillPath', 'disable-model-invocation', 'open_trail', 'open_library', 'show_research', 'absolute `project`'];

const frontMatter = (text: string) => { const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1]; assert.ok(block, 'front matter'); return Object.fromEntries(block.split('\n').map(line => { const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1).trim()]; })); };
const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function files(dir: string, prefix = ''): Promise<string[]> {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(d => d.isDirectory() ? files(join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`]))).flat();
}

test('[methods] there are 39, one folder each, and every catalog method and helper has one', () => {
  assert.equal(NAMES.length, 39);
  assert.deepEqual(new Set(moduleSkills(MODULES.map(m => m.id))), new Set(NAMES));
});

test('[methods] each SKILL.md has exactly name and description, and its folder is its name', async () => {
  for (const name of NAMES) {
    const fm = frontMatter(await readFile(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8'));
    assert.deepEqual(Object.keys(fm).sort(), ['description', 'name'], name);
    assert.equal(fm.name, name);
    assert.ok(fm.description.length > 20, `${name} has a description`);
  }
});

test('[methods] no host invocation syntax, plugin paths, views or project arguments remain', async () => {
  for (const name of NAMES) for (const file of await files(join(SKILLS_ROOT, name))) {
    const text = await readFile(join(SKILLS_ROOT, name, file), 'utf8');
    for (const banned of BANNED) assert.ok(!text.includes(banned), `${name}/${file} mentions ${banned}`);
  }
});

test('[methods] every tool name in backticks is a tool, an action or a field of the surface', async () => {
  for (const name of NAMES) for (const file of await files(join(SKILLS_ROOT, name))) {
    const text = await readFile(join(SKILLS_ROOT, name, file), 'utf8');
    for (const [, id] of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) assert.ok(TOOLS.has(id) || ACTIONS.has(id) || FIELDS.has(id), `${name}/${file}: \`${id}\` is no tool, action or field`);
    // A call written as `name({ … })` names a tool.
    for (const [, id] of text.matchAll(/`([a-z_]+)\(\{/g)) assert.ok(TOOLS.has(id), `${name}/${file}: ${id}(…) is no tool`);
  }
});

test('[methods] every relative link resolves to a file inside its method', async () => {
  for (const name of NAMES) for (const file of await files(join(SKILLS_ROOT, name))) {
    const text = await readFile(join(SKILLS_ROOT, name, file), 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:|^#/i.test(target)) continue;
      const path = resolve(dirname(join(SKILLS_ROOT, name, file)), target.split('#')[0]);
      assert.ok(!relative(join(SKILLS_ROOT, name), path).startsWith('..'), `${name}/${file} links outside its method: ${target}`);
      assert.ok(existsSync(path), `${name}/${file} links to a missing file: ${target}`);
    }
  }
});

test('[catalog] lists all 39 with manifests whose digests and sizes match the files', async () => {
  assert.deepEqual(all.list.map(m => m.name), NAMES);
  for (const m of all.list) {
    assert.equal(m.entry.uri, `skill://${m.name}/SKILL.md`);
    assert.deepEqual(m.entry.frontmatter, { name: m.name, description: m.description });
    const onDisk = (await files(join(SKILLS_ROOT, m.name))).sort();
    assert.ok(Array.isArray(m.entry.resources));
    assert.deepEqual(m.entry.resources.map(r => r.uri).sort(), onDisk.map(f => `skill://${m.name}/${f}`).sort(), `${m.name}'s manifest lists every file`);
    for (const r of m.entry.resources) {
      const bytes = await readFile(join(SKILLS_ROOT, m.name, r.uri.slice(`skill://${m.name}/`.length)));
      assert.equal(r.size, bytes.length, r.uri); assert.equal(r.digest, sha256(bytes), r.uri);
    }
  }
  assert.equal(all.byName.get('x-judge')?.module, 'x'); assert.equal(all.byName.get('dig')?.module, null); assert.equal(all.byName.get('video-analyze')?.module, 'video');
  assert.deepEqual(listedMethods(all, ['hackernews']).map(m => m.name), ['dig', 'hackernews', 'library', 'setup']);
});

test('[prompt] a method\'s message is its instructions, with the question appended as the task', () => {
  const m = all.byName.get('hackernews')!;
  const plain = promptMessage(m);
  assert.equal(plain.description, m.description);
  assert.equal(plain.messages.length, 1); assert.equal(plain.messages[0].role, 'user');
  const text = (plain.messages[0].content as { text: string }).text;
  assert.ok(text.startsWith('# Hacker News research'), 'the instructions, without front matter'); assert.ok(!text.includes('## Task'));
  const asked = (promptMessage(m, '  What do developers say about Bun?  ').messages[0].content as { text: string }).text;
  assert.equal(asked, `${text}\n## Task\n\nWhat do developers say about Bun?\n`);
  assert.match(methodText(all.byName.get('dig')!), /read with `method\(\{ name: "dig", file \}\)`: `references\/website-opportunities\.md`\.\n$/);
  assert.deepEqual(promptedMethods(all.list).map(m => m.name).filter(n => !NAMES.includes(n)), []);
  assert.ok(!promptedMethods(all.list).some(m => m.name === 'youtube-summarizer'));
});

test('[method tool] instructions, a supporting file, an unknown name and a file outside the folder', () => {
  const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;
  const instructions = readMethod(all, 'x-post');
  assert.ok(!instructions.isError); assert.equal(text(instructions), methodText(all.byName.get('x-post')!));
  const file = readMethod(all, 'dataforseo', 'references/website-recipes.md');
  assert.ok(!file.isError); assert.match(text(file), /^# /);
  for (const xMethod of ['x-judge', 'x-breadth', 'x-post', 'x-trace']) {
    const pb = readMethod(all, xMethod, 'references/playbooks.md');
    assert.ok(!pb.isError, `${xMethod} exposes references/playbooks.md`);
    assert.match(text(pb), /^# /);
    const skillBytes = all.byName.get(xMethod)!.files.get('SKILL.md')!.length;
    assert.ok(skillBytes < 20_000, `${xMethod}/SKILL.md grew to ${skillBytes} bytes`);
  }
  const unknown = readMethod(all, 'x-search');
  assert.equal(unknown.isError, true); assert.match(text(unknown), /No method is named x-search\. The methods are: .*x-judge/);
  for (const outside of ['../dataforseo/references/website-recipes.md', '/etc/passwd', 'references/../../dig/SKILL.md', 'file:///etc/passwd']) {
    const refused = readMethod(all, 'dataforseo-ai-visibility', outside);
    assert.equal(refused.isError, true, outside); assert.match(text(refused), /outside the dataforseo-ai-visibility method's folder/, outside);
  }
  assert.match((methodFile(all.byName.get('dig')!, 'references/nothing.md') as { error: string }).error, /has no file references\/nothing\.md\. Its files: SKILL\.md, references\/website-opportunities\.md/);
});

test('[server] skills/list, skills/get for listed and unlisted methods, an unknown URI, prompts and the method tool', async () => {
  const server = new McpServer({ name: 'dig-test', version: '0.0.0' });
  await registerMethods(server, { era: 'modern' });
  const client = new Client({ name: 'methods-test', version: '0.0.0' });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd); await client.connect(clientEnd);
  try {
    const enabled = (await loadConfig()).sources.enabled as string[];
    assert.ok(!enabled.includes('x'), 'the default settings leave X off');
    const skills = new SkillsClient(client);
    assert.equal(skills.supported, true);
    const listing = await skills.list();
    assert.deepEqual(listing.skills.map(s => s.frontmatter.name).sort(), listedMethods(all, enabled).map(m => m.name).sort());
    // A listed method, read and verified against its manifest.
    const dig = await skills.get('skill://dig/SKILL.md');
    assert.deepEqual(dig.skill, all.byName.get('dig')!.entry);
    const read = await skills.read(dig.skill, 'references/website-opportunities.md');
    assert.equal(read.text, await readFile(join(SKILLS_ROOT, 'dig/references/website-opportunities.md'), 'utf8'));
    // A method of a disabled source: not listed, still served.
    assert.ok(!listing.skills.some(s => s.uri === 'skill://x-judge/SKILL.md'));
    const judge = await skills.get('skill://x-judge/SKILL.md');
    assert.equal(judge.skill.frontmatter.name, 'x-judge');
    assert.match((await skills.read(judge.skill)).text, /^---\nname: x-judge\n/);
    await assert.rejects(skills.get('skill://x-search/SKILL.md'), (e: { code?: number }) => e.code === -32602);
    // Prompts: those of listed methods, each with an optional question.
    const prompts = (await client.listPrompts()).prompts;
    assert.ok(prompts.some(p => p.name === 'dig') && !prompts.some(p => p.name === 'x-judge') && !prompts.some(p => p.name === 'youtube-summarizer'));
    assert.deepEqual(prompts.find(p => p.name === 'library')?.arguments?.map(a => [a.name, a.required ?? false]), [['question', false]]);
    const prompt = await client.getPrompt({ name: 'library', arguments: { question: 'What did earlier digs find about Bun?' } });
    assert.match((prompt.messages[0].content as { text: string }).text, /## Task\n\nWhat did earlier digs find about Bun\?\n$/);
    // The method tool serves every method, listed or not.
    const tool = (await client.listTools()).tools.find(t => t.name === 'method');
    assert.match(tool?.description ?? '', /source_info names each source's methods/);
    const called = await client.callTool({ name: 'method', arguments: { name: 'x-judge' } });
    assert.equal((called.content as { text: string }[])[0].text, methodText(all.byName.get('x-judge')!));
  } finally { await client.close(); await server.close(); }
});
