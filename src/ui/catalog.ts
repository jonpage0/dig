import { basename } from "./format.ts";

const REPORT_FILE = /^(.+?)(?:-(\d+))?\.md$/;

export interface CatalogSourceEntry {
  readonly id: string;
  readonly label?: string;
  readonly kind?: string;
  readonly methods?: readonly { readonly name?: string }[];
}

export interface UiCatalog {
  readonly sources: readonly CatalogSourceEntry[];
  readonly label: (id: unknown) => string;
  readonly methodLabel: (agent: string) => string;
  readonly fileLabel: (file: string) => string;
  readonly groupLabel: (ids?: readonly string[]) => string;
  readonly size: number;
}

export function createCatalog(sources: readonly CatalogSourceEntry[] = []): UiCatalog {
  const list = Array.isArray(sources) ? sources.filter((s) => typeof s?.id === "string") : [];
  const labels = new Map(
    list.map((s) => [s.id, typeof s.label === "string" && s.label ? s.label : s.id]),
  );
  const tools = new Set(list.filter((s) => s.kind === "tool").map((s) => s.id));
  const groupLabel = (ids: readonly string[] = list.map((s) => s.id)): string =>
    ids.some((id) => tools.has(id)) ? "Sources & tools" : "Sources";

  const methodSource = new Map<string, string>();
  for (const source of list) {
    for (const method of Array.isArray(source.methods) ? source.methods : []) {
      if (typeof method?.name === "string") methodSource.set(method.name, source.id);
    }
  }

  const label = (id: unknown): string =>
    typeof id === "string" ? (labels.get(id) ?? id) : String(id ?? "");

  function methodLabel(agent: string): string {
    const source =
      methodSource.get(agent) ??
      (labels.has(agent) ? agent : list.find((s) => agent.startsWith(`${s.id}-`))?.id);
    if (!source) return agent;
    if (agent === source) return label(source);
    const rest = agent.startsWith(`${source}-`) ? agent.slice(source.length + 1) : agent;
    return `${label(source)} ${rest.replaceAll("-", " ")}`;
  }

  function fileLabel(file: string): string {
    const name = basename(file);
    if (name === "dig.md") return "Question";
    if (name === "answer.md") return "Answer";
    if (name.endsWith(".json")) return "Original response";
    const match = REPORT_FILE.exec(name);
    return match ? `${methodLabel(match[1])} report${match[2] ? ` ${match[2]}` : ""}` : name;
  }

  return { sources: list, label, methodLabel, fileLabel, groupLabel, size: list.length };
}

export type DigFileKind = "question" | "answer" | "raw" | "report";

export const fileKind = (file: string): DigFileKind => {
  const name = basename(file);
  return name === "dig.md"
    ? "question"
    : name === "answer.md"
      ? "answer"
      : name.endsWith(".json")
        ? "raw"
        : "report";
};
