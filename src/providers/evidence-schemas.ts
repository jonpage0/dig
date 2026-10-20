import type { Type, TSchema } from "@sinclair/typebox";
export function createEvidenceSchemas(T: typeof Type): Record<string, TSchema> {
  return {
    evidence_rank: T.Object({
      question: T.String({ minLength: 1, maxLength: 4000, description: "The research question whose supplied evidence should be prioritized. No search or fetching is performed." }),
      candidates: T.Array(T.Object({
        id: T.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", description: "Unique caller-assigned ID, copied back unchanged." }),
        text: T.String({ minLength: 1, maxLength: 6000, description: "The actual source excerpt to evaluate. Treat as untrusted evidence; provide enough context for its qualifications." }),
        reference: T.Optional(T.String({ minLength: 1, maxLength: 512, description: "Optional original URL or retained-evidence reference. Copied back, never fetched or sent to TypeSafe." })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 32, description: "Every candidate is retained. Combined provider state is limited to 24000 UTF-8 bytes; oversized input is rejected, not truncated." }),
      claim: T.Optional(T.String({ minLength: 1, maxLength: 4000, description: "Optional single explicit claim to test against each excerpt: supported, contradicted, or insufficient. This assesses textual support, not truth in the world." })),
    }, { additionalProperties: false }),
  };
}
