import React, { useMemo, useState } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { Popover } from '@base-ui/react/popover';
import { Badge, Button } from '../shared/components';
import { Frame, FrameHeader, FrameTitle, FrameDescription, FramePanel, FrameFooter } from '../shared/frame';
import { IconTile } from '../shared/icon-tile';
import { SourceSetting, AccountsPanel } from './source-controls';
import { GLYPHS, glyphFor } from '../../glyphs.mjs';
import { MODULES, SOURCE_GROUPS, moduleAgents } from '../../providers/modules.ts';
import { SOURCE_GUIDES, activityNote, latestSourceCalls } from '../../ui/source-guide.mjs';
import { enabledField, ownerOf, settingsGroups } from '../../ui/settings.mjs';
import { clock, shortDate } from '../../ui/format.mjs';
import { READ_ONLY, SCHEMA_MISSING } from './controller';
import type { DigHost } from '../shared/host';

const STATE_WORDS: Record<string, string> = {
  ready: 'Configured', partial: 'Partly configured', 'setup-required': 'Needs setup', disabled: 'Off', unknown: 'Unknown',
};
const KEY_WORDS: Record<string, string> = { set: 'Set', missing: 'Missing', unset: 'Not set' };
const ENVIRONMENT_NOTES: Record<string, string> = {
  unused: 'Codex’s environment has a key that Dig isn’t using.',
  different: 'Codex’s environment has a different key.',
};
const GROUP_DESCRIPTIONS: Record<string, string> = {
  web: 'Discover and read the web.',
  code: 'Follow software, repositories and developer discussions.',
  papers: 'Find research and inspect the original work.',
  video: 'Read transcripts and understand what is shown.',
  social: 'Find firsthand accounts and inspect public conversations.',
  markets: 'Explore products, markets, advertising and search visibility.',
  tools: 'Optional analysis for evidence already in hand.',
};
const WORKERS_NOTE = 'The conversation chooses each worker’s model and effort and may choose others. A method without a suggestion of its own follows Source workers on the Settings page.';
const KEYS_NOTE = 'Edit keys.env opens the file in Codex and adds empty lines for missing names. Fill in values there and save. Dig checks whether a key is present; it does not test whether the provider accepts it.';
const WORKER_FIELD = /_worker_(model|effort)$/;
const workerKey = (method: string, field: string) => `${method.replaceAll('-', '_')}_worker_${field}`;
const list = new Intl.ListFormat('en', { type: 'conjunction' });
const sourceId = (id: string) => `source-${id}`;
const safeUrl = (value: unknown) => {
  try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};

/** Add-ons share their parent's group and remain independently configurable inside its card. */
export function groupSourceModules(modules: readonly any[]) {
  const top = modules.filter(module => !module.extends);
  const placed = new Set<string>();
  const grouped = SOURCE_GROUPS.map(group => ({
    ...group,
    members: group.sources.flatMap(id => {
      const module = top.find(entry => entry.id === id);
      if (!module) return [];
      placed.add(id);
      return [{ module, addOns: modules.filter(entry => entry.extends === id) }];
    }),
  })).filter(group => group.members.length);
  const others = top.filter(module => !placed.has(module.id));
  if (others.length) grouped.push({ id: 'other', label: 'Other sources and tools', sources: others.map(module => module.id), members: others.map(module => ({ module, addOns: modules.filter(entry => entry.extends === module.id) })) } as any);
  return grouped;
}

/** Only package-owned symbol references and package-owned Lucide paths enter SVG. No remote image requests. */
function SourceMark({ module }: { module: any }) {
  return <IconTile className="source-page-mark">
    {module.logo ? <svg aria-hidden="true" focusable="false" className="source-page-logo"><use href={`#logo-${module.logo}`} /></svg>
      : <svg aria-hidden="true" focusable="false" className="source-page-glyph" viewBox="0 0 24 24">
        {GLYPHS[glyphFor(module.id)].map(([name, attributes]: [string, Record<string, string>], index: number) => React.createElement(name, {
          key: index,
          ...Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key.replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase()), value])),
        }))}
      </svg>}
  </IconTile>;
}

