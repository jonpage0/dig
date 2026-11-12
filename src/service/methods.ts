// Methods: the instructions in skills/<name>/, served three ways from one in-memory copy of their bytes, so every
// manifest digest and size describes exactly what is served. The Skills extension is the standard path; prompts (one
// per method a person would run) and the `method` tool reach hosts that do not implement it yet.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CallToolResult, GetPromptResult, McpRequestContext, McpServer, RegisteredPrompt } from '@modelcontextprotocol/server';
import { SkillsExtension, skillEntry, type Skill, type SkillSource } from '@modelcontextprotocol/server/ext/skills';
import { loadConfig } from '../config.mjs';
import { MODULES, moduleSkills, type DigModule, type ModuleId } from '../providers/modules.ts';

/** The methods folder: `skills/` at the package root, reached from `src/service/` in development and from the bundle in `dist/`. */
export const SKILLS_ROOT = fileURLToPath(['../skills/', '../../skills/'].map(path => new URL(path, import.meta.url)).find(url => existsSync(new URL('dig/SKILL.md', url))) ?? new URL('../../skills/', import.meta.url));
const BASE = 'skill://';
/** Methods that only assist another method and that a person would not run alone: no prompt. */
const UNPROMPTED = new Set(['youtube-summarizer']);
// skills/list follows the enabled sources, so a client keeps it no longer than the tool list.
const CACHE = { ttlMs: 60_000, cacheScope: 'private' } as const;

export interface Method {
  name: string; description: string;
  /** The catalog entry it belongs to; null for `dig`, `library` and `setup`, which belong to every installation. */
  module: string | null;
  /** The instructions: SKILL.md after its front matter. */
  instructions: string;
  /** Every file, by path relative to the method's folder (`SKILL.md`, `references/…`), as the bytes served. */
  files: ReadonlyMap<string, Uint8Array>;
  /** The Skills extension entry: frontmatter and a manifest computed from `files`. */
  entry: Skill;
}
export interface Methods { list: readonly Method[]; byName: ReadonlyMap<string, Method>; byUri: ReadonlyMap<string, { method: Method; path: string }> }

const owner = new Map<string, string>((MODULES as readonly DigModule[]).flatMap(m => [...(m.skills ?? (m.kind === 'tool' ? [] : [m.id])), ...(m.helpers ?? []), ...(m.helperSkill ? [m.helperSkill] : [])].map(name => [name, m.id] as const)));

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const d of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${d.name}` : d.name;
    // Only regular files and folders are served; anything else (a link) is left out rather than followed.
    if (d.isDirectory()) out.push(...await walk(join(dir, d.name), path)); else if (d.isFile()) out.push(path);
  }
  return out;
}
const body = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/^\s+/, '');

/** Reads every method under `root`. A folder whose SKILL.md is missing or whose `name` differs from the folder fails loudly. */
export async function loadMethods(root = SKILLS_ROOT): Promise<Methods> {
  const list: Method[] = [];
  for (const d of (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const files = new Map<string, Uint8Array>();
    // SKILL.md first, then the supporting files in path order.
    for (const path of (await walk(join(root, d.name))).sort((a, b) => Number(b === 'SKILL.md') - Number(a === 'SKILL.md'))) files.set(path, new Uint8Array(await readFile(join(root, d.name, path))));
    if (!files.has('SKILL.md')) throw new Error(`skills/${d.name} has no SKILL.md`);
    const entry = await skillEntry(d.name, Object.fromEntries(files), { baseUri: BASE });
    const { name, description } = entry.frontmatter;
    if (name !== d.name) throw new Error(`skills/${d.name}/SKILL.md is named ${name}; a method's name is its folder's`);
    list.push({ name, description, module: owner.get(name) ?? null, instructions: body(new TextDecoder().decode(files.get('SKILL.md'))), files, entry });
  }
  const byUri = new Map(list.flatMap(method => [...method.files.keys()].map(path => [`${BASE}${method.name}/${path}`, { method, path }] as const)));
  return { list, byName: new Map(list.map(m => [m.name, m])), byUri };
}

let loaded: Promise<Methods> | undefined;
/** The methods the service serves, read once per process. */
export const methods = () => (loaded ??= loadMethods());

/** The methods listed to a client: `dig`, `library`, `setup` and those of the enabled sources, in folder order. */
export function listedMethods(all: Methods, enabled: readonly string[]): Method[] {
  const names = new Set(moduleSkills(enabled.filter(id => MODULES.some(m => m.id === id)) as ModuleId[]));
  return all.list.filter(m => names.has(m.name));
}
const enabledSources = async () => { try { return (await loadConfig()).sources.enabled as string[]; } catch { return []; } };

const fileLine = (m: Method) => { const extra = [...m.files.keys()].filter(path => path !== 'SKILL.md'); return extra.length ? `\n\nThis method's supporting files, read with \`method({ name: "${m.name}", file })\`: ${extra.map(path => `\`${path}\``).join(', ')}.` : ''; };
/** What the `method` tool and a prompt give the model: the instructions, and how to reach the supporting files. */
export const methodText = (m: Method) => `${m.instructions.trimEnd()}${fileLine(m)}\n`;

