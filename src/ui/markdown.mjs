// Reports and answers are untrusted text. marked tokenizes the Markdown (GFM tables, emphasis, code, lists);
// this module builds DOM nodes from those tokens with an allowlist. There is no innerHTML: raw HTML in a
// report appears as literal text, only absolute http(s) links navigate, and images are never loaded.
import { Lexer } from 'marked';
import { node, attr, httpUrl, externalLink } from './dom.mjs';
import { decodeEntities } from './format.mjs';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SOURCE_CARD = /^\s*```ya?ml[^\n]*\n(source_card:[^\n]*\n[\s\S]*?)\n?```[^\n]*(?:\n|$)/;
// Markdown h1 sits below the page's h1 (Dig), h2 (the question) and h3 (the open file's name).
const HEADING_OFFSET = 3;
const MAX_HEADING = 6;

function scalar(raw) {
  const value = raw.trim();
  const double = /^"(?:[^"\\]|\\.)*"/.exec(value);
  if (double) { try { return JSON.parse(double[0]); } catch { return double[0].slice(1, -1); } }
  const single = /^'(?:[^']|'')*'/.exec(value);
  if (single) return single[0].slice(1, -1).replaceAll("''", "'");
  const bare = value.replace(/\s+#.*$/, '');
  if (bare.startsWith('[')) { try { return JSON.parse(bare); } catch { return bare; } }
  return bare === 'null' || bare === '~' ? null : bare === 'true' ? true : bare === 'false' ? false : bare;
}

/** Leading front matter: one `key: value` per line, JSON-quoted or bare, as the library writes it. */
export function frontMatter(text) {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) { const pair = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line); if (pair) meta[pair[1]] = scalar(pair[2]); }
  return { meta, body: text.slice(match[0].length) };
}

/**
 * The source skill's leading `source_card` block. Scalars and string lists are read for the summary;
 * anything else stays visible in the verbatim block (`partial` marks a card the summary could not fully read).
 */
export function sourceCard(body) {
  const match = SOURCE_CARD.exec(body);
  if (!match) return { card: null, body };
  const yaml = match[1];
  const fields = {}; const lists = {}; let list = null; let partial = false;
  for (const line of yaml.split(/\r?\n/).slice(1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const entry = /^ {2}([a-z_][a-z0-9_]*):\s*(.*)$/.exec(line);
    const item = /^ {2,}- (.*)$/.exec(line);
    if (entry) {
      list = null;
      const value = entry[2].replace(/^#.*$/, '').trim();
      if (!value) { list = lists[entry[1]] = []; continue; }
      const parsed = scalar(value);
      if (Array.isArray(parsed)) lists[entry[1]] = parsed.map(String); else fields[entry[1]] = parsed;
    } else if (item && list) {
      const parsed = scalar(item[1]);
      if (typeof parsed === 'string' || typeof parsed === 'number') list.push(String(parsed)); else partial = true;
    } else partial = true;
  }
  return { card: { fields, lists, yaml, partial }, body: body.slice(match[0].length) };
}

function inline(tokens) {
  return (tokens ?? []).map(token => {
    switch (token.type) {
      case 'text': return token.tokens ? inline(token.tokens) : decodeEntities(token.text);
      case 'escape': return token.text;
      case 'strong': return node('strong', '', inline(token.tokens));
      case 'em': return node('em', '', inline(token.tokens));
      case 'del': return node('del', '', inline(token.tokens));
      case 'codespan': return node('code', '', token.text);
      case 'br': return node('br', '');
      case 'checkbox': return attr(attr(node('span', 'task', token.checked ? '☑ ' : '☐ '), 'role', 'img'), 'aria-label', token.checked ? 'done' : 'not done');
      case 'link': return link(token);
      case 'image': return image(token);
      // Raw HTML (and anything unrecognized) is shown as the characters the report contains.
      default: return token.text ?? token.raw ?? '';
    }
  });
}
function link(token) {
  const href = httpUrl(token.href);
  const content = inline(token.tokens);
  if (href) { const anchor = externalLink(href, content); if (token.title) anchor.title = decodeEntities(token.title); return anchor; }
  // Relative paths, file: and other schemes do not navigate; the target stays readable beside the text.
  const target = typeof token.href === 'string' ? token.href.trim() : '';
  return target && !target.startsWith('#') && target !== token.text ? [content, ' ', node('code', 'link-target', target)] : content;
}
function image(token) {
  const label = `Image: ${token.text || 'untitled'}`;
  const href = httpUrl(token.href);
  return href ? externalLink(href, label) : node('span', 'image-ref', label);
}

function blocks(tokens) {
  return (tokens ?? []).map(token => {
    switch (token.type) {
      case 'space': case 'def': return null;
      case 'heading': return node(`h${Math.min(token.depth + HEADING_OFFSET, MAX_HEADING)}`, '', inline(token.tokens));
      case 'paragraph': return node('p', '', inline(token.tokens));
      case 'text': return token.tokens ? inline(token.tokens) : decodeEntities(token.text);
      case 'code': return node('pre', 'code', node('code', '', token.text));
      case 'blockquote': return node('blockquote', '', blocks(token.tokens));
      case 'list': return list(token);
      case 'table': return table(token);
      case 'hr': return node('hr', '');
      case 'checkbox': return inline([token]);
      case 'html': return node('p', 'literal-html', token.text);
      default: return node('p', '', token.raw ?? '');
    }
  });
}
function list(token) {
  const element = node(token.ordered ? 'ol' : 'ul', '', token.items.map(item => node('li', item.task ? 'task-item' : '', blocks(item.tokens))));
  if (token.ordered && typeof token.start === 'number' && token.start !== 1) element.setAttribute('start', String(token.start));
  return element;
}
function cell(tag, data, scope) {
  const element = node(tag, '', inline(data.tokens));
  if (data.align) element.setAttribute('data-align', data.align);
  if (scope) element.setAttribute('scope', scope);
  return element;
}
function table(token) {
  return node('div', 'table-scroll', node('table', '',
    node('thead', '', node('tr', '', token.header.map(data => cell('th', data, 'col')))),
    node('tbody', '', token.rows.map(row => node('tr', '', row.map(data => cell('td', data)))))));
}

/** Markdown as a DOM subtree; the caller strips front matter and the source card first. */
export function renderMarkdown(markdown) {
  return node('div', 'prose', blocks(Lexer.lex(markdown, { gfm: true })));
}

/** The first paragraph of some Markdown as plain text, for card snippets (headings and markup removed). */
export function firstParagraph(markdown) {
  const plain = tokens => (tokens ?? []).map(token => (token.tokens ? plain(token.tokens) : token.type === 'escape' || token.type === 'codespan' || token.type === 'text' ? decodeEntities(token.text) : '')).join('');
  const tokens = Lexer.lex(frontMatter(markdown).body, { gfm: true });
  const first = tokens.find(token => token.type === 'paragraph') ?? tokens.find(token => token.type === 'text');
  return first ? plain(first.tokens ?? [first]).replace(/\s+/g, ' ').trim() : '';
}
