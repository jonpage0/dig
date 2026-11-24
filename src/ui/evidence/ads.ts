import { compact, plural, shortDate } from "../format.ts";
import {
  attempted,
  excerpt,
  failedCall,
  noItems,
  nonEmpty,
  obj,
  objs,
  query,
  scope,
  str,
  strs,
  type EvidenceCall,
  type EvidenceContext,
  type EvidenceItem,
  type EvidenceLink,
  type EvidenceResult,
} from "./read.ts";

const TEXT_EXCERPT = 200;
const TRANSPARENCY = "https://adstransparency.google.com";

const ran = (start: string | undefined, end: string | undefined): string | undefined =>
  start || end ? `${start ? shortDate(start) : "?"} → ${end ? shortDate(end) : "?"}` : undefined;

const range = (v: unknown): string | undefined => {
  const r = obj(v);
  const low = str(r?.min ?? r?.lower);
  const high = str(r?.max ?? r?.upper);
  return low || high ? `${low ?? "?"}–${high ?? "?"}` : str(v);
};

const unique = (items: readonly (EvidenceItem | undefined)[]): EvidenceItem[] => [
  ...new Map(items.filter((x): x is EvidenceItem => Boolean(x)).map((item) => [item.key, item])).values(),
];

const resultLine = (call: EvidenceCall, items: readonly EvidenceItem[], kind: string): string | undefined =>
  failedCall(call) ? undefined : items.length ? plural(items.length, kind) : noItems(call);

function googleAdvertiser(a: Record<string, unknown>): EvidenceItem | undefined {
  const id = str(a.advertiser_id);
  if (!id) return undefined;
  const estimate = Number(a.number_of_ads_estimate);
  return {
    kind: "advertiser",
    key: id,
    title: str(a.name) ?? id,
    url: `${TRANSPARENCY}/advertiser/${encodeURIComponent(id)}`,
    meta: nonEmpty([
      id,
      str(a.region),
      Number.isFinite(estimate) ? `about ${compact(estimate)} ads` : undefined,
    ]),
  };
}

function googleListed(ad: Record<string, unknown>): EvidenceItem | undefined {
  const id = str(ad.creativeId);
  if (!id) return undefined;
  return {
    kind: "ad",
    key: id,
    title: `${str(ad.advertiserName) ?? "Advertiser not returned"} · ${id}`,
    url: str(ad.adUrl),
    meta: nonEmpty([str(ad.format), ran(str(ad.firstShown), str(ad.lastShown))]),
  };
}

