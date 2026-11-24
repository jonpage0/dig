import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildSearchRuntime, selectPlatformFiles } from "../scripts/search-runtime.mjs";
import {
  RUNTIME,
  SUPPORTED_PLATFORMS,
  assertSupportedPlatform,
  chunkPassages,
  embeddingText,
  isSupportedPlatform,
  tokenCount,
} from "../src/core/search-onnx.ts";

test("packaged search runtime resolves dynamically from src/core and dist/dig.mjs and loads on supported hosts", async () => {
  const packaged = pathToFileURL(join(process.cwd(), "runtime/dist/onnx.cjs")).href;
  assert.equal(RUNTIME, packaged);
  assert.equal(
    new URL("../runtime/dist/onnx.cjs", pathToFileURL(join(process.cwd(), "dist/dig.mjs"))).href,
    packaged,
    "dist/dig.mjs looks one folder up",
  );
  assert.ok(existsSync(new URL(packaged)));
  const bundle = await readFile(new URL(packaged), "utf8");
  assert.match(bundle, /process\.platform,\s*process\.arch,\s*['"]onnxruntime_binding\.node['"]/);
  assert.equal(bundle.includes("darwin/arm64/onnxruntime_binding.node"), false);
  if (isSupportedPlatform()) {
    const runtime = (await import(RUNTIME)) as {
      default?: { InferenceSession?: { create?: unknown } };
      InferenceSession?: { create?: unknown };
    };
    assert.equal(typeof (runtime.default ?? runtime).InferenceSession?.create, "function");
  }
});

test("local semantic search supports darwin/arm64 and linux/x64 and rejects other platforms clearly", () => {
  assert.deepEqual([...SUPPORTED_PLATFORMS], ["darwin/arm64", "linux/x64"]);
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["linux", "x64"],
  ] as const) {
    assert.equal(isSupportedPlatform(platform, arch), true, `${platform}/${arch}`);
    assert.doesNotThrow(() => assertSupportedPlatform(platform, arch));
  }
  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ] as const) {
    assert.equal(isSupportedPlatform(platform, arch), false, `${platform}/${arch}`);
    assert.throws(
      () => assertSupportedPlatform(platform, arch),
      new RegExp(`macOS arm64 and Linux x64.*${platform}/${arch}.*Keyword search remains available`),
    );
  }
});

test("passages cover long Unicode/code content without token truncation or surrogate splits", () => {
  const text = "---\ntitle: \"meta\"\n---\n# Heading\n" + "😀 OAuth42/漢字 `.config`\n".repeat(1000);
  const passages = chunkPassages(text, "title");
  assert.ok(passages.length > 10);
  for (const passage of passages) {
    assert.ok(tokenCount(embeddingText("title", passage.heading, text.slice(passage.start, passage.end))) <= 480);
    assert.ok(!/[\uDC00-\uDFFF]/.test(text[passage.start] ?? ""));
  }
  for (let i = text.indexOf("# Heading"); i < text.length; i++) {
    if (text[i]?.trim()) {
      assert.ok(passages.some((p) => p.start <= i && i < p.end));
    }
  }
});