function StateBadge({ state, words }: { state: string; words?: string }) {
  const tone = state === 'ready' || state === 'set' ? 'success' : state === 'partial' ? 'partial'
    : state === 'setup-required' || state === 'missing' ? 'warning' : 'muted';
  return <Badge tone={tone} className="source-page-state" data-state={state}>{words ?? STATE_WORDS[state] ?? state}</Badge>;
}

function HelpNote({ label, children }: { label: string; children: React.ReactNode }) {
  return <Popover.Root>
    <Popover.Trigger className="source-page-help" aria-label={label} openOnHover delay={150} closeDelay={150}>i</Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner sideOffset={7} align="start">
        <Popover.Popup className="source-page-note">
          <Popover.Title className="source-page-note-title">{label}</Popover.Title>
          <Popover.Description className="source-page-note-body">{children}</Popover.Description>
          <Popover.Close className="source-page-note-close">Close</Popover.Close>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

function ProviderLine({ module }: { module: any }) {
  if (!module.providers?.length) return null;
  return <p className="source-page-providers">Via {module.providers.map((provider: any, index: number) => {
    const url = safeUrl(provider.url);
    return <React.Fragment key={`${provider.name}:${index}`}>{index > 0 && <span aria-hidden="true"> · </span>}
      {url ? <a href={url} data-external="" target="_blank" rel="noopener noreferrer">{provider.name}</a> : provider.name}
    </React.Fragment>;
  })}</p>;
}

function readinessMessage(source: any) {
  if (!source || ['ready', 'disabled'].includes(source.readiness?.status)) return '';
  const message = String(source.readiness?.message ?? '');
  const missing = /^Missing (.+?) in Dig’s keys\.env\./.exec(message);
  return missing ? `Missing ${missing[1]} in keys.env. Open Setup to add ${missing[1].includes(';') ? 'them' : 'it'}.` : message;
}

function KeyName({ name }: { name: string }) {
  return <code>{name.split('_').map((part, index) => <React.Fragment key={index}>{index > 0 && <>_<wbr /></>}{part}</React.Fragment>)}</code>;
}

function PresenceRow({ name, state, optional = false, words, children }: {
  name: string; state: string; optional?: boolean; words?: string; children?: React.ReactNode;
}) {
  return <li className="source-page-presence-row">
    <div className="source-page-presence-label"><KeyName name={name} />{optional && <span className="source-page-optional">Optional</span>}</div>
    <StateBadge state={state} words={words ?? KEY_WORDS[state]} />
    {children && <div className="source-page-presence-note">{children}</div>}
  </li>;
}

function sharedKeys(module: any, modules: readonly any[]) {
  const names = (module.keys ?? []).flat();
  return names.flatMap((name: string) => {
    const others = modules.filter(other => other.id !== module.id && (other.keys ?? []).flat().includes(name)).map(other => other.label);
    return others.length ? [`${name} also covers ${list.format(others)}.`] : [];
  }).join(' ');
}

function ActionButton({ children, action, disabled, ...props }: any) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true); setError('');
    try { await action(); } catch (error: any) { setError(error.message || 'This action could not be completed.'); }
    finally { setBusy(false); }
  };
  return <span className="source-page-action">
    <Button variant="outline" size="sm" disabled={disabled || busy} onClick={() => { void run(); }} {...props}>{busy ? 'Working…' : children}</Button>
    {error && <span className="source-page-action-error" role="status">{error}</span>}
  </span>;
}

