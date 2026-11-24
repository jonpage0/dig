import { costSummary, receiptCost, type CostAmount, type CostSummary, type ReceiptCost } from "../core/cost.ts";

const DAY_MS = 86_400_000;
const MAX_DAILY_COLUMNS = 62;

export const WINDOWS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 0, label: "All time" },
] as const;

export interface UsageCall extends ReceiptCost {
  readonly at?: string;
  readonly ms?: number;
  readonly tool?: string;
  readonly source?: string | null;
  readonly status?: string;
}

export interface UsageReport {
  readonly at?: string | null;
  readonly source?: string | null;
}

export interface UsageSnapshot {
  readonly items?: readonly {
    readonly calls?: readonly UsageCall[];
    readonly reportDetails?: readonly UsageReport[];
  }[];
  readonly live?: readonly UsageCall[];
}

export interface OutcomeCounts {
  results: number;
  empty: number;
  failed: number;
  total: number;
}

export interface UsageBucket extends OutcomeCounts {
  readonly start: number;
}

export interface SourceUsageRow extends OutcomeCounts {
  readonly id: string;
  readonly reports: number;
  readonly cost: CostSummary;
}

export interface UsageSummary {
  readonly days: number;
  readonly start: number;
  readonly end: number;
  readonly weekly: boolean;
  readonly buckets: readonly UsageBucket[];
  readonly recorded: number;
  readonly totals: OutcomeCounts & { readonly reports: number; readonly cost: CostSummary };
  readonly sources: readonly SourceUsageRow[];
}

export interface ToolHistoryRow {
  readonly tool: string;
  readonly source: string | null;
  readonly calls: number;
  readonly failed: number;
  readonly failureRate: number;
  readonly medianMs: number | null;
  readonly typicalCost: readonly CostAmount[] | null;
  readonly pricedCalls: number;
  readonly unknownCalls: number;
  readonly freeCalls: number;
  readonly lastAt: string;
}

const outcomeOf = (status: unknown): "results" | "empty" | "failed" =>
  status === "success" || status === "partial" ? "results" : status === "empty" ? "empty" : "failed";

const tally = (target: OutcomeCounts, call: UsageCall): void => {
  target[outcomeOf(call.status)] += 1;
  target.total += 1;
};

export function outcomeCounts(calls: readonly UsageCall[]): OutcomeCounts {
  const counts: OutcomeCounts = { results: 0, empty: 0, failed: 0, total: 0 };
  for (const call of calls) tally(counts, call);
  return counts;
}

