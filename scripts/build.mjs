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
await build({ entryPoints: ['src/server.mjs'], outfile: 'plugin/dist/server.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
const hostStylesUrl = new URL(import.meta.resolve('@openai/mcp-extensions/app/styles.css'));
const hostStyles = await readFile(hostStylesUrl, 'utf8');
// Each MCP App is one self-contained HTML resource: the shared OpenAI stylesheet plus its bundled script.
const logoFiles = (await readdir('src/logos')).filter(file => file.endsWith('.svg')).sort();
for (const m of MODULES) if (m.logo && !logoFiles.includes(`${m.logo}.svg`)) throw new Error(`${m.id} names logo ${m.logo}, which src/logos lacks`);
const sprite = logoSprite(await Promise.all(logoFiles.map(async file => ({ name: file.slice(0, -4), svg: await readFile(`src/logos/${file}`, 'utf8') }))));
for (const [entry, page, out] of [['src/app.mjs', 'src/library.html', 'plugin/dist/library.html'], ['src/card.mjs', 'src/card.html', 'plugin/dist/card.html']]) {
  const ui = await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false });
  const html = (await readFile(page, 'utf8'))
    .replace('/*OPENAI_STYLES*/', () => hostStyles)
    .replace('<!--LOGO_SPRITE-->', () => sprite)
    .replace('<!--APP_SCRIPT-->', () => `<script>${ui.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  await writeFile(out, html);
}
await writeFile('plugin/LICENSE', await readFile('LICENSE', 'utf8'));
await writeFile('plugin/OpenAI-MCP-Extensions-LICENSE', await readFile(new URL('./LICENSE', hostStylesUrl)));
await writeFile('plugin/.mcp.json', `${JSON.stringify({ mcpServers: { dig: {
  command: 'node', args: ['./dist/server.mjs'], cwd: '.', startup_timeout_sec: 30, tool_timeout_sec: 600,
  env_vars: ['DIG_STATE_DIR', 'PAPER_SEARCH_MCP_ENV_FILE', ...moduleEnvironment(ALL_MODULES)],
} } }, null, 2)}\n`);
console.log('Built standalone server, native library and saved-research card resources.');
