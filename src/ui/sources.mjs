// Dig's Sources page: one card per source, grouped by what it researches, with a table of contents. Each card
// explains the source from the shared catalog (what it finds, the services Dig calls, how they bill), shows its
// on/off switch and own settings from settings.read, and its readiness from source_info. Its Setup details fold holds
// the credential, setting and prerequisite names with a presence chip each (never values), the keys.env buttons, and
// the suggested worker model and effort of each of the source's methods; text that every card would repeat sits behind
// an (i) button beside its section title. Controls save as they change, through the same settings.update that
// Codex's plugin settings use, so config.toml stays the one authority.
import { GLYPHS, glyphFor } from '../glyphs.mjs';
import { MODULES, SOURCE_GROUPS, moduleAgents } from '../providers/modules.ts';
import { attr, button, externalLink, fold, keyName, keyed, node, rebuild } from './dom.mjs';
import { control, enabledField, ownerOf, settingsGroups } from './settings.mjs';

const WORKER_FIELD = /_worker_(model|effort)$/;
const workerKey = (method, field) => `${method.replaceAll('-', '_')}_worker_${field}`;

const SVG = 'http://www.w3.org/2000/svg';
const STATE_WORDS = { ready: 'ready', partial: 'partly ready', 'setup-required': 'needs setup', disabled: 'off', unknown: 'unknown' };
const KEY_WORDS = { set: 'set', missing: 'missing', unset: 'not set' };
const TOOL_WORDS = { set: 'installed', missing: 'not installed' };
const ENVIRONMENT_NOTES = { unused: 'Codex’s environment has one that Dig isn’t using.', different: 'Codex’s environment has a different one.' };
const KEYS_NOTE = 'Edit keys.env opens the file in Codex. Any name here that isn’t in the file yet gets an empty line to fill in, and Dig picks up your changes when you save. Dig checks only that a key is there, not that the provider accepts it.';
const WORKERS_NOTE = 'The suggested worker for each method. The conversation chooses each worker’s model and effort and may choose others. A method without a suggestion of its own follows Source workers on the Settings page.';
const list = new Intl.ListFormat('en', { type: 'conjunction' });
const cardId = id => `source-${id}`;

/** A labeled readiness state; the word carries the meaning and the CSS pattern repeats it, never colour alone. */
export function stateChip(status) {
  return attr(node('span', 'state', STATE_WORDS[status] ?? String(status ?? 'unknown')), 'data-state', String(status ?? 'unknown'));
}
/** A presence chip in the same patterns: `set`, `missing` (something on needs it) or `unset` (optional, not set). */
const presenceChip = (state, words) => attr(node('span', 'state', words[state]), 'data-state', state);

/** The source's brand logo from the inlined sprite, or its Dig glyph, on the same light tile. */
export function mark(module, small = false) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  if (module.logo) {
    svg.setAttribute('class', 'logo');
    const use = document.createElementNS(SVG, 'use'); use.setAttribute('href', `#logo-${module.logo}`); svg.append(use);
  } else {
    svg.setAttribute('class', 'glyph'); svg.setAttribute('viewBox', '0 0 24 24');
    for (const [tag, attributes] of GLYPHS[glyphFor(module.id)]) {
      const shape = document.createElementNS(SVG, tag);
      for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
      svg.append(shape);
    }
  }
  return node('span', small ? 'mark small' : 'mark', svg);
}

// The open note, if any: one at a time. A note opened by hovering its (i) closes when the pointer leaves it; one
// opened by a click (or Enter or Space) stays until a second click, Escape, or a click elsewhere. Escape returns
// focus to the (i) button.
let openNote = null;
function closeNote(restoreFocus = false) {
  if (!openNote) return;
  const { trigger, note } = openNote; openNote = null;
  note.hidden = true; trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger.focus();
}
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && openNote) closeNote(true); });
  document.addEventListener('pointerdown', event => { if (openNote && !openNote.head.contains(event.target)) closeNote(); });
}
/**
 * A section title with an (i) button whose note explains what every card would otherwise repeat, then any `extra`
 * controls at the end of the row. The note spans the row beneath it and follows the button in reading order, and the
 * button reports whether it is open (`aria-expanded`). `key` keeps keyboard focus on the button when its section is
 * rebuilt.
 */