test("search-runtime packages darwin/arm64 and linux/x64 bindings dynamically, preserves linux .so symlinks, and skips unsupported platforms", async (t) => {
  assert.deepEqual(
    selectPlatformFiles("darwin/arm64", [
      "onnxruntime_binding.node",
      "libonnxruntime.1.dylib",
      "libonnxruntime.1.30.0.dylib",
      "other.dylib",
    ]),
    {
      binding: ["onnxruntime_binding.node"],
      libs: ["libonnxruntime.1.dylib"],
    },
  );
  assert.deepEqual(
    selectPlatformFiles("linux/x64", [
      "onnxruntime_binding.node",
      "libonnxruntime.so.1",
      "libonnxruntime.so.1.30.0",
      "libonnxruntime.so",
      "README.txt",
    ]),
    {
      binding: ["onnxruntime_binding.node"],
      libs: ["libonnxruntime.so", "libonnxruntime.so.1", "libonnxruntime.so.1.30.0"],
    },
  );
  assert.deepEqual(selectPlatformFiles("win32/x64", ["onnxruntime_binding.node", "onnxruntime.dll"]), {
    binding: [],
    libs: [],
  });

  const root = await mkdtemp(join(tmpdir(), "dig-search-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const linuxOut = join(root, "linux-real");
  const linuxResult = await buildSearchRuntime({
    root: linuxOut,
    packageRoot: process.cwd(),
    platform: "linux",
    arch: "x64",
    checkLoad: false,
    writeNotices: false,
  });
  assert.deepEqual(linuxResult, {
    supported: true,
    platform: "linux/x64",
    copied: ["onnxruntime_binding.node", "libonnxruntime.so.1"],
    loadChecked: false,
  });
  assert.deepEqual((await readdir(join(linuxOut, "runtime/bin/napi-v6/linux/x64"))).sort(), [
    "libonnxruntime.so.1",
    "onnxruntime_binding.node",
  ]);
  const onnxBundle = await readFile(join(linuxOut, "runtime/dist/onnx.cjs"), "utf8");
  assert.match(onnxBundle, /process\.platform,\s*process\.arch,\s*['"]onnxruntime_binding\.node['"]/);
  assert.equal(onnxBundle.includes("darwin/arm64/onnxruntime_binding.node"), false);

  const fakeBins = join(root, "fake-bins");
  const fakeLinux = join(fakeBins, "linux/x64");
  await mkdir(fakeLinux, { recursive: true });
  await writeFile(join(fakeLinux, "onnxruntime_binding.node"), "fake-binding");
  await writeFile(join(fakeLinux, "libonnxruntime.so.1.30.0"), "fake-so-binary");
  await symlink("libonnxruntime.so.1.30.0", join(fakeLinux, "libonnxruntime.so.1"));
  const symOut = join(root, "linux-symlink");
  const symResult = await buildSearchRuntime({
    root: symOut,
    packageRoot: process.cwd(),
    binRoot: fakeBins,
    platform: "linux",
    arch: "x64",
    checkLoad: false,
    writeNotices: false,
  });
  assert.deepEqual(symResult.copied, ["onnxruntime_binding.node", "libonnxruntime.so.1", "libonnxruntime.so.1.30.0"]);
  const copiedLink = join(symOut, "runtime/bin/napi-v6/linux/x64/libonnxruntime.so.1");
  assert.equal((await lstat(copiedLink)).isSymbolicLink(), true);
  assert.equal(await readlink(copiedLink), "libonnxruntime.so.1.30.0");

  const macOut = join(root, "darwin-real");
  const macResult = await buildSearchRuntime({
    root: macOut,
    packageRoot: process.cwd(),
    platform: "darwin",
    arch: "arm64",
    checkLoad: false,
    writeNotices: false,
  });
  assert.deepEqual(macResult, {
    supported: true,
    platform: "darwin/arm64",
    copied: ["onnxruntime_binding.node", "libonnxruntime.1.dylib"],
    loadChecked: false,
  });
  assert.deepEqual((await readdir(join(macOut, "runtime/bin/napi-v6/darwin/arm64"))).sort(), [
    "libonnxruntime.1.dylib",
    "onnxruntime_binding.node",
  ]);

  const winOut = join(root, "win-skip");
  const winResult = await buildSearchRuntime({
    root: winOut,
    packageRoot: process.cwd(),
    platform: "win32",
    arch: "x64",
    writeNotices: false,
  });
  assert.deepEqual(winResult, { supported: false, platform: "win32/x64", copied: [], loadChecked: false });
  assert.deepEqual((await readdir(join(winOut, "runtime"))).sort(), ["dist"]);
});