function Credentials({ module, source, modules, app, preview }: any) {
  const credentials = source?.credentials ?? [];
  const envSettings = source?.envSettings ?? [];
  const guidance = source?.credentialGuidance;
  const copyable = credentials.filter((credential: any) => ['unused', 'different'].includes(credential.environment));
  const replacing = copyable.some((credential: any) => credential.environment === 'different');
  const plural = copyable.length > 1 ? 's' : '';
  const share = sharedKeys(module, modules);
  if (!credentials.length && !envSettings.length && !guidance) return null;
  return <section className="source-page-setup-section" aria-label={`${module.label} keys`}>
    <div className="source-page-section-heading"><h5>Keys</h5><HelpNote label={`About ${module.label}’s keys`}>{KEYS_NOTE}</HelpNote></div>
    {guidance && !credentials.some((credential: any) => credential.name === guidance) && <p className="source-page-note-text">{guidance}</p>}
    {(credentials.length > 0 || envSettings.length > 0) && <>
      <ul className="source-page-presence-list">
        {credentials.map((credential: any) => <PresenceRow key={credential.name} name={credential.name}
          state={credential.available ? 'set' : credential.required === false ? 'unset' : 'missing'} optional={credential.required === false}>
          {ENVIRONMENT_NOTES[credential.environment]}
        </PresenceRow>)}
        {envSettings.map((setting: any) => <PresenceRow key={setting.name} name={setting.name} state={setting.available || setting.bridge ? 'set' : 'unset'} optional>
          {setting.bridge && 'Set in the Papers bridge’s .env. '}{setting.label}. {setting.purpose}
        </PresenceRow>)}
      </ul>
      {share && <p className="source-page-note-text">{share}</p>}
      <div className="source-page-key-actions">
        <ActionButton disabled={preview} action={() => app.editKeys(module.id)} data-key={`keys:${module.id}`}>Edit keys.env</ActionButton>
        {copyable.length > 0 && <ActionButton disabled={preview} action={() => app.useEnvironment(module.id)} data-key={`env:${module.id}`}>
          {replacing ? `Update key${plural} from env` : `Use existing key${plural}`}
        </ActionButton>}
      </div>
      {copyable.length > 0 && <p className="source-page-note-text">{replacing
        ? `Update key${plural} from env replaces the keys.env value${plural} with the one${plural} in Codex’s environment.`
        : `Use existing key${plural} copies the key${plural} from Codex’s environment into keys.env.`}</p>}
    </>}
  </section>;
}

function WorkerSettings({ module, properties, values, save }: any) {
  if (module.extends) return null;
  const methods = moduleAgents([module.id]).filter(method => ['model', 'effort'].some(field => properties[workerKey(method.name, field)]));
  if (!methods.length) return null;
  const methodLabel = (name: string) => name === module.id ? module.label : name.startsWith(`${module.id}-`) ? `${module.label} ${name.slice(module.id.length + 1).replaceAll('-', ' ')}` : name;
  return <section className="source-page-setup-section">
    <div className="source-page-section-heading"><h5>{methods.length > 1 ? 'Research methods' : 'Research method'}</h5>
      <HelpNote label={`About ${module.label}’s suggested workers`}>{WORKERS_NOTE}</HelpNote></div>
    <div className="source-page-workers">{methods.map(method => <div className="source-page-worker" key={method.name}>
      <p className="source-page-worker-name">{methodLabel(method.name)}{method.helper && <span className="source-page-optional">Helper</span>}</p>
      <div className="source-page-worker-fields">{['model', 'effort'].map(field => {
        const key = workerKey(method.name, field);
        return properties[key] ? <SourceSetting key={key} settingKey={key} schema={properties[key]} value={values[key]} save={save} label={field === 'model' ? 'Model' : 'Effort'} quiet /> : null;
      })}</div>
    </div>)}</div>
  </section>;
}

function Example({ id, example }: { id: string; example: string }) {
  const [state, setState] = useState('');
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(example);
      setState('Copied. Paste it into the conversation and replace the bracketed text.');
    } catch { setState('Select the example text and copy it, then paste it into the conversation.'); }
  };
  return <details className="source-page-tertiary" data-key={`example:${id}`}>
    <summary>Example for the conversation</summary>
    <div className="source-page-example">
      <p>{example}</p>
      <Button variant="ghost" size="sm" onClick={() => { void copy(); }}>Copy example</Button>
      {state && <p className="source-page-copy-status" role="status">{state}</p>}
    </div>
  </details>;
}

function activityBrief(call: any) {
  if (!call) return 'No retained calls';
  const outcome: Record<string, string> = { success: 'Completed', partial: 'Partial results', empty: 'No results', failed: 'Failed', cancelled: 'Stopped', skipped: 'Skipped' };
  return `${outcome[call.status] ?? 'Unknown outcome'} · ${shortDate(call.at)} · ${clock(call.at)}`;
}

