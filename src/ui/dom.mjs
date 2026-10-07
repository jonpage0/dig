// Small DOM helpers shared by the Dig views. Every value from research files or provider responses
// reaches the page through text nodes or validated attributes; nothing here parses HTML.
import { patternOf } from '../status.mjs';

export const $ = id => document.getElementById(id);
export const text = (element, value) => { element.textContent = value; return element; };
export const keyed = (element, key) => { element.setAttribute('data-key', key); return element; };
export const attr = (element, name, value) => { element.setAttribute(name, value); return element; };

// node(tag, className, ...children): strings become text nodes; null, undefined and false are skipped; arrays flatten.
export function node(tag, className, ...children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  append(element, children);
  return element;
}
function append(element, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(element, child);
    else element.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}
export function button(className, label, onclick) {
  const element = node('button', `btn ${className}`, label); element.type = 'button'; element.onclick = onclick;
  return element;
}
/** A keys.env name in code type that may wrap after an underscore rather than mid-word. */
export const keyName = name => node('code', 'key-name', name.split('_').flatMap((part, i) => (i ? ['_', node('wbr', ''), part] : [part])));

/** A down chevron in the line weight of its text; the fold's CSS turns it when the fold is open. */
function chevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'chevron'); svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'm6 9 6 6 6-6');
  svg.append(path);
  return svg;
}
/**
 * A native disclosure (`details`) whose summary reads as a button: a border, a hover state, its title, a short gist of
 * what is inside and a chevron. Build it once and change only `gist` and `body`, so a refresh keeps it open; `key`
 * keeps keyboard focus on its summary through a rebuild around it.
 */
export function fold(className, key, title, ...body) {
  const gist = node('span', 'fold-gist');
  const summary = keyed(node('summary', 'fold-summary', title, gist, chevron()), key);
  const content = node('div', 'fold-body', ...body);
  return { element: node('details', `fold ${className}`, summary, content), gist, body: content };
}

// Rebuilding a list must not steal keyboard focus: the element with the same data-key regains it.
export function rebuild(container, children) {
  const key = document.activeElement?.getAttribute('data-key');
  container.replaceChildren(...children);
  if (key) for (const child of container.querySelectorAll('[data-key]')) if (child.getAttribute('data-key') === key) { child.focus(); break; }
}

// Only absolute http(s) URLs become navigable; everything else stays text.
export function httpUrl(value) {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value.trim()); return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null; } catch { return null; }
}
// An outbound link. Clicks are routed through the host when it can open links (see app.mjs); the
// attributes below are the plain-browser behavior.
export function externalLink(href, ...children) {
  const anchor = node('a', 'external', ...children);
  anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.setAttribute('data-external', '');
  return anchor;
}

/**
 * A status tag: a lowercase word on a borderless fill. The word carries the meaning and the fill (`solid`, `stripes`,
 * `warning` or `dots`, from the word unless given) repeats it, never colour alone.
 */
export function tag(word, pattern = patternOf(word)) {
  const element = node('span', 'state', String(word ?? 'unknown'));
  if (pattern) element.setAttribute('data-pattern', pattern);
  return element;
}