function googleDetail(ad: Record<string, unknown>): EvidenceItem | undefined {
  const id = str(ad.creativeId);
  if (!id) return undefined;
  const variation = objs(ad.variations)[0];
  const text = str(variation?.headline) ?? str(variation?.description) ?? str(variation?.allText);
  const regions = nonEmpty(objs(ad.creativeRegions).map((r) => str(r.regionName) ?? str(r.regionCode)));
  const impressions = range(ad.overallImpressions);
  const dest = str(variation?.destinationUrl);
  const links: EvidenceLink[] = dest
    ? [{ label: "Destination", url: /^https?:\/\//.test(dest) ? dest : `https://${dest}` }]
    : [];
  const allText = str(variation?.allText);
  return {
    kind: "ad",
    key: id,
    title: text ? excerpt(text, TEXT_EXCERPT) : `Ad ${id}`,
    url: str(ad.url),
    meta: nonEmpty([
      str(ad.advertiserId),
      str(ad.format),
      ran(str(ad.firstShown), str(ad.lastShown)),
      regions.length ? regions.join(", ") : undefined,
      impressions ? `${impressions} impressions` : undefined,
    ]),
    excerpt: allText && allText !== text ? excerpt(allText, TEXT_EXCERPT * 2) : undefined,
    links,
  };
}

export function readGoogleAds(
  call: EvidenceCall,
  responseBodies: readonly unknown[],
  context: EvidenceContext,
): EvidenceResult {
  const a = call.args;
  const found = responseBodies.map(obj).filter((x): x is Record<string, unknown> => Boolean(x));
  const label = context.label(call.source);
  if (a.action === "advertisers") {
    const items = unique(found.flatMap((b) => objs(b.advertisers).map(googleAdvertiser)));
    return {
      action: [`searched ${label} for advertisers named`, ...query(str(a.query)), ...scope([str(a.country)])],
      result: resultLine(call, items, "advertiser"),
      items,
    };
  }
  if (a.action === "detail") {
    const items = unique(found.map(googleDetail));
    return {
      action: [attempted(call.status, "read", "read"), `the ${label} ad`, str(a.url) ?? ""],
      result: resultLine(call, items, "ad"),
      items,
    };
  }
  const items = unique(found.flatMap((b) => objs(b.ads).map(googleListed)));
  return {
    action: [
      `listed ${label} for`,
      str(a.domain) ?? str(a.advertiser_id) ?? "an advertiser",
      ...scope([
        str(a.country),
        str(a.start_date) || str(a.end_date)
          ? `${str(a.start_date) ?? "…"} to ${str(a.end_date) ?? "…"}`
          : undefined,
        str(a.format),
        str(a.cursor) ? "a later page" : undefined,
      ]),
    ],
    result: resultLine(call, items, "ad"),
    items,
  };
}

function linkedinAd(ad: Record<string, unknown>, full: boolean): EvidenceItem | undefined {
  const id = str(ad.id);
  if (!id) return undefined;
  const text = str(ad.headline) ?? str(ad.description);
  const destination = str(ad.destinationUrl) ?? str(ad.landingPage);
  const links: EvidenceLink[] | undefined = full
    ? [
        ...(destination ? [{ label: "Destination", url: destination }] : []),
        ...strs(ad.imageSources).map((url, i) => ({ label: `Image ${i + 1}`, url })),
        ...objs(ad.videoSources).flatMap((v, i) => {
          const src = str(v.src);
          return src ? [{ label: `Video ${i + 1}`, url: src }] : [];
        }),
      ]
    : undefined;
  return {
    kind: "ad",
    key: id,
    title: text ? excerpt(text, TEXT_EXCERPT) : `Ad ${id}`,
    url: str(ad.url) ?? `https://www.linkedin.com/ad-library/detail/${id}`,
    meta: nonEmpty([
      str(ad.advertiser),
      str(ad.adType),
      ran(str(ad.startDate), str(ad.endDate)) ?? str(ad.adDuration),
      full && str(ad.paidForBy) ? `paid for by ${str(ad.paidForBy)}` : undefined,
      full && str(ad.totalImpressions) ? `${str(ad.totalImpressions)} impressions` : undefined,
    ]),
    excerpt:
      full && str(ad.headline) && str(ad.description)
        ? excerpt(str(ad.description)!, TEXT_EXCERPT * 2)
        : undefined,
    links,
  };
}

export function readLinkedInAds(
  call: EvidenceCall,
  responseBodies: readonly unknown[],
  context: EvidenceContext,
): EvidenceResult {
  const a = call.args;
  const found = responseBodies.map(obj).filter((x): x is Record<string, unknown> => Boolean(x));
  const label = context.label(call.source);
  if (a.action === "detail") {
    const items = unique(found.map((b) => linkedinAd(b, true)));
    return {
      action: [
        attempted(call.status, "read", "read"),
        `the ${label} ad`,
        str(a.url) ?? str(a.ad_id) ?? "",
      ],
      result: resultLine(call, items, "ad"),
      items,
    };
  }
  const items = unique(found.flatMap((b) => objs(b.ads).map((ad) => linkedinAd(ad, false))));
  const subject = nonEmpty([
    str(a.company_name),
    str(a.company_id) ? `company ${str(a.company_id)}` : undefined,
  ]).join(", ");
  return {
    action: [
      `searched ${label} for`,
      ...(str(a.query) ? query(str(a.query)) : [subject || "ads"]),
      ...scope([
        str(a.query) ? subject : undefined,
        str(a.countries),
        str(a.start_date) ? `${str(a.start_date)} to ${str(a.end_date) ?? "…"}` : undefined,
        str(a.cursor) ? "a later page" : undefined,
      ]),
    ],
    result: resultLine(call, items, "ad"),
    items,
  };
}
