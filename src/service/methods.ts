// Methods: the research instructions in `skills/<name>/`, served three ways from one in-memory
// snapshot of their bytes so every manifest digest and size describes exactly what is served:
// 1. MCP Skills extension (`@modelcontextprotocol/server/ext/skills`)
// 2. MCP Prompts (one per enabled non-helper method)
// 3. The `method` fallback tool (using Effect 4.1.5 `Schema.toStandardJSONSchemaV1`, zero zod)
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import type {
  CallToolResult,
  GetPromptResult,
  McpRequestContext,
  McpServer,
  RegisteredPrompt,
} from "@modelcontextprotocol/server";
import {
  SkillsExtension,
  skillEntry,
  type Skill,
  type SkillSource,
} from "@modelcontextprotocol/server/ext/skills";
import { ConfigService } from "../core/config.ts";
import type { DigManagedRuntime } from "../core/runtime.ts";
import { ALL_SOURCE_IDS, SOURCES, allMethodsFor, sourceSkills } from "../sources/index.ts";
import { toMcpSchema } from "./surface.ts";

/** The methods folder: `skills/` at the package root, reached from `src/service/` in dev and `dist/` in builds. */
export const SKILLS_ROOT = fileURLToPath(
  ["../skills/", "../../skills/"]
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => existsSync(new URL("dig/SKILL.md", url))) ??
    new URL("../../skills/", import.meta.url),
);

const BASE = "skill://";

/** Methods that only assist another method and that a person would not run alone: no prompt. */
const UNPROMPTED = new Set(["youtube-summarizer"]);

// skills/list follows the enabled sources, so clients keep it no longer than tools/list.
const CACHE = { ttlMs: 60_000, cacheScope: "private" } as const;

export interface Method {
  readonly name: string;
  readonly description: string;
  /** The catalog source id it belongs to; null for `dig`, `library`, and `setup`. */
  readonly source: string | null;
  /** The instructions: SKILL.md body after its YAML front matter. */
  readonly instructions: string;
  /** Every regular file relative to the method's folder (`SKILL.md`, `references/...`), as exact served bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The MCP Skills extension entry: frontmatter and manifest digests computed from `files`. */
  readonly entry: Skill;
}

export interface Methods {
  readonly list: readonly Method[];
  readonly byName: ReadonlyMap<string, Method>;
  readonly byUri: ReadonlyMap<string, { readonly method: Method; readonly path: string }>;
}

const owner = new Map<string, string>(
  SOURCES.flatMap((s) =>
    [...sourceSkills(s), ...(s.helpers ?? []), ...(s.helperSkill ? [s.helperSkill] : [])].map(
      (name) => [name, s.id] as const,
    ),
  ),
);

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const d of entries) {
    // Only regular files and directories are served; symlinks and special entries are never followed.
    if (d.isSymbolicLink()) continue;
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await walk(join(dir, d.name), rel)));
    else if (d.isFile()) out.push(rel);
  }
  return out;
}

const stripFrontMatter = (text: string): string =>
  text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").replace(/^\s+/, "");

/** Reads every method under `root`. Fails loudly if `SKILL.md` is missing or its `name` differs from the folder. */
export async function loadMethods(root = SKILLS_ROOT): Promise<Methods> {
  const list: Method[] = [];
  const dirs = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const d of dirs) {
    const files = new Map<string, Uint8Array>();
    const paths = (await walk(join(root, d.name))).sort(
      (a, b) => Number(b === "SKILL.md") - Number(a === "SKILL.md"),
    );
    for (const rel of paths) {
      files.set(rel, new Uint8Array(await readFile(join(root, d.name, rel))));
    }
    if (!files.has("SKILL.md")) {
      throw new Error(`skills/${d.name} has no SKILL.md`);
    }
    const entry = await skillEntry(d.name, Object.fromEntries(files), { baseUri: BASE });
    const { name, description } = entry.frontmatter;
    if (name !== d.name) {
      throw new Error(
        `skills/${d.name}/SKILL.md is named ${name}; a method's name must match its folder`,
      );
    }
    list.push({
      name,
      description,
      source: owner.get(name) ?? null,
      instructions: stripFrontMatter(new TextDecoder().decode(files.get("SKILL.md"))),
      files,
      entry,
    });
  }

  const byUri = new Map(
    list.flatMap((method) =>
      [...method.files.keys()].map((rel) => [`${BASE}${method.name}/${rel}`, { method, path: rel }] as const),
    ),
  );
  return { list, byName: new Map(list.map((m) => [m.name, m])), byUri };
}

let cachedMethods: Promise<Methods> | undefined;

/** The methods the service serves, loaded once per process. */
export const methods = (): Promise<Methods> => (cachedMethods ??= loadMethods());

/** The methods listed to a client: `dig`, `library`, `setup`, and those of enabled sources, in folder order. */
export function listedMethods(all: Methods, enabled: readonly string[]): Method[] {
  const knownEnabled = enabled.filter((id) => ALL_SOURCE_IDS.includes(id));
  const names = new Set(allMethodsFor(knownEnabled));
  return all.list.filter((m) => names.has(m.name));
}

const fileLine = (m: Method): string => {
  const extra = [...m.files.keys()].filter((p) => p !== "SKILL.md");
  return extra.length
    ? `\n\nThis method's supporting files, read with \`method({ name: "${m.name}", file })\`: ${extra.map((p) => `\`${p}\``).join(", ")}.`
    : "";
};

/** What the `method` tool and prompts give the model: instructions plus how to read supporting files. */
export const methodText = (m: Method): string => `${m.instructions.trimEnd()}${fileLine(m)}\n`;

/** A prompt's message: the method's instructions, followed by the task when a question is provided. */
export function promptMessage(m: Method, question?: string): GetPromptResult {
  const task = question?.trim();
  return {
    description: m.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: task ? `${methodText(m)}\n## Task\n\n${task}\n` : methodText(m),
        },
      },
    ],
  };
}

