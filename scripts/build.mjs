import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { SOURCES } from '../src/sources/index.ts';
import { VERSION } from '../src/version.ts';
import { logoSprite } from './logo-sprite.mjs';
import { wrapperFiles } from './wrappers.mjs';
import { buildSearchRuntime, SUPPORTED_PLATFORMS } from './search-runtime.mjs';

// The files that carry Dig's version besides src/version.ts; the host wrappers take theirs from it.
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
for (const [file, version] of [
  ['package.json', JSON.parse(await readFile('package.json', 'utf8')).version],
  ['package-lock.json', lock.version],
  ['package-lock.json (packages[""])', lock.packages?.['']?.version],
]) {
  if (version !== VERSION) throw new Error(`${file} is version ${version}; src/version.ts is ${VERSION}`);
}

const searchRuntime = await buildSearchRuntime();
if (!searchRuntime.supported) {
  console.log(
    `Skipped packaging native ONNX search runtime binaries and load check: supported platforms are ${SUPPORTED_PLATFORMS.join(', ')}, not ${searchRuntime.platform}.`,
  );
}

// Every package the bundles include, by its node_modules root, so its license travels with the package.
const bundled = new Set();
const collectInput = input => {
  const clean = input.replace(/^\0/, '').split('?')[0];
  const at = clean.lastIndexOf('node_modules/');
  if (at < 0) return;
  const match = /^((?:@[^/]+\/)?[^/]+)/.exec(clean.slice(at + 13));
  if (!match) return;
  const root = `${clean.slice(0, at)}node_modules/${match[1]}`;
  bundled.add(root.startsWith('/') ? relative(process.cwd(), root) : root);
};
const collect = result => {
  for (const input of Object.keys(result.metafile.inputs)) collectInput(input);
};

// The `dig` command (the service, stdio front, CLI and interactive setup TUI), runnable as plain Node.
await mkdir('dist', { recursive: true });
await rm('dist/library.html', { force: true });
await rm('dist/card.html', { force: true });
collect(
  await build({
    entryPoints: ['src/service/cli.ts'],
    outfile: 'dist/dig.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node:sqlite'],
    metafile: true,
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __digCreateRequire } from 'node:module'; const require = __digCreateRequire(import.meta.url);",
    },
  }),
);
await chmod('dist/dig.mjs', 0o755);

// Brand logos: validated SVG sprite injected into the localhost Web SPA and light tiles for README.md.
const logoFiles = (await readdir('src/logos')).filter(file => file.endsWith('.svg')).sort();
for (const source of SOURCES) {
  if (source.logo && !logoFiles.includes(`${source.logo}.svg`)) {
    throw new Error(`${source.id} names logo ${source.logo}, which src/logos lacks`);
  }
}
const sprite = logoSprite(
  await Promise.all(
    logoFiles.map(async file => ({
      name: file.slice(0, -4),
      svg: await readFile(`src/logos/${file}`, 'utf8'),
    })),
  ),
);

