export type DigHost = "codex" | "claude-code" | "antigravity" | "any";

export interface HostWords {
  readonly app: string;
  readonly plans: string;
  readonly skill: (name: string) => string;
  readonly refresh: string;
}

const SIDEBAR = "Right-click Dig in the sidebar and choose Refresh to load the new one.";

const WORDS: Record<DigHost, HostWords> = {
  codex: {
    app: "Codex",
    plans: "ChatGPT or Codex",
    skill: (name) => `$dig:${name}`,
    refresh: SIDEBAR,
  },
  "claude-code": {
    app: "Claude Code",
    plans: "Claude Code",
    skill: (name) => `Dig’s ${name} method`,
    refresh: SIDEBAR,
  },
  antigravity: {
    app: "Antigravity",
    plans: "Antigravity",
    skill: (name) => `/${name}`,
    refresh: "Reload Dig in Antigravity to load the new one.",
  },
  any: {
    app: "your assistant",
    plans: "assistant",
    skill: (name) => `Dig’s ${name} method`,
    refresh: "Reload this page to load the new one.",
  },
};

export const hostOf = (value: unknown): DigHost =>
  value === "claude-code" || value === "antigravity" || value === "any" ? value : "codex";

export const hostWords = (host: unknown): HostWords => WORDS[hostOf(host)];
