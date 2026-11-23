import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { Script } from 'node:vm';
import { MODULES } from '../src/providers/modules.ts';
import { VERSION } from '../src/version.mjs';
import { logoSprite } from './logo-sprite.mjs';
import { wrapperFiles } from './wrappers.mjs';
import { buildSearchRuntime, SUPPORTED_PLATFORMS } from './search-runtime.mjs';

// The files that carry Dig's version besides src/version.mjs; the host wrappers take theirs from it.
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
for (const [file, version] of [['package.json', JSON.parse(await readFile('package.json', 'utf8')).version], ['package-lock.json', lock.version], ['package-lock.json (packages[""])', lock.packages?.['']?.version]]) {
  if (version !== VERSION) throw new Error(`${file} is version ${version}; src/version.mjs is ${VERSION}`);
}

const searchRuntime = await buildSearchRuntime();
if (!searchRuntime.supported) console.log(`Skipped packaging native ONNX search runtime binaries and load check: supported platforms are ${SUPPORTED_PLATFORMS.join(', ')}, not ${searchRuntime.platform}.`);
// Every package the bundles include, by its node_modules root, so its license travels with the package.
const bundled = new Set();
const collectInput = input => { const clean = input.replace(/^\0/, '').split('?')[0]; const at = clean.lastIndexOf('node_modules/'); if (at < 0) return; const name = /^((?:@[^/]+\/)?[^/]+)/.exec(clean.slice(at + 13))[1]; const root = `${clean.slice(0, at)}node_modules/${name}`; bundled.add(root.startsWith('/') ? relative(process.cwd(), root) : root); };
const collect = result => { for (const input of Object.keys(result.metafile.inputs)) collectInput(input); };
// The `dig` command (the service and its stdio front), runnable as plain Node without the TypeScript loader.
await mkdir('dist', { recursive: true });
collect(await build({ entryPoints: ['src/service/cli.ts'], outfile: 'dist/dig.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true, banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } }));
await chmod('dist/dig.mjs', 0o755);
const hostStylesUrl = new URL(import.meta.resolve('@openai/mcp-extensions/app/styles.css'));
// Each MCP App remains one self-contained HTML resource. Vite handles React and
// Tailwind; final packaging refuses extra chunks or separately served assets.
const logoFiles = (await readdir('src/logos')).filter(file => file.endsWith('.svg')).sort();
for (const m of MODULES) if (m.logo && !logoFiles.includes(`${m.logo}.svg`)) throw new Error(`${m.id} names logo ${m.logo}, which src/logos lacks`);
const sprite = logoSprite(await Promise.all(logoFiles.map(async file => ({ name: file.slice(0, -4), svg: await readFile(`src/logos/${file}`, 'utf8') }))));
// README logos: each brand logo on the light tile the Sources page uses, so dark logos stay visible in GitHub's dark theme.
await mkdir('docs/logos', { recursive: true });
for (const file of await readdir('docs/logos')) if (file.endsWith('.svg')) await rm(`docs/logos/${file}`);
for (const file of logoFiles) {
  // Exported logos may open with an XML declaration and comments; the tile nests the logo's own <svg>.
  const logo = (await readFile(`src/logos/${file}`, 'utf8')).trim().replace(/^<\?xml[^>]*\?>\s*/, '').replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  if (!/^<svg\b[^>]*\bviewBox=/.test(logo)) throw new Error(`src/logos/${file} needs a viewBox to scale onto its README tile`);
  const inner = logo.replace(/^<svg\b([^>]*)>/, (_, attrs) => `<svg x="12" y="12" width="40" height="40"${attrs.replace(/\s(?:width|height|x|y)="[^"]*"/g, '')}>`);
  await writeFile(`docs/logos/${file}`, `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="0.5" y="0.5" width="63" height="63" rx="14" fill="#ffffff" stroke="#d0d7de"/>${inner}</svg>\n`);
}
for (const surface of ['library', 'card']) {
  const ui = await viteBuild({
    configFile: false, publicDir: false, logLevel: 'warn',
    plugins: [tailwindcss(), { name: 'dig-license-inputs', generateBundle() { for (const input of this.getModuleIds()) collectInput(input); } }],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      lib: { entry: `src/frontend/${surface}.tsx`, name: surface === 'library' ? 'DigLibrary' : 'DigCard', formats: ['iife'] },
      target: 'es2022', write: false, sourcemap: false, minify: true,
      cssCodeSplit: false, modulePreload: false, copyPublicDir: false,
      rolldownOptions: {
        // Every entry is a browser-only app; React Server Component markers have
        // no runtime meaning here. Keep all other bundler warnings visible.
        onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); },
        output: { codeSplitting: false },
      },
    },
  });
  const output = Array.isArray(ui) ? ui.flatMap(result => result.output) : ui.output;
  const chunks = output.filter(file => file.type === 'chunk');
  const assets = output.filter(file => file.type === 'asset');
  // Rolldown records an inlined dynamic import as an edge back to its own chunk.
  // The generated code resolves that edge in memory; all other edges are refused.
  if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.some(file => file !== chunks[0].fileName)) throw new Error(`${surface} must be a single self-contained script: ${JSON.stringify(chunks.map(({ fileName, imports, dynamicImports }) => ({ fileName, imports, dynamicImports })))}`);
  if (assets.some(file => !file.fileName.endsWith('.css'))) throw new Error(`${surface} emits an external asset; embed it in the package HTML instead`);
  const css = assets.map(file => typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString()).join('\n');
  if (/@import\s|url\(\s*["']?(?:https?:|\/\/|\/assets\/)/i.test(css)) throw new Error(`${surface} CSS requires a separately loaded resource`);
  const page = `src/frontend/${surface}.html`;
  const html = (await readFile(page, 'utf8'))
    .replace('<!--APP_STYLES-->', () => `<style>${css}</style>`)
    .replace('<!--LOGO_SPRITE-->', () => sprite)
    .replace('<!--APP_SCRIPT-->', () => `<script>${chunks[0].code.replace(/<\/script/gi, '<\\/script')}</script>`);
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  // The service serves the page, as an MCP App and in a browser, from beside its own bundle.
  await writeFile(`dist/${surface}.html`, html);
}
// The notices sit at the package root, beside LICENSE and Lucide-LICENSE.
await writeFile('OpenAI-MCP-Extensions-LICENSE', await readFile(new URL('./LICENSE', hostStylesUrl)));
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
  if (files.length) text = (await Promise.all(files.map(file => readFile(`${root}/${file}`, 'utf8')))).map(t => t.trim()).join('\n\n');
  else if (pkg.license === 'MIT' && authorOf(pkg)) text = `The package ships no license file; its package.json declares MIT, by ${authorOf(pkg)}.\n\nCopyright (c) ${authorOf(pkg)}\n\n${MIT_TERMS}`;
  else throw new Error(`${pkg.name} is bundled but ships no license file; its notice must travel with the package`);
  notices.push(`## ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license ?? 'see below'}\n\n\`\`\`\`text\n${text.replace(/[ \t]+$/gm, '')}\n\`\`\`\`\n`);
}
await writeFile('THIRD_PARTY_NOTICES.md', `# Third-party notices\n\nDig's bundled service (dist/dig.mjs) and views include code from the packages below, under their own licenses. Dig itself is MIT-licensed (LICENSE).\n\nLocal semantic search additionally uses ONNX Runtime Node/Common 1.30.0 (Microsoft, MIT); Search-Runtime-LICENSE and Search-Runtime-ThirdPartyNotices.txt carry its runtime notices. Supported packaged native bindings are macOS arm64 and Linux x64 (the active build platform's binding is included).\n\nThe selected ReUI Base UI Frame, Icon Tile and Timeline components are MIT-licensed by Keenthemes Inc; their notice ships as ReUI-LICENSE. Their source provenance is documented in src/frontend/shared/THIRD_PARTY.md in the repository.\n\nDig's icon glyphs are Lucide icons (ISC License, Copyright (c) 2026 Lucide Icons and Contributors); their notice ships as Lucide-LICENSE.\n\n${notices.join('\n')}`);
// The host wrappers are build output: plugins/ is replaced as a whole, so nothing in it is kept by hand.
await rm('plugins', { recursive: true, force: true });
for (const [path, contents] of await wrapperFiles()) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }
console.log('Built the dig command, the library and saved-research card views, and the host wrappers.');
