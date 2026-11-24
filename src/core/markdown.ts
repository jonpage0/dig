import { Lexer, type Token, type Tokens } from "marked";

/**
 * Pure Markdown frontmatter & report-structure parser shared by the library,
 * search indexer, and web SPA (zero DOM imports).
 */

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  const dbl = /^"(?:[^"\\]|\\.)*"/.exec(value);
  if (dbl) {
    try {
      return JSON.parse(dbl[0]);
    } catch {
      return dbl[0].slice(1, -1);
    }
  }
  const sgl = /^'(?:[^']|'')*'/.exec(value);
  if (sgl) return sgl[0].slice(1, -1).replaceAll("''", "'");
  const bare = value.replace(/\s+#.*$/, "");
  if (bare.startsWith("[")) {
    try {
      return JSON.parse(bare);
    } catch {
      return bare;
    }
  }
  if (bare === "null" || bare === "~") return null;
  if (bare === "true") return true;
  if (bare === "false") return false;
  return bare;
}

export function frontMatter(text: string): {
  readonly meta: Record<string, unknown>;
  readonly body: string;
} {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (pair) meta[pair[1]] = parseScalar(pair[2]);
  }
  return { meta, body: text.slice(match[0].length) };
}

function closedFence(raw: string): boolean {
  const lines = raw.replace(/\n$/, "").split("\n");
  const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "");
  if (!fenceMatch) return false;
  const fence = fenceMatch[1];
  const closer = lines.length > 1 ? lines.at(-1)!.replace(/^ {0,3}/, "") : "";
  return closer.startsWith(fence) && /^[`~]* *$/.test(closer.slice(fence.length));
}

function isSourceCard(block: Token | undefined): block is Tokens.Code {
  return (
    block?.type === "code" &&
    (block as Tokens.Code).codeBlockStyle !== "indented" &&
    /^ya?ml(?:\s|$)/.test((block as Tokens.Code).lang ?? "") &&
    /^source_card:/.test((block as Tokens.Code).text) &&
    closedFence(block.raw)
  );
}

export interface SourceCard {
  readonly fields: Record<string, unknown>;
  readonly lists: Record<string, string[]>;
  readonly yaml: string;
  readonly partial: boolean;
}

function readCard(yaml: string): SourceCard {
  const fields: Record<string, unknown> = {};
  const lists: Record<string, string[]> = {};
  let list: string[] | null = null;
  let partial = false;

  for (const line of yaml.split("\n").slice(1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const entry = /^ {2}([a-z_][a-z0-9_]*):\s*(.*)$/.exec(line);
    const item = /^ {2,}- (.*)$/.exec(line);
    if (entry) {
      list = null;
      const value = entry[2].replace(/^#.*$/, "").trim();
      if (!value) {
        list = lists[entry[1]] = [];
        continue;
      }
      const parsed = parseScalar(value);
      if (Array.isArray(parsed)) {
        if (parsed.some((v) => typeof v !== "string" && typeof v !== "number")) partial = true;
        lists[entry[1]] = parsed
          .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
          .map(String);
      } else {
        fields[entry[1]] = parsed;
      }
    } else if (item && list) {
      const parsed = parseScalar(item[1]);
      if (typeof parsed === "string" || typeof parsed === "number") list.push(String(parsed));
      else partial = true;
    } else {
      partial = true;
    }
  }
  return { fields, lists, yaml, partial };
}

function summaryLine(blocks: readonly Token[]): string {
  const at = blocks.findIndex(
    (b) => b.type === "heading" && (b as Tokens.Heading).depth === 2 && (b as Tokens.Heading).text === "Summary",
  );
  if (at < 0) return "";
  for (const block of blocks.slice(at + 1)) {
    if (block.type === "heading" && (block as Tokens.Heading).depth <= 2) break;
    const line = block.raw.split("\n").find((t) => t.trim());
    if (line !== undefined) return line;
  }
  return "";
}

export interface ReportParts {
  readonly card: SourceCard | null;
  readonly rest: string;
  readonly headings: readonly { readonly depth: number; readonly text: string }[];
  readonly summary: string;
}

export function reportParts(body: string): ReportParts {
  const text = body.replace(/\r\n?/g, "\n");
  const blocks = new Lexer({ gfm: true }).blockTokens(text);
  const first = blocks.findIndex((b) => b.type !== "space");
  let card: SourceCard | null = null;
  let rest = text;

  const firstBlock = first >= 0 ? blocks[first] : undefined;
  if (isSourceCard(firstBlock)) {
    card = readCard(firstBlock.text);
    let end = blocks.slice(0, first + 1).reduce((len, b) => len + b.raw.length, 0);
    if (!firstBlock.raw.endsWith("\n") && text[end] === "\n") end += 1;
    rest = text.slice(end);
  }

  const headings = blocks
    .filter((b): b is Tokens.Heading => b.type === "heading")
    .map(({ depth, text: heading }) => ({ depth, text: heading }));

  return { card, rest, headings, summary: summaryLine(blocks) };
}

export function decodeEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'");
}

export function firstParagraph(markdown: string): string {
  const plain = (tokens: readonly Token[] | undefined): string =>
    (tokens ?? [])
      .map((token) => {
        const sub = (token as { tokens?: readonly Token[] }).tokens;
        if (sub) return plain(sub);
        if (token.type === "escape" || token.type === "codespan" || token.type === "text") {
          return decodeEntities((token as { text?: string }).text ?? "");
        }
        return "";
      })
      .join("");

  const tokens = Lexer.lex(frontMatter(markdown).body, { gfm: true });
  const first = tokens.find((t) => t.type === "paragraph") ?? tokens.find((t) => t.type === "text");
  if (!first) return "";
  const inner = (first as { tokens?: readonly Token[] }).tokens;
  return plain(inner ?? [first]).replace(/\s+/g, " ").trim();
}
