import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logoSymbol } from '../scripts/logo-sprite.mjs';

const svg = body => `<svg viewBox="0 0 10 10">${body}</svg>`;

test('a logo keeps only local shapes and references; anything that could run, leave the SVG or fetch fails the build', () => {
  const kept = logoSymbol('probe', svg('<defs><linearGradient id="a"><stop offset="0" style="stop-color:#fff"/></linearGradient></defs><path d="M0 0h10v10z" fill="url(#a)"/>'));
  assert.match(kept, /<linearGradient id="logo-probe-a">/);
  assert.match(kept, /fill="url\(#logo-probe-a\)"/);
  for (const body of [
    '<p><img src=data:,x /onerror=alert(1)></p>',
    '<script>alert(1)</script>',
    '<path d="M0 0" onload="alert(1)"/>',
    '<g ID="search"/>',
    '<feImage href=https://example.invalid/a.png />',
    '<use href="#a"/>',
    '<path d="M0 0" style="filter:u\\72l(https://example.invalid/f)"/>',
    '<path d="M0 0" fill="url(https://example.invalid/x)"/>',
    '<rect width="10" height="10" fill="url(external.svg"/>',
    '<rect width="10" height="10" style="fill:url(external.svg"/>',
    '<path d="M0 0" fill="url(#missing)"/>',
    '<path d="M0 0" fill="url(#missing"/>',
    '<path d="M0 0" fill="var(--page)"/>',
    '<g>text</g>',
  ]) assert.throws(() => logoSymbol('probe', svg(body)), /^Error: Logo probe\.svg/, body);
});