await mkdir('docs/logos', { recursive: true });
for (const file of await readdir('docs/logos')) if (file.endsWith('.svg')) await rm(`docs/logos/${file}`);
for (const file of logoFiles) {
  const logo = (await readFile(`src/logos/${file}`, 'utf8'))
    .trim()
    .replace(/^<\?xml[^>]*\?>\s*/, '')
    .replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  if (!/^<svg\b[^>]*\bviewBox=/.test(logo)) {
    throw new Error(`src/logos/${file} needs a viewBox to scale onto its README tile`);
  }
  const inner = logo.replace(
    /^<svg\b([^>]*)>/,
    (_, attrs) => `<svg x="12" y="12" width="40" height="40"${attrs.replace(/\s(?:width|height|x|y)="[^"]*"/g, '')}>`,
  );
  await writeFile(
    `docs/logos/${file}`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="0.5" y="0.5" width="63" height="63" rx="14" fill="#ffffff" stroke="#d0d7de"/>${inner}</svg>\n`,
  );
}

// Localhost React 19 Web SPA (dist/web/), served by the Dig HTTP daemon.
const webOutDir = resolve('dist/web');
await rm(webOutDir, { recursive: true, force: true });
await viteBuild({
  configFile: false,
  root: resolve('src/frontend'),
  base: '/',
  publicDir: false,
  logLevel: 'warn',
  plugins: [
    tailwindcss(),
    {
      name: 'dig-logo-sprite',
      transformIndexHtml(html) {
        return html.replace('<!--LOGO_SPRITE-->', () => sprite);
      },
    },
    {
      name: 'dig-license-and-css-guard',
      generateBundle(_, bundle) {
        for (const input of this.getModuleIds()) collectInput(input);
        for (const item of Object.values(bundle)) {
          if (item.type === 'asset' && item.fileName.endsWith('.css')) {
            const css = typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString();
            if (/@import\s|url\(\s*["']?(?:https?:|\/\/)/i.test(css)) {
              throw new Error(`Web SPA CSS requires an external resource (${item.fileName})`);
            }
          }
        }
      },
    },
  ],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: webOutDir,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    minify: true,
    copyPublicDir: false,
    rolldownOptions: {
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
      },
    },
  },
});

const builtIndex = await readFile(resolve(webOutDir, 'index.html'), 'utf8');
if (builtIndex.includes('<!--LOGO_SPRITE-->') || !builtIndex.includes('<svg class="logo-sprite"')) {
  throw new Error('dist/web/index.html did not receive the validated SVG logo sprite');
}

// Notices sit at the package root, beside LICENSE and Lucide-LICENSE.
await writeFile('ReUI-LICENSE', await readFile('src/frontend/shared/ReUI-LICENSE.md'));
// Tailwind transforms its stylesheet before Vite's JS module inventory sees it.
collectInput('node_modules/tailwindcss/index.css');
// The MIT permission text, from Dig's own MIT license, for a bundled MIT package that ships no license file.
const MIT_TERMS = (await readFile('LICENSE', 'utf8')).split('\n').slice(4).join('\n').trim();
const authorOf = pkg => (typeof pkg.author === 'string' ? pkg.author : pkg.author?.name)?.replace(/\s*[<(].*$/, '').trim();
const notices = [];
for (const root of [...bundled].sort()) {
  const pkg = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  const files = (await readdir(root)).filter(file => /^(licen[cs]e|copying|notice)/i.test(file)).sort();
  let text;
  if (files.length) {
    text = (await Promise.all(files.map(file => readFile(`${root}/${file}`, 'utf8')))).map(t => t.trim()).join('\n\n');
  } else if (pkg.license === 'MIT' && authorOf(pkg)) {
    text = `The package ships no license file; its package.json declares MIT, by ${authorOf(pkg)}.\n\nCopyright (c) ${authorOf(pkg)}\n\n${MIT_TERMS}`;
  } else {
    throw new Error(`${pkg.name} is bundled but ships no license file; its notice must travel with the package`);
  }
  notices.push(`## ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license ?? 'see below'}\n\n\`\`\`\`text\n${text.replace(/[ \t]+$/gm, '')}\n\`\`\`\`\n`);
}
await writeFile(
  'THIRD_PARTY_NOTICES.md',
  `# Third-party notices\n\nDig's bundled service (dist/dig.mjs) and web application (dist/web/) include code from the packages below, under their own licenses. Dig itself is MIT-licensed (LICENSE).\n\nLocal semantic search additionally uses ONNX Runtime Node/Common 1.30.0 (Microsoft, MIT); Search-Runtime-LICENSE and Search-Runtime-ThirdPartyNotices.txt carry its runtime notices. Supported packaged native bindings are macOS arm64 and Linux x64 (the active build platform's binding is included).\n\nThe selected ReUI Base UI Frame, Icon Tile and Timeline components are MIT-licensed by Keenthemes Inc; their notice ships as ReUI-LICENSE. Their source provenance is documented in src/frontend/shared/THIRD_PARTY.md in the repository.\n\nDig's icon glyphs are Lucide icons (ISC License, Copyright (c) 2026 Lucide Icons and Contributors); their notice ships as Lucide-LICENSE.\n\n${notices.join('\n')}`,
);

// The host wrappers are build output: plugins/ is replaced as a whole, so nothing in it is kept by hand.
await rm('plugins', { recursive: true, force: true });
for (const [path, contents] of await wrapperFiles()) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
console.log('Built dist/dig.mjs, the localhost web SPA (dist/web/), the ONNX search runtime, and the host wrappers.');
