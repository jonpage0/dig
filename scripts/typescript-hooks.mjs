// Development-only Node hooks: esbuild strips TypeScript, and relative
// `./x.js` imports resolve to their source `./x.ts` files. The installed
// server is already bundled and never loads this. The synchronous pair is for
// module.registerHooks; resolve and load wrap it for module.register.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

export function resolveSync(specifier, context, nextResolve) {
  if (/\.tsx?$/.test(context.parentURL ?? '') && /^\.\.?\//.test(specifier)) {
    const base = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier;
    for (const extension of ['.ts', '.tsx']) {
      const source = new URL(`${base}${extension}`, context.parentURL);
      if (existsSync(source)) return { url: source.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export function loadSync(url, context, nextLoad) {
  if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return nextLoad(url, context);
  const file = fileURLToPath(url);
  const { code } = transformSync(readFileSync(file, 'utf8'), { loader: url.endsWith('.tsx') ? 'tsx' : 'ts', jsx: 'automatic', format: 'esm', target: 'node22', sourcefile: file, sourcemap: 'inline' });
  return { format: 'module', source: code, shortCircuit: true };
}

export const resolve = async (specifier, context, nextResolve) => resolveSync(specifier, context, nextResolve);
export const load = async (url, context, nextLoad) => loadSync(url, context, nextLoad);
