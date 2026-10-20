import type { Type, TSchema } from "@sinclair/typebox";
export function createYouTubeAnalysisSchemas(T: typeof Type): Record<string, TSchema> {
  const choice = (values: string[]) => T.Union(values.map(v => T.Literal(v)));
  const interactionId = T.String({ minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$", description: "Google interaction ID returned by this task's analysis. It is an account-scoped provider reference, not a local file." });
  return {
    youtube_analyze: T.Object({
      question: T.String({ minLength: 1, maxLength: 20000, description: "The summary, review, comparison or focused question. Ask for timestamps and separate observed visuals, speech and inference." }),
      videos: T.Optional(T.Array(T.Object({
        url: T.String({ minLength: 1, description: "Public YouTube watch/shorts/live/youtu.be URL or 11-character video ID. A URL time parameter is not a clipping control." }),
        processing: T.Optional(choice(["static", "agentic"])),
        startSeconds: T.Optional(T.Number({ minimum: 0, description: "Static-mode interval start. Original-video timestamps are preserved." })),
        endSeconds: T.Optional(T.Number({ exclusiveMinimum: 0, description: "Static-mode interval end, after start." })),
        fps: T.Optional(T.Number({ minimum: 0.01, maximum: 30, description: "Static-mode frame sampling; omitted uses Google's default. Higher density uses more context." })),
        resolution: T.Optional(choice(["low", "medium", "high", "ultra_high"])),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 10, description: "Up to ten videos, each with its own processing controls. Required for a first request; optional when continuing a stored interaction." })),
      previousInteractionId: T.Optional(interactionId),
      model: T.Optional(choice(["gemini-3.8-flash", "gemini-4-argon"])),
      thinking: T.Optional(choice(["minimal", "low", "medium", "high"])),
      maxTokens: T.Optional(T.Integer({ minimum: 128, maximum: 16384, description: "Response token ceiling, default 4096. Not a total spend limit." })),
      responseSchema: T.Optional(T.Record(T.String(), T.Any(), { description: "Optional JSON Schema for structured findings. Google supports a subset; unsupported combinations fail explicitly. Structure does not prove accuracy." })),
      webSearch: T.Optional(T.Boolean({ description: "Explicitly enable Google's web-search grounding. Off by default; may add provider charges and external sources." })),
      urlContext: T.Optional(T.Boolean({ description: "Explicitly let Google read reference URLs in the question. Off by default." })),
      background: T.Optional(T.Boolean({ description: "Return the provider interaction ID promptly and continue with youtube_analysis_status. Default waits for the result." })),
      store: T.Optional(T.Boolean({ description: "Allow Google to store this interaction for polling and follow-ups (default true). False requires foreground, no previousInteractionId, and provides no provider resume history. Dig's own retention is separate." })),
    }, { additionalProperties: false }),
    youtube_analysis_status: T.Object({
      interactionId,
      action: T.Optional(choice(["get", "cancel"])),
      waitSeconds: T.Optional(T.Number({ minimum: 0, maximum: 120, description: "On get, wait up to this many seconds for completion. Default 0 reads once; this never starts a second generation." })),
    }, { additionalProperties: false }),
  };
}