function titleWithNote(title, label, text, key, ...extra) {
  listen();
  const id = `note-${key.replace(/[^\w-]/g, '-')}`;
  const note = attr(node('p', 'note', text), 'id', id); note.hidden = true;
  const trigger = keyed(attr(attr(attr(node('button', 'info'), 'aria-label', label), 'aria-expanded', 'false'), 'aria-controls', id), key);
  trigger.type = 'button';
  const head = node('div', 'setup-head', node('p', 'setup-title', title), trigger, extra.length ? node('div', 'head-actions', extra) : null, note);
  let leaving = null;
  const open = pinned => {
    if (openNote?.trigger !== trigger) { closeNote(); openNote = { trigger, note, head, pinned }; }
    openNote.pinned ||= pinned;
    note.hidden = false; trigger.setAttribute('aria-expanded', 'true');
  };
  trigger.onclick = () => (openNote?.trigger === trigger && openNote.pinned ? closeNote() : open(true));
  const stay = () => clearTimeout(leaving);
  const leave = () => { leaving = setTimeout(() => { if (openNote?.trigger === trigger && !openNote.pinned) closeNote(); }, 150); };
  trigger.onmouseenter = () => { stay(); open(false); };
  trigger.onmouseleave = leave; note.onmouseenter = stay; note.onmouseleave = leave;
  return head;
}
const section = (head, ...body) => node('div', 'setup-section', typeof head === 'string' ? node('p', 'setup-title', head) : head, ...body);

/**
 * The card's readiness sentence. Ready and Off need none beside their chip (Setup details lists each key's state). The
 * server's missing-key sentence is written for the conversation, so the card keeps only its first clause and points
 * at Setup details; any other message (a partial source's specifics) is shown as the server wrote it.
 */
function readinessMessage(source) {
  const status = source?.readiness?.status;
  if (!source || status === 'ready' || status === 'disabled') return '';
  const message = String(source.readiness?.message ?? '');
  const missing = /^Missing (.+?) in Dig’s keys\.env\./.exec(message);
  return missing ? `Missing ${missing[1]} in keys.env. Open Setup details to add ${missing[1].includes(';') ? 'them' : 'it'}.` : message;
}
/** `x-judge` → "X judge"; a method named after its source takes the source's label. */
const methodLabel = (source, name) => (name === source.id ? source.label : name.startsWith(`${source.id}-`) ? `${source.label} ${name.slice(source.id.length + 1).replaceAll('-', ' ')}` : name);
const details = items => items.filter(Boolean).map(detail => node('span', 'setup-detail', detail));
/** A presence chip, then the keys.env name with "optional" when no source needs it, and under the name what the
 * environment or the bridge adds. The chip and the name are the list's two columns. */
const keyRow = (name, state, optional, ...notes) => node('li', 'key-row',
  node('span', 'key-line', presenceChip(state, KEY_WORDS), node('span', 'key-label', keyName(name), optional ? node('span', 'key-optional', 'optional') : null)), details(notes));
/** A local tool, after whether it is installed. */
const toolRow = p => node('li', 'key-row tool-row', node('span', 'key-line', presenceChip(p.available ? 'set' : 'missing', TOOL_WORDS), node('span', 'key-label tool-name', p.name)), details([p.detail]));

/** Sources that need the same credential, so one key covers them all. */
function sharedKeyNote(module) {
  const names = (module.keys ?? []).flatMap(k => (typeof k === 'string' ? [k] : k));
  const notes = names.map(name => {
    const others = MODULES.filter(other => other.id !== module.id && (other.keys ?? []).flat().includes(name)).map(other => other.label);
    return others.length ? `${name} also covers ${list.format(others)}.` : null;
  }).filter(Boolean);
  return notes.length ? node('p', 'meta shared-key', notes.join(' ')) : null;
}

/**
 * The parts of Setup details that come from source_info, so none without it: its keys and settings with the keys.env
 * buttons, and what this computer needs. They sit above the worker suggestions.
 */
