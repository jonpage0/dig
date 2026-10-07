// Display formatting for the Dig reader. Adapted from Dig's dashboard/ui/format.ts (MIT, same author);
// only the helpers the native reader uses are kept.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const LOCALE = 'en-US';

export const num = n => n.toLocaleString(LOCALE);
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
export const compact = n => n.toLocaleString(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
const valid = iso => typeof iso === 'string' && Number.isFinite(Date.parse(iso));

export function shortDate(iso) {
  if (!valid(iso)) return String(iso ?? '');
  const date = new Date(iso);
  return date.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
}
export function absTime(iso) {
  if (!valid(iso)) return String(iso ?? '');
  return new Date(iso).toLocaleString(LOCALE, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function clock(iso) {
  return valid(iso) ? new Date(iso).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' }) : '';
}
export function duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  if (ms < SECOND) return `${Math.round(ms)} ms`;
  if (ms < MINUTE) return `${(ms / SECOND).toFixed(ms < 10 * SECOND ? 1 : 0)} s`;
  if (ms < HOUR) { const m = Math.floor(ms / MINUTE); const s = Math.round((ms % MINUTE) / SECOND); return s ? `${m} min ${s} s` : `${m} min`; }
  const hours = Math.floor(ms / HOUR); const m = Math.round((ms % HOUR) / MINUTE);
  return m ? `${hours} h ${m} min` : `${hours} h`;
}
export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
/** Numeric and common named character references as text; unknown names stay literal. The result is only ever inserted as text. */
export function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? entity;
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}
/** ISO 8601 duration (YouTube's PT41M12S) → 41:12. */
export function isoDuration(value) {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return undefined;
  const [, d, hr, m, s] = match.map(x => Number(x ?? 0));
  const hours = d * 24 + hr;
  return `${hours ? `${hours}:` : ''}${hours ? String(m).padStart(2, '0') : String(m)}:${String(s).padStart(2, '0')}`;
}
export function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
export const basename = path => String(path ?? '').split('/').filter(Boolean).at(-1) ?? '';

// Provider costs come from retained call receipts alone; they are never Codex model usage or a reconciled bill.
export const COST_SCOPE = 'Provider costs · retained calls only · excludes Codex model costs';
export const COST_CAVEAT = 'Provider-reported usage, not a reconciled invoice.';
// Receipts before provider-named credit units recorded ScrapeCreators' credits as bare "credits".
const LEGACY_CREDITS = 'credits';
const unitName = (unit, shown) => {
  const name = unit === LEGACY_CREDITS ? 'ScrapeCreators credits' : unit;
  return shown === 1 ? name.replace(/credits$/, 'credit') : name;
};
const USD_DIGITS = 4; const LARGE_USD_DIGITS = 2; const LARGE_USD = 10; const UNIT_DIGITS = 2;
// Amount in its own unit: dollars keep four decimals under $10 so small charges stay visible, and a positive
// amount below the last shown digit reads as "<" that digit, never as zero. Display only; the amount is unchanged.
function money(amount, unit) {
  const usd = unit === 'USD';
  const digits = !usd ? UNIT_DIGITS : Math.abs(amount) >= LARGE_USD ? LARGE_USD_DIGITS : USD_DIGITS;
  const smallest = 10 ** -digits;
  const below = amount > 0 && amount < smallest;
  const shown = below ? smallest : Number(amount.toFixed(digits));
  const value = shown.toLocaleString(LOCALE, usd ? { minimumFractionDigits: digits, maximumFractionDigits: digits } : { maximumFractionDigits: digits });
  const bound = below ? '<' : '';
  return usd ? `${bound}$${value}` : `${bound}${value} ${unitName(unit, below ? null : shown)}`;
}
/** Each unit's known amount from a costSummary, formatted on its own; empty when nothing was reported. */
export const costAmounts = ({ byUnit }) => Object.entries(byUnit).map(([unit, amount]) => money(amount, unit));
/**
 * What a costSummary of retained receipts establishes, each unit kept separate: a complete provider-reported
 * total, a reported subtotal whose total is unknown, unknown, or the receipts' recorded no-charge (not an invoice).
 */
export function costText({ byUnit, unknownCalls }) {
  const known = Object.entries(byUnit).map(([unit, amount]) => money(amount, unit)).join(' + ');
  if (unknownCalls === 0) return known ? `Provider-reported cost: ${known}` : 'Recorded no provider charge';
  return known ? `Provider-reported subtotal: ${known}; total unknown` : 'Provider cost unknown';
}
/** costText over `calls` receipts, counting incompletely priced tool calls; null for no calls, so an empty set never reads as no charge. */
export function costTotal(summary, calls) {
  if (calls === 0) return null;
  const { unknownCalls } = summary;
  if (unknownCalls === 0) return costText(summary);
  return `${costText(summary)} · ${unknownCalls === calls ? plural(calls, 'tool call') : `${num(unknownCalls)} of ${plural(calls, 'tool call')}`} incompletely priced`;
}
/** A short cost for a few receipts: each unit's amount, with "+ unpriced" when some are incompletely priced, else "cost unknown" or "no charge recorded"; empty for no calls. */
export function costShort(summary, calls) {
  if (!calls) return '';
  const amounts = costAmounts(summary);
  if (amounts.length) return `${amounts.join(' + ')}${summary.unknownCalls ? ' + unpriced' : ''}`;
  return summary.unknownCalls ? 'cost unknown' : 'no charge recorded';
}
