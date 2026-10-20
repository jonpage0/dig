import React, { useEffect, useRef, useState } from 'react';
import { Input } from '@base-ui/react/input';
import { Select } from '@base-ui/react/select';
import { Switch } from '@base-ui/react/switch';
import { Collapsible } from '@base-ui/react/collapsible';
import { ACCOUNTS } from '../../providers/modules.ts';
import { Badge, Button } from '../shared/components';
import { Frame, FrameHeader, FramePanel } from '../shared/frame';

type SaveSetting = (key: string, value: unknown) => Promise<Record<string, unknown>>;
type SettingProps = {
  settingKey: string;
  schema: any;
  value: unknown;
  save?: SaveSetting | null;
  switchLabel?: string;
  label?: string;
  quiet?: boolean;
  note?: React.ReactNode;
};
const format = (value: unknown) => value == null ? '' : String(value);

function validate(schema: any, raw: string | boolean): { value?: unknown; error?: string } {
  if (schema.type === 'boolean') return { value: raw === true };
  if (schema.type === 'number' || schema.type === 'integer') {
    const value = String(raw).trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return { error: `Enter ${schema.type === 'integer' ? 'a whole number' : 'a number'}.` };
    if (schema.minimum !== undefined && value < schema.minimum) return { error: `Enter ${schema.minimum} or more.` };
    if (schema.maximum !== undefined && value > schema.maximum) return { error: `Enter ${schema.maximum} or less.` };
    return { value };
  }
  const value = String(raw).trim();
  if (schema.minLength !== undefined && value.length < schema.minLength) return { error: 'This cannot be empty.' };
  if (schema.maxLength !== undefined && value.length > schema.maxLength) return { error: `Use ${schema.maxLength} characters or fewer.` };
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return { error: 'Choose one of the available options.' };
  return { value };
}

/** Base UI controls over the existing TOML settings operation. Text commits on blur/Enter; a poll or
 * completed save never replaces a newer draft. Each accepted change is queued, including rapid toggles. */
