/**
 * Library vocabulary the shared schemas name. The approved library contract
 * (docs/architecture.md) owns these values; src/library.mjs writes them.
 */
export const REPORT_STATUSES = ["complete", "partial", "failed"] as const;
export const TOPIC_VOLATILITIES = ["live", "fast", "medium", "slow", "reference"] as const;
