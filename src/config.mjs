import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import TOML from '@iarna/toml';
import { MODULES, ALL_MODULES, moduleAgents } from './providers/modules.ts';
import { registerSecret } from './providers/secrets.ts';

export function stateDirectory(env = process.env) {
  return resolve(env.DIG_STATE_DIR || join(homedir(), '.local', 'share', 'dig'));
}
export const sourceSetting = id => `${id.replaceAll('-', '_')}_enabled`;
const X_DEFAULTS = { model: 'grok-4.7', depth: 'standard', web_search: false, code_execution: false };
/**
 * Dig's built-in guidance for the Codex worker that runs a source method: `default` covers every method without its
 * own entry. Guidance, not an enforced pin: the initiating thread chooses each worker's model and effort.
 */
export const WORKER_DEFAULTS = { default: { model: 'gpt-6.1-sol', effort: 'medium' }, 'x-breadth': { model: 'gpt-6-luna', effort: 'high' }, 'x-judge': { model: 'gpt-6-astra', effort: 'high' } };
/** Codex's reasoning effort names (Codex 0.160). Whether a model accepts one is the host's and account's concern. */
export const WORKER_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** `[workers.<name>]` tables: `default` and every catalog method, helpers included. */
export const WORKER_TABLES = ['default', ...moduleAgents(ALL_MODULES).map(agent => agent.name)];
const WORKER_FIELDS = ['model', 'effort'];
/** The flat settings field for one worker table's field: `worker_model`, `x_judge_worker_effort`. */
export const workerSetting = (table, field) => (table === 'default' ? `worker_${field}` : `${table.replaceAll('-', '_')}_worker_${field}`);
function workerValue(name, field, value) {
  if (field === 'model' && (typeof value !== 'string' || !value.trim())) throw new Error(`${name} must be a nonempty model name`);
  if (field === 'effort' && !WORKER_EFFORTS.includes(value)) throw new Error(`${name} must be one of ${WORKER_EFFORTS.join(', ')}`);
  return field === 'model' ? value.trim() : value;
}
/** What a worker table's field resolves to without its own value: a method's built-in entry, else the Dig-wide value. */
function inherited(workers, table, field) {
  return table === 'default' ? WORKER_DEFAULTS.default[field] : WORKER_DEFAULTS[table]?.[field] ?? workers.default?.[field] ?? WORKER_DEFAULTS.default[field];
}
/**
 * The worker guidance for one method (or `default`), field by field: the method's own `[workers.<method>]` value, else
 * Dig's built-in entry for that method, else `[workers.default]`, else Dig's built-in default. `configured` says
 * whether a value the user stored decided either field.
 */
