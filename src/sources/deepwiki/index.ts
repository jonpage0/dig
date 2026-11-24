import { Effect, Result, Schema } from "effect";
import { freeRequest, type FreeHttp } from "../../core/http.ts";
import {
  defineAction,
  defineSource,
  failed,
  outcome,
  type ActionContext,
  type ActionOutcome,
  type SourcePlugin,
} from "../../core/plugin.ts";
import { USER_AGENT } from "../../version.ts";

const DEEPWIKI_MCP_URL = "https://mcp.deepwiki.com/mcp";
/**
 * Maximum wiki slice returned per read so results stay well within MCP host payload budgets.
 * The retained original keeps the whole wiki.
 */
const CONTENTS_MAX_CHARS = 200_000;
const BOUNDARY_WINDOW = 20_000;

type DeepWikiToolName = "read_wiki_structure" | "read_wiki_contents" | "ask_question";

function normalizeRepoName(value: unknown): string | { readonly error: string } {
  const repo = String(value ?? "").trim();
  if (!repo) return { error: "repoName is required in owner/repo format" };
  return repo;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractNotificationMessage(message: unknown): string | null {
  const rec = asRecord(message);
  if (!rec || typeof rec.method !== "string") return null;
  const params = asRecord(rec.params);
  if (!params) return null;
  if (typeof params.message === "string" && params.message.trim()) return params.message.trim();
  const data = asRecord(params.data);
  if (typeof data?.msg === "string" && data.msg.trim()) return data.msg.trim();
  if (typeof params.data === "string" && params.data.trim()) return params.data.trim();
  return null;
}

/**
 * DeepWiki answers over streamable HTTP. A slow `ask_question` streams progress
 * notifications (and `: ping` comments) before the JSON-RPC response, so parse
 * each SSE event on its own and return the one carrying `result` or `error`.
 */
export function extractSseJson(
  text: string,
  onNotification?: (message: string) => void,
): unknown {
  const messages: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (data) messages.push(JSON.parse(data));
  }
  if (!messages.length) {
    if (!text.trim()) throw new Error("DeepWiki returned an empty response");
    return JSON.parse(text);
  }
  if (onNotification) {
    for (const msg of messages) {
      const note = extractNotificationMessage(msg);
      if (note) onNotification(note);
    }
  }
  const response = messages.find(
    (m) => typeof m === "object" && m !== null && ("result" in m || "error" in m),
  );
  if (!response) throw new Error("DeepWiki stream ended without a response");
  return response;
}

