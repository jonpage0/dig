// Settings helpers shared by Dig's Sources and Settings pages, built from settings.read: its JSON schema names
// and types every control, and its layout orders them as Codex's native plugin settings page does.

const ENABLED_SUFFIX = '_enabled';
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