const midnight = (time: number): number => {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

const shift = (time: number, days: number): number => {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
};

const monday = (time: number): number =>
  shift(midnight(time), -((new Date(time).getDay() + 6) % 7));

function sourceRows(calls: readonly UsageCall[], reports: readonly UsageReport[] = []): SourceUsageRow[] {
  const rows = new Map<
    string,
    { id: string; calls: UsageCall[]; results: number; empty: number; failed: number; total: number; reports: number }
  >();
  const row = (id: string | null | undefined) => {
    const key = typeof id === "string" && id ? id : "unknown";
    let existing = rows.get(key);
    if (!existing) {
      existing = { id: key, calls: [], results: 0, empty: 0, failed: 0, total: 0, reports: 0 };
      rows.set(key, existing);
    }
    return existing;
  };
  for (const call of calls) {
    const s = row(call.source);
    s.calls.push(call);
    tally(s, call);
  }
  for (const report of reports) row(report.source).reports += 1;
  return [...rows.values()]
    .map(({ calls: list, ...rest }) => ({ ...rest, cost: costSummary(list) }))
    .sort((a, b) => b.total - a.total || b.reports - a.reports || a.id.localeCompare(b.id));
}

export function usageOf(
  snapshot: UsageSnapshot | null | undefined,
  { days = 30, now = Date.now() }: { readonly days?: number; readonly now?: number } = {},
): UsageSummary {
  const timed = <T extends { readonly at?: string | null }>(list: readonly T[]): Array<T & { readonly time: number }> =>
    list
      .map((entry) => ({ ...entry, time: typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN }))
      .filter((entry) => Number.isFinite(entry.time));

  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const receipts = timed([
    ...items.flatMap((item) => (Array.isArray(item.calls) ? item.calls : [])),
    ...(Array.isArray(snapshot?.live) ? snapshot.live : []),
  ]);
  const reports = timed(
    items.flatMap((item) => (Array.isArray(item.reportDetails) ? item.reportDetails : [])),
  );

  const end = shift(midnight(now), 1);
  const first = [...receipts, ...reports].reduce(
    (earliest, entry) => Math.min(earliest, midnight(entry.time)),
    midnight(now),
  );
  const start = days > 0 ? shift(end, -days) : first;
  const within = (entry: { readonly time: number }): boolean => entry.time >= start && entry.time < end;

  const calls = receipts.filter(within);
  const saved = reports.filter(within);
  const weekly = Math.round((end - start) / DAY_MS) > MAX_DAILY_COLUMNS;
  const buckets: UsageBucket[] = [];
  for (let at = weekly ? monday(start) : start; at < end; at = shift(at, weekly ? 7 : 1)) {
    buckets.push({ start: at, results: 0, empty: 0, failed: 0, total: 0 });
  }
  for (const call of calls) {
    let bucket: UsageBucket | null = null;
    for (const candidate of buckets) if (candidate.start <= call.time) bucket = candidate;
    if (bucket) tally(bucket, call);
  }
  return {
    days,
    start,
    end,
    weekly,
    buckets,
    recorded: receipts.length + reports.length,
    totals: { ...outcomeCounts(calls), reports: saved.length, cost: costSummary(calls) },
    sources: sourceRows(calls, saved),
  };
}

const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function toolHistory(
  calls: readonly UsageCall[],
  { days = 90, now = Date.now() }: { readonly days?: number; readonly now?: number } = {},
): ToolHistoryRow[] {
  const start = now - days * DAY_MS;
  const tools = new Map<string, Array<{ readonly call: UsageCall; readonly time: number }>>();
  for (const call of Array.isArray(calls) ? calls : []) {
    const time = typeof call?.at === "string" ? Date.parse(call.at) : Number.NaN;
    if (
      !Number.isFinite(time) ||
      time < start ||
      time > now ||
      typeof call.tool !== "string" ||
      call.status === "cancelled" ||
      call.status === "skipped"
    ) {
      continue;
    }
    const list = tools.get(call.tool) ?? [];
    list.push({ call, time });
    tools.set(call.tool, list);
  }
  return [...tools]
    .map(([tool, list]) => {
      list.sort((a, b) => b.time - a.time);
      const priced: Array<readonly CostAmount[]> = [];
      for (const { call } of list) {
        try {
          const parsed = receiptCost(call).cost;
          if (parsed !== null) priced.push(parsed);
        } catch {
          // ignore malformed cost
        }
      }
      const units = [...new Set(priced.flat().map(({ unit }) => unit))].sort();
      const typical: CostAmount[] = units
        .map((unit) => ({
          amount: median(priced.map((cost) => cost.find((e) => e.unit === unit)?.amount ?? 0)) ?? 0,
          unit,
        }))
        .filter(({ amount }) => amount > 0);
      const failed = list.filter(({ call }) => call.status === "failed").length;
      const msValues = list
        .map(({ call }) => call.ms)
        .filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms));
      return {
        tool,
        source: list[0].call.source ?? null,
        calls: list.length,
        failed,
        failureRate: failed / list.length,
        medianMs: median(msValues),
        typicalCost: priced.length ? typical : null,
        pricedCalls: priced.length,
        unknownCalls: list.length - priced.length,
        freeCalls: priced.filter((cost) => !cost.length).length,
        lastAt: list[0].call.at ?? "",
      };
    })
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}
