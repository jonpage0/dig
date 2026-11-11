/**
 * Library vocabulary the server's library-tool schemas name. The approved library contract
 * (docs/architecture.md) owns these values; src/library.mjs writes them.
 */
export const TOPIC_VOLATILITIES = ["live", "fast", "medium", "slow", "reference"] as const;