function setupSections(module, source, actions) {
  const id = module.id;
  const credentials = Array.isArray(source?.credentials) ? source.credentials : [];
  const settings = Array.isArray(source?.envSettings) ? source.envSettings : [];
  const prerequisites = Array.isArray(source?.prerequisites) ? source.prerequisites : [];
  const guidance = typeof source?.credentialGuidance === 'string' && source.credentialGuidance ? source.credentialGuidance : null;
  // Dig uses only keys.env; a key Codex's environment holds is copied in only on request, per source.
  const copyable = credentials.filter(c => c.environment === 'unused' || c.environment === 'different');
  const update = copyable.some(c => c.environment === 'different');
  const plural = copyable.length > 1 ? 's' : '';
  let reuse = null; let keys = null;
  if (copyable.length) {
    reuse = keyed(button('', update ? `Update key${plural} from env` : `Use existing key${plural}`, () => actions?.useEnvironment(id)), `env:${id}`);
    reuse.disabled = !actions;
  }
  if (credentials.length || settings.length) {
    keys = keyed(button('', 'Edit keys.env', () => actions?.editKeys(id)), `keys:${id}`);
    keys.disabled = !actions;
  }
  const rows = [
    ...credentials.map(c => keyRow(c.name, c.available ? 'set' : c.required === false ? 'unset' : 'missing', c.required === false, ENVIRONMENT_NOTES[c.environment])),
    ...settings.map(s => keyRow(s.name, s.available || s.bridge ? 'set' : 'unset', true, s.bridge ? 'Set in the Papers bridge’s .env.' : null, `${s.label}. ${s.purpose}`)),
  ];
  return [
    keys ? section(titleWithNote('Keys', `About ${module.label}’s keys`, KEYS_NOTE, `note-keys:${id}`, keys),
      guidance && !credentials.some(c => c.name === guidance) ? node('p', 'meta', guidance) : null,
      node('ul', 'setup-list', rows),
      sharedKeyNote(module),
      reuse ? node('div', 'actions', reuse) : null,
      // The copy changes keys.env, so what it does stays in sight beside its button.
      reuse ? node('p', 'meta', update ? `${reuse.textContent} replaces the keys.env value${plural} with the one${plural} in Codex’s environment.` : `${reuse.textContent} copies the key${plural} from Codex’s environment into keys.env.`) : null)
      : guidance ? section('Keys', node('p', 'meta', guidance)) : null,
    prerequisites.length ? section('On this computer', node('ul', 'setup-list', prerequisites.map(toolRow))) : null,
  ].filter(Boolean);
}

function providerLine(module) {
  const providers = module.providers ?? [];
  if (!providers.length) return null;
  const parts = providers.flatMap((p, i) => [i ? (i === providers.length - 1 ? (providers.length > 2 ? ', and ' : ' and ') : ', ') : null, p.url ? externalLink(p.url, p.name) : p.name]);
  return node('p', 'meta providers', 'Uses ', parts);
}

/**
 * Renders the table of contents into `toc` and the cards into `container`. `read` is settings.read, `sources` is
 * source_info's list and `save(key, value)` applies one setting (null in the read-only preview). `actions` serves
 * the keys.env buttons. Returns `update(read, sources)`, which refreshes switches, settings and readiness in place,
 * keeping focus and any field being typed in.
 */
