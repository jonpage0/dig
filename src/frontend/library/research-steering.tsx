import React, { useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '../shared/components';
import type { DigHost } from '../shared/host';
import { STEERING_LABELS, steeringPrompt } from './research-state';
import type { SteeringIntent } from './research-state';

/** Steering proposes an instruction in the native conversation. It never runs research itself. */
export function ResearchSteering({ host, item, library, triggerLabel = 'Steer research', intent = 'continue' }: {
  host: DigHost; item: any; library: string; triggerLabel?: string; intent?: SteeringIntent;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<SteeringIntent>(intent);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const identity = library + ':' + item?.project + ':' + item?.id;
  const latestIdentity = useRef(identity); latestIdentity.current = identity;
  const context = useRef({ item, library });
  useEffect(() => { generation.current++; setOpen(false); setNotice(''); setBusy(false); return () => { generation.current++; }; }, [library, item?.project, item?.id]);
  const changeOpen = (value: boolean) => { generation.current++; if (value) context.current = { item: { ...item, reports: [...(item?.reports ?? [])] }, library }; setOpen(value); setNotice(''); setBusy(false); };
  const prompt = steeringPrompt(open ? context.current.item : item, open ? context.current.library : library, selected);
  const copy = async () => {
    const request = ++generation.current;
    const origin = identity;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prompt);
      if (request === generation.current && origin === latestIdentity.current) setNotice('Copied. Paste into the conversation, adjust the direction, and send when ready.');
    } catch { if (request === generation.current && origin === latestIdentity.current) setNotice('Open Instruction and saved references, then select and copy the text into the conversation.'); }
  };
  const draft = async () => {
    const request = ++generation.current;
    const origin = identity;
    setBusy(true); setNotice('');
    try { await host.draft(prompt); if (request === generation.current && origin === latestIdentity.current) setNotice('Placed in the conversation as an unsent draft. Review it there before sending.'); }
    catch (error: any) { if (request === generation.current && origin === latestIdentity.current) setNotice('The host could not place an unsent draft. Copy the instruction instead. ' + (error?.message || '')); }
    finally { if (request === generation.current && origin === latestIdentity.current) setBusy(false); }
  };
  return <>
    <Button variant="outline" size="sm" className="research-steer-button" onClick={() => { setSelected(intent); changeOpen(true); }}>{triggerLabel}</Button>
    <Dialog open={open} onOpenChange={changeOpen} title="Steer from the conversation" description="Choose a direction, then review the instruction in your conversation. Preparing an instruction does not start research.">
      <div className="research-steering-options" role="group" aria-label="Research direction">
        {(Object.keys(STEERING_LABELS) as SteeringIntent[]).map(value => <Button key={value} variant={selected === value ? 'default' : 'outline'} size="sm" disabled={busy} aria-pressed={selected === value} onClick={() => { generation.current++; setSelected(value); setNotice(''); }}>{STEERING_LABELS[value]}</Button>)}
      </div>
      <p className="research-steering-question">{open ? context.current.item?.title : item?.title}</p>
      <details className="research-steering-context"><summary>Instruction and saved references</summary><pre tabIndex={0}>{prompt}</pre></details>
      <div className="research-steering-actions">
        {host.canDraft() && !host.preview && <Button size="sm" disabled={busy} onClick={() => { void draft(); }}>{busy ? 'Placing draft…' : 'Draft in conversation'}</Button>}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void copy(); }}>Copy instruction</Button>
      </div>
      {(!host.canDraft() || host.preview) && <p className="research-steering-note">Composer drafts are unavailable here. Copy the instruction into your conversation.</p>}
      {notice && <p className="research-steering-note" role="status">{notice}</p>}
    </Dialog>
  </>;
}
