import { decodeEntities } from "../format.ts";

export interface EvidenceCall {
  readonly tool: string;
  readonly source: string;
  readonly status: string;
  readonly args: Record<string, unknown>;
}

export interface EvidenceContext {
  readonly label: (id: unknown) => string;
}

export type ActionPart = string | { readonly query: string };

export interface EvidenceOutcome {
  readonly label: string;
  readonly probability: number;
  readonly dayMove?: number;
}

export interface EvidenceLink {
  readonly label: string;
  readonly url: string;
}

export interface EvidenceItem {
  readonly kind: string;
  readonly key: string;
  readonly title: string;
  readonly url?: string;
  readonly meta: string[];
  readonly excerpt?: string;
  readonly outcomes?: readonly EvidenceOutcome[];
  readonly links?: readonly EvidenceLink[];
  readonly count?: number;
}

export interface ConnectorState {
  readonly name: string;
  readonly state: string;
  readonly results?: number;
  readonly note?: string;
}

export interface EvidenceResult {
  readonly action: readonly ActionPart[];
  readonly result?: string;
  readonly items: readonly EvidenceItem[];
  readonly connectors?: readonly ConnectorState[];
}

export const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const objs = (v: unknown): Record<string, unknown>[] =>
  arr(v).flatMap((x) => {
    const o = obj(x);
    return o ? [o] : [];
  });

export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim()
    ? v.trim()
    : typeof v === "number"
      ? String(v)
      : undefined;

export const numv = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

export const strs = (v: unknown): string[] =>
  arr(v).flatMap((x) => {
    const s = str(x);
    return s ? [s] : [];
  });

export function bodies(content: unknown): unknown[] {
  return objs(obj(content)?.responses).map((r) => r.body);
}

export const ITEM_NOUNS: Record<string, readonly [string, string]> = {
  post: ["post", "posts"],
  story: ["story", "stories"],
  comment: ["comment", "comments"],
  paper: ["paper", "papers"],
  video: ["video", "videos"],
  repo: ["repository", "repositories"],
  event: ["event", "events"],
  page: ["page", "pages"],
  answer: ["answer", "answers"],
  account: ["account", "accounts"],
  bucket: ["time bucket", "time buckets"],
  trend: ["trend", "trends"],
  space: ["Space", "Spaces"],
  community: ["Community", "Communities"],
  capture: ["capture", "captures"],
  image: ["picture", "pictures"],
  ad: ["ad", "ads"],
  advertiser: ["advertiser", "advertisers"],
};

export function htmlText(html: string): string {
  return decodeEntities(html.replace(/<(?:p|br)\s*\/?>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

export function excerpt(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max).replace(/\s+\S*$/, "")}…` : clean;
}

export function scope(parts: readonly (string | undefined)[]): string[] {
  const kept = parts.filter((p): p is string => typeof p === "string" && p.length > 0);
  return kept.length ? [`(${kept.join(", ")})`] : [];
}

export const query = (value: string | undefined): ActionPart[] =>
  value ? [{ query: value }] : [];

export const attempted = (status: string, done: string, verb: string): string =>
  status === "failed" || status === "cancelled" ? `tried to ${verb}` : done;

export const noItems = (call: EvidenceCall): string =>
  call.status === "empty"
    ? "nothing found"
    : "no preview items recognized; inspect the original response";

export const failedCall = (call: EvidenceCall): boolean =>
  call.status === "failed" || call.status === "cancelled";

export const nonEmpty = (items: readonly (string | undefined | null | false)[]): string[] =>
  items.filter((x): x is string => typeof x === "string" && x.length > 0);
