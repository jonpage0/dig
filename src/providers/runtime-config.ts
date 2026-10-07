import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigSync, stateDirectory } from "../config.mjs";

/**
 * The settings provider tools read, in the spellings they were written
 * against. The native authority is `<state>/config.toml`, loaded by
 * src/config.mjs in its TOML spellings (`keep_raw`, `[x] web_search`, …);
 * this adapter only renames them. Read per call, so an edit applies to the
 * next call without a restart.
 */
export interface XSearchConfig {
  model: string;
  depth: "quick" | "standard" | "max" | "ultra";
  webSearch: boolean;
  codeExecution: boolean;
}
export interface ProviderConfig {
  /** Absolute library root; one folder per project inside it. */
  library: string;
  /** Keep each provider's raw response beside the reports. */
  keepRaw: boolean;
  x: XSearchConfig;
}

/** src/config.mjs `loadConfigSync()`: the TOML spellings. */
interface NativeConfig {
  library: string;
  keep_raw: boolean;
  x: {
    model: string;
    depth: XSearchConfig["depth"];
    web_search: boolean;
    code_execution: boolean;
  };
}

export function loadConfig(): ProviderConfig {
  const native: NativeConfig = loadConfigSync();
  return {
    library: native.library,
    keepRaw: native.keep_raw,
    x: {
      model: native.x.model,
      depth: native.x.depth,
      webSearch: native.x.web_search,
      codeExecution: native.x.code_execution,
    },
  };
}

/**
 * The optional Papers bridge: a pinned, patched paper-search-mcp clone that
 * plugin/bridges/papers/setup.mjs installs beneath the native state
 * directory, never inside the package cache or another edition's tools.
 */
export function paperSearchDirectory(): string {
  return join(stateDirectory(), "tools", "paper-search-mcp");
}
/** The bridge's Python environment; it exists once setup has installed the clone. */
export function paperSearchInterpreter(): string {
  return join(paperSearchDirectory(), ".venv", "bin", "python");
}
/** The bridge's settings file: PAPER_SEARCH_MCP_ENV_FILE when set, else the clone's own `.env`, never a user-global file. */
export function paperSearchEnvFile(): string {
  return process.env.PAPER_SEARCH_MCP_ENV_FILE?.trim() || join(paperSearchDirectory(), ".env");
}
/**
 * Every nonempty value the bridge's settings file assigns `name`, read as the bridge reads it (an optional `export `,
 * matching quotes stripped). Server-side only: callers report presence or scrub these values, never return them.
 */
export function paperSearchEnvValues(name: string): string[] {
  let text = "";
  try {
    text = readFileSync(paperSearchEnvFile(), "utf8");
  } catch {
    return [];
  }
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    const value = match?.[1] === name ? match[2].trim().replace(/^(['"])(.*)\1$/, "$2") : "";
    return value ? [value] : [];
  });
}
