import React from 'react';
import { MODULES } from '../../providers/modules.ts';
import { basename } from '../../ui/format.mjs';
import { ownerOf, settingsGroups } from '../../ui/settings.mjs';
import { Badge } from '../shared/components';
import { Frame, FrameHeader, FrameTitle, FrameDescription, FramePanel } from '../shared/frame';
import { SourceSetting } from './source-controls';
import { READ_ONLY, SCHEMA_MISSING } from './controller';
import type { DigHost } from '../shared/host';

const LIBRARY_FOLDER_NOTES: Record<string, string> = {
  missing: 'This folder does not exist yet. Dig creates it when research is first saved here. If you meant a folder that already holds your research, check the path.',
  'not-folder': 'This path is not a folder, so research cannot be saved here. Choose a folder.',
};
const GROUP_COPY: Record<string, { eyebrow: string; description: string }> = {
  Library: { eyebrow: 'Research records', description: 'Choose where research lives and whether to retain original provider responses.' },
  'Source workers': { eyebrow: 'Agent guidance', description: 'Suggested defaults for the conversation. Each source can have its own suggestions.' },
};

/** Operating preferences use the same schema and TOML authority as the host's native settings. */
export function SettingsPage({ app, host, hidden }: { app: any; host: DigHost; hidden: boolean }) {
  const read = app.settings;
  const properties = read?.schema?.properties ?? {};
  const values = read?.values ?? {};
  const sourceIds = MODULES.map(module => module.id);
  const groups = read ? settingsGroups(read).map((group: any) => ({ ...group, keys: group.keys.filter((key: string) => !ownerOf(key, sourceIds)) })).filter((group: any) => group.keys.length) : [];
  const error = app.settingsError?.message || (read && (!read.schema?.properties || !read.values) ? SCHEMA_MISSING : '');
  const libraryNote = LIBRARY_FOLDER_NOTES[app.snapshot.libraryFolder];
  const library = values.library ?? app.snapshot.library;
  const retention = values.keep_raw === true ? 'Originals retained' : values.keep_raw === false ? 'Reports retained' : 'Reading settings…';
  return <section id="settings" className="preferences-page settings-page" hidden={hidden}>
    <header className="settings-page-heading"><div><p className="settings-eyebrow">Operating preferences</p><h2>Settings</h2><p>How Dig keeps evidence and guides source workers.</p></div><Badge tone="muted">{host.preview ? 'Read-only preview' : 'Saves automatically'}</Badge></header>
    <dl className="settings-state" aria-label="Current operating preferences">
      <div><dt>Research library</dt><dd title={library || undefined}>{library ? basename(library) || library : 'Reading library…'}</dd><span>{app.snapshot.libraryFolder === 'missing' ? 'Created when research is saved' : app.snapshot.libraryFolder === 'not-folder' ? 'Folder needs attention' : 'One place for saved research'}</span></div>
      <div><dt>Evidence retention</dt><dd>{retention}</dd><span>{values.keep_raw === false ? 'New original responses are not retained' : 'Read the sources behind each report'}</span></div>
      <div><dt>Suggested worker</dt><dd>{values.worker_model || 'Reading settings…'}</dd><span>{values.worker_effort ? `${values.worker_effort} effort · conversation may choose another` : 'Guidance for the conversation'}</span></div>
    </dl>
    <div id="settings-fields" className="settings-groups">{groups.map((group: any) => {
      const copy = GROUP_COPY[group.title] ?? { eyebrow: 'Shared preferences', description: 'Defaults shared across Dig.' };
      return <Frame className="settings-frame" spacing="sm" key={group.title}>
        <FrameHeader className="settings-group-heading"><p className="settings-eyebrow">{copy.eyebrow}</p><FrameTitle role="heading" aria-level={3}>{group.title}</FrameTitle><FrameDescription>{copy.description}</FrameDescription></FrameHeader>
        <FramePanel className="settings-fields">{group.keys.map((key: string) => <SourceSetting key={key} settingKey={key} schema={properties[key]} value={values[key]} save={host.preview ? undefined : app.saveSetting} layout="row" note={key === 'library' && libraryNote ? <p aria-live="polite">{libraryNote}</p> : undefined} />)}</FramePanel>
      </Frame>;
    })}</div>
    <div className="settings-authority"><div><span className="settings-eyebrow">One settings file</span><p>Dig and the host’s plugin settings edit this same file. Source-specific controls are in Sources &amp; tools.</p></div><details><summary>File location</summary><p id="config-path">{app.snapshot.configPath || 'config.toml'}</p></details></div>
    <p id="settings-status" className="settings-status" role="status" aria-live="polite">{error || (!read ? 'Reading settings…' : host.preview ? READ_ONLY : '')}</p>
  </section>;
}
