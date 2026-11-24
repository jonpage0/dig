import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { Lexer } from "marked";
import manifest from "../search/assets/manifest.json" with { type: "json" };
import tokenizerData from "../search/assets/tokenizer.json" with { type: "json" };
import tokenizerConfig from "../search/assets/tokenizer_config.json" with { type: "json" };
import { frontMatter } from "./markdown.ts";

/**
 * Local ONNX embedding engine (clean TypeScript replacement for `src/search/engine.mjs`).
 * Supports `darwin/arm64` and `linux/x64` via packaged native runtime in `runtime/dist/onnx.cjs`.
 */

export const SUPPORTED_PLATFORMS = Object.freeze(["darwin/arm64", "linux/x64"] as const);

export const RUNTIME =
  (["../runtime/dist/onnx.cjs", "../../runtime/dist/onnx.cjs"]
    .map((p) => new URL(p, import.meta.url))
    .find((url) => existsSync(url)) ?? new URL("../../runtime/dist/onnx.cjs", import.meta.url)).href;

export function isSupportedPlatform(platform = process.platform, arch = process.arch): boolean {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(`${platform}/${arch}`);
}

export function assertSupportedPlatform(platform = process.platform, arch = process.arch): void {
  if (!isSupportedPlatform(platform, arch)) {
    throw new Error(
      `Local semantic search is currently packaged for macOS arm64 and Linux x64 (not ${platform}/${arch}). Keyword search remains available.`,
    );
  }
}

export const MODEL = {
  id: manifest.model,
  revision: manifest.revision,
  dtype: "q8",
  pooling: "cls",
  dimensions: 384,
  normalized: true,
} as const;

export const tokenizer = new Tokenizer(tokenizerData, tokenizerConfig);
export const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const tokenCount = (text: string): number => tokenizer.encode(text).ids.length;
export const queryText = (text: string): string =>
  `Represent this sentence for searching relevant passages: ${text}`;

export function embeddingText(title: string, heading: string | null, text: string): string {
  let context = [title, heading].filter(Boolean).join(" — ");
  if (tokenCount(context) > 64) {
    let low = 0;
    let high = context.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (tokenCount(context.slice(0, mid)) <= 64) low = mid;
      else high = mid - 1;
    }
    context = context.slice(0, low);
  }
  return `${context}\n${text}`;
}

export interface ChunkedPassage {
  readonly start: number;
  readonly end: number;
  readonly heading: string | null;
}

export function chunkPassages(text: string, title: string): ChunkedPassage[] {
  let start = text.length - frontMatter(text).body.length;
  let position = start;
  const headings: { at: number; label: string }[] = [];
  for (const block of Lexer.lex(text.slice(start))) {
    if (block.type === "heading") {
      headings.push({ at: position, label: (block as { text: string }).text });
    }
    position += block.raw.length;
  }

  const result: ChunkedPassage[] = [];
  while (start < text.length) {
    let end = Math.min(text.length, start + 1800);
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;

    while (tokenCount(text.slice(start, end)) > 320) {
      let n = start + Math.floor((end - start) * 0.85);
      if (n <= start) n = start + 1;
      if (/[\uDC00-\uDFFF]/.test(text[n])) n--;
      end = Math.max(start + 1, n);
    }

    if (end < text.length) {
      const para = text.lastIndexOf("\n\n", end);
      if (para > start + (end - start) / 2) end = para + 2;
    }

    const heading = headings.filter((h) => h.at <= start).at(-1)?.label ?? null;
    while (tokenCount(embeddingText(title, heading, text.slice(start, end))) > 480 && end > start + 2) {
      end--;
    }
    if (/[\uDC00-\uDFFF]/.test(text[end])) end--;

    if (text.slice(start, end).trim()) {
      result.push({ start, end, heading });
    }
    start = end;
  }
  return result;
}

export function encodeVectorBlob(vec: readonly number[]): Uint8Array {
  const f32 = new Float32Array(vec);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function decodeVectorBlob(blob: Uint8Array | Buffer): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

interface OrtSession {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dispose(): void }>>;
  release(): Promise<void>;
}

