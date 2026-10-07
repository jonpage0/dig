// Host-facing views of the existing research files: "Open in Dig" links, the saved-research card, composer
// at-mentions and the settings-page readiness summary. Everything here is derived from files the library already
// writes; nothing is persisted.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { MODULES } from './providers/modules.ts';
import { packageRoot } from './catalog.mjs';
import { createCatalog } from './ui/catalog.mjs';
import { firstParagraph, frontMatter, sourceCard } from './ui/markdown.mjs';
import { answerWord, runWord } from './status.mjs';
import { glyphFor, monochromeSvg, svgDataUri } from './glyphs.mjs';

export const catalog = createCatalog(MODULES.map(({ id, label }) => ({ id, label })));

/**
 * The installed plugin's identity, read from Codex's cache layout `<cache>/<marketplace>/<plugin>/<version>/`.
 * Codex passes no plugin id to the server; outside an installed copy (tests, preview, the repository) this is
 * null and Dig emits no links rather than guessing a marketplace.
 */
export function pluginIdentity(root = packageRoot) {
  const parts = root.replace(/[\\/]+$/, '').split(sep);
  const at = parts.lastIndexOf('cache');
  if (at < 2 || parts[at - 1] !== 'plugins' || parts.length !== at + 4) return null;
  const [marketplace, plugin] = parts.slice(at + 1, at + 3);
  try {
    const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
    return manifest.name === plugin ? { plugin, marketplace } : null;
  } catch { return null; }
}
const identity = existsSync(packageRoot) ? pluginIdentity() : null;

const VERSION_FOLDER = /^\d+\.\d+\.\d+$/;
const newer = (a, b) => { const [x, y] = [a, b].map(v => v.split('.').map(Number)); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b; return a; };
/**
 * Codex's installer removes the previous version's cache folder while the desktop keeps the old server running, so
 * this server's own package can vanish under it. While the package is in place this is null. Once it is gone, it is
 * `{ version }`: the newest `<major>.<minor>.<patch>` folder beside the package (the version that replaced it), or
 * null when there is none, as after an uninstall. View data only; nothing is persisted.
 */
export function packageReplaced(root = packageRoot) {
  if (existsSync(join(root, '.codex-plugin', 'plugin.json'))) return null;
  let version = null;
  try { version = readdirSync(dirname(root.replace(/[\\/]+$/, ''))).filter(name => VERSION_FOLDER.test(name)).reduce((best, name) => (best ? newer(best, name) : name), null); } catch { version = null; }
  return { version };
}

/** codex:// link that opens one library file in Dig's reader (the app's `/read?file=` route), or null. */
export function openInDig(file, id = identity) {
  if (!id || !file) return null;
  return `codex://plugins/${id.plugin}@${id.marketplace}/app/open_library?path=${encodeURIComponent(`/read?file=${encodeURIComponent(file)}`)}`;
}
export const isDigDocument = file => /\/digs\/[^/]+\/[^/]+\.md$/.test(file);

const SUMMARY = /^## Summary\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/m;
const trim = (text, max) => (text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : text);

/** Details for the saved-research card: what was saved, about which question, its own status as a tag word, and how much evidence it retains. */
export function savedResearch(snapshot, file, text) {
  const item = snapshot.items.find(entry => entry.files.includes(file));
  if (!item) throw new Error('This file is not part of a dig in the selected library');
  const { meta, body } = frontMatter(text);
  const answer = file.endsWith('/answer.md');
  if (answer) {
    const reports = Array.isArray(meta.reports) ? meta.reports.map(name => catalog.fileLabel(String(name))) : [];
    return {
      kind: 'answer', file, title: item.title, label: 'Answer', glyph: 'shovel', status: answerWord(meta.status) ?? (typeof meta.status === 'string' ? meta.status : null), savedAt: meta.finished_at ?? null,
      summary: trim(firstParagraph(body), 280), reports, retrievals: item.calls.length, link: openInDig(file),
    };
  }
  const { card, body: rest } = sourceCard(body);
  const summary = SUMMARY.exec(rest)?.[1] ?? '';
  return {
    kind: 'report', file, title: item.title, label: catalog.fileLabel(file), source: meta.source ?? null, method: meta.agent ?? null,
    glyph: glyphFor(meta.source, meta.agent), status: runWord(card?.fields?.status), savedAt: meta.generated_at ?? null,
    summary: trim(firstParagraph(summary), 280), retrievals: item.calls.filter(call => call.claimedBy === file).length, link: openInDig(file),
  };
}

const shortDate = iso => { const at = Date.parse(iso); return Number.isFinite(at) ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''; };
const icons = new Map();
const iconFor = glyph => { if (!icons.has(glyph)) icons.set(glyph, [{ src: svgDataUri(monochromeSvg(glyph)), mimeType: 'image/svg+xml', sizes: ['any'] }]); return icons.get(glyph); };
const MENTION_LIMIT = 20;
/**
 * Composer at-mention results: saved reports and answers, newest first. Every query word must appear in the
 * question, the report's method or source name, or its Summary snippet. Each item is a resource link the host
 * resolves through `dig://library/{file}`.
 */
export function mentionItems(snapshot, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const entries = [];
  for (const item of snapshot.items) {
    const documents = [...(item.answer ? [{ file: item.answer, label: 'Answer', glyph: 'shovel', summary: '', at: item.finishedAt }] : []),
      ...(item.reportDetails ?? []).map(report => ({ file: report.file, label: catalog.fileLabel(report.file), glyph: glyphFor(report.source, report.method), summary: report.summary, at: null }))];
    for (const document of documents) {
      const haystack = `${item.title}\n${document.label}\n${document.summary}`.toLowerCase();
      if (words.every(word => haystack.includes(word))) entries.push({ item, ...document });
    }
  }
  return entries.slice(0, MENTION_LIMIT).map(({ item, file, label, glyph }) => ({
    type: 'resource_link', uri: `dig://library/${encodeURIComponent(file)}`, name: file.split('/').at(-1),
    title: trim(item.title, 120), description: [label, shortDate(item.startedAt)].filter(Boolean).join(' · '), mimeType: 'text/markdown', icons: iconFor(glyph),
  }));
}

/** Plain text for the settings-page button: grouped readiness of every source, presence-only. */
export function readinessText(info) {
  const enabled = info.sources.filter(source => source.enabled);
  const missing = source => [...source.credentials.filter(c => c.required && !c.available).map(c => c.name), ...source.prerequisites.filter(p => !p.available).map(p => p.name)];
  const describe = source => { const names = missing(source); return names.length ? `${source.label} (needs ${names.join(', ')})` : source.label; };
  const group = (status, title) => { const list = enabled.filter(source => source.readiness.status === status); return list.length ? `${title}: ${list.map(status === 'ready' ? s => s.label : describe).join('; ')}.` : null; };
  const disabled = info.sources.filter(source => !source.enabled);
  return [
    `${enabled.length} of ${info.sources.length} sources enabled.`,
    group('ready', 'Ready'), group('partial', 'Partly ready'), group('setup-required', 'Setup needed'),
    disabled.length ? `Disabled: ${disabled.map(s => s.label).join(', ')}.` : null,
    'Checks credential names and local prerequisites only; no provider was called.',
  ].filter(Boolean).join('\n');
}
