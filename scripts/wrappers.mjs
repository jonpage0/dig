// The host wrappers: thin plugins that launch `dig mcp` from this checkout, generated from the sources and never
// edited by hand. plugins/chatgpt is a ChatGPT/Codex plugin (manifest, pointer, a copy of skills/ with each method's
// agents/openai.yaml, and the icons those name), since ChatGPT does not yet read methods from a local server;
// plugins/claude is a Claude Code plugin with the pointer only, since Claude Code shows the service's prompts. Each
// host's marketplace file sits at plugins/. The pointer holds this checkout's absolute path, so plugins/ is not tracked.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES } from '../src/providers/modules.ts';
import { GLYPHS, glyphFor, tileSvg } from '../src/glyphs.mjs';
import { VERSION } from '../src/version.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const at = path => join(ROOT, path);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const MARKETPLACE = 'dig-local';
const BRAND = '#2d68aa';
// What each host shows for Dig. The wrappers are the only host manifests: these fields are their source.
const AUTHOR = { name: 'Jon Page' };
const REPOSITORY = 'https://github.com/jonpage0/dig';
const DESCRIPTION = 'Source-specific research tools and methods with a native retained-evidence library.';
const PROMPTS = ['Research this question with Dig and keep the original evidence.', 'What have I already researched about this topic in Dig?', 'Set up Dig\'s research sources.'];
const MANIFEST = { name: 'dig', description: DESCRIPTION, author: AUTHOR, homepage: REPOSITORY, repository: REPOSITORY, license: 'MIT' };
const CODEX = {
  ...MANIFEST, skills: './skills/', mcpServers: './.mcp.json',
  interface: {
    displayName: 'Dig', shortDescription: 'Research, retained.',
    longDescription: 'Research web documents, repositories, papers, social platforms, commerce and prediction markets with source-specific methods. Retain original responses, save grounded reports and inspect the evidence in a native library. The initiating conversation chooses sources and composes only when needed.',
    developerName: AUTHOR.name, category: 'Research', capabilities: ['Read', 'Write', 'Interactive'],
    logo: './assets/logo.png', logoDark: './assets/logo-dark.png', composerIcon: './assets/icon.png', brandColor: BRAND, defaultPrompt: PROMPTS,
  },
  extensions: { 'com.openai': { onboardingSkill: './skills/setup/SKILL.md' } },
};
const CLAUDE = { ...MANIFEST, keywords: ['research', 'evidence', 'mcp'] };
// The three methods every installation has take their glyph here; a source's methods take theirs from the glyph table.
const OWN_GLYPHS = { dig: 'shovel', library: 'library-big', setup: 'sliders-horizontal' };

