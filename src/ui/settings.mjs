// Settings controls shared by Dig's Sources and Settings pages, built from settings.read: its JSON schema names
// and types every control, and its layout orders them as Codex's native plugin settings page does. A control
// saves when it changes (a switch at once, a text or number field when it is committed), through settings.update,
// which edits the one config.toml both pages and Codex's own settings page share.
import { attr, node, text } from './dom.mjs';

const ENABLED_SUFFIX = '_enabled';
const settingId = key => `setting-${key}`;
/** The settings field that turns a source on: `tikhub-reddit` → `tikhub_reddit_enabled`. */
export const enabledField = id => `${String(id).replaceAll('-', '_')}${ENABLED_SUFFIX}`;
/**
 * The source a settings key belongs to (`<source>_enabled` or `<source>_…`), or null for a Dig-wide setting. The
 * longest source id wins, so `tiktok_ads_enabled` belongs to TikTok ads rather than TikTok.
 */
export function ownerOf(key, sourceIds) {
  let owner = null;
  for (const id of sourceIds) {
    const prefix = `${String(id).replaceAll('-', '_')}_`;
    if (key.startsWith(prefix) && (!owner || prefix.length > owner.prefix.length)) owner = { id, prefix };
  }
  return owner?.id ?? null;
}

/** Groups in layout order; properties the layout omits appear last under "Other settings", as on the native page. */
export function settingsGroups(read) {
  const properties = read.schema?.properties ?? {};
  const placed = new Set(); const groups = [];
  for (const group of Array.isArray(read.layout) ? read.layout : []) {
    const keys = (group.items ?? []).filter(entry => entry.kind === 'property' && Object.hasOwn(properties, entry.property) && !placed.has(entry.property)).map(entry => entry.property);
    keys.forEach(key => placed.add(key));
    if (keys.length) groups.push({ title: group.title, keys });
  }
  const rest = Object.keys(properties).filter(key => !placed.has(key));
  if (rest.length) groups.push({ title: groups.length ? 'Other settings' : 'Settings', keys: rest });
  return groups;
}

function readValue(input, schema) {
  if (schema.type === 'boolean') return { value: input.checked };
  if (schema.type === 'number' || schema.type === 'integer') {
    const number = input.value.trim() === '' ? NaN : Number(input.value);
    if (!Number.isFinite(number) || (schema.type === 'integer' && !Number.isInteger(number))) return { error: `Enter ${schema.type === 'integer' ? 'a whole number' : 'a number'}.` };
    return { value: number };
  }
  const value = input.value.trim();
  if (schema.minLength !== undefined && value.length < schema.minLength) return { error: 'This cannot be empty.' };
  return { value };
}

/**
 * One control for a settings field. `save(key, value)` resolves to the saved values (settings.update's result) or
 * rejects; without `save` (the browser preview) the control is read-only. While saving, the control says so; a
 * failed save puts back the last saved value and names the error beside the control. `switchLabel` renders a
 * boolean as an on/off switch with that accessible name; `note` is an element with an id, kept under the field and
 * named in its description, that the caller fills from data the settings do not carry. `label` replaces the visible
 * label where the surroundings already name the subject (the schema title stays the accessible name), and `quiet`
 * leaves out the schema description where the caller explains the group once. Returns `set(value)` for a value
 * saved elsewhere.
 * Neither a settling save nor `set` repaints what the user changed after it began: a draft typed into a text or
 * number field stays until it is committed, and while a save is running its result, not `set`, decides the value.
 */
