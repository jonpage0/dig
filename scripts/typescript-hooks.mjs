// Development-only Node hooks: esbuild strips TypeScript, and relative
// `./x.js` imports resolve to their source `./x.ts` files. The installed
// server is already bundled and never loads this.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('.ts') && /^\.\.?\//.test(specifier) && specifier.endsWith('.js')) {
    const source = new URL(`${specifier.slice(0, -'.js'.length)}.ts`, context.parentURL);
    if (existsSync(source)) return { url: source.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);
  const file = fileURLToPath(url);
  const { code } = await transform(await readFile(file, 'utf8'), { loader: 'ts', format: 'esm', target: 'node22', sourcefile: file, sourcemap: 'inline' });
  return { format: 'module', source: code, shortCircuit: true };
}
