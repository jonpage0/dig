// Source brand logos (trademarks of their owners, used to identify each service) become one hidden SVG sprite of
// <symbol>s inlined into the library view: the view runs in a sandbox that cannot load the plugin's files or outside
// images, and <use> references need no parsing at runtime. Each logo is re-serialized from the allowlist below, its
// ids are prefixed with its name and its class rules become inline styles, so one logo cannot restyle another or the
// page, and every internal reference must name an id the same logo defines.
//
// Anything outside the allowlist fails the build: an element or attribute not listed (names are case-sensitive), an
// unquoted or single-quoted value, text between tags, unbalanced tags or parentheses, a CSS function not listed, an
// escape, or a url()/href that is not a complete reference to an id inside the same logo. That keeps script, HTML
// that would leave the SVG, outside requests and page restyling out of the sprite.

const ELEMENTS = new Set(['g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polygon', 'polyline', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask']);
const PROPERTIES = new Set(['fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'clip-path', 'mask', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity', 'stop-color', 'stop-opacity']);
const ATTRIBUTES = new Set([...PROPERTIES, 'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'width', 'height', 'offset', 'transform', 'gradientTransform', 'gradientUnits', 'spreadMethod', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'id', 'class', 'style', 'href', 'xlink:href']);
const FUNCTIONS = new Set(['url', 'rgb', 'rgba', 'hsl', 'hsla', 'matrix', 'translate', 'scale', 'rotate', 'skewX', 'skewY']);
const ID = /^[\w.-]+$/;
const LOCAL_URL = /url\(#([\w.-]+)\)/g;

/** One attribute or style value: plain tokens, listed functions with balanced parentheses, url() only as url(#id). */
function checkValue(file, value) {
  if (!/^[\w\s#.,%+()-]*$/.test(value)) throw new Error(`Logo ${file}: value "${value}" has characters a logo does not need`);
  let depth = 0;
  for (const character of value) if ((character === '(' ? ++depth : character === ')' ? --depth : depth) < 0) break;
  if (depth !== 0) throw new Error(`Logo ${file}: value "${value}" has unbalanced parentheses`);
  for (const [, name] of value.matchAll(/([A-Za-z-]+)\(/g)) if (!FUNCTIONS.has(name)) throw new Error(`Logo ${file}: function ${name}() is not allowed`);
  if ((value.match(/url\(/g)?.length ?? 0) !== [...value.matchAll(LOCAL_URL)].length) throw new Error(`Logo ${file}: every url() in "${value}" must be url(#id) inside the logo`);
  return value;
}
function checkStyle(file, css) {
  return css.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const [, property, value] = /^([a-z-]+)\s*:\s*(.+)$/.exec(part) ?? [];
    if (!PROPERTIES.has(property)) throw new Error(`Logo ${file}: style "${part}" is not allowed`);
    return `${property}:${checkValue(file, value.trim())}`;
  });
}

/** The `<symbol id="logo-<name>">` for one logo's SVG source, or an error naming what the allowlist refused. */
export function logoSymbol(name, source) {
  const file = `${name}.svg`;
  const svg = source.replace(/^\s*<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->|<metadata\b[\s\S]*?<\/metadata>|<title\b[\s\S]*?<\/title>/g, '').trim();
  const root = /^<svg\b([^>]*)>([\s\S]*)<\/svg>$/.exec(svg);
  const viewBox = root && /\sviewBox="([\d.\s-]+)"/.exec(root[1])?.[1];
  if (!viewBox) throw new Error(`Logo ${file} needs one root <svg> with a numeric viewBox`);
  const fill = /\sfill="([^"]*)"/.exec(root[1])?.[1];
  if (fill !== undefined && !/^(#[0-9a-fA-F]{3,8}|[a-z]+)$/.test(fill)) throw new Error(`Logo ${file}: root fill "${fill}" is not a colour`);
  const prefix = `logo-${name}-`;
  const rules = new Map();
  const body = root[2].replace(/<style\b[^>]*>([\s\S]*?)<\/style>/g, (_, css) => {
    for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) for (const selector of selectors.split(',')) {
      const match = /^\s*\.([\w-]+)\s*$/.exec(selector);
      if (!match) throw new Error(`Logo ${file}: only class selectors are supported, found "${selector.trim()}"`);
      rules.set(match[1], [...(rules.get(match[1]) ?? []), ...checkStyle(file, declarations)]);
    }
    if (css.replace(/([^{}]+)\{([^}]*)\}/g, '').trim()) throw new Error(`Logo ${file}: its <style> has rules this builder cannot read`);
    return '';
  });
  const out = []; const open = []; const ids = new Set(); const references = new Set();
  const reference = value => value.replace(LOCAL_URL, (_, id) => { references.add(id); return `url(#${prefix}${id})`; });
  const token = /\s*(?:<([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|<\/([A-Za-z][\w:-]*)\s*>)\s*/y;
  let at = 0;
  while (at < body.length) {
    token.lastIndex = at;
    const match = token.exec(body);
    if (!match) throw new Error(`Logo ${file}: unexpected markup near "${body.slice(at, at + 40)}"`);
    at = token.lastIndex;
    const [, tag, attributes = '', selfClosing, closing] = match;
    if (closing) {
      if (open.pop() !== closing) throw new Error(`Logo ${file}: </${closing}> does not close the open element`);
      out.push(`</${closing}>`); continue;
    }
    if (!ELEMENTS.has(tag)) throw new Error(`Logo ${file}: element <${tag}> is not allowed`);
    const style = []; let rest = '';
    for (const [, key, value] of attributes.matchAll(/\s+([\w:-]+)="([^"]*)"/g)) {
      if (!ATTRIBUTES.has(key)) throw new Error(`Logo ${file}: attribute ${key} on <${tag}> is not allowed`);
      if (key === 'class') { for (const cls of value.split(/\s+/).filter(Boolean)) style.unshift(...(rules.get(cls) ?? [])); continue; }
      if (key === 'style') { style.push(...checkStyle(file, value)); continue; }
      if (key === 'id') {
        if (!ID.test(value) || ids.has(value)) throw new Error(`Logo ${file}: id "${value}" is invalid or repeated`);
        ids.add(value); rest += ` id="${prefix}${value}"`; continue;
      }
      if (key === 'href' || key === 'xlink:href') {
        const [, id] = /^#([\w.-]+)$/.exec(value) ?? [];
        if (!id) throw new Error(`Logo ${file}: ${key}="${value}" is not a reference inside the logo`);
        references.add(id); rest += ` href="#${prefix}${id}"`; continue;
      }
      rest += ` ${key}="${reference(checkValue(file, value))}"`;
    }
    if (style.length) rest += ` style="${reference(style.join(';'))}"`;
    out.push(`<${tag}${rest}${selfClosing ? '/' : ''}>`);
    if (!selfClosing) open.push(tag);
  }
  if (open.length) throw new Error(`Logo ${file}: <${open.at(-1)}> is never closed`);
  for (const id of references) if (!ids.has(id)) throw new Error(`Logo ${file}: reference #${id} names no id in the logo`);
  return `<symbol id="logo-${name}" viewBox="${viewBox}">${fill ? `<g fill="${fill}">${out.join('')}</g>` : out.join('')}</symbol>`;
}

/** The hidden sprite for `logos` ([{ name, svg }]), hidden without display:none, which would stop gradients painting. */
export function logoSprite(logos) {
  return `<svg class="logo-sprite" aria-hidden="true" focusable="false" width="0" height="0">${logos.map(({ name, svg }) => logoSymbol(name, svg)).join('')}</svg>`;
}
