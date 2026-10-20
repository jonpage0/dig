import type { Type, TSchema } from "@sinclair/typebox";

export const SOCIAL_CACHE_AGES = ["1d", "3d", "7d", "14d", "30d"] as const;
export const TIKTOK_READ_KINDS = ["post", "profile", "posts", "transcript", "replies"] as const;
export const INSTAGRAM_READ_KINDS = ["post", "profile", "posts", "reels", "transcript", "replies"] as const;

export function createSocialReadSchemas(T: typeof Type): Record<string, TSchema> {
  const text = (description: string) => T.Optional(T.String({ minLength: 1, description }));
  const cache = () => T.Optional(T.Union(SOCIAL_CACHE_AGES.map(value => T.Literal(value)), { description: "Accept a provider cache hit this old; only post/profile reads and Instagram transcripts support it. Returned charges remain authoritative." }));
  const common = {
    url: text("Public HTTPS TikTok or Instagram post URL, required for post, transcript and replies. No sign-in, downloads or visual analysis."),
    handle: text("Creator handle (optional leading @), required for profile and creator posts/reels."),
    commentId: text("The parent comment's ID returned by the comments tool; required for replies."),
    cacheMaxAge: cache(),
  };
  return {
    tiktok_read: T.Object({
      ...common,
      kind: T.Union(TIKTOK_READ_KINDS.map(value => T.Literal(value)), { description: "Read one exact post (video or photo), profile, one creator-feed page, one transcript, or one parent comment's replies." }),
      cursor: T.Optional(T.Union([T.String({ minLength: 1 }), T.Integer({ minimum: 0 })], { description: "posts: opaque max_cursor string; replies: nonnegative numeric cursor. Reuse only with the same creator/post, region and sort." })),
      region: text("Two-letter proxy country for post/posts. Does not filter creator nationality or prove global availability."),
      sort: T.Optional(T.Union([T.Literal("latest"), T.Literal("popular")], { description: "Creator posts only; default latest." })),
      includePinned: T.Optional(T.Boolean({ description: "Creator posts only; pass the provider's pinned-post option explicitly." })),
      language: text("Transcript only: two-letter caption language."),
      aiFallback: T.Optional(T.Boolean({ description: "Transcript only; default false. If native captions are unavailable, permit AI transcription up to 120 seconds for one credit when successful. Long paid transcription is not enabled." })),
    }, { additionalProperties: false }),
    instagram_read: T.Object({
      ...common,
      kind: T.Union(INSTAGRAM_READ_KINDS.map(value => T.Literal(value)), { description: "Read one exact post/reel/carousel, profile, one creator-posts/reels page, one AI transcript, or one parent comment's replies." }),
      cursor: text("posts: next_max_id; reels: max_id; replies: cursor. Reuse the opaque string with the same operation and target."),
      includePlayCount: T.Optional(T.Boolean({ description: "Post only; default true. False skips the provider's extra play-count lookup. Missing counts stay unknown." })),
    }, { additionalProperties: false }),
  };
}