function SourceCard({ module, addOns = [], modules, app, host, info, activity, read, addOn = false }: any) {
  const [setupOpen, setSetupOpen] = useState(false);
  const properties = read?.schema?.properties ?? {}; const values = read?.values ?? {};
  const ownField = enabledField(module.id);
  const save = host.preview ? undefined : app.saveSetting;
  const guide = (SOURCE_GUIDES as Record<string, any>)[module.id];
  const own = settingsGroups(read ?? {}).flatMap((group: any) => group.keys)
    .filter((key: string) => key !== ownField && !WORKER_FIELD.test(key) && ownerOf(key, modules.map((entry: any) => entry.id)) === module.id && properties[key]);
  const methods = module.extends ? [] : moduleAgents([module.id]).filter(method => ['model', 'effort'].some(field => properties[workerKey(method.name, field)]));
  const source = info.get(module.id);
  const state = source?.readiness?.status ?? 'unknown';
  const prerequisites = source?.prerequisites ?? [];
  const hasKeys = source?.credentials?.length || source?.envSettings?.length || source?.credentialGuidance;
  const setupParts = [hasKeys ? 'keys' : null, prerequisites.length ? 'local tools' : null, own.length ? 'settings' : null, methods.length ? 'workers' : null].filter(Boolean);
  const recent = activity.get(module.id);
  const message = readinessMessage(source);
  const headingId = `source-heading-${module.id}`;
  const body = <>
    <FrameHeader className="source-page-card-header">
      <div className="source-page-identity">
        <SourceMark module={module} />
        <div className="source-page-name">
          <FrameTitle><h4 id={headingId} tabIndex={-1}>{module.label}</h4></FrameTitle>
          <FrameDescription>{module.description}</FrameDescription>
        </div>
      </div>
      {properties[ownField] && <SourceSetting settingKey={ownField} schema={properties[ownField]} value={values[ownField]} save={save} switchLabel={`Turn ${module.label} on or off`} />}
    </FrameHeader>
    <FramePanel className="source-page-card-content">
      <div className="source-page-state-row"><StateBadge state={state} />{module.kind === 'tool' && <span className="source-page-kind">Shared tool</span>}{addOn && <span className="source-page-kind">Optional add-on</span>}</div>
      <ProviderLine module={module} />
      <ul className="source-page-capabilities">{(guide?.tasks ?? [module.about]).map((task: string) => <li key={task}>{task}</li>)}</ul>
      <div className="source-page-billing"><span className="source-page-billing-label">Cost</span><p>{module.billing}</p></div>
      {message && <p className="source-page-readiness-note">{message}</p>}
      {setupParts.length > 0 && <Collapsible.Root open={setupOpen} onOpenChange={setSetupOpen} className="source-page-setup">
        <Collapsible.Trigger className="source-page-setup-trigger" data-key={`setup:${module.id}`}>
          <span>Setup <span className="source-page-setup-gist">{list.format(setupParts as string[])}</span></span>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
        </Collapsible.Trigger>
        <Collapsible.Panel keepMounted className="source-page-setup-panel">
          <Credentials module={module} source={source} modules={modules} app={app} preview={host.preview} />
          {prerequisites.length > 0 && <section className="source-page-setup-section"><div className="source-page-section-heading"><h5>On this computer</h5></div>
            <ul className="source-page-presence-list">{prerequisites.map((prerequisite: any) => <PresenceRow key={prerequisite.name} name={prerequisite.name} state={prerequisite.available ? 'set' : 'missing'} words={prerequisite.available ? 'Installed' : 'Not installed'}>{prerequisite.detail}</PresenceRow>)}</ul>
          </section>}
          {own.length > 0 && <section className="source-page-setup-section"><div className="source-page-section-heading"><h5>{module.label} settings</h5></div>
            <div className="source-page-own-settings">{own.map((key: string) => <SourceSetting key={key} settingKey={key} schema={properties[key]} value={values[key]} save={save} />)}</div>
          </section>}
          <WorkerSettings module={module} properties={properties} values={values} save={save} />
          <p className="source-page-activity-detail">{activityNote(recent)}</p>
        </Collapsible.Panel>
      </Collapsible.Root>}
      <p className="source-page-activity" title={activityNote(recent)}><span>Last retained call</span>{activityBrief(recent)}</p>
    </FramePanel>
    {addOns.length > 0 && <div className="source-page-addons">{addOns.map((entry: any) => <SourceCard key={entry.id} module={entry} modules={modules} app={app} host={host} info={info} activity={activity} read={read} addOn />)}</div>}
    <FrameFooter className="source-page-card-footer">
      <details className="source-page-tertiary"><summary>{module.kind === 'tool' ? 'About this tool' : 'About this source'}</summary><p>{module.about}</p></details>
      {guide?.example && <Example id={module.id} example={guide.example} />}
    </FrameFooter>
  </>;
  return <article className={`source-page-card${addOn ? ' source-page-addon' : ''}`} id={sourceId(module.id)} aria-labelledby={headingId}>
    <Frame className="source-page-frame">{body}</Frame>
  </article>;
}