export function SourceSetting({ settingKey, schema, value, save, switchLabel, label, quiet, note }: SettingProps) {
  const boolean = schema.type === 'boolean';
  const typing = !boolean && !Array.isArray(schema.enum);
  const display = (next: unknown) => boolean ? next === true : format(next);
  const [draft, setDraft] = useState<string | boolean>(() => display(value));
  const [status, setStatus] = useState('');
  const [invalid, setInvalid] = useState(false);
  const state = useRef({
    draft: display(value), saved: value, latest: value, edit: 0, attempt: 0, pending: 0,
    queue: Promise.resolve(), alive: true,
  });
  useEffect(() => {
    state.current.alive = true;
    return () => { state.current.alive = false; };
  }, []);
  useEffect(() => {
    const current = state.current;
    if (current.pending) return;
    const dirty = typing && current.draft !== display(current.saved);
    current.saved = value;
    current.latest = value;
    if (!dirty) { current.draft = display(value); setDraft(current.draft); }
  }, [value, typing, boolean]);

  const edit = (next: string | boolean) => {
    const current = state.current;
    current.draft = next;
    current.edit++;
    setDraft(next);
    setInvalid(false);
    if (!current.pending) setStatus('');
  };
  const commit = (raw: string | boolean) => {
    if (!save) return;
    const checked = validate(schema, raw);
    if (checked.error) { setInvalid(true); setStatus(checked.error); return; }
    const current = state.current;
    setInvalid(false);
    if (checked.value === current.latest) {
      if (!current.pending) setStatus('');
      return;
    }
    const attempt = ++current.attempt;
    const editedAt = current.edit;
    current.latest = checked.value;
    current.pending++;
    setStatus('Saving…');
    // A rejection is handled within the job, so the next submitted value still runs.
    current.queue = current.queue.then(async () => {
      try {
        const values = await save(settingKey, checked.value);
        current.saved = Object.hasOwn(values ?? {}, settingKey) ? values[settingKey] : checked.value;
        if (attempt === current.attempt) {
          current.latest = current.saved;
          if (current.edit === editedAt) {
            current.draft = display(current.saved);
            if (current.alive) setDraft(current.draft);
          }
          if (current.alive) setStatus('Saved');
        }
      } catch (error: any) {
        if (attempt === current.attempt) {
          current.latest = current.saved;
          if (current.edit === editedAt) {
            current.draft = display(current.saved);
            if (current.alive) setDraft(current.draft);
          }
          if (current.alive) setStatus(`Not saved: ${error?.message || 'The setting could not be saved.'}`);
        }
      } finally { current.pending--; }
    });
  };
  const id = `setting-${settingKey}`;
  const title = schema.title || settingKey;
  const description = schema.description && !switchLabel && !quiet ? schema.description : '';
  const describedBy = [description ? `${id}-help` : null, note ? `${id}-note` : null, status ? `${id}-status` : null].filter(Boolean).join(' ') || undefined;
  const common = {
    id, name: settingKey, 'data-key': `setting:${settingKey}`,
    'aria-label': switchLabel || title, 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined,
    disabled: !save,
  };
  const feedback = <span id={`${id}-status`} className="source-control-status" data-error={invalid || status.startsWith('Not saved:') || undefined} role="status" aria-live="polite">{status}</span>;
  let control: React.ReactNode;
  if (boolean) {
    control = <div className="source-control-toggle">
      <Switch.Root {...common} nativeButton render={<button type="button" />} checked={draft === true} onCheckedChange={next => { edit(next); commit(next); }} className="source-switch">
        <Switch.Thumb className="source-switch-thumb" />
      </Switch.Root>
      {switchLabel ? <span className="source-control-on" aria-hidden="true">{draft ? 'On' : 'Off'}</span> : <label htmlFor={id} className="source-control-label">{label || title}</label>}
      {feedback}
    </div>;
  } else if (Array.isArray(schema.enum)) {
    control = <Select.Root name={settingKey} value={String(draft)} disabled={!save} items={schema.enum.map((option: string) => ({ value: option, label: option }))} onValueChange={next => {
      if (next === null) return;
      edit(String(next)); commit(String(next));
    }}>
      <Select.Trigger {...common} className="source-select-trigger">
        <Select.Value /><Select.Icon className="source-select-arrow" aria-hidden="true">⌄</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={5} alignItemWithTrigger={false} className="source-select-positioner">
          <Select.Popup className="source-select-popup">
            <Select.List className="source-select-list">{schema.enum.map((option: string) => <Select.Item key={option} value={option} className="source-select-item">
              <Select.ItemText>{option}</Select.ItemText><Select.ItemIndicator aria-hidden="true">✓</Select.ItemIndicator>
            </Select.Item>)}</Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>;
  } else {
    const numeric = schema.type === 'number' || schema.type === 'integer';
    control = <Input {...common} value={String(draft)} type={numeric ? 'number' : 'text'} className="source-control-input"
      autoComplete="off" spellCheck={false} min={schema.minimum} max={schema.maximum}
      step={schema.multipleOf ?? (schema.type === 'integer' ? 1 : numeric ? 'any' : undefined)}
      minLength={schema.minLength} maxLength={schema.maxLength}
      onValueChange={next => edit(next)}
      onBlur={event => commit(event.currentTarget.value)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(event.currentTarget.value); } }}
    />;
  }
  return <div className={`source-control${boolean ? ' source-control-boolean' : ''}`}>
    {!boolean && <div className="source-control-heading"><label htmlFor={id} className="source-control-label">{label || title}</label>{feedback}</div>}
    {control}
    {description && <p id={`${id}-help`} className="source-control-help">{description}</p>}
    {note && <div id={`${id}-note`} className="source-control-note">{note}</div>}
  </div>;
}

const list = new Intl.ListFormat('en', { type: 'conjunction' });
const labels = (items: any[]) => [...new Set(items.map(item => item.source.label))] as string[];
const groupsOf = (account: any) => account.keys.map((key: any) => typeof key === 'string' ? [key] : key);
function KeyNames({ groups }: { groups: string[][] }) {
  return <>{groups.map((group, i) => <React.Fragment key={group.join('|')}>
    {i ? i === groups.length - 1 ? ' and ' : ', ' : null}
    {group.map((name, j) => <React.Fragment key={name}>{j ? ' or ' : null}<code>{name}</code></React.Fragment>)}
  </React.Fragment>)}</>;
}

