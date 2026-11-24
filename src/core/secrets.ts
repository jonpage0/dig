import { Context, Effect, Layer } from "effect";

/**
 * Credential redaction across plain text, URL-encoded query parameters, and
 * JSON-decoded provider payloads. Values registered here remain redacted for
 * the lifetime of the service process so rotated/removed keys stay scrubbed
 * from in-flight responses and receipts.
 */

const REDACTED = "[redacted]";
const MIN_SECRET_LENGTH = 8;
export const SECRET_NAME_PATTERN = /_(KEY|TOKEN|SECRET|PASSWORD)$/;

const globalRegistered = new Set<string>();
const credentialEnvNames = new Set<string>([
  "EXA_API_KEY",
  "FIRECRAWL_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SEMANTIC_SCHOLAR_API_KEY",
  "OPENALEX_API_KEY",
  "NCBI_API_KEY",
  "PAPER_SEARCH_MCP_NCBI_API_KEY",
  "PAPER_SEARCH_MCP_SEMANTIC_SCHOLAR_API_KEY",
  "PAPER_SEARCH_MCP_OPENALEX_API_KEY",
  "PAPER_SEARCH_MCP_CORE_API_KEY",
  "OPENCODE_RESEARCH_GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "ELORIAN_API_KEY",
  "TYPESAFE_API_KEY",
  "XAI_API_KEY",
  "X_BEARER_TOKEN",
  "X_CONSUMER_KEY",
  "X_CONSUMER_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
  "SCRAPECREATORS_API_KEY",
  "TIKHUB_API_KEY",
  "JUSTONE_API_KEY",
  "SCRAPE_DO_API_KEY",
  "SCRAPEDO_API_TOKEN",
  "NEXSCOPE_API_KEY",
  "DATAFORSEO_PASSWORD",
]);

export function registerCredentialEnvNames(names: readonly string[]): void {
  for (const name of names) {
    if (SECRET_NAME_PATTERN.test(name)) credentialEnvNames.add(name);
  }
}

export function registerSecret(value: string): void {
  const secret = value.trim();
  if (secret.length >= MIN_SECRET_LENGTH) globalRegistered.add(secret);
}

export function knownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set(globalRegistered);
  for (const name of credentialEnvNames) {
    const value = env[name]?.trim();
    if (value && value.length >= MIN_SECRET_LENGTH) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

const literal = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
const utf8 = new TextEncoder();
const byteEscape = (byte: number) =>
  `%${byte.toString(16).toUpperCase().padStart(2, "0").replace(/[A-F]/g, (d) => `[${d}${d.toLowerCase()}]`)}`;

function characterSpellings(character: string): { pattern: string; length: number } {
  const spellings: string[] = [];
  let length = character.length;
  if (character.isWellFormed()) {
    const bytes = [...utf8.encode(character)];
    spellings.push(bytes.map(byteEscape).join(""));
    length = Math.max(length, 3 * bytes.length);
  }
  if (character === " ") spellings.push("\\+");
  spellings.push(literal(character));
  return { pattern: `(?:${spellings.join("|")})`, length };
}

interface Spellings {
  readonly pattern: RegExp;
  readonly reach: number;
}
const spellingsBySecret = new Map<string, Spellings>();

function secretSpellings(secret: string): Spellings {
  let found = spellingsBySecret.get(secret);
  if (!found) {
    const characters = [...secret].map(characterSpellings);
    found = {
      pattern: new RegExp(characters.map((c) => c.pattern).join(""), "g"),
      reach: characters.reduce((sum, c) => sum + c.length, 0),
    };
    spellingsBySecret.set(secret, found);
  }
  return found;
}

function redactEncoded(text: string, secret: string): string {
  const { pattern, reach } = secretSpellings(secret);
  if (text.length <= reach) return text.replace(pattern, REDACTED);
  const marks = /[%+]/g;
  let redacted = "";
  let done = 0;
  for (let mark = marks.exec(text); mark; ) {
    const start = Math.max(done, mark.index - reach + 1);
    let end = mark.index + reach;
    for (mark = marks.exec(text); mark && mark.index - reach + 1 < end; mark = marks.exec(text)) {
      end = mark.index + reach;
    }
    end = Math.min(end, text.length);
    redacted += text.slice(done, start) + text.slice(start, end).replace(pattern, REDACTED);
    done = end;
  }
  return done === 0 ? text : redacted + text.slice(done);
}

export function redactText(text: string, secrets: readonly string[] = knownSecrets()): string {
  if (!secrets.length) return text;
  const escaped = /[%+]/.test(text);
  let clean = text;
  for (const secret of secrets) {
    if (escaped) clean = redactEncoded(clean, secret);
    clean = clean.replaceAll(secret, REDACTED);
  }
  return clean;
}

export function redactValue(value: unknown, secrets: readonly string[] = knownSecrets()): unknown {
  if (!secrets.length) return value;
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) {
    const items = value.map((item) => redactValue(item, secrets));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const entries = Object.entries(value);
    const clean = entries.map(([name, item]) => [redactText(name, secrets), redactValue(item, secrets)] as const);
    return clean.some(([name, item], index) => name !== entries[index][0] || item !== entries[index][1])
      ? Object.fromEntries(clean)
      : value;
  }
  return value;
}

export function redactRecord(record: object, secrets: readonly string[] = knownSecrets()): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([name, item]) => [redactText(name, secrets), redactValue(item, secrets)]),
  );
}

export type RedactedProviderText =
  | { readonly text: string; readonly json: true; readonly value: unknown }
  | { readonly text: string; readonly json: false };

export function redactProviderText(
  text: string,
  secrets: readonly string[] = knownSecrets(),
  parse: (text: string) => unknown = JSON.parse,
): RedactedProviderText {
  let decoded: unknown;
  try {
    decoded = parse(text);
  } catch {
    return { text: redactText(text, secrets), json: false };
  }
  const value = redactValue(decoded, secrets);
  return { text: value === decoded ? text : JSON.stringify(value), json: true, value };
}

export interface SecretRegistryService {
  readonly register: (secret: string) => Effect.Effect<void>;
  readonly secrets: () => Effect.Effect<readonly string[]>;
  readonly redactText: (text: string) => Effect.Effect<string>;
  readonly redactValue: <T>(value: T) => Effect.Effect<T>;
}

export class SecretRegistry extends Context.Service<SecretRegistry, SecretRegistryService>()("dig/SecretRegistry") {
  static readonly Live = Layer.succeed(
    SecretRegistry,
    SecretRegistry.of({
      register: (secret) => Effect.sync(() => registerSecret(secret)),
      secrets: () => Effect.sync(() => knownSecrets()),
      redactText: (text) => Effect.sync(() => redactText(text, knownSecrets())),
      redactValue: <T>(value: T) => Effect.sync(() => redactValue(value, knownSecrets()) as T),
    }),
  );
}
