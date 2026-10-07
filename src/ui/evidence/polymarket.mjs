// Polymarket: the events a search found, each with its likeliest outcomes, volume and recent move.
// Adapted from Dig's dashboard/ui/evidence/polymarket.ts (MIT, same author).
import { compact, plural, shortDate } from '../format.mjs';
import { failedCall, noItems, numv, obj, objs, query, str } from './read.mjs';

const EVENT_URL = 'https://polymarket.com/event/';

/** `outcomes` and `outcomePrices` arrive as JSON-encoded string arrays. */
function decoded(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}

/** One row per outcome, likeliest first; a binary market reads as its Yes price. Inactive and closed markets are left out. */
function readOutcomes(event) {
  const markets = objs(event.markets).filter(m => m.closed !== true && m.active !== false);
  const rows = markets.flatMap(m => {
    const outcomes = decoded(m.outcomes); const prices = decoded(m.outcomePrices).map(Number);
    if (!outcomes.length || prices.length !== outcomes.length || prices.some(p => !Number.isFinite(p))) return [];
    const yes = outcomes.findIndex(o => o.toLowerCase() === 'yes');
    if (yes >= 0 && outcomes.length === 2) return [{ label: str(m.groupItemTitle) ?? (markets.length > 1 ? str(m.question) : undefined) ?? 'Yes', probability: prices[yes], dayMove: numv(m.oneDayPriceChange) }];
    return outcomes.map((label, i) => ({ label, probability: prices[i] }));
  });
  return rows.sort((a, b) => b.probability - a.probability);
}

export function readPolymarket(call, bodies) {
  const events = new Map();
  for (const body of bodies) for (const e of objs(obj(body)?.events)) {
    const id = str(e.id) ?? str(e.slug) ?? str(e.title);
    if (!id || events.has(id)) continue;
    const slug = str(e.slug); const volume = numv(e.volume); const end = str(e.endDate);
    events.set(id, { kind: 'event', key: id, title: str(e.title) ?? id, url: slug ? `${EVENT_URL}${encodeURIComponent(slug)}` : undefined, meta: [volume === undefined ? undefined : `$${compact(volume)} volume`, end ? `ends ${shortDate(end)}` : undefined].filter(Boolean), outcomes: readOutcomes(e), volume: volume ?? 0 });
  }
  const list = [...events.values()].sort((a, b) => b.volume - a.volume);
  const volume = list.reduce((n, e) => n + e.volume, 0);
  return {
    action: ['searched Polymarket for', ...query(str(call.args.query))],
    result: failedCall(call) ? undefined : list.length ? `${plural(list.length, 'event')}${volume ? `, $${compact(volume)} traded` : ''}` : noItems(call),
    items: list.map(({ volume: _volume, ...item }) => item),
  };
}
