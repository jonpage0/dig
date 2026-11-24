export const ANSWER_STATUSES = ["answered", "partly-answered", "unanswered"] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

const ANSWER_WORDS: Record<AnswerStatus, string> = {
  answered: "answered",
  "partly-answered": "partly answered",
  unanswered: "not answered",
};

export const answerWord = (status: unknown): string | null =>
  typeof status === "string" && Object.hasOwn(ANSWER_WORDS, status)
    ? ANSWER_WORDS[status as AnswerStatus]
    : null;

export const digWord = (
  answerStatus: unknown,
  state: { readonly answer: unknown; readonly reports: number },
): string => answerWord(answerStatus) ?? (state.answer ? "answer saved" : state.reports ? "report saved" : "started");

const CALL_WORDS: Record<string, string> = {
  success: "results",
  partial: "some results",
  empty: "no results",
  failed: "failed",
  cancelled: "stopped",
  skipped: "skipped",
};

export const callWord = (status: unknown): string =>
  (typeof status === "string" && Object.hasOwn(CALL_WORDS, status) ? CALL_WORDS[status] : undefined) ??
  String(status ?? "unknown");

export const runWord = (status: unknown): string | null =>
  typeof status === "string" && status.trim() ? status.trim().toLowerCase() : null;

const PATTERNS: Record<string, "solid" | "stripes" | "warning" | "dots"> = {
  answered: "solid",
  complete: "solid",
  results: "solid",
  "partly answered": "stripes",
  partial: "stripes",
  "some results": "stripes",
  "not answered": "warning",
  failed: "warning",
  stopped: "warning",
  skipped: "warning",
  started: "dots",
  "no results": "dots",
};

export const patternOf = (word: string): "solid" | "stripes" | "warning" | "dots" | null =>
  Object.hasOwn(PATTERNS, word) ? PATTERNS[word] : null;
