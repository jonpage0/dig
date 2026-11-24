import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { stateDirectory } from "../../core/config.ts";

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** GUI hosts often lack the login shell PATH. Do not execute a shell to locate a binary. */
export function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const path = resolve(directory, name);
    if (isExecutable(path)) return path;
  }
  for (const directory of [
    join(homedir(), ".local/bin"),
    join(homedir(), ".bun/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ]) {
    const path = join(directory, name);
    if (isExecutable(path)) return path;
  }
  return undefined;
}

export function paperSearchDirectory(): string {
  return join(stateDirectory(), "tools", "paper-search-mcp");
}

export function paperSearchInterpreter(): string {
  return join(paperSearchDirectory(), ".venv", "bin", "python");
}

export function paperSearchEnvFile(): string {
  return process.env.PAPER_SEARCH_MCP_ENV_FILE?.trim() || join(paperSearchDirectory(), ".env");
}

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
