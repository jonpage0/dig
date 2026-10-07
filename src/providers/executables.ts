import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { accessSync, constants, statSync } from "node:fs";

/** An executable regular file; directories and unreadable entries are not. */
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
