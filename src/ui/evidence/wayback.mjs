// Wayback Machine: the captures the CDX server listed, or the one capture a read found, by its title, time and address.
import { bytes, plural } from '../format.mjs';
import { attempted, failedCall, htmlText, noItems, obj, scope, str } from './read.mjs';

const ARCHIVE = 'https://web.archive.org/web/';
const CAPTURE = /^https?:\/\/web\.archive\.org\/web\/(\d{14})\/(.+)$/;
const when = ts => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)} UTC`;
const isCapture = row => Array.isArray(row) && row.length === 5 && row.every(field => typeof field === 'string') && /^\d{14}$/.test(row[0]);

/** wayback_read: the availability lookup's capture, titled by the page the read kept. */
function readCapture(call, bodies) {
  const closest = obj(obj(bodies.map(obj).find(b => obj(b?.archived_snapshots))?.archived_snapshots)?.closest);
  const listed = CAPTURE.exec(str(closest?.url) ?? '');
  const page = bodies.filter(b => typeof b === 'string' && b.trim()).at(-1);
  const title = page ? htmlText(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(page)?.[1] ?? '') : '';
  const item = listed ? { kind: 'capture', key: listed[1], title: title || listed[2], url: `${ARCHIVE}${listed[1]}/${listed[2]}`, meta: [when(listed[1]), listed[2]] } : undefined;
  const date = str(call.args.date);
  return {
    action: [attempted(call.status, 'read', 'read'), 'the Wayback Machine’s capture of', str(call.args.url) ?? 'a page', ...(date ? [`as of ${date}`] : [])],
    result: failedCall(call) ? undefined : item ? `capture of ${when(listed[1])}` : noItems(call),
    items: item ? [item] : [],
  };
}

export function readWayback(call, bodies) {
  if (call.tool === 'wayback_read') return readCapture(call, bodies);
  const a = call.args; const lists = bodies.filter(Array.isArray);
  const rows = lists.flatMap(list => list.filter(isCapture));
  const more = lists.some(list => list.some(row => Array.isArray(row) && row.length === 0));
  const match = str(a.match); const range = [str(a.from) ? `from ${str(a.from)}` : undefined, str(a.to) ? `to ${str(a.to)}` : undefined].filter(Boolean).join(' ');
  const items = rows.map(([ts, original, type, status, length]) => ({
    kind: 'capture', key: `${ts} ${original}`, title: when(ts), url: `${ARCHIVE}${ts}/${original}`,
    meta: [`HTTP ${status}`, type, /^\d+$/.test(length) ? `${bytes(Number(length))} stored` : undefined, match && match !== 'exact' ? original : undefined].filter(Boolean),
  }));
  return {
    action: ['listed Wayback Machine captures of', str(a.url) ?? 'a page', ...scope([match && match !== 'exact' ? `${match} match` : undefined, range || undefined, a.changesOnly === false ? 'every capture' : undefined])],
    result: failedCall(call) ? undefined : items.length ? `${plural(items.length, 'capture')}${more ? ', more available' : ''}` : noItems(call),
    items,
  };
}
