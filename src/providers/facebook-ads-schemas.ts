// Type-only: the host supplies the builder (`Type`), as in schemas.ts.
import type { Type, TSchema } from "@sinclair/typebox";
import { CACHE_MAX_AGE_VALUES } from "./tools/scrapecreators.js";

type Typebox = typeof Type;

/** Shared with tools/facebook_ads.ts, which validates against the same values. */
export const FACEBOOK_AD_KIND_VALUES = ["search", "company", "ad", "companies", "transcript"] as const;
export const FACEBOOK_AD_STATUS_VALUES = ["ALL", "ACTIVE", "INACTIVE"] as const;
export const FACEBOOK_AD_MEDIA_TYPE_VALUES = ["ALL", "IMAGE", "VIDEO", "MEME", "IMAGE_AND_MEME", "NONE"] as const;
export const FACEBOOK_AD_SORT_VALUES = ["total_impressions", "relevancy_monthly_grouped"] as const;
export const FACEBOOK_AD_SEARCH_TYPE_VALUES = ["keyword_unordered", "keyword_exact_phrase"] as const;
export const FACEBOOK_AD_TYPE_VALUES = ["all", "political_and_issue_ads"] as const;

function choice(T: Typebox, values: readonly string[], description: string) {
  return T.Union(
    values.map((value) => T.Literal(value)),
    { description },
  );
}

function text(T: Typebox, description: string) {
  return T.Optional(T.String({ description }));
}

export function createFacebookAdsSchemas(T: Typebox): Record<string, TSchema> {
  return {
    facebook_ad_library: T.Object(
      {
        kind: choice(
          T,
          FACEBOOK_AD_KIND_VALUES,
          "search: ads matching a keyword; company: one advertiser's ads by page_id or company_name; ad: one ad's details by ad_id or url; companies: advertiser pages (and their page_id) matching a name; transcript: one video ad's transcript by ad_id or url.",
        ),
        query: text(
          T,
          "kind='search': keyword to find in ads. kind='companies': advertiser or page name to look up.",
        ),
        page_id: text(
          T,
          "kind='company'. Numeric Ad Library page id, from kind='companies' or an ad's page id. Use this or company_name.",
        ),
        company_name: text(
          T,
          "kind='company'. Advertiser name, resolved by the provider. Use this or page_id; page_id is exact.",
        ),
        ad_id: text(
          T,
          "kind='ad' or 'transcript'. Numeric Ad Library id (ad_archive_id). Use this or url.",
        ),
        url: text(
          T,
          "kind='ad' or 'transcript'. Ad Library URL such as https://www.facebook.com/ads/library?id=702369045530963. Use this or ad_id.",
        ),
        country: text(
          T,
          "kind='search' or 'company'. One two-letter country code, or ALL (provider default: ALL).",
        ),
        status: T.Optional(
          choice(
            T,
            FACEBOOK_AD_STATUS_VALUES,
            "kind='search' or 'company'. Ad delivery status (provider default: ACTIVE, so inactive ads are left out unless ALL or INACTIVE).",
          ),
        ),
        media_type: T.Optional(
          choice(
            T,
            FACEBOOK_AD_MEDIA_TYPE_VALUES,
            "kind='search' or 'company'. Creative media (provider default: ALL). MEME means image with text.",
          ),
        ),
        language: text(
          T,
          "kind='search' or 'company'. Two-letter ad language code such as EN or ES.",
        ),
        sort_by: T.Optional(
          choice(
            T,
            FACEBOOK_AD_SORT_VALUES,
            "kind='search' or 'company'. total_impressions (provider default: impressions, high to low) or relevancy_monthly_grouped (most recent).",
          ),
        ),
        start_date: text(
          T,
          "kind='search' or 'company'. Impressions from this date, YYYY-MM-DD.",
        ),
        end_date: text(
          T,
          "kind='search' or 'company'. Impressions up to this date, YYYY-MM-DD.",
        ),
        search_type: T.Optional(
          choice(
            T,
            FACEBOOK_AD_SEARCH_TYPE_VALUES,
            "kind='search'. keyword_unordered (any order) or keyword_exact_phrase.",
          ),
        ),
        ad_type: T.Optional(
          choice(
            T,
            FACEBOOK_AD_TYPE_VALUES,
            "kind='search'. all, or only political and issue ads.",
          ),
        ),
        cursor: text(
          T,
          "kind='search' or 'company'. Cursor from the previous page, with the same other arguments; omit for the first page.",
        ),
        cache_max_age: T.Optional(
          choice(
            T,
            CACHE_MAX_AGE_VALUES,
            "kind='ad' or 'transcript'. Accept a cached response this old or newer; cache hits cost 0 credits.",
          ),
        ),
      },
      { additionalProperties: false },
    ),
  };
}
