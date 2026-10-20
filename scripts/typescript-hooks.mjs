// Development-only Node hooks: esbuild strips TypeScript, and relative
// `./x.js` imports resolve to their source `./x.ts` files. The installed
// server is already bundled and never loads this.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

export async function resolve(specifier, context, nextResolve) {
  if (/\.tsx?$/.test(context.parentURL ?? '') && /^\.\.?\//.test(specifier)) {
    const base = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier;
    for (const extension of ['.ts', '.tsx']) {
      const source = new URL(`${base}${extension}`, context.parentURL);
      if (existsSync(source)) return { url: source.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return nextLoad(url, context);
  const file = fileURLToPath(url);
  const { code } = await transform(await readFile(file, 'utf8'), { loader: url.endsWith('.tsx') ? 'tsx' : 'ts', jsx: 'automatic', format: 'esm', target: 'node22', sourcefile: file, sourcemap: 'inline' });
  return { format: 'module', source: code, shortCircuit: true };
}
