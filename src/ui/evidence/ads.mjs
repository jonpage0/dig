// Google ads and LinkedIn ads: a list of ads as rows, one ad as its fields, and Google's advertiser lookup as rows.
// The fields are those google_ads.ts and linkedin_ads.ts read from the same responses.
import { compact, plural, shortDate } from '../format.mjs';
import { attempted, excerpt, failedCall, noItems, obj, objs, query, scope, str, strs } from './read.mjs';

const TEXT_EXCERPT = 200;
const TRANSPARENCY = 'https://adstransparency.google.com';
const ran = (start, end) => (start || end ? `${start ? shortDate(start) : '?'} → ${end ? shortDate(end) : '?'}` : undefined);
const range = v => { const r = obj(v); const low = str(r?.min ?? r?.lower); const high = str(r?.max ?? r?.upper); return low || high ? `${low ?? '?'}–${high ?? '?'}` : str(v); };
const unique = items => [...new Map(items.filter(Boolean).map(item => [item.key, item])).values()];
const result = (call, items, kind) => (failedCall(call) ? undefined : items.length ? plural(items.length, kind) : noItems(call));

// --- Google ---------------------------------------------------------------------------------------------

function googleAdvertiser(a) {
  const id = str(a.advertiser_id); if (!id) return undefined;
  const estimate = Number(a.number_of_ads_estimate);
  return { kind: 'advertiser', key: id, title: str(a.name) ?? id, url: `${TRANSPARENCY}/advertiser/${encodeURIComponent(id)}`, meta: [id, str(a.region), Number.isFinite(estimate) ? `about ${compact(estimate)} ads` : undefined].filter(Boolean) };
}
function googleListed(ad) {
  const id = str(ad.creativeId); if (!id) return undefined;
  return { kind: 'ad', key: id, title: `${str(ad.advertiserName) ?? 'Advertiser not returned'} · ${id}`, url: str(ad.adUrl), meta: [str(ad.format), ran(str(ad.firstShown), str(ad.lastShown))].filter(Boolean) };
}
function googleDetail(ad) {
  const id = str(ad.creativeId); if (!id) return undefined;
  const variation = objs(ad.variations)[0];
  const text = str(variation?.headline) ?? str(variation?.description) ?? str(variation?.allText);
  const regions = objs(ad.creativeRegions).map(r => str(r.regionName) ?? str(r.regionCode)).filter(Boolean);
  const impressions = range(ad.overallImpressions);
  return {
    kind: 'ad', key: id, title: text ? excerpt(text, TEXT_EXCERPT) : `Ad ${id}`, url: str(ad.url),
    meta: [str(ad.advertiserId), str(ad.format), ran(str(ad.firstShown), str(ad.lastShown)), regions.length ? regions.join(', ') : undefined, impressions ? `${impressions} impressions` : undefined].filter(Boolean),
    excerpt: str(variation?.allText) && str(variation?.allText) !== text ? excerpt(str(variation.allText), TEXT_EXCERPT * 2) : undefined,
    links: [str(variation?.destinationUrl) ? { label: 'Destination', url: /^https?:\/\//.test(variation.destinationUrl) ? variation.destinationUrl : `https://${variation.destinationUrl}` } : undefined].filter(Boolean),
  };
}

export function readGoogleAds(call, bodies, context) {
  const a = call.args; const found = bodies.map(obj).filter(Boolean); const label = context.label(call.source);
  if (a.action === 'advertisers') {
    const items = unique(found.flatMap(b => objs(b.advertisers).map(googleAdvertiser)));
    return { action: [`searched ${label} for advertisers named`, ...query(str(a.query)), ...scope([str(a.country)])], result: result(call, items, 'advertiser'), items };
  }
  if (a.action === 'detail') {
    const items = unique(found.map(googleDetail));
    return { action: [attempted(call.status, 'read', 'read'), `the ${label} ad`, str(a.url) ?? ''], result: result(call, items, 'ad'), items };
  }
  const items = unique(found.flatMap(b => objs(b.ads).map(googleListed)));
  return {
    action: [`listed ${label} for`, str(a.domain) ?? str(a.advertiser_id) ?? 'an advertiser', ...scope([str(a.country), str(a.start_date) || str(a.end_date) ? `${str(a.start_date) ?? '…'} to ${str(a.end_date) ?? '…'}` : undefined, str(a.format), str(a.cursor) ? 'a later page' : undefined])],
    result: result(call, items, 'ad'),
    items,
  };
}

// --- LinkedIn -------------------------------------------------------------------------------------------

function linkedinAd(ad, full) {
  const id = str(ad.id); if (!id) return undefined;
  const text = str(ad.headline) ?? str(ad.description);
  const destination = str(ad.destinationUrl) ?? str(ad.landingPage);
  return {
    kind: 'ad', key: id, title: text ? excerpt(text, TEXT_EXCERPT) : `Ad ${id}`, url: str(ad.url) ?? `https://www.linkedin.com/ad-library/detail/${id}`,
    meta: [str(ad.advertiser), str(ad.adType), ran(str(ad.startDate), str(ad.endDate)) ?? (str(ad.adDuration) || undefined), full && str(ad.paidForBy) ? `paid for by ${str(ad.paidForBy)}` : undefined, full && str(ad.totalImpressions) ? `${str(ad.totalImpressions)} impressions` : undefined].filter(Boolean),
    excerpt: full && str(ad.headline) && str(ad.description) ? excerpt(str(ad.description), TEXT_EXCERPT * 2) : undefined,
    links: full ? [destination ? { label: 'Destination', url: destination } : undefined, ...strs(ad.imageSources).map((url, i) => ({ label: `Image ${i + 1}`, url })), ...objs(ad.videoSources).flatMap((v, i) => (str(v.src) ? [{ label: `Video ${i + 1}`, url: str(v.src) }] : []))].filter(Boolean) : undefined,
  };
}

export function readLinkedInAds(call, bodies, context) {
  const a = call.args; const found = bodies.map(obj).filter(Boolean); const label = context.label(call.source);
  if (a.action === 'detail') {
    const items = unique(found.map(b => linkedinAd(b, true)));
    return { action: [attempted(call.status, 'read', 'read'), `the ${label} ad`, str(a.url) ?? str(a.ad_id) ?? ''], result: result(call, items, 'ad'), items };
  }
  const items = unique(found.flatMap(b => objs(b.ads).map(ad => linkedinAd(ad, false))));
  const subject = [str(a.company_name), str(a.company_id) ? `company ${str(a.company_id)}` : undefined].filter(Boolean).join(', ');
  return {
    action: [`searched ${label} for`, ...(str(a.query) ? query(str(a.query)) : [subject || 'ads']), ...scope([str(a.query) ? subject : undefined, str(a.countries), str(a.start_date) ? `${str(a.start_date)} to ${str(a.end_date) ?? '…'}` : undefined, str(a.cursor) ? 'a later page' : undefined])],
    result: result(call, items, 'ad'),
    items,
  };
}
