// The inline card Codex shows when research_save or dig_finish saves research. The save result names the file;
// the card reads its own details through the app-only saved_research tool, so the model's result stays small.
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { GLYPHS } from './glyphs.mjs';
import { $, attr, node, tag, text } from './ui/dom.mjs';
import { absTime, plural } from './ui/format.mjs';
import { VERSION } from './version.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const params = new URLSearchParams(location.search);
const preview = params.has('preview');
let app; let extensions; let saved = null; let shown = null;

async function call(name, args = {}) {
  const result = preview ? await (await fetch(`/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })).json() : await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || 'Dig could not read this research');
  return result.structuredContent ?? result;
}
function note(value, failure = false) {
  text($('note'), value); $('note').hidden = !value; $('note').className = failure ? 'note error' : 'note';
}
// The glyph is Dig's own static drawing data, built as SVG elements rather than parsed markup.
function glyph(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'glyph');
  for (const [tag, attrs] of GLYPHS[name] ?? GLYPHS.shovel) {
    const shape = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}

function render(details) {
  shown = details;
  $('tile').replaceChildren(glyph(details.glyph));
  text($('eyebrow'), details.kind === 'answer' ? 'Answer saved to Dig' : `Saved to Dig · ${details.label}`);
  text($('title'), details.title);
  text($('summary'), details.summary); $('summary').hidden = !details.summary;
  const facts = [
    details.status ? tag(details.status) : null,
    details.kind === 'answer' && details.reports?.length ? `Relies on ${details.reports.join(', ')}` : null,
    plural(details.retrievals, 'retrieval'),
    details.savedAt ? absTime(details.savedAt) : null,
  ].filter(Boolean);
  // Each fact is its own element so the flex gap spaces the separators; adjacent text nodes would merge.
  $('meta').replaceChildren(...facts.flatMap((fact, i) => {
    const item = typeof fact === 'string' ? node('span', null, fact) : fact;
    return i ? [attr(node('span', 'sep', '·'), 'aria-hidden', 'true'), item] : [item];
  }));
  $('open').hidden = !details.link;
  $('file').hidden = preview || !saved?.path || !extensions?.files;
  $('foot').hidden = false;
  $('card').setAttribute('aria-busy', 'false');
}
function failed(message) {
  $('tile').replaceChildren(glyph('shovel'));
  text($('eyebrow'), 'Dig did not save this research');
  $('card').setAttribute('aria-busy', 'false');
  note(message, true);
}
async function show(value) {
  saved = value;
  try { render(await call('saved_research', { file: value.file })); } catch (e) {
    $('tile').replaceChildren(glyph('shovel')); text($('eyebrow'), 'Saved to Dig'); $('card').setAttribute('aria-busy', 'false');
    note(`Saved, but the card cannot show its details: ${e.message}`, true);
  }
}

// Host refusals are reported in the card, never dropped silently.
$('open').onclick = async () => {
  try { const result = await app.openLink({ url: shown.link }); note(result?.isError ? 'Codex did not open Dig. Open Dig from the sidebar to read this research.' : ''); } catch (e) { note(`Unable to open Dig: ${e.message}`, true); }
};
$('file').onclick = async () => {
  try { await extensions.files.open(saved.path); note(''); } catch (e) { note(`Codex could not open the file: ${e.message}`, true); }
};

async function start() {
  if (preview) { await show({ file: params.get('file') }); return; }
  app = new App({ name: 'Dig saved research', version: VERSION }); extensions = new OpenAIExtensions(app);
  const apply = context => { if (context?.theme) applyDocumentTheme(context.theme); if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables); };
  app.ontoolresult = result => {
    const value = result.structuredContent;
    if (result.isError || !value?.file) failed(result.content?.find(c => c.type === 'text')?.text || 'The save did not complete.');
    else show(value);
  };
  app.addEventListener('hostcontextchanged', apply);
  await app.connect(); apply(app.getHostContext());
}
start().catch(e => note(e.message, true));
