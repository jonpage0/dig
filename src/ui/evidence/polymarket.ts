import { compact, plural, shortDate } from "../format.ts";
import {
  attempted,
  failedCall,
  noItems,
  nonEmpty,
  numv,
  obj,
  objs,
  query,
  str,
  type EvidenceCall,
  type EvidenceItem,
  type EvidenceOutcome,
  type EvidenceResult,
} from "./read.ts";

const EVENT_URL = "https://polymarket.com/event/";

function decoded(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function readOutcomes(event: Record<string, unknown>): EvidenceOutcome[] {
  const markets = objs(event.markets).filter((m) => m.closed !== true && m.active !== false);
  const rows: EvidenceOutcome[] = markets.flatMap((m) => {
    const outcomes = decoded(m.outcomes);
    const prices = decoded(m.outcomePrices).map(Number);
    if (!outcomes.length || prices.length !== outcomes.length || prices.some((p) => !Number.isFinite(p))) {
      return [];
    }
    const yes = outcomes.findIndex((o) => o.toLowerCase() === "yes");
    if (yes >= 0 && outcomes.length === 2) {
      return [
        {
          label: str(m.groupItemTitle) ?? (markets.length > 1 ? str(m.question) : undefined) ?? "Yes",
          probability: prices[yes],
          dayMove: numv(m.oneDayPriceChange),
        },
      ];
    }
    return outcomes.map((label, i) => ({ label, probability: prices[i] }));
  });
  return rows.sort((a, b) => b.probability - a.probability);
}

function readMarketData(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  const a = call.args;
  const failed = failedCall(call);
  const pages = responseBodies
    .map(obj)
    .filter((b): b is Record<string, unknown> => Boolean(b && Array.isArray(b.data)));
  const rows = pages.flatMap((b) => objs(b.data));
  if (call.tool === "polymarket_history") {
    const more = pages.some((b) => obj(b.pagination)?.has_more === true);
    return {
      action: [
        attempted(call.status, "read", "read"),
        `Polymarket price history for outcome token ${str(a.token_id) ?? "?"}`,
      ],
      result: failed
        ? undefined
        : pages.length
          ? `${plural(rows.length, "price point")}${more ? ", more pages available" : ""}`
          : noItems(call),
      items: [],
    };
  }
  const selector = str(a.condition)
    ? `condition ${str(a.condition)}`
    : str(a.event_id)
      ? `event ${str(a.event_id)}`
      : str(a.question_id)
        ? `question ${str(a.question_id)}`
        : "the markets named";
  const statuses = [
    ...new Set(
      rows.flatMap((r) => {
        const s = str(r.status);
        return s ? [s] : [];
      }),
    ),
  ];
  return {
    action: [attempted(call.status, "read", "read"), `Polymarket resolution state for ${selector}`],
    result: failed
      ? undefined
      : pages.length
        ? `${plural(rows.length, "resolution record")}${statuses.length ? ` (${statuses.join(", ")})` : ""}`
        : noItems(call),
    items: [],
  };
}

export function readPolymarket(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  if (call.tool === "polymarket_history" || call.tool === "polymarket_resolution") {
    return readMarketData(call, responseBodies);
  }
  const events = new Map<string, EvidenceItem & { readonly volume: number }>();
  for (const body of responseBodies) {
    for (const e of objs(obj(body)?.events)) {
      const id = str(e.id) ?? str(e.slug) ?? str(e.title);
      if (!id || events.has(id)) continue;
      const slug = str(e.slug);
      const volume = numv(e.volume);
      const end = str(e.endDate);
      events.set(id, {
        kind: "event",
        key: id,
        title: str(e.title) ?? id,
        url: slug ? `${EVENT_URL}${encodeURIComponent(slug)}` : undefined,
        meta: nonEmpty([
          volume === undefined ? undefined : `$${compact(volume)} volume`,
          end ? `ends ${shortDate(end)}` : undefined,
        ]),
        outcomes: readOutcomes(e),
        volume: volume ?? 0,
      });
    }
  }
  const list = [...events.values()].sort((a, b) => b.volume - a.volume);
  const volume = list.reduce((n, e) => n + e.volume, 0);
  return {
    action: ["searched Polymarket for", ...query(str(call.args.query))],
    result: failedCall(call)
      ? undefined
      : list.length
        ? `${plural(list.length, "event")}${volume ? `, $${compact(volume)} traded` : ""}`
        : noItems(call),
    items: list.map(({ volume: _v, ...item }) => item),
  };
}
