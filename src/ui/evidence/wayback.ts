import { bytes, plural } from "../format.ts";
import {
  attempted,
  failedCall,
  htmlText,
  noItems,
  nonEmpty,
  obj,
  scope,
  str,
  type EvidenceCall,
  type EvidenceItem,
  type EvidenceResult,
} from "./read.ts";

const ARCHIVE = "https://web.archive.org/web/";
const CAPTURE = /^https?:\/\/web\.archive\.org\/web\/(\d{14})\/(.+)$/;

const when = (ts: string): string =>
  `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)} UTC`;

const isCapture = (row: unknown): row is [string, string, string, string, string] =>
  Array.isArray(row) &&
  row.length === 5 &&
  row.every((field) => typeof field === "string") &&
  /^\d{14}$/.test(row[0]);

function readCapture(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  const closest = obj(
    obj(responseBodies.map(obj).find((b) => obj(b?.archived_snapshots))?.archived_snapshots)?.closest,
  );
  const listed = CAPTURE.exec(str(closest?.url) ?? "");
  const page = responseBodies.filter((b): b is string => typeof b === "string" && b.trim().length > 0).at(-1);
  const title = page ? htmlText(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(page)?.[1] ?? "") : "";
  const item: EvidenceItem | undefined = listed
    ? {
        kind: "capture",
        key: listed[1],
        title: title || listed[2],
        url: `${ARCHIVE}${listed[1]}/${listed[2]}`,
        meta: [when(listed[1]), listed[2]],
      }
    : undefined;
  const date = str(call.args.date);
  return {
    action: [
      attempted(call.status, "read", "read"),
      "the Wayback Machine’s capture of",
      str(call.args.url) ?? "a page",
      ...(date ? [`as of ${date}`] : []),
    ],
    result: failedCall(call) ? undefined : item && listed ? `capture of ${when(listed[1])}` : noItems(call),
    items: item ? [item] : [],
  };
}

export function readWayback(call: EvidenceCall, responseBodies: readonly unknown[]): EvidenceResult {
  if (call.tool === "wayback_read") return readCapture(call, responseBodies);
  const a = call.args;
  const lists = responseBodies.filter((b): b is unknown[] => Array.isArray(b));
  const rows = lists.flatMap((list) => list.filter(isCapture));
  const more = lists.some((list) => list.some((row) => Array.isArray(row) && row.length === 0));
  const match = str(a.match);
  const range = nonEmpty([
    str(a.from) ? `from ${str(a.from)}` : undefined,
    str(a.to) ? `to ${str(a.to)}` : undefined,
  ]).join(" ");
  const items: EvidenceItem[] = rows.map(([ts, original, type, status, length]) => ({
    kind: "capture",
    key: `${ts} ${original}`,
    title: when(ts),
    url: `${ARCHIVE}${ts}/${original}`,
    meta: nonEmpty([
      `HTTP ${status}`,
      type,
      /^\d+$/.test(length) ? `${bytes(Number(length))} stored` : undefined,
      match && match !== "exact" ? original : undefined,
    ]),
  }));
  return {
    action: [
      "listed Wayback Machine captures of",
      str(a.url) ?? "a page",
      ...scope([
        match && match !== "exact" ? `${match} match` : undefined,
        range || undefined,
        a.changesOnly === false ? "every capture" : undefined,
      ]),
    ],
    result: failedCall(call)
      ? undefined
      : items.length
        ? `${plural(items.length, "capture")}${more ? ", more available" : ""}`
        : noItems(call),
    items,
  };
}