export function SourcesPage({ app, host, hidden }: { app: any; host: DigHost; hidden: boolean }) {
  const sources = Array.isArray(app.sources?.sources) ? app.sources.sources : [];
  const info = useMemo(() => new Map(sources.map((source: any) => [source.id, source])), [sources]);
  const groups = useMemo(() => groupSourceModules(MODULES), []);
  const activity = useMemo(() => latestSourceCalls(app.snapshot), [app.snapshot]);
  const on = sources.filter((source: any) => source.enabled);
  const ready = on.filter((source: any) => source.readiness?.status === 'ready').length;
  const attention = on.filter((source: any) => ['partial', 'setup-required'].includes(source.readiness?.status)).length;
  const read = app.settings;
  const error = app.settingsError?.message || (read && (!read.schema?.properties || !read.values) ? SCHEMA_MISSING : '');
  const jump = (id: string) => {
    const section = document.getElementById(`source-group-${id}`);
    section?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    section?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
  };
  const navigateLink = (event: React.MouseEvent) => {
    const anchor = (event.target as Element)?.closest<HTMLAnchorElement>('a[data-external]');
    if (!anchor || host.preview || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation();
    const url = safeUrl(anchor.href);
    if (url) void host.openLink(url).catch((error: any) => app.notify?.(`Unable to open ${url}: ${error.message}`, true));
  };
  return <section id="sources" className="source-page" hidden={hidden} onClick={navigateLink}>
    <header className="source-page-header">
      <div><h2>Sources &amp; tools</h2><p>Choose where Dig looks and what it can use.</p></div>
      {sources.length > 0 && <dl className="source-page-overview" aria-label="Source configuration">
        <div><dt>Enabled</dt><dd>{on.length}<span> / {sources.length}</span></dd></div>
        <div><dt>Configured</dt><dd>{ready}</dd></div>
        <div><dt>Needs attention</dt><dd>{attention}</dd></div>
      </dl>}
    </header>
    <p className="source-page-scope" id="sources-summary">{sources.length > 0 && <>{on.length} of {sources.length} sources and tools on. </>}Configured means local prerequisites are present. Recent calls describe past activity, not a connection test.</p>
    <AccountsPanel sources={sources} keysPath={app.sources?.keysPath} editKeys={host.preview ? undefined : app.editKeys} preview={host.preview} />
    <p id="sources-status" className="source-page-status" role="status" aria-live="polite">{error || (app.sourcesError ? `Source readiness is unavailable: ${app.sourcesError.message}` : !read || !app.sources ? 'Reading sources and tools…' : host.preview ? READ_ONLY : '')}</p>
    <nav id="sources-toc" className="source-page-categories" aria-label="Source categories">
      {groups.map(group => <Button key={group.id} variant="ghost" size="sm" onClick={() => jump(group.id)} data-key={`category:${group.id}`}><span>{group.label}</span><span className="source-page-category-count">{group.members.length}</span></Button>)}
    </nav>
    <div id="sources-list" className="source-page-groups">
      {groups.map(group => <section key={group.id} id={`source-group-${group.id}`} className={`source-page-group${group.members.length === 1 ? ' source-page-group-single' : ''}`} aria-labelledby={`source-group-heading-${group.id}`}>
        <div className="source-page-group-header"><h3 id={`source-group-heading-${group.id}`} tabIndex={-1}>{group.label}</h3><p>{GROUP_DESCRIPTIONS[group.id] ?? 'Additional tools in this edition.'}</p></div>
        <div className="source-page-grid">{group.members.map(({ module, addOns }) => <SourceCard key={module.id} module={module} addOns={addOns} modules={MODULES} app={app} host={host} info={info} activity={activity} read={read} />)}</div>
      </section>)}
    </div>
  </section>;
}
