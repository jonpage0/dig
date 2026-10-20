import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { Script } from 'node:vm';

for (const surface of ['library', 'card']) test(`${surface} is a self-contained MCP App with no runtime asset requests`, async () => {
  const html = await readFile(new URL(`../plugin/dist/${surface}.html`, import.meta.url), 'utf8');
  const window = new Window({ settings: { enableJavaScriptEvaluation: false } });
  try {
    window.document.write(html);
    const scripts = [...window.document.querySelectorAll('script')];
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].hasAttribute('src'), false);
    assert.doesNotThrow(() => new Script(scripts[0].textContent));
    assert.equal(/\bimport\s*\(/.test(scripts[0].textContent), false);
    assert.equal(window.document.querySelectorAll('link[rel=stylesheet], link[rel=modulepreload], img[src], iframe[src]').length, 0);
    const css = [...window.document.querySelectorAll('style')].map(style => style.textContent).join('\n');
    assert.ok(css.includes('--color-background-primary'), 'host tokens remain in the bundled CSS');
    assert.ok(css.includes('dig-button'), 'shared components are styled');
    assert.equal(/@import\s|url\(\s*["']?(?:https?:|\/\/|\/assets\/)/i.test(css), false);
    assert.ok(window.document.querySelector('#root'));
    assert.equal(html.includes('<!--APP_SCRIPT-->'), false);
    assert.equal(html.includes('<!--APP_STYLES-->'), false);
  } finally { await window.happyDOM.close(); }
});

test('frontend third-party source and bundled runtime notices travel with the plugin', async () => {
  const notices = await readFile(new URL('../plugin/THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const name of ['react', 'react-dom', '@base-ui/react', '@tanstack/react-query', '@tanstack/react-router', 'tailwindcss']) {
    assert.ok(notices.includes(`## ${name} `), `missing notice for ${name}`);
  }
  const reui = await readFile(new URL('../plugin/ReUI-LICENSE', import.meta.url), 'utf8');
  assert.ok(reui.includes('Copyright (c) 2025 Keenthemes Inc'));
});
