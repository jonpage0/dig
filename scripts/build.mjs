import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { Script } from 'node:vm';
import { ALL_MODULES, MODULES, moduleEnvironment } from '../src/providers/modules.ts';
import { GLYPHS, tileSvg } from '../src/glyphs.mjs';
import { VERSION } from '../src/version.mjs';
import { logoSprite } from './logo-sprite.mjs';

for (const manifest of ['package.json', 'plugin/.codex-plugin/plugin.json']) {
  const { version } = JSON.parse(await readFile(manifest, 'utf8'));
  if (version !== VERSION) throw new Error(`${manifest} is version ${version}; src/version.mjs is ${VERSION}`);
}

await mkdir('plugin/dist', { recursive: true });
// Skill icons (agents/openai.yaml icon_small/icon_large) are generated from the one glyph table.
await mkdir('plugin/assets/skills', { recursive: true });
for (const name of Object.keys(GLYPHS)) await writeFile(`plugin/assets/skills/${name}.svg`, tileSvg(name));
// Every package the bundles include, by its node_modules root, so its license travels with the plugin.
const bundled = new Set();
const collectInput = input => { const clean = input.replace(/^\0/, '').split('?')[0]; const at = clean.lastIndexOf('node_modules/'); if (at < 0) return; const name = /^((?:@[^/]+\/)?[^/]+)/.exec(clean.slice(at + 13))[1]; const root = `${clean.slice(0, at)}node_modules/${name}`; bundled.add(root.startsWith('/') ? relative(process.cwd(), root) : root); };
const collect = result => { for (const input of Object.keys(result.metafile.inputs)) collectInput(input); };
collect(await build({ entryPoints: ['src/server.mjs'], outfile: 'plugin/dist/server.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true, banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } }));
const hostStylesUrl = new URL(import.meta.resolve('@openai/mcp-extensions/app/styles.css'));
// Each MCP App remains one self-contained HTML resource. Vite handles React and
// Tailwind; final packaging refuses extra chunks or separately served assets.
const logoFiles = (await readdir('src/logos')).filter(file => file.endsWith('.svg')).sort();
for (const m of MODULES) if (m.logo && !logoFiles.includes(`${m.logo}.svg`)) throw new Error(`${m.id} names logo ${m.logo}, which src/logos lacks`);
const sprite = logoSprite(await Promise.all(logoFiles.map(async file => ({ name: file.slice(0, -4), svg: await readFile(`src/logos/${file}`, 'utf8') }))));
// README logos: each brand logo on the light tile the Sources page uses, so dark logos stay visible in GitHub's dark theme.
await mkdir('docs/logos', { recursive: true });
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
  await writeFile(`plugin/dist/${surface}.html`, html);
}
await writeFile('plugin/LICENSE', await readFile('LICENSE', 'utf8'));
await writeFile('plugin/OpenAI-MCP-Extensions-LICENSE', await readFile(new URL('./LICENSE', hostStylesUrl)));
await writeFile('plugin/ReUI-LICENSE', await readFile('src/frontend/shared/ReUI-LICENSE.md'));
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
  else throw new Error(`${pkg.name} is bundled but ships no license file; its notice must travel with the plugin`);
  notices.push(`## ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license ?? 'see below'}\n\n\`\`\`\`text\n${text.replace(/[ \t]+$/gm, '')}\n\`\`\`\`\n`);
}
await writeFile('plugin/THIRD_PARTY_NOTICES.md', `# Third-party notices\n\nDig's bundled server and views include code from the packages below, under their own licenses. Dig itself is MIT-licensed (LICENSE).\n\nThe selected ReUI Base UI Timeline component is MIT-licensed by Keenthemes Inc; its notice ships as ReUI-LICENSE. Its source provenance is documented in src/frontend/shared/THIRD_PARTY.md in the repository.\n\n${notices.join('\n')}`);
await writeFile('plugin/.mcp.json', `${JSON.stringify({ mcpServers: { dig: {
  command: 'node', args: ['./dist/server.mjs'], cwd: '.', startup_timeout_sec: 30, tool_timeout_sec: 600,
  env_vars: ['DIG_STATE_DIR', 'PAPER_SEARCH_MCP_ENV_FILE', ...moduleEnvironment(ALL_MODULES)],
} } }, null, 2)}\n`);
console.log('Built standalone server, native library and saved-research card resources.');
