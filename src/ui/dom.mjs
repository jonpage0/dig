// Small DOM helpers shared by the Dig views. Every value from research files or provider responses
// reaches the page through text nodes or validated attributes; nothing here parses HTML.
import { patternOf } from '../status.mjs';

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

// Only absolute http(s) URLs become navigable; everything else stays text.
export function httpUrl(value) {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value.trim()); return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null; } catch { return null; }
}
// An outbound link. Clicks are routed through the host when it can open links (see frontend/library/app.tsx); the
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
