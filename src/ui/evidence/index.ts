import { readGoogleAds, readLinkedInAds } from "./ads.ts";
import { readDeepwiki, readGithub } from "./code.ts";
import { readHackerNews } from "./hackernews.ts";
import { readPapersCall } from "./papers.ts";
import { readPolymarket } from "./polymarket.ts";
import {
  obj,
  query,
  str,
  type EvidenceCall,
  type EvidenceContext,
  type EvidenceResult,
} from "./read.ts";
import { readSocial } from "./social.ts";
import { readWayback } from "./wayback.ts";
import { readWeb } from "./web.ts";
import { readX } from "./x.ts";
import { readYoutube } from "./youtube.ts";

export {
  bodies,
  ITEM_NOUNS,
  type ActionPart,
  type ConnectorState,
  type EvidenceCall,
  type EvidenceContext,
  type EvidenceItem,
  type EvidenceLink,
  type EvidenceOutcome,
  type EvidenceResult,
} from "./read.ts";

const ARG_SUMMARY_MAX = 3;

function readGeneric(call: EvidenceCall): EvidenceResult {
  const q = str(call.args.query) ?? str(call.args.question) ?? str(call.args.url);
  const rest = Object.entries(call.args)
    .filter(
      ([key, value]) =>
        value !== undefined && value !== null && value !== "" && str(value) !== q && key !== "query",
    )
    .slice(0, ARG_SUMMARY_MAX)
    .map(([key, value]) => `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return {
    action: [
      `called ${call.tool}`,
      ...(q ? ["for", ...query(q)] : []),
      ...(rest.length ? [`(${rest.join(", ")})`] : []),
    ],
    items: [],
  };
}

type EvidenceReader = (
  call: EvidenceCall,
  responseBodies: readonly unknown[],
  context: EvidenceContext,
) => EvidenceResult;

const READERS: Record<string, EvidenceReader> = {
  x: readX,
  hackernews: readHackerNews,
  papers: readPapersCall,
  youtube: readYoutube,
  github: readGithub,
  deepwiki: readDeepwiki,
  polymarket: readPolymarket,
  exa: readWeb,
  firecrawl: readWeb,
  reddit: readSocial,
  "tikhub-reddit": readSocial,
  tiktok: readSocial,
  instagram: readSocial,
  linkedin: readSocial,
  telegram: readSocial,
  "china-social": readSocial,
  bluesky: readSocial,
  wayback: readWayback,
  "google-ads": readGoogleAds,
  "linkedin-ads": readLinkedInAds,
};

export const hasSourceView = (source: string): boolean => Object.hasOwn(READERS, source);

export function evidence(
  receipt: {
    readonly tool?: unknown;
    readonly source?: unknown;
    readonly status?: unknown;
    readonly args?: unknown;
  },
  responseBodies: readonly unknown[],
  context: EvidenceContext,
): EvidenceResult {
  const call: EvidenceCall = {
    tool: String(receipt.tool ?? "unknown tool"),
    source: String(receipt.source ?? ""),
    status: String(receipt.status ?? ""),
    args: obj(receipt.args) ?? {},
  };
  const read = READERS[call.source] ?? readGeneric;
  const e = read(call, responseBodies, context);
  return responseBodies.length ? e : { ...e, result: undefined, items: [] };
}

export function sentenceText(e: EvidenceResult): string {
  const action = e.action.map((p) => (typeof p === "string" ? p : `“${p.query}”`)).join(" ");
  const line = `${action[0]?.toUpperCase() ?? ""}${action.slice(1)}`;
  return e.result ? `${line} → ${e.result}` : line;
}
