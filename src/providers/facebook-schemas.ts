// Type-only: the host supplies the builder (`Type`), so this module adds no
// runtime schema dependency of its own. The value lists are shared with
// tools/facebook.ts, which validates the same arguments before any request.
import type { Type, TSchema } from "@sinclair/typebox";

type Typebox = typeof Type;

export const FACEBOOK_KINDS = [
  "profile",
  "profile_posts",
  "profile_reels",
  "profile_photos",
  "search_videos",
  "post",
  "transcript",
  "comments",
  "replies",
  "group",
  "group_posts",
] as const;

export const FACEBOOK_EVENT_KINDS = ["profile", "search", "city", "details"] as const;

/** /v1/facebook/group/posts `sort_by`; the provider defaults to CHRONOLOGICAL. */
export const FACEBOOK_GROUP_SORT_VALUES = [
  "TOP_POSTS",
  "RECENT_ACTIVITY",
  "CHRONOLOGICAL",
  "CHRONOLOGICAL_LISTINGS",
] as const;

/** /v1/facebook/events `time`; the provider defaults to all time. */
export const FACEBOOK_EVENT_TIME_VALUES = ["today", "this_week", "next_week"] as const;

/** Documented only on /v1/facebook/profile, /post and /post/transcript. */
export const FACEBOOK_CACHE_MAX_AGE_VALUES = ["1d", "3d", "7d", "14d", "30d"] as const;

function literals(T: Typebox, values: readonly string[], description: string) {
  return T.Union(
    values.map((value) => T.Literal(value)),
    { description },
  );
}

function text(T: Typebox, description: string) {
  return T.Optional(T.String({ description }));
}

export function createFacebookSchemas(T: Typebox): Record<string, TSchema> {
  return {
    scrapecreators_facebook: T.Object(
      {
        kind: literals(
          T,
          FACEBOOK_KINDS,
          "profile: public page details; profile_posts (3 per page), profile_reels (up to 10 per page) or profile_photos: one page of a public page's items; search_videos: Facebook's native public video/Reels search (not text or photo post search); post: one public post or reel; transcript: a provider-returned transcript of a video under 2 minutes; comments or replies: one page of comments or of one comment's replies; group: a group's public About page; group_posts: one page (3 posts) of a public group's posts.",
        ),
        url: text(
          T,
          "Full facebook.com URL: the page for profile/profile_posts/profile_reels/profile_photos, the post or reel for post/transcript/comments, the group for group/group_posts.",
        ),
        page_id: text(
          T,
          "profile_posts only. Numeric page id instead of url (faster).",
        ),
        group_id: text(
          T,
          "group or group_posts only. Numeric group id instead of url.",
        ),
        feedback_id: text(
          T,
          "comments: the post's feedback_id (from kind='post') instead of url, which is faster. replies (required): the comment's feedback_id from a comments page; it is not the comment id.",
        ),
        expansion_token: text(
          T,
          "replies only (required). The comment's expansion_token from a comments page.",
        ),
        query: text(T, "search_videos only (required). Keyword or phrase."),
        cursor: text(
          T,
          "Opaque cursor from the previous page of the same kind and target (for search_videos, keep the same query). Omit for the first page.",
        ),
        next_page_id: text(
          T,
          "profile_reels or profile_photos only. Pass together with cursor; both come from the previous page.",
        ),
        sort_by: T.Optional(
          literals(
            T,
            FACEBOOK_GROUP_SORT_VALUES,
            "group_posts only. Facebook's group feed order (default CHRONOLOGICAL).",
          ),
        ),
        business_hours: T.Optional(
          T.Boolean({
            description: "profile only. Also return the business's opening hours.",
          }),
        ),
        include_gated_profile: T.Optional(
          T.Boolean({
            description:
              "profile only. For a private or age-restricted page, return the limited public fields Facebook still shows (id, name, category, likes, links); the gated content stays unavailable.",
          }),
        ),
        cache_max_age: T.Optional(
          literals(
            T,
            FACEBOOK_CACHE_MAX_AGE_VALUES,
            "profile, post or transcript only. Accept a cached response this old or newer; cache hits cost 0 credits.",
          ),
        ),
      },
      { additionalProperties: false },
    ),
    scrapecreators_facebook_events: T.Object(
      {
        kind: literals(
          T,
          FACEBOOK_EVENT_KINDS,
          "profile: one page of a public page's events; search: Facebook's public event search by name; city: one page of a city's Facebook Events page; details: one public event.",
        ),
        url: text(
          T,
          "Full facebook.com URL: the page for profile, the city's events page (https://www.facebook.com/events/explore/<city>/<id>) for city, the event for details.",
        ),
        event_id: text(T, "details only. Numeric event id instead of url."),
        query: text(T, "search only (required). Event name or description words."),
        time: T.Optional(
          literals(
            T,
            FACEBOOK_EVENT_TIME_VALUES,
            "city only. Time frame (default: all time).",
          ),
        ),
        cursor: text(
          T,
          "profile, search or city. Opaque cursor from the previous page of the same kind and target. Omit for the first page.",
        ),
      },
      { additionalProperties: false },
    ),
  };
}
