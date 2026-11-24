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
