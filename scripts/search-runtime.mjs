import { build } from 'esbuild';
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_PLATFORMS = Object.freeze(['darwin/arm64', 'linux/x64']);
export const isSupportedPlatform = (platform = process.platform, arch = process.arch) => SUPPORTED_PLATFORMS.includes(`${platform}/${arch}`);

/** Selects onnxruntime_binding.node and the platform's shared libs from a platform bin folder. */
export function selectPlatformFiles(platformKey, entries) {
  const binding = entries.includes('onnxruntime_binding.node') ? ['onnxruntime_binding.node'] : [];
  if (platformKey === 'darwin/arm64') {
    const libs = entries.filter(name => name === 'libonnxruntime.1.dylib').sort();
    return { binding, libs };
  }
  if (platformKey === 'linux/x64') {
    const libs = entries.filter(name => /^libonnxruntime\.so(?:\.|$)/.test(name)).sort();
    return { binding, libs };
  }
  return { binding: [], libs: [] };
}

async function copyPreservingSymlink(src, dest) {
  const info = await lstat(src);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(src), dest);
  } else {
    await cp(src, dest);
  }
}

/**
 * Packages the local ONNX search runtime into `<root>/runtime/` and writes its notices.
 * Resolves the native binding path dynamically for `${process.platform}/${process.arch}` inside
 * `runtime/dist/onnx.cjs`. On supported platforms (`darwin/arm64`, `linux/x64`), copies the native
 * binding and platform shared libraries (preserving symlinks/versions on Linux) and runs the load check
 * when building for the current host. Skips native binary copy and load check on other platforms.
 */
export async function buildSearchRuntime({
  root = process.cwd(),
  packageRoot = root,
  binRoot = join(packageRoot, 'node_modules/onnxruntime-node/bin/napi-v6'),
  platform = process.platform,
  arch = process.arch,
  checkLoad = platform === process.platform && arch === process.arch,
  writeNotices = true,
} = {}) {
  const runtimeDir = join(root, 'runtime');
  const platformKey = `${platform}/${arch}`;
  // The package's runtime/, beside dist/: the bundled service (dist/dig.mjs) and src/search/engine.mjs load it from there.
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(join(runtimeDir, 'dist'), { recursive: true });
  // Keep the binding's ../bin path valid while bundling all JS dependencies, without node_modules in the package.
  const entry = join(packageRoot, 'node_modules/onnxruntime-node/dist/index.js');
  const outfile = join(runtimeDir, 'dist/onnx.cjs');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    minify: true,
    banner: {
      js: "const DIG_NATIVE_BINDING = require('node:path').join(__dirname, '../bin/napi-v6', process.platform, process.arch, 'onnxruntime_binding.node');",
    },
    plugins: [{
      name: 'fixed-cpu-binding',
      setup(b) {
        b.onLoad({ filter: /onnxruntime-node[\\/]dist[\\/]binding\.js$/ }, async args => {
          const source = await readFile(args.path, 'utf8');
          const pattern = /require\(`\.\.\/bin\/napi-v6\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/;
          if (!pattern.test(source)) throw Error('ONNX binding path changed');
          return { contents: source.replace(pattern, 'require(DIG_NATIVE_BINDING)'), loader: 'js' };
        });
      },
    }],
  });
  if (writeNotices) {
    await writeFile(join(root, 'Search-Runtime-LICENSE'), await readFile(join(packageRoot, 'src/search/ONNX-Runtime-LICENSE')));
    await writeFile(join(root, 'Search-Runtime-ThirdPartyNotices.txt'), await readFile(join(packageRoot, 'src/search/ONNX-Runtime-ThirdPartyNotices.txt')));
  }
  if (!isSupportedPlatform(platform, arch)) {
    return { supported: false, platform: platformKey, copied: [], loadChecked: false };
  }
  const srcDir = join(binRoot, platform, arch);
  const entries = await readdir(srcDir);
  const { binding, libs } = selectPlatformFiles(platformKey, entries);
  if (!binding.length || !libs.length) {
    throw Error(`Missing ONNX Runtime native files for ${platformKey} in ${srcDir} (found: ${entries.join(', ') || 'none'})`);
  }
  const destDir = join(runtimeDir, 'bin/napi-v6', platform, arch);
  await mkdir(destDir, { recursive: true });
  const copied = [...binding, ...libs];
  for (const file of copied) await copyPreservingSymlink(join(srcDir, file), join(destDir, file));
  if (checkLoad) {
    const runtime = createRequire(import.meta.url)(resolve(outfile));
    if (typeof runtime.InferenceSession?.create !== 'function') throw Error('Packaged ONNX Runtime failed its load check');
  }
  return { supported: true, platform: platformKey, copied, loadChecked: checkLoad };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSearchRuntime();
  if (!result.supported) {
    console.log(`Skipped packaging native ONNX search runtime binaries and load check: supported platforms are ${SUPPORTED_PLATFORMS.join(', ')}, not ${result.platform}.`);
  }
}
