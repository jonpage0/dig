// Type-only: the host supplies the builder (`Type`), as in schemas.ts.
import type { Type, TSchema } from "@sinclair/typebox";

type Typebox = typeof Type;

/** Shared with tools/google_ads.ts and tools/linkedin_ads.ts, which validate against the same values. */
export const GOOGLE_AD_ACTION_VALUES = ["advertisers", "ads", "detail"] as const;
export const GOOGLE_AD_FORMAT_VALUES = ["text", "image", "video"] as const;
export const LINKEDIN_AD_ACTION_VALUES = ["search", "detail"] as const;

function choice(T: Typebox, values: readonly string[], description: string) {
  return T.Union(
    values.map((value) => T.Literal(value)),
    { description },
  );
}

function text(T: Typebox, description: string) {
  return T.Optional(T.String({ description }));
}

function limit(T: Typebox, actions: string) {
  return T.Optional(
    T.Integer({
      minimum: 1,
      description: `${actions}. Show at most this many of the returned entries. The request is unchanged and the whole page is paid for; the cursor still continues after every returned entry.`,
    }),
  );
}

export function createAdLibrarySchemas(T: Typebox): Record<string, TSchema> {
  return {
    google_ad_library: T.Object(
      {
        action: choice(
          T,
          GOOGLE_AD_ACTION_VALUES,
          "advertisers: advertisers (and their advertiser_id) matching a name; ads: one advertiser's ads by domain or advertiser_id; detail: one ad's details by its Ads Transparency Center url.",
        ),
        query: text(T, "action='advertisers'. Advertiser name to look up."),
        domain: text(
          T,
          "action='ads'. The advertiser's website domain, such as lululemon.com. Use this or advertiser_id.",
        ),
        advertiser_id: text(
          T,
          "action='ads'. Google's advertiser id (AR followed by digits), from action='advertisers' or an ad's address. Use this or domain.",
        ),
        country: text(
          T,
          "action='advertisers' or 'ads'. One two-letter region code such as US, sent as Google's region. Provider default: US for advertisers, anywhere for ads.",
        ),
        start_date: text(T, "action='ads'. Ads shown from this date, YYYY-MM-DD."),
        end_date: text(T, "action='ads'. Ads shown up to this date, YYYY-MM-DD."),
        format: T.Optional(
          choice(T, GOOGLE_AD_FORMAT_VALUES, "action='ads'. Only ads of this format."),
        ),
        cursor: text(
          T,
          "action='ads'. Cursor from the previous page, with the same other arguments; omit for the first page.",
        ),
        url: text(
          T,
          "action='detail'. The ad's Ads Transparency Center address, such as https://adstransparency.google.com/advertiser/AR07541154843046445057/creative/CR17778900238552006657.",
        ),
        limit: limit(T, "action='advertisers' or 'ads'"),
      },
      { additionalProperties: false },
    ),
    linkedin_ad_library: T.Object(
      {
        action: choice(
          T,
          LINKEDIN_AD_ACTION_VALUES,
          "search: ads by company, keyword, company id, countries and dates; detail: one ad by its Ad Library url or ad_id.",
        ),
        company_name: text(T, "action='search'. Advertiser name, resolved by LinkedIn, such as Microsoft."),
        company_id: text(T, "action='search'. LinkedIn's numeric company id, the number in a linkedin.com/company/<id> address."),
        query: text(T, "action='search'. Keyword to find in ads."),
        countries: text(
          T,
          "action='search'. Comma-separated two-letter country codes, such as US,CA,MX.",
        ),
        start_date: text(
          T,
          "action='search'. Ads shown from this date, YYYY-MM-DD; needs end_date and is no earlier than one year ago.",
        ),
        end_date: text(
          T,
          "action='search'. Ads shown up to this date, YYYY-MM-DD; needs start_date and is at the latest yesterday.",
        ),
        cursor: text(
          T,
          "action='search'. Cursor from the previous page, with the same other arguments; omit for the first page.",
        ),
        url: text(
          T,
          "action='detail'. The ad's Ad Library address, such as https://www.linkedin.com/ad-library/detail/666281156. Use this or ad_id.",
        ),
        ad_id: text(T, "action='detail'. The ad's numeric Ad Library id. Use this or url."),
        limit: limit(T, "action='search'"),
      },
      { additionalProperties: false },
    ),
  };
}