/** A prompt's message: the method's instructions, then the person's question as the task when one is given. */
export function promptMessage(m: Method, question?: string): GetPromptResult {
  const task = question?.trim();
  return { description: m.description, messages: [{ role: 'user', content: { type: 'text', text: task ? `${methodText(m)}\n## Task\n\n${task}\n` : methodText(m) } }] };
}
/** The methods offered as prompts: every method a person would run, not the helpers that only assist another. */
export const promptedMethods = (all: readonly Method[]) => all.filter(m => !UNPROMPTED.has(m.name));

/** One supporting file of a method, by its path relative to the method's folder; a path that leaves the folder is refused. */
export function methodFile(m: Method, file: string): { text: string } | { error: string } {
  const path = posix.normalize(file.replaceAll('\\', '/'));
  if (posix.isAbsolute(path) || path === '..' || path.startsWith('../') || /^[a-z][a-z0-9+.-]*:/i.test(file)) return { error: `${file} is outside the ${m.name} method's folder; name a file by its path inside it, such as references/….` };
  const bytes = m.files.get(path);
  if (!bytes) return { error: `The ${m.name} method has no file ${path}. Its files: ${[...m.files.keys()].join(', ')}.` };
  return { text: new TextDecoder().decode(bytes) };
}

/** The `method` tool's answer for one call. */
export function readMethod(all: Methods, name: string, file?: string): CallToolResult {
  const m = all.byName.get(name);
  const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });
  if (!m) return fail(`No method is named ${name}. The methods are: ${all.list.map(x => x.name).join(', ')}.`);
  if (file === undefined) return { content: [{ type: 'text', text: methodText(m) }] };
  const read = methodFile(m, file);
  return 'error' in read ? fail(read.error) : { content: [{ type: 'text', text: read.text }] };
}

/** The Skills extension's view of the methods: listing follows the enabled sources; `skills/get` and reads serve every method. */
export function skillSource(all: () => Promise<Methods>, enabled: () => Promise<readonly string[]>): SkillSource {
  return {
    async list() { return { skills: listedMethods(await all(), await enabled()).map(m => m.entry) }; },
    async get(uri) { return (await all()).byName.get(uri.startsWith(BASE) && uri.endsWith('/SKILL.md') ? uri.slice(BASE.length, -'/SKILL.md'.length) : '')?.entry; },
    async read(uri) {
      const hit = (await all()).byUri.get(uri);
      if (!hit) return undefined;
      const bytes = hit.method.files.get(hit.path)!;
      return hit.path.endsWith('.md') ? { text: new TextDecoder().decode(bytes), mimeType: 'text/markdown' } : { bytes, mimeType: 'application/octet-stream' };
    },
  };
}
// One extension instance serves every server instance the service builds.
let extension: SkillsExtension | undefined;
const skills = () => (extension ??= new SkillsExtension({ source: skillSource(methods, enabledSources), cacheHint: CACHE }));

const METHOD_DESCRIPTION = 'Read a Dig method: the instructions for researching one source (or for running a dig, reusing the library, or setting Dig up), which say what to search, how to weigh it and how to save the report. source_info names each source\'s methods. method({ name }) returns a method\'s instructions; method({ name, file }) returns one of its supporting files, by the path the instructions give.';

/**
 * Serves the methods on one server instance: the Skills extension, a prompt per method a person would run (those of
 * enabled sources), and the `method` tool. Returns a function that relists the prompts when settings change.
 */
export async function registerMethods(server: McpServer, _context: McpRequestContext) {
  const all = await methods();
  skills().attach(server);
  const prompts = new Map<Method, RegisteredPrompt>();
  for (const m of promptedMethods(all.list)) {
    prompts.set(m, server.registerPrompt(m.name, { description: m.description, argsSchema: z.object({ question: z.string().optional().describe('The research question or request to run the method on.') }) }, ({ question }) => promptMessage(m, question)));
  }
  const sync = (enabled: readonly string[]) => {
    const listed = new Set(listedMethods(all, enabled));
    for (const [m, prompt] of prompts) if (listed.has(m) !== prompt.enabled) { if (listed.has(m)) prompt.enable(); else prompt.disable(); }
  };
  sync(await enabledSources());
  server.registerTool('method', {
    title: 'Read a method', description: METHOD_DESCRIPTION,
    inputSchema: z.object({ name: z.string().min(1).describe('The method\'s name, as source_info gives it.'), file: z.string().min(1).optional().describe('A supporting file\'s path inside the method\'s folder, such as references/….') }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ name, file }) => readMethod(await methods(), name, file));
  return sync;
}
