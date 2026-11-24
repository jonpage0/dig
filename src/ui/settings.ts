const ENABLED_SUFFIX = "_enabled";

export const enabledField = (id: string): string => `${String(id).replaceAll("-", "_")}${ENABLED_SUFFIX}`;

export function ownerOf(key: string, sourceIds: readonly string[]): string | null {
  let owner: { readonly id: string; readonly prefix: string } | null = null;
  for (const id of sourceIds) {
    const prefix = `${String(id).replaceAll("-", "_")}_`;
    if (key.startsWith(prefix) && (!owner || prefix.length > owner.prefix.length)) {
      owner = { id, prefix };
    }
  }
  return owner?.id ?? null;
}

export interface SettingsGroup {
  readonly title: string;
  readonly keys: readonly string[];
}

export interface SettingsSchemaPayload {
  readonly schema?: { readonly properties?: Record<string, unknown> };
  readonly layout?: readonly {
    readonly title: string;
    readonly items?: readonly { readonly kind?: string; readonly property?: string }[];
  }[];
}

export function settingsGroups(read: SettingsSchemaPayload): SettingsGroup[] {
  const properties = read.schema?.properties ?? {};
  const placed = new Set<string>();
  const groups: SettingsGroup[] = [];
  for (const group of Array.isArray(read.layout) ? read.layout : []) {
    const keys = (group.items ?? [])
      .filter(
        (entry: { readonly kind?: string; readonly property?: string }): entry is { readonly kind: "property"; readonly property: string } =>
          entry.kind === "property" &&
          typeof entry.property === "string" &&
          Object.hasOwn(properties, entry.property) &&
          !placed.has(entry.property),
      )
      .map((entry: { readonly kind: "property"; readonly property: string }) => entry.property);
    for (const key of keys) placed.add(key);
    if (keys.length) groups.push({ title: group.title, keys });
  }
  const rest = Object.keys(properties).filter((key) => !placed.has(key));
  if (rest.length) groups.push({ title: groups.length ? "Other settings" : "Settings", keys: rest });
  return groups;
}