export function control(key, schema, value, save, { switchLabel, note, label, quiet } = {}) {
  const id = settingId(key); const title = schema.title || key;
  const description = schema.description && !switchLabel && !quiet ? attr(node('p', 'meta', schema.description), 'id', `${id}-help`) : null;
  const state = attr(attr(node('span', 'save-state'), 'role', 'status'), 'aria-live', 'polite');
  let input; let words = null;
  if (schema.type === 'boolean') {
    input = node('input', switchLabel ? 'switch' : 'form-check-input'); input.type = 'checkbox';
    if (switchLabel) { input.setAttribute('role', 'switch'); input.setAttribute('aria-label', switchLabel); words = attr(node('span', 'switch-text'), 'aria-hidden', 'true'); }
  } else if (schema.type === 'string' && Array.isArray(schema.enum)) {
    input = node('select', 'form-select', schema.enum.map(option => { const element = node('option', '', option); element.value = option; return element; }));
  } else if (schema.type === 'number' || schema.type === 'integer') {
    input = node('input', 'form-control'); input.type = 'number';
    if (schema.minimum !== undefined) input.min = String(schema.minimum);
    if (schema.maximum !== undefined) input.max = String(schema.maximum);
    input.step = schema.multipleOf !== undefined ? String(schema.multipleOf) : schema.type === 'integer' ? '1' : 'any';
  } else {
    input = node('input', 'form-control'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    if (schema.minLength !== undefined) input.minLength = schema.minLength;
    if (schema.maxLength !== undefined) input.maxLength = schema.maxLength;
  }
  input.id = id; input.name = key; input.disabled = !save;
  if (label) input.setAttribute('aria-label', title);
  const describedBy = [description ? `${id}-help` : null, note?.getAttribute('id') || null].filter(Boolean).join(' ');
  if (describedBy) input.setAttribute('aria-describedby', describedBy);
  let saved = value; let latest = value;
  const typing = schema.type !== 'boolean' && !Array.isArray(schema.enum);
  const format = next => (next === undefined || next === null ? '' : String(next));
  const current = () => (schema.type === 'boolean' ? input.checked : input.value);
  const show = next => {
    if (schema.type === 'boolean') input.checked = next === true;
    else input.value = format(next);
    if (words) text(words, next === true ? 'On' : 'Off');
  };
  show(value);
  // Saves run in order; only the newest change updates the control, and a quick second change is never dropped.
  let pending = 0; let inFlight = 0;
  input.onchange = async () => {
    const read = readValue(input, schema);
    if (read.error) { input.setAttribute('aria-invalid', 'true'); text(state, read.error); return; }
    input.removeAttribute('aria-invalid');
    if (read.value === latest) { if (latest === saved) text(state, ''); return; }
    latest = read.value;
    if (words) text(words, read.value ? 'On' : 'Off');
    const attempt = ++pending; const submitted = current(); inFlight++; text(state, 'Saving…');
    try {
      const values = await save(key, read.value);
      saved = Object.hasOwn(values ?? {}, key) ? values[key] : read.value;
      if (attempt === pending) { latest = saved; if (current() === submitted) show(saved); text(state, 'Saved'); }
    } catch (e) {
      if (attempt === pending) { latest = saved; if (current() === submitted) show(saved); text(state, `Not saved: ${e.message}`); }
    } finally { inFlight--; }
  };
  let element;
  if (switchLabel) element = node('label', 'switch-label', input, words, state);
  else if (schema.type === 'boolean') element = node('div', 'setting', node('label', 'form-check check', input, ` ${title}`, state), description);
  else element = node('div', 'setting', node('div', 'field-head', attr(node('label', 'form-label field-label', label ?? title), 'for', id), state), input, description, note);
  return {
    input, element,
    set(next) {
      if (inFlight) return;
      const draft = typing && input.value !== format(saved);
      saved = next; latest = next;
      if (!draft) show(next);
    },
  };
}

/**
 * Renders the Dig-wide settings (every field that does not belong to a source) into `container`, grouped as the
 * layout groups them; `notes` maps a key to the note element kept under its field. Returns `update(read)` for values
 * saved elsewhere.
 */
export function renderSettings(container, read, sourceIds, save, notes = {}) {
  const properties = read.schema?.properties ?? {};
  const controls = new Map();
  const groups = settingsGroups(read).map(group => ({ ...group, keys: group.keys.filter(key => !ownerOf(key, sourceIds)) })).filter(group => group.keys.length);
  container.replaceChildren(...(groups.length ? groups.map(group => node('fieldset', 'settings-group', node('legend', '', group.title), group.keys.map(key => {
    const built = control(key, properties[key], read.values?.[key], save, { note: notes[key] });
    controls.set(key, built); return built.element;
  }))) : [node('p', 'meta', 'Dig has no settings outside its sources yet.')]));
  return { update(next) { if (next?.values) for (const [key, built] of controls) if (Object.hasOwn(next.values, key)) built.set(next.values[key]); } };
}