function textFromMcpResult(payload: unknown): ActionOutcome {
  const envelope = asRecord(payload);
  const rpcError = asRecord(envelope?.error);
  if (rpcError) {
    const msg = typeof rpcError.message === "string" && rpcError.message ? rpcError.message : "DeepWiki MCP error";
    throw new Error(msg);
  }
  const result = asRecord(envelope?.result);
  if (!result) throw new Error("DeepWiki MCP response did not include a result");
  const isError = result.isError === true;
  if (typeof result.result === "string") {
    return isError ? failed(result.result) : outcome("success", result.result);
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((item) => {
      const block = asRecord(item);
      return block?.type === "text" && typeof block.text === "string" ? block.text : null;
    })
    .filter((entry): entry is string => entry !== null)
    .join("\n");
  if (!text) throw new Error("DeepWiki MCP response did not include text content");
  return isError ? failed(text) : outcome("success", text);
}

function callDeepWiki(
  name: DeepWikiToolName,
  args: Record<string, unknown>,
  ctx: ActionContext,
  timeoutMs = 60_000,
  onNotification?: (message: string) => void,
): Effect.Effect<ActionOutcome, never, FreeHttp> {
  return Effect.gen(function* () {
    if (ctx.signal.aborted) {
      return outcome("cancelled", `DeepWiki ${name} cancelled`);
    }

    let parseFailureReason: string | null = null;
    const res = yield* Effect.result(
      freeRequest({
        url: DEEPWIKI_MCP_URL,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "User-Agent": USER_AGENT,
        },
        body: {
          jsonrpc: "2.0",
          id: `${name}-${Date.now()}`,
          method: "tools/call",
          params: { name, arguments: args },
        },
        timeoutMs,
        signal: ctx.signal,
        label: name,
        keep: ctx.keep,
        parseJson: (rawText) => {
          try {
            return extractSseJson(rawText, onNotification);
          } catch (error) {
            // The JSON parser's own message quotes part of the response, which could cut a credential in two.
            parseFailureReason =
              error instanceof SyntaxError
                ? "a response event is not JSON"
                : error instanceof Error
                  ? error.message
                  : "Unknown error";
            throw error;
          }
        },
      }),
    );

    if (Result.isFailure(res)) {
      if (ctx.signal.aborted) return outcome("cancelled", `DeepWiki ${name} cancelled`);
      return failed(`DeepWiki ${name} failed: ${res.failure.message}`);
    }

    const { status, isJson, payload, text } = res.success;
    if (status < 200 || status >= 300) {
      const excerpt = isJson ? JSON.stringify(payload).slice(0, 300) : text.slice(0, 300);
      return failed(`DeepWiki HTTP ${status}: ${excerpt}`);
    }
    if (!isJson) {
      return failed(`Failed to parse DeepWiki response: ${parseFailureReason ?? "a response event is not JSON"}`);
    }
    try {
      return textFromMcpResult(payload);
    } catch (error) {
      return failed(
        `Failed to parse DeepWiki response: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  });
}

function boundedContents(result: ActionOutcome): ActionOutcome {
  const text = result.text;
  if (result.status !== "success" || text.length <= CONTENTS_MAX_CHARS) return result;
  const sliceWindow = text.slice(0, CONTENTS_MAX_CHARS + 1);
  const headings = [...sliceWindow.matchAll(/\n(?=#{1,6} )/g)].map((match) => (match.index ?? 0) + 1);
  const heading = headings.at(-1);
  const line = sliceWindow.lastIndexOf("\n");
  let cut =
    heading !== undefined && heading >= CONTENTS_MAX_CHARS - BOUNDARY_WINDOW
      ? heading
      : line >= CONTENTS_MAX_CHARS - BOUNDARY_WINDOW
        ? line + 1
        : CONTENTS_MAX_CHARS;
  if (/[\uD800-\uDBFF]/.test(text[cut - 1] ?? "")) cut -= 1;
  const shown = text.slice(0, cut);
  const count = (n: number) => n.toLocaleString("en-US");
  return outcome(
    "partial",
    `Showing the first ${count(shown.length)} of ${count(text.length)} characters of this wiki (Dig returns at most ${count(CONTENTS_MAX_CHARS)} per call); the retained original holds the whole wiki, and deepwiki_ask_question or the page list from deepwiki_read_wiki_structure reaches a specific page.\n\n${shown}`,
    result.details,
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const deepwikiReadStructureSchema = Schema.Struct({
  repoName: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "GitHub repository in owner/repo format.",
  }),
});

export const deepwikiReadContentsSchema = Schema.Struct({
  repoName: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "GitHub repository in owner/repo format.",
  }),
});

export const deepwikiAskQuestionSchema = Schema.Struct({
  repoName: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "GitHub repository in owner/repo format.",
  }),
  question: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Focused structural question about the repository.",
  }),
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const deepwikiReadStructureAction = defineAction({
  name: "deepwiki_read_wiki_structure",
  description:
    "Get a list of documentation topics for a GitHub repository via DeepWiki's public no-auth endpoint.",
  schema: deepwikiReadStructureSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const repoName = normalizeRepoName(args.repoName);
      if (typeof repoName !== "string") return failed(repoName.error);
      return yield* callDeepWiki("read_wiki_structure", { repoName }, ctx, 60_000);
    }),
});

export const deepwikiReadContentsAction = defineAction({
  name: "deepwiki_read_wiki_contents",
  description:
    "View DeepWiki documentation contents for a GitHub repository via DeepWiki's public no-auth endpoint. Returns at most 200,000 characters: a longer wiki comes back cut at a page boundary, as partial, with the full size stated; the retained original keeps the whole wiki.",
  schema: deepwikiReadContentsSchema,
  billing: "free",
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const repoName = normalizeRepoName(args.repoName);
      if (typeof repoName !== "string") return failed(repoName.error);
      const res = yield* callDeepWiki("read_wiki_contents", { repoName }, ctx, 60_000);
      return boundedContents(res);
    }),
});

export const deepwikiAskQuestionAction = defineAction({
  name: "deepwiki_ask_question",
  description: "Ask DeepWiki an AI-powered, context-grounded question about one GitHub repository.",
  schema: deepwikiAskQuestionSchema,
  billing: "free",
  slow: true,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const repoName = normalizeRepoName(args.repoName);
      if (typeof repoName !== "string") return failed(repoName.error);
      const question = String(args.question ?? "").trim();
      if (!question) return failed("question is required");

      ctx.progress({ progress: 0, total: 2, message: `Asking DeepWiki about ${repoName}...` });
      let sawNotification = false;
      const result = yield* callDeepWiki(
        "ask_question",
        { repoName, question },
        ctx,
        180_000,
        (note) => {
          sawNotification = true;
          ctx.progress({ progress: 1, total: 2, message: `DeepWiki (${repoName}): ${note}` });
        },
      );
      if (result.status === "success") {
        if (!sawNotification) {
          ctx.progress({
            progress: 1,
            total: 2,
            message: `DeepWiki response received for ${repoName}`,
          });
        }
        ctx.progress({
          progress: 2,
          total: 2,
          message: `DeepWiki answer ready for ${repoName}`,
        });
      }
      return result;
    }),
});

export const deepwikiSource: SourcePlugin = defineSource({
  id: "deepwiki",
  group: "code",
  label: "DeepWiki",
  description: "Public repository documentation and Q&A",
  about:
    "Generated documentation for public GitHub repositories: browse a repository's wiki or ask a question about its code. Answers are generated from the code and can be wrong, so load-bearing claims get checked in the repository itself.",
  providers: [{ name: "DeepWiki", url: "https://deepwiki.com" }],
  billing: "Free. No account or key.",
  actions: [deepwikiReadStructureAction, deepwikiReadContentsAction, deepwikiAskQuestionAction],
});

export default deepwikiSource;
