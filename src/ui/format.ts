import type { CostSummary } from "../core/cost.ts";
import { hostWords } from "./host.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const LOCALE = "en-US";

export const num = (n: number): string => n.toLocaleString(LOCALE);
export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${num(n)} ${n === 1 ? one : many}`;
export const compact = (n: number): string =>
  n.toLocaleString(LOCALE, { notation: "compact", maximumFractionDigits: 1 });

const valid = (iso: unknown): iso is string =>
  typeof iso === "string" && Number.isFinite(Date.parse(iso));

export function shortDate(iso: unknown): string {
  if (!valid(iso)) return String(iso ?? "");
  const date = new Date(iso);
  return date.toLocaleDateString(LOCALE, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

export function absTime(iso: unknown): string {
  if (!valid(iso)) return String(iso ?? "");
  return new Date(iso).toLocaleString(LOCALE, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function clock(iso: unknown): string {
  return valid(iso)
    ? new Date(iso).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" })
    : "";
}

export function duration(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms < SECOND) return `${Math.round(ms)} ms`;
  if (ms < MINUTE) return `${(ms / SECOND).toFixed(ms < 10 * SECOND ? 1 : 0)} s`;
  if (ms < HOUR) {
    const m = Math.floor(ms / MINUTE);
    const s = Math.round((ms % MINUTE) / SECOND);
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  const hours = Math.floor(ms / HOUR);
  const m = Math.round((ms % HOUR) / MINUTE);
  return m ? `${hours} h ${m} min` : `${hours} h`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
    const code =
      name[1] === "x" || name[1] === "X"
        ? Number.parseInt(name.slice(2), 16)
        : Number(name.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : entity;
  });
}

export function isoDuration(value: string): string | undefined {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return undefined;
  const [, d, hr, m, s] = match.map((x) => Number(x ?? 0));
  const hours = d * 24 + hr;
  return `${hours ? `${hours}:` : ""}${hours ? String(m).padStart(2, "0") : String(m)}:${String(s).padStart(2, "0")}`;
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const basename = (path: unknown): string =>
  String(path ?? "")
    .split("/")
    .filter(Boolean)
    .at(-1) ?? "";

const CALL_OUTCOMES: Record<string, string> = {
  success: "Succeeded",
  partial: "Partial",
  empty: "Empty",
  failed: "Failed",
  cancelled: "Stopped",
  skipped: "Skipped",
};

export const callOutcome = (status: unknown): string =>
  typeof status === "string" ? (CALL_OUTCOMES[status] ?? "Unknown outcome") : "Unknown outcome";

export const costScope = (host: unknown): string =>
  `Provider costs · retained calls only · excludes ${hostWords(host).app} model costs`;

export const COST_CAVEAT = "Provider-reported usage, not a reconciled invoice.";

const LEGACY_CREDITS = "credits";
const unitName = (unit: string, shown: number | null): string => {
  const name = unit === LEGACY_CREDITS ? "ScrapeCreators credits" : unit;
  return shown === 1 ? name.replace(/(credit|read)s$/, "$1") : name;
};

const USD_DIGITS = 4;
const LARGE_USD_DIGITS = 2;
const LARGE_USD = 10;
const UNIT_DIGITS = 2;

function money(amount: number, unit: string): string {
  const usd = unit === "USD";
  const digits = !usd ? UNIT_DIGITS : Math.abs(amount) >= LARGE_USD ? LARGE_USD_DIGITS : USD_DIGITS;
  const smallest = 10 ** -digits;
  const below = amount > 0 && amount < smallest;
  const shown = below ? smallest : Number(amount.toFixed(digits));
  const value = shown.toLocaleString(
    LOCALE,
    usd
      ? { minimumFractionDigits: digits, maximumFractionDigits: digits }
      : { maximumFractionDigits: digits },
  );
  const bound = below ? "<" : "";
  return usd ? `${bound}$${value}` : `${bound}${value} ${unitName(unit, below ? null : shown)}`;
}

const orderedCosts = (byUnit: Record<string, number>): Array<[string, number]> =>
  Object.entries(byUnit).sort(([left], [right]) => {
    if (left === "USD" || right === "USD") return left === right ? 0 : left === "USD" ? -1 : 1;
    return (
      unitName(left, null).localeCompare(unitName(right, null), LOCALE, { ignorePunctuation: true }) ||
      left.localeCompare(right, LOCALE)
    );
  });

export const costAmounts = ({ byUnit }: Pick<CostSummary, "byUnit">): string[] =>
  orderedCosts(byUnit).map(([unit, amount]) => money(amount, unit));

export function costText({ byUnit, unknownCalls }: Pick<CostSummary, "byUnit" | "unknownCalls">): string {
  const known = costAmounts({ byUnit }).join(" + ");
  if (unknownCalls === 0) return known ? `Provider-reported cost: ${known}` : "Recorded no provider charge";
  return known ? `Provider-reported subtotal: ${known}; total unknown` : "Provider cost unknown";
}

export function costTotal(summary: CostSummary, calls: number): string | null {
  if (calls === 0) return null;
  const { unknownCalls } = summary;
  if (unknownCalls === 0) return costText(summary);
  return `${costText(summary)} · ${
    unknownCalls === calls
      ? plural(calls, "tool call")
      : `${num(unknownCalls)} of ${plural(calls, "tool call")}`
  } incompletely priced`;
}

export function costShort(summary: CostSummary, calls: number): string {
  if (!calls) return "";
  const amounts = costAmounts(summary);
  if (amounts.length) return `${amounts.join(" + ")}${summary.unknownCalls ? " + unpriced" : ""}`;
  return summary.unknownCalls ? "cost unknown" : "no charge recorded";
}
