import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
const collect = result => { for (const input of Object.keys(result.metafile.inputs)) { const at = input.lastIndexOf('node_modules/'); if (at < 0) continue; const name = /^((?:@[^/]+\/)?[^/]+)/.exec(input.slice(at + 13))[1]; bundled.add(`${input.slice(0, at)}node_modules/${name}`); } };
collect(await build({ entryPoints: ['src/server.mjs'], outfile: 'plugin/dist/server.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true, banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } }));
const hostStylesUrl = new URL(import.meta.resolve('@openai/mcp-extensions/app/styles.css'));
const hostStyles = await readFile(hostStylesUrl, 'utf8');
// Each MCP App is one self-contained HTML resource: the shared OpenAI stylesheet plus its bundled script.
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
for (const [entry, page, out] of [['src/app.mjs', 'src/library.html', 'plugin/dist/library.html'], ['src/card.mjs', 'src/card.html', 'plugin/dist/card.html']]) {
  const ui = await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, metafile: true });
  collect(ui);
  const html = (await readFile(page, 'utf8'))
    .replace('/*OPENAI_STYLES*/', () => hostStyles)
    .replace('<!--LOGO_SPRITE-->', () => sprite)
    .replace('<!--APP_SCRIPT-->', () => `<script>${ui.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  await writeFile(out, html);
}
await writeFile('plugin/LICENSE', await readFile('LICENSE', 'utf8'));
await writeFile('plugin/OpenAI-MCP-Extensions-LICENSE', await readFile(new URL('./LICENSE', hostStylesUrl)));
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
  notices.push(`## ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license ?? 'see below'}\n\n\`\`\`\`text\n${text}\n\`\`\`\`\n`);
}
await writeFile('plugin/THIRD_PARTY_NOTICES.md', `# Third-party notices\n\nDig's bundled server and views include code from the packages below, under their own licenses. Dig itself is MIT-licensed (LICENSE).\n\n${notices.join('\n')}`);
await writeFile('plugin/.mcp.json', `${JSON.stringify({ mcpServers: { dig: {
  command: 'node', args: ['./dist/server.mjs'], cwd: '.', startup_timeout_sec: 30, tool_timeout_sec: 600,
  env_vars: ['DIG_STATE_DIR', 'PAPER_SEARCH_MCP_ENV_FILE', ...moduleEnvironment(ALL_MODULES)],
} } }, null, 2)}\n`);
console.log('Built standalone server, native library and saved-research card resources.');