async function files(dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(path)); else if (entry.isFile()) out.push(path);
  }
  return out;
}
const frontMatter = text => Object.fromEntries((/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '').split(/\r?\n/).map(line => /^([a-z-]+):\s*(.*)$/.exec(line)).filter(Boolean).map(([, key, value]) => [key, value.replace(/^(['"])(.*)\1$/, '$2')]));
const shorten = (text, max = 72) => { const sentence = text.split(/(?<=\.)\s/)[0].replace(/\.$/, ''); if (sentence.length <= max) return sentence; const cut = sentence.slice(0, max - 1).replace(/[\s,;:]+\S*$/, ''); return `${cut}…`; };

/** The catalog entry a method belongs to, as the service's methods module reads it; null for dig, library and setup. */
const owner = new Map(MODULES.flatMap(m => [...(m.skills ?? (m.kind === 'tool' ? [] : [m.id])), ...(m.helpers ?? []), ...(m.helperSkill ? [m.helperSkill] : [])].map(name => [name, m])));
const label = name => { const m = owner.get(name); if (!m) return name === 'dig' ? null : name[0].toUpperCase() + name.slice(1); return name === m.id || name === m.helperSkill ? m.label : `${m.label} ${name.startsWith(`${m.id}-`) ? name.slice(m.id.length + 1).replaceAll('-', ' ') : name.replaceAll('-', ' ')}`; };
const glyph = name => OWN_GLYPHS[name] ?? glyphFor(owner.get(name)?.id, name);

/**
 * agents/openai.yaml for one method: its display name, short description and icon, generated from the method and the
 * glyph table. A source's methods are reached through the dig method's routing or by name, never implicitly; the
 * three every installation has, and the shared tools' helpers, a person may run directly.
 */
function openaiYaml(name, description, prompts) {
  const m = owner.get(name); const icon = `../../assets/skills/${glyph(name)}.svg`;
  const short = m && name === m.id ? m.description : shorten(description);
  const prompt = { dig: prompts[0], library: prompts[1], setup: prompts[2] }[name] ?? `Use $dig:${name} for this question.`;
  const implicit = !m || m.kind === 'tool';
  return ['interface:', `  display_name: ${JSON.stringify(label(name) ? `Dig · ${label(name)}` : 'Dig')}`, `  short_description: ${JSON.stringify(short)}`, `  icon_small: ${JSON.stringify(icon)}`, `  icon_large: ${JSON.stringify(icon)}`, `  brand_color: ${JSON.stringify(BRAND)}`, `  default_prompt: ${JSON.stringify(prompt)}`,
    ...(implicit ? [] : ['policy:', `  # Reached through the dig method's source_info routing or an explicit $dig:${name} mention.`, '  allow_implicit_invocation: false']), ''].join('\n');
}

/** Every generated file, by its path under the repository, with its exact contents. */
export async function wrapperFiles() {
  const out = new Map();
  const launch = { command: 'node', args: [at('dist/dig.mjs'), 'mcp'] };

  // Marketplaces, one per host, each naming its wrapper.
  out.set('plugins/.claude-plugin/marketplace.json', json({ name: MARKETPLACE, owner: AUTHOR, metadata: { description: 'Dig: source-specific research with a retained-evidence library. Runs the local Dig service from this checkout.' }, plugins: [{ name: 'dig', source: './claude', description: DESCRIPTION, category: 'research' }] }));
  out.set('plugins/.agents/plugins/marketplace.json', json({ name: MARKETPLACE, interface: { displayName: 'Dig (local service)' }, plugins: [{ name: 'dig', source: { source: 'local', path: './chatgpt' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Research' }] }));

  // Claude Code: the manifest with its pointer; the methods come from the service as prompts.
  out.set('plugins/claude/.claude-plugin/plugin.json', json({ name: 'dig', version: VERSION, ...CLAUDE, mcpServers: { dig: launch } }));

  // ChatGPT and Codex: the manifest, the pointer, the methods with their host files, and the images they name.
  out.set('plugins/chatgpt/.codex-plugin/plugin.json', json({ name: 'dig', version: VERSION, ...CODEX }));
  // The service reads keys.env itself, so no credential is passed through; only where the service lives.
  out.set('plugins/chatgpt/.mcp.json', json({ mcpServers: { dig: { ...launch, startup_timeout_sec: 30, tool_timeout_sec: 600, env_vars: ['DIG_STATE_DIR', 'DIG_PORT'] } } }));
  for (const image of ['logo.png', 'logo-dark.png', 'icon.png']) out.set(`plugins/chatgpt/assets/${image}`, await readFile(at(`assets/${image}`)));
  const glyphs = new Set();
  for (const dir of (await readdir(at('skills'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    for (const file of await files(at(`skills/${dir}`))) out.set(`plugins/chatgpt/skills/${relative(at('skills'), file)}`, await readFile(file));
    const { name, description } = frontMatter(await readFile(at(`skills/${dir}/SKILL.md`), 'utf8'));
    if (name !== dir || !description) throw new Error(`skills/${dir}/SKILL.md needs name ${dir} and a description`);
    out.set(`plugins/chatgpt/skills/${dir}/agents/openai.yaml`, openaiYaml(dir, description, PROMPTS));
    glyphs.add(glyph(dir));
  }
  for (const name of [...glyphs].sort()) { if (!GLYPHS[name]) throw new Error(`No glyph ${name}`); out.set(`plugins/chatgpt/assets/skills/${name}.svg`, tileSvg(name)); }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}