export function workerGuidance(c, table) {
  const pick = field => c.workers[table]?.[field] ?? inherited(c.workers, table, field);
  const configured = WORKER_FIELDS.some(field => c.workers[table]?.[field] !== undefined || (table !== 'default' && WORKER_DEFAULTS[table]?.[field] === undefined && c.workers.default?.[field] !== undefined));
  return { model: pick('model'), effort: pick('effort'), configured };
}
function table(value, name, keys) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${name} must be a table`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown configuration field: ${name}.${key}`);
  return value;
}
function config(input, state) {
  table(input, 'config', ['library', 'keep_raw', 'sources', 'x', 'workers']);
  if (input.library !== undefined && (typeof input.library !== 'string' || !input.library.trim())) throw new Error('library must be a nonempty path');
  const library = (input.library ?? join(state, 'library')).replace(/^~(?=\/|$)/, homedir());
  if (!isAbsolute(library)) throw new Error('library must be an absolute path or start with ~/');
  if (input.keep_raw !== undefined && typeof input.keep_raw !== 'boolean') throw new Error('keep_raw must be boolean');
  const enabled = table(input.sources, 'sources', ['enabled']).enabled ?? ['hackernews'];
  if (!Array.isArray(enabled) || enabled.some(id => !MODULES.some(m => m.id === id)) || new Set(enabled).size !== enabled.length) throw new Error('sources.enabled must contain only supported, unique source ids');
  const x = { ...X_DEFAULTS, ...table(input.x, 'x', Object.keys(X_DEFAULTS)) };
  if (typeof x.model !== 'string' || !x.model.trim()) throw new Error('x.model must be a nonempty string');
  if (!['quick', 'standard', 'max', 'ultra'].includes(x.depth)) throw new Error('x.depth must be quick, standard, max or ultra');
  for (const key of ['web_search', 'code_execution']) if (typeof x[key] !== 'boolean') throw new Error(`x.${key} must be boolean`);
  const workers = {};
  for (const [name, entry] of Object.entries(table(input.workers, 'workers', WORKER_TABLES))) {
    const fields = Object.entries(table(entry, `workers.${name}`, WORKER_FIELDS)).map(([field, value]) => [field, workerValue(`workers.${name}.${field}`, field, value)]);
    if (fields.length) workers[name] = Object.fromEntries(fields);
  }
  return { path: join(state, 'config.toml'), library: resolve(library), keep_raw: input.keep_raw ?? true, sources: { enabled }, x, workers };
}
export function loadConfigSync(state = stateDirectory()) {
  const path = join(state, 'config.toml');
  let input = {};
  try { input = TOML.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`Cannot read ${path}: ${e.message}`); }
  return config(input, state);
}
export async function loadConfig(state = stateDirectory()) {
  const path = join(state, 'config.toml');
  let input = {};
  try { input = TOML.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`Cannot read ${path}: ${e.message}`); }
  return config(input, state);
}
// `[workers]` is written only when it holds something, so a file without worker suggestions stays as before.
const serialized = c => `# Dig native settings. Native controls edit this file.\n${TOML.stringify({ library: c.library, keep_raw: c.keep_raw, sources: c.sources, x: c.x, ...(Object.keys(c.workers).length ? { workers: c.workers } : {}) })}`;
export async function initializeConfig(state = stateDirectory()) {
  const c = await loadConfig(state);
  await mkdir(state, { recursive: true });
  try { await writeFile(c.path, serialized(c), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return loadConfig(state);
}
/**
 * Applies flat settings fields (`set`, as Codex's settings page and Dig's controls send them) to config.toml. A
 * worker field is stored only when it differs from what its table would inherit, so echoing the value a control
 * shows stores nothing and a method keeps following the Dig-wide suggestion until it is given its own. Only the
 * fields in `set` are compared; values written by hand stay as they are.
 */
export async function updateConfig(set, state = stateDirectory()) {
  const current = await loadConfig(state);
  const workerKeys = WORKER_TABLES.flatMap(name => WORKER_FIELDS.map(field => [workerSetting(name, field), name, field]));
  const allowed = ['library', 'keep_raw', ...MODULES.map(m => sourceSetting(m.id)), ...Object.keys(X_DEFAULTS).map(k => `x_${k}`), ...workerKeys.map(([key]) => key)];
  for (const key of Object.keys(set)) if (!allowed.includes(key)) throw new Error(`Unknown setting: ${key}`);
  for (const m of MODULES) if (set[sourceSetting(m.id)] !== undefined && typeof set[sourceSetting(m.id)] !== 'boolean') throw new Error(`${sourceSetting(m.id)} must be boolean`);
  const workers = Object.fromEntries(Object.entries(current.workers).map(([name, entry]) => [name, { ...entry }]));
  const touched = workerKeys.filter(([key]) => set[key] !== undefined);
  for (const [key, name, field] of touched) (workers[name] ??= {})[field] = workerValue(key, field, set[key]);
  // `default` comes first in WORKER_TABLES, so a method compares against the Dig-wide value this update leaves.
  for (const [, name, field] of touched) {
    if (workers[name][field] === inherited(workers, name, field)) delete workers[name][field];
    if (!Object.keys(workers[name]).length) delete workers[name];
  }
  const next = config({
    library: set.library ?? current.library, keep_raw: set.keep_raw ?? current.keep_raw,
    sources: { enabled: MODULES.filter(m => set[sourceSetting(m.id)] ?? current.sources.enabled.includes(m.id)).map(m => m.id) },
    x: Object.fromEntries(Object.keys(X_DEFAULTS).map(k => [k, set[`x_${k}`] ?? current.x[k]])),
    workers,
  }, state);
  await mkdir(state, { recursive: true });
  const temporary = `${current.path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, serialized(next), { mode: 0o600 });
  await rename(temporary, current.path);
  return next;
}
export const keysPath = (state = stateDirectory()) => join(state, 'keys.env');
const CATALOG_NAMES = new Set(MODULES.flatMap(m => m.env ?? []));
const REQUIRED_NAMES = new Set(MODULES.flatMap(m => (m.keys ?? []).flat()));
const SECRET_NAME = /_(KEY|TOKEN|SECRET|PASSWORD)$/;
/** Credentials are secret-shaped names plus the logins a source requires; base URLs, timeouts and contact emails are settings. */
export const isCredentialName = name => SECRET_NAME.test(name) || REQUIRED_NAMES.has(name);
// What the environment that started Dig held for each catalog name, set aside on the first load.
const startingValues = new WeakMap();
/** The starting environment's values for catalog names. Server-side only: never returned, logged or saved. */
export const environmentValues = (env = process.env) => startingValues.get(env) ?? new Map();
/**
 * Applies keys.env to `env`, the one place Dig takes credentials from. A credential Codex passed in from its own
 * environment is set aside and used only once the user copies it into keys.env (Settings → Use existing key); it
 * stays redacted. For other catalog names (base URLs, timeouts, contact email) a keys.env value wins and the
 * environment's value is the fallback. Safe to call again whenever the file changes: the file is read whole before
 * anything is applied, so an unreadable file leaves the previous values in place. Every secret-shaped value loaded is
 * registered for redaction for the life of the process, so a key rotated or removed while a request that used it is
 * still running stays redacted from that request's result and retained responses. Never reads another Dig edition's keys.
 */
export function loadKeys(env = process.env, state = stateDirectory(env)) {
  let text = '';
  try { text = readFileSync(keysPath(state), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const file = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw.trim());
    if (!match || !CATALOG_NAMES.has(match[1]) || file.has(match[1])) continue;
    // An empty assignment (`NAME=`) is a placeholder, not a value.
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!value) continue;
    file.set(match[1], value);
    if (SECRET_NAME.test(match[1])) registerSecret(value);
  }
  let starting = startingValues.get(env);
  if (!starting) {
    starting = new Map();
    for (const name of CATALOG_NAMES) {
      const value = env[name]?.trim();
      if (!value) continue;
      starting.set(name, value);
      if (SECRET_NAME.test(name)) registerSecret(value);
    }
    startingValues.set(env, starting);
  }
  for (const name of CATALOG_NAMES) {
    const value = file.get(name) ?? (isCredentialName(name) ? undefined : starting.get(name));
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
}
