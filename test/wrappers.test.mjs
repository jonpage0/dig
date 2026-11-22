// The host wrappers under plugins/ are build output: exactly what scripts/wrappers.mjs generates from the sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { wrapperFiles } from '../scripts/wrappers.mjs';

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) out.push(...await files(path)); else out.push(path); }
  return out;
}
const DIG = resolve('dist/dig.mjs');

test('plugins/ holds exactly the generated wrappers, byte for byte, and nothing else', async () => {
  const generated = await wrapperFiles();
  const onDisk = (await files('plugins')).map(path => relative('.', path)).sort();
  assert.deepEqual(onDisk, [...generated.keys()].sort());
  for (const [path, contents] of generated) assert.ok(Buffer.from(contents).equals(await readFile(path)), `${path} differs from what the build generates`);
});

test('every method has its ChatGPT and Antigravity copies and generated host file; the Claude wrapper carries no methods', async () => {
  const generated = await wrapperFiles();
  const methods = (await readdir('skills', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.ok(methods.length >= 30);
  for (const name of methods) {
    assert.equal(String(generated.get(`plugins/chatgpt/skills/${name}/SKILL.md`)), await readFile(`skills/${name}/SKILL.md`, 'utf8'), name);
    assert.ok(generated.has(`plugins/antigravity/skills/${name}/SKILL.md`), `antigravity ${name}`);
    const yaml = String(generated.get(`plugins/chatgpt/skills/${name}/agents/openai.yaml`));
    assert.match(yaml, /^interface:\n  display_name: "Dig(?: · [^"]+)?"\n  short_description: "[^"]{1,90}"\n  icon_small: "\.\.\/\.\.\/assets\/skills\/([a-z0-9-]+)\.svg"\n  icon_large: "\.\.\/\.\.\/assets\/skills\/\1\.svg"\n  brand_color: "#2d68aa"\n  default_prompt: "[^"]+"\n/, name);
    const icon = /icon_small: "\.\.\/\.\.\/(assets\/skills\/[a-z0-9-]+\.svg)"/.exec(yaml)[1];
    assert.ok(generated.has(`plugins/chatgpt/${icon}`), `${name}'s icon ${icon}`);
  }
  // A source's methods are reached by routing or by name; the three every installation has may be chosen implicitly.
  assert.match(String(generated.get('plugins/chatgpt/skills/hackernews/agents/openai.yaml')), /allow_implicit_invocation: false/);
  assert.doesNotMatch(String(generated.get('plugins/chatgpt/skills/dig/agents/openai.yaml')), /policy:/);
  assert.match(String(generated.get('plugins/chatgpt/skills/hackernews/agents/openai.yaml')), /display_name: "Dig · Hacker News"/);
  assert.match(String(generated.get('plugins/antigravity/skills/hackernews/SKILL.md')), /^---\n[\s\S]*\ndisable-model-invocation: true\n---\n/);
  for (const implicit of ['dig', 'library', 'setup', 'video-analyze', 'evidence-rank']) {
    assert.doesNotMatch(String(generated.get(`plugins/antigravity/skills/${implicit}/SKILL.md`)), /disable-model-invocation/, implicit);
  }
  assert.deepEqual([...generated.keys()].filter(path => path.startsWith('plugins/claude/')), ['plugins/claude/.claude-plugin/plugin.json']);
});

test('each pointer launches dig mcp from this checkout\'s dist/dig.mjs, with no credential allowlist', async () => {
  const generated = await wrapperFiles();
  const codex = JSON.parse(generated.get('plugins/chatgpt/.mcp.json')).mcpServers.dig;
  assert.deepEqual([codex.command, ...codex.args], ['node', DIG, 'mcp']);
  assert.equal(codex.tool_timeout_sec, 600);
  assert.deepEqual(codex.env_vars, ['DIG_STATE_DIR', 'DIG_PORT']);
  const claude = JSON.parse(generated.get('plugins/claude/.claude-plugin/plugin.json'));
  assert.deepEqual(claude.mcpServers, { dig: { command: 'node', args: [DIG, 'mcp'] } });
  const agyManifest = JSON.parse(generated.get('plugins/antigravity/plugin.json'));
  assert.equal(agyManifest.$schema, 'https://antigravity.google/schemas/v1/plugin.json');
  assert.equal(agyManifest.name, 'dig');
  assert.equal(agyManifest.displayName, 'Dig');
  assert.equal(agyManifest.logo, 'assets/logo.png');
  assert.ok(generated.has(`plugins/antigravity/${agyManifest.logo}`));
  assert.ok(Array.isArray(agyManifest.suggestedPrompts) && agyManifest.suggestedPrompts.length > 0);
  const agyMcp = JSON.parse(generated.get('plugins/antigravity/mcp_config.json')).mcpServers.dig;
  assert.deepEqual([agyMcp.command, ...agyMcp.args], ['node', DIG, 'mcp']);
  assert.equal(agyMcp.timeoutSeconds, 600);
  const manifest = JSON.parse(generated.get('plugins/chatgpt/.codex-plugin/plugin.json'));
  assert.equal(manifest.skills, './skills/'); assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(manifest.extensions['com.openai'].onboardingSkill, './skills/setup/SKILL.md');
  for (const image of [manifest.interface.logo, manifest.interface.logoDark, manifest.interface.composerIcon]) assert.ok(generated.has(join('plugins/chatgpt', image)), image);
  const markets = [JSON.parse(generated.get('plugins/.claude-plugin/marketplace.json')), JSON.parse(generated.get('plugins/.agents/plugins/marketplace.json'))];
  assert.deepEqual(markets.map(market => market.plugins.map(plugin => plugin.source)), [['./claude'], [{ source: 'local', path: './chatgpt' }]]);
});