/** Presence is derived from source_info names/booleans. Credential values are never rendered. */
export function AccountsPanel({ sources, keysPath, editKeys, preview }: {
  sources: any[]; keysPath?: string; editKeys?: () => unknown; preview: boolean;
}) {
  const [open, setOpen] = useState(false);
  const available = Array.isArray(sources) ? sources : [];
  const credentials = available.flatMap(source => (source.credentials ?? []).map((credential: any) => ({ ...credential, source })));
  const accounts = ACCOUNTS.map(account => {
    const groups = groupsOf(account);
    const uses = credentials.filter(credential => groups.flat().includes(credential.name));
    const held = groups.filter((group: string[]) => uses.some(credential => group.includes(credential.name) && credential.available)).length;
    return { account, groups, uses, state: held === groups.length ? 'set' : held ? 'partial' : 'unset' };
  });
  const tools = new Map<string, any>();
  for (const source of available) for (const prerequisite of source.prerequisites ?? []) {
    const tool = tools.get(prerequisite.name) ?? { ...prerequisite, sources: [] };
    tool.sources.push(source.label); tools.set(prerequisite.name, tool);
  }
  const set = accounts.filter(account => account.state === 'set').length;
  const missing = [...tools.values()].filter(tool => !tool.available).length;
  if (!keysPath && !available.length) return null;
  return <section id="keys-section" className="source-accounts" aria-labelledby="keys-title">
    <Frame spacing="sm">
    <FrameHeader className="source-accounts-header">
      <div><h3 id="keys-title">Accounts and keys</h3><p className="source-accounts-summary">{set} of {accounts.length} accounts set{missing ? ` · ${missing} local tool${missing === 1 ? '' : 's'} missing` : ''}</p></div>
      <Button id="edit-keys" variant="outline" size="sm" disabled={preview || !keysPath || !editKeys} onClick={() => { void editKeys?.(); }}>Edit keys.env</Button>
    </FrameHeader>
    <FramePanel>
    <p className="source-accounts-intro">One provider key can serve several sources. Keys stay in <code>keys.env</code>, outside the conversation.</p>
    <Collapsible.Root open={open} onOpenChange={setOpen} className="source-accounts-directory">
      <Collapsible.Trigger className="source-accounts-trigger" data-key="accounts"><span>Where to get each key</span><span aria-hidden="true" className="source-accounts-chevron">⌄</span></Collapsible.Trigger>
      <Collapsible.Panel keepMounted className="source-accounts-content">
        <p className="source-accounts-note">“Set” means the key is present. Opening this page does not test provider access.</p>
        <ul className="source-account-grid">{accounts.map(({ account, groups, uses, state }) => {
          const needed = labels(uses.filter(credential => credential.required));
          const optional = labels(uses.filter(credential => !credential.required)).filter(label => !needed.includes(label));
          return <li key={account.id} className="source-account" data-account={account.id}>
            <div className="source-account-heading">
              <a href={account.signup} data-external="" target="_blank" rel="noopener noreferrer" data-key={`account:${account.id}`} aria-label={`${account.name}: create or find your key`}>{account.name}</a>
              <Badge tone={state === 'set' ? 'success' : state === 'partial' ? 'partial' : 'muted'}>{state === 'set' ? 'set' : state === 'partial' ? 'partly set' : 'not set'}</Badge>
            </div>
            <p className="source-account-keys"><KeyNames groups={groups} />{account.optional?.length ? <>; optional: <KeyNames groups={account.optional.map(name => [name])} /></> : null}</p>
            {(needed.length > 0 || optional.length > 0) && <p className="source-account-uses">{needed.length ? `Needed by ${list.format(needed)}. ` : ''}{optional.length ? `Optional for ${list.format(optional)}.` : ''}</p>}
            <p className="source-account-billing">{account.billing}</p>
          </li>;
        })}</ul>
        {!!tools.size && <div className="source-local-tools"><h4>On this computer</h4><ul>{[...tools.values()].map(tool => <li key={tool.name}>
          <div className="source-account-heading"><strong>{tool.name}</strong><Badge tone={tool.available ? 'success' : 'muted'}>{tool.available ? 'installed' : 'not installed'}</Badge></div>
          <p>Used by {list.format([...new Set(tool.sources)] as string[])}.{tool.detail ? ` ${tool.detail}` : ''}</p>
        </li>)}</ul></div>}
        {keysPath && <details className="source-keys-location"><summary>Keys file location</summary><p id="keys-path">{keysPath}</p></details>}
      </Collapsible.Panel>
    </Collapsible.Root>
    </FramePanel>
    </Frame>
  </section>;
}