/** The methods offered as prompts: every method a person would run directly (skips helper-only `youtube-summarizer`). */
export const promptedMethods = (all: readonly Method[]): Method[] =>
  all.filter((m) => !UNPROMPTED.has(m.name));

/**
 * Reads one supporting file of a method by its path relative to the method's folder.
 * Refuses any path that escapes the folder (traversal, absolute path, or URI scheme).
 */
export function methodFile(m: Method, file: string): { readonly text: string } | { readonly error: string } {
  const normalized = posix.normalize(file.replaceAll("\\", "/"));
  if (
    posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    /^[a-z][a-z0-9+.-]*:/i.test(file)
  ) {
    return {
      error: `${file} is outside the ${m.name} method's folder; name a file by its path inside it, such as references/….`,
    };
  }
  const bytes = m.files.get(normalized);
  if (!bytes) {
    return {
      error: `The ${m.name} method has no file ${normalized}. Its files: ${[...m.files.keys()].join(", ")}.`,
    };
  }
  return { text: new TextDecoder().decode(bytes) };
}

/** The `method` tool's answer for a single invocation. */
export function readMethod(all: Methods, name: string, file?: string): CallToolResult {
  const m = all.byName.get(name);
  const fail = (text: string): CallToolResult => ({
    content: [{ type: "text", text }],
    isError: true,
  });
  if (!m) {
    return fail(`No method is named ${name}. The methods are: ${all.list.map((x) => x.name).join(", ")}.`);
  }
  if (file === undefined) return { content: [{ type: "text", text: methodText(m) }] };
  const read = methodFile(m, file);
  return "error" in read ? fail(read.error) : { content: [{ type: "text", text: read.text }] };
}

/** The Skills extension's view of methods: listing follows enabled sources; `skills/get` & reads serve all. */
export function skillSource(
  all: () => Promise<Methods>,
  enabled: () => Promise<readonly string[]>,
): SkillSource {
  return {
    async list() {
      return { skills: listedMethods(await all(), await enabled()).map((m) => m.entry) };
    },
    async get(uri) {
      const name =
        uri.startsWith(BASE) && uri.endsWith("/SKILL.md")
          ? uri.slice(BASE.length, -"/SKILL.md".length)
          : "";
      return (await all()).byName.get(name)?.entry;
    },
    async read(uri) {
      const hit = (await all()).byUri.get(uri);
      if (!hit) return undefined;
      const bytes = hit.method.files.get(hit.path)!;
      return hit.path.endsWith(".md")
        ? { text: new TextDecoder().decode(bytes), mimeType: "text/markdown" }
        : { bytes, mimeType: "application/octet-stream" };
    },
  };
}

const PromptArgsSchema = toMcpSchema(
  Schema.Struct({
    question: Schema.optionalKey(
      Schema.String.annotate({
        description: "The research question or request to run the method on.",
      }),
    ),
  }),
);

const MethodToolInputSchema = toMcpSchema(
  Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "The method's name, as source_info gives it.",
    }),
    file: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "A supporting file's path inside the method's folder, such as references/….",
      }),
    ),
  }),
);

const METHOD_DESCRIPTION =
  "Read a Dig method: the instructions for researching one source (or for running a dig, reusing the library, or setting Dig up), which say what to search, how to weigh it and how to save the report. source_info names each source's methods. method({ name }) returns a method's instructions; method({ name, file }) returns one of its supporting files, by the path the instructions give.";

/**
 * Registers the MCP Skills extension, one prompt per enabled non-helper method, and the
 * `method` fallback tool on `server`. Returns a `sync` callback that updates prompt enabled
 * states whenever `config.toml` changes.
 */
export async function registerMethods(
  server: McpServer,
  _context: McpRequestContext,
  runtime: DigManagedRuntime,
): Promise<(enabled: readonly string[]) => void> {
  const all = await methods();

  const getEnabled = async (): Promise<readonly string[]> => {
    try {
      const cfg = await runtime.runPromise(Effect.flatMap(ConfigService, (c) => c.load()));
      return cfg.sources.enabled;
    } catch {
      return [];
    }
  };

  const skillsExtension = new SkillsExtension({
    source: skillSource(methods, getEnabled),
    cacheHint: CACHE,
  });
  skillsExtension.attach(server);

  const prompts = new Map<Method, RegisteredPrompt>();
  for (const m of promptedMethods(all.list)) {
    prompts.set(
      m,
      server.registerPrompt(
        m.name,
        { description: m.description, argsSchema: PromptArgsSchema },
        ({ question }) => promptMessage(m, question),
      ),
    );
  }

  const sync = (enabled: readonly string[]) => {
    const listed = new Set(listedMethods(all, enabled));
    for (const [m, prompt] of prompts) {
      const want = listed.has(m);
      if (want !== prompt.enabled) {
        if (want) prompt.enable();
        else prompt.disable();
      }
    }
  };
  sync(await getEnabled());

  server.registerTool(
    "method",
    {
      title: "Read a method",
      description: METHOD_DESCRIPTION,
      inputSchema: MethodToolInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, file }) => readMethod(await methods(), name, file),
  );

  return sync;
}
