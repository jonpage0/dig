// Reports and answers are untrusted text. marked tokenizes the Markdown (GFM tables, emphasis, code, lists);
// this module builds DOM nodes from those tokens with an allowlist. There is no innerHTML: raw HTML in a
// report appears as literal text, only absolute http(s) links navigate, and images are never loaded.
import { Lexer } from 'marked';
import { node, attr, httpUrl, externalLink } from './dom.mjs';
import { decodeEntities } from './format.mjs';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
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
 * Whether a fenced code block's source ends with a closing fence, as marked reads one: up to three spaces, the
 * opening fence's characters, any more backticks or tildes, then only spaces. Unclosed, the block runs to the end.
 */
function closedFence(raw) {
  const lines = raw.replace(/\n$/, '').split('\n');
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0])[1];
  const closer = lines.length > 1 ? lines.at(-1).replace(/^ {0,3}/, '') : '';
  return closer.startsWith(fence) && /^[`~]* *$/.test(closer.slice(fence.length));
}

/** A report's source card block: a closed fenced code block, `yaml` or `yml` its info string's first word, whose text begins `source_card:`. */
const isSourceCard = block => block?.type === 'code' && block.codeBlockStyle !== 'indented' && /^ya?ml(?:\s|$)/.test(block.lang ?? '') && /^source_card:/.test(block.text) && closedFence(block.raw);

/** The card's scalars and string lists; anything else stays visible in the verbatim `yaml` (`partial` marks a card the summary could not fully read). */
function readCard(yaml) {
  const fields = {}; const lists = {}; let list = null; let partial = false;
  for (const line of yaml.split('\n').slice(1)) {
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
  return { fields, lists, yaml, partial };
}

/** The first nonblank source line under the top-level `## Summary`, before the next heading of level 1 or 2; '' when there is none. */
function summaryLine(blocks) {
  const at = blocks.findIndex(block => block.type === 'heading' && block.depth === 2 && block.text === 'Summary');
  if (at < 0) return '';
  for (const block of blocks.slice(at + 1)) {
    if (block.type === 'heading' && block.depth <= 2) break;
    const line = block.raw.split('\n').find(text => text.trim());
    if (line !== undefined) return line;
  }
  return '';
}

/**
 * A report body (front matter removed) read as marked reads Markdown, CommonMark with GFM. Code (fenced or indented,
 * in a list or block quote or not), list items, block quotes and HTML blocks are block structure, so no line inside
 * them is a heading or the card. The save's check and every reader of a report's card, status, title and Summary use
 * this one reading, so they agree with each other and with the rendered report.
 * - `card`: the first block when it is the source card (`isSourceCard`), read by `readCard`; otherwise null.
 * - `rest`: the body after the card's closing fence line, or the whole body without a card.
 * - `headings`: the top-level headings, ATX or setext, as `{ depth, text }`.
 * - `summary`: the Summary snippet's source line (`summaryLine`).
 */
export function reportParts(body) {
  const text = body.replace(/\r\n?/g, '\n');
  const blocks = new Lexer({ gfm: true }).blockTokens(text);
  const first = blocks.findIndex(block => block.type !== 'space');
  let card = null; let rest = text;
  if (isSourceCard(blocks[first])) {
    card = readCard(blocks[first].text);
    // Only blank lines precede the card; the newline that ends its closing fence line is part of it.
    let end = blocks.slice(0, first + 1).reduce((length, block) => length + block.raw.length, 0);
    if (!blocks[first].raw.endsWith('\n') && text[end] === '\n') end += 1;
    rest = text.slice(end);
  }
  const headings = blocks.filter(block => block.type === 'heading').map(({ depth, text: heading }) => ({ depth, text: heading }));
  return { card, rest, headings, summary: summaryLine(blocks) };
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
