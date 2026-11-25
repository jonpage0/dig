import { Data } from "effect";

export class RefusalError extends Data.TaggedError("RefusalError")<{
  readonly message: string;
}> {}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class KeysError extends Data.TaggedError("KeysError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class LibraryError extends Data.TaggedError("LibraryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SsrfBlockedError extends Data.TaggedError("SsrfBlockedError")<{
  readonly url: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `Blocked non-public URL (${this.reason}): ${this.url}`;
  }
}

export class SpendLimitError extends Data.TaggedError("SpendLimitError")<{
  readonly unit: string;
  readonly spent: number;
  readonly limit: number;
  readonly message: string;
}> {}

export class ProviderCallError extends Data.TaggedError("ProviderCallError")<{
  readonly provider: string;
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export type DigError =
  | RefusalError
  | ConfigError
  | KeysError
  | LibraryError
  | SsrfBlockedError
  | SpendLimitError
  | ProviderCallError;

/**
 * A failure's own text, never empty: its message, else the first non-empty message among its causes (an Effect
 * platform error such as `ServeError` carries the real one, `listen EADDRINUSE …`, only in `cause`), else its tag.
 */
export function errorMessage(error: unknown): string {
  const seen = new Set<unknown>();
  let tag = "";
  for (let current = error; current !== undefined && current !== null && !seen.has(current); ) {
    seen.add(current);
    if (typeof current !== "object") {
      const text = String(current).trim();
      if (text) return text;
      break;
    }
    const { message, _tag, name, cause } = current as {
      readonly message?: unknown;
      readonly _tag?: unknown;
      readonly name?: unknown;
      readonly cause?: unknown;
    };
    if (typeof message === "string" && message.trim()) return message;
    if (!tag) tag = typeof _tag === "string" ? _tag : typeof name === "string" && name !== "Error" ? name : "";
    current = cause;
  }
  return `${tag || "Unexpected failure"} (no message)`;
}