export function renderSources(container, toc, read, sources, save, actions) {
  const properties = read.schema?.properties ?? {};
  const ids = MODULES.map(m => m.id);
  const ordered = settingsGroups(read).flatMap(group => group.keys);
  const infoOf = list => new Map((Array.isArray(list) ? list : []).map(source => [source.id, source]));
  let info = infoOf(sources);
  const controls = new Map(); const blocks = new Map();

  /**
   * The Research method(s) section: each of the source's methods with its suggested worker model and effort. Built
   * once per card and never moved (see fillReadiness).
   */
  function workerSection(module) {
    const methods = moduleAgents([module.id]);
    const rows = methods.map(method => {
      const fields = ['model', 'effort'].map(field => {
        const key = workerKey(method.name, field);
        if (!properties[key]) return null;
        const built = control(key, properties[key], read.values?.[key], save, { label: field === 'model' ? 'Model' : 'Effort', quiet: true });
        keyed(built.input, `setting:${key}`);
        controls.set(key, built); return built.element;
      }).filter(Boolean);
      return fields.length ? node('div', 'worker-row', node('p', 'worker-name', `${methodLabel(module, method.name)}${method.helper ? ' (helper)' : ''}`), node('div', 'worker-fields', fields)) : null;
    }).filter(Boolean);
    if (!rows.length) return null;
    const title = rows.length > 1 ? 'Research methods' : 'Research method';
    return section(titleWithNote(title, `About ${module.label}’s suggested workers`, WORKERS_NOTE, `note-workers:${module.id}`), ...rows);
  }
  function sourceBody(module, heading) {
    const field = enabledField(module.id);
    const toggle = properties[field] ? control(field, properties[field], read.values?.[field], save, { switchLabel: `Turn ${module.label} on or off` }) : null;
    if (toggle) controls.set(field, toggle);
    // Setup details and the worker suggestions in it are built once; a refresh rebuilds only the source_info sections
    // above them, so the fold stays open.
    const methods = workerSection(module); const sections = node('div', 'setup-sections');
    const setup = fold('setup', `setup:${module.id}`, node('span', 'fold-title', 'Setup details'), sections, methods);
    // A note inside a fold being closed would stay open out of sight.
    setup.element.ontoggle = () => { if (!setup.element.open && openNote && setup.element.contains(openNote.trigger)) closeNote(); };
    const status = node('p', 'meta status-line');
    blocks.set(module.id, { module, status, sections, methods, setup });
    const own = ordered.filter(key => key !== field && !WORKER_FIELD.test(key) && ownerOf(key, ids) === module.id && properties[key]).map(key => {
      const built = control(key, properties[key], read.values?.[key], save);
      controls.set(key, built); return built.element;
    });
    return [
      node('div', 'source-head', mark(module), node('div', 'source-name', heading, providerLine(module)), toggle?.element),
      node('p', 'about', module.about),
      node('p', 'meta billing', node('span', 'fact-label', 'Cost: '), module.billing),
      node('div', 'readiness', status, setup.element),
      own.length ? node('div', 'source-settings', node('p', 'eyebrow', `${module.label} settings`), own) : null,
    ];
  }
  /**
   * Refreshes a card's readiness line and the source_info sections of its Setup details, and the fold's gist of what
   * it holds. The fold and the worker fields stay where they are: a field taken off the page while being typed in
   * loses focus, and the browser commits its draft as a change, which would save it.
   */
  function fillReadiness(id) {
    const block = blocks.get(id); const source = info.get(id);
    if (!block) return;
    const message = readinessMessage(source);
    block.status.replaceChildren(stateChip(source?.readiness?.status ?? 'unknown'), ...(message ? [` ${message}`] : []));
    // A note open in a section about to be rebuilt goes with it.
    if (openNote && block.sections.contains(openNote.trigger)) closeNote();
    const sections = setupSections(block.module, source, actions);
    rebuild(block.sections, sections);
    block.sections.hidden = !sections.length;
    block.setup.element.hidden = !sections.length && !block.methods;
    // What the fold holds, so its summary says more than its name: a keyless source's "No API key required" is not keys.
    const methods = moduleAgents([id]).length;
    const holds = [
      source?.credentials?.length || source?.envSettings?.length ? 'keys' : null,
      source?.prerequisites?.length ? 'local tools' : null,
      block.methods ? (methods > 1 ? 'suggested workers' : 'suggested worker') : null,
    ].filter(Boolean);
    const gist = list.format(holds);
    block.setup.gist.textContent = gist ? gist[0].toUpperCase() + gist.slice(1) : '';
  }

  const cards = SOURCE_GROUPS.map(group => {
    const members = group.sources.map(id => MODULES.find(m => m.id === id)).filter(Boolean);
    // A group of one sits beside the next group of one instead of stranding a full row.
    return node('section', members.length === 1 ? 'source-group single' : 'source-group', attr(node('h3', 'group-title', group.label), 'id', `group-${group.id}`), node('div', 'source-grid', members.map(module => {
      const heading = attr(node('h4', '', module.label), 'tabindex', '-1');
      return attr(node('article', 'source', ...sourceBody(module, heading)), 'id', cardId(module.id));
    })));
  });
  container.replaceChildren(...cards);
  for (const id of ids) fillReadiness(id);

  function jump(id) {
    const card = document.getElementById(cardId(id));
    card?.scrollIntoView?.({ block: 'start' });
    card?.querySelector?.('h4')?.focus?.({ preventScroll: true });
  }
  // One row per group; a source shows its state only when it is not ready, so the exceptions stand out.
  function fillToc() {
    rebuild(toc, SOURCE_GROUPS.map(group => node('div', 'toc-row', node('p', 'toc-title', group.label), node('ul', 'toc-list', group.sources.map(id => {
      const module = MODULES.find(m => m.id === id); const status = info.get(id)?.readiness?.status ?? 'unknown';
      if (!module) return null;
      return node('li', '', keyed(button('btn-ghost toc-link', [mark(module, true), node('span', 'toc-name', module.label), status === 'ready' ? null : stateChip(status)], () => jump(id)), `toc:${id}`));
    })))));
  }
  fillToc();

  return {
    update(next, nextSources) {
      if (next?.values) for (const [key, built] of controls) if (Object.hasOwn(next.values, key)) built.set(next.values[key]);
      if (Array.isArray(nextSources)) { info = infoOf(nextSources); for (const id of ids) fillReadiness(id); fillToc(); }
    },
  };
}