let queue: Promise<unknown> = Promise.resolve();
let activeSession: OrtSession | null = null;
let activeSessionPath: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task);
  queue = next.catch(() => {});
  return next;
}

async function verifiedAsset(path: string, asset: { bytes: number; sha256: string }): Promise<boolean> {
  try {
    const bytes = await readFile(path);
    return bytes.length === asset.bytes && sha256Hex(bytes) === asset.sha256;
  } catch {
    return false;
  }
}

export async function installModelAssets(stateDir: string, signal?: AbortSignal): Promise<string> {
  const base = join(stateDir, "search/models", manifest.revision);
  for (const asset of manifest.files) {
    signal?.throwIfAborted();
    const path = join(base, asset.path);
    if (await verifiedAsset(path, asset)) continue;
    await mkdir(dirname(path), { recursive: true });
    const response = await fetch(asset.url, { signal });
    if (!response.ok) throw new Error(`Model asset download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.bytes || sha256Hex(bytes) !== asset.sha256) {
      throw new Error(`Model asset integrity check failed: ${asset.path}`);
    }
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, bytes, { mode: 0o600 });
      signal?.throwIfAborted();
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  return join(base, "onnx/model_quantized.onnx");
}

export function embedText(stateDir: string, text: string, signal?: AbortSignal): Promise<number[]> {
  return serialized(async () => {
    signal?.throwIfAborted();
    if (idleTimer) clearTimeout(idleTimer);
    assertSupportedPlatform();
    const path = join(stateDir, "search/models", manifest.revision, "onnx/model_quantized.onnx");
    if (!activeSession || activeSessionPath !== path) {
      await installModelAssets(stateDir, signal);
    }
    const runtime = (await import(RUNTIME)) as {
      default?: { InferenceSession: { create: Function }; Tensor: new (...args: unknown[]) => { dispose(): void } };
      InferenceSession?: { create: Function };
      Tensor?: new (...args: unknown[]) => { dispose(): void };
    };
    const ort = runtime.default ?? runtime;
    if (!activeSession || activeSessionPath !== path) {
      await activeSession?.release();
      activeSession = null;
      activeSession = (await ort.InferenceSession!.create(path, {
        executionProviders: ["cpu"],
        intraOpNumThreads: 4,
        interOpNumThreads: 1,
      })) as OrtSession;
      activeSessionPath = path;
    }

    const encoded = tokenizer.encode(text);
    if (encoded.ids.length > 480) throw new Error("Embedding input exceeds 480 tokens");
    const n = encoded.ids.length;
    const feeds: Record<string, { dispose(): void }> = {
      input_ids: new ort.Tensor!("int64", BigInt64Array.from(encoded.ids, BigInt), [1, n]),
      attention_mask: new ort.Tensor!("int64", BigInt64Array.from(encoded.attention_mask, BigInt), [1, n]),
    };
    if (activeSession.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = new ort.Tensor!("int64", new BigInt64Array(n), [1, n]);
    }

    let output: Record<string, { data: Float32Array; dispose(): void }> | undefined;
    try {
      output = await activeSession.run(feeds);
      signal?.throwIfAborted();
      const tensor = output.last_hidden_state ?? Object.values(output)[0];
      const vec = Array.from(tensor.data.slice(0, MODEL.dimensions));
      const norm = Math.hypot(...vec);
      if (!Number.isFinite(norm) || !norm) throw new Error("Invalid embedding");
      return vec.map((x) => x / norm);
    } finally {
      for (const t of Object.values(output ?? {})) t.dispose();
      for (const t of Object.values(feeds)) t.dispose();
      idleTimer = setTimeout(() => {
        void serialized(async () => {
          await activeSession?.release();
          activeSession = null;
          activeSessionPath = null;
        });
      }, 60_000);
      idleTimer.unref();
    }
  });
}

export async function cleanupSearchTemps(stateDir: string): Promise<void> {
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const match = /\.(\d+)\.[0-9a-f-]{36}\.tmp$/.exec(entry.name);
        if (!match) continue;
        try {
          process.kill(Number(match[1]), 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ESRCH") {
            await rm(full, { force: true }).catch(() => {});
          }
        }
      }
    }
  }
  await walk(join(stateDir, "search"));
}
