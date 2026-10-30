// Host-facing views of the existing research files: "Open in Dig" links, the saved-research card, composer
// at-mentions and the settings-page readiness summary. Everything here is derived from files the library already
// writes; nothing is persisted.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { MODULES } from './providers/modules.ts';
import { packageRoot } from './catalog.mjs';
import { createCatalog } from './ui/catalog.mjs';
import { firstParagraph, frontMatter, reportParts } from './ui/markdown.mjs';
import { answerWord, runWord } from './status.mjs';
import { glyphFor, monochromeSvg, svgDataUri } from './glyphs.mjs';
import { costSummary } from './providers/library/cost.ts';
import { displayTitle } from './library.mjs';

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

const trim = (text, max) => (text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : text);

/** Details for the saved-research card: what was saved, about which question, its own status as a tag word, and how much evidence it retains. */
export function savedResearch(snapshot, file, text) {
  const item = snapshot.items.find(entry => entry.answer === file || entry.reports.includes(file));
  if (!item) throw new Error('This file is not part of a dig in the selected library');
  const { meta, body } = frontMatter(text);
  const answer = file.endsWith('/answer.md');
  const calls = answer ? item.calls : item.calls.filter(call => call.claimedBy === file);
  const common = {
    question: item.title,
    cost: { ...costSummary(calls), totalCalls: calls.length, scope: answer ? 'dig' : 'report' },
    findings: [], contradictions: [], followUps: [], confidence: null, evidenceGrade: null, schemaWarnings: [], insights: [],
  };
  if (answer) {
    const reports = Array.isArray(meta.reports) ? meta.reports.map(name => catalog.fileLabel(String(name))) : [];
    return {
      ...common, kind: 'answer', file, title: displayTitle(item.title, 'composed', [], reportParts(body).headings.find(h => h.depth === 1)?.text), label: 'Answer', glyph: 'shovel', status: answerWord(meta.status) ?? (typeof meta.status === 'string' ? meta.status : null), savedAt: meta.finished_at ?? null,
      summary: trim(firstParagraph(body), 280), reports, retrievals: item.calls.length, link: openInDig(file),
    };
  }
  const { card, summary } = reportParts(body);
  const lists = card && !card.partial ? card.lists : {};
  const list = name => Array.isArray(lists[name]) ? lists[name].filter(x => typeof x === 'string').slice(0, 6).map(x => trim(x, 1000)) : [];
  const grade = value => ['high', 'medium', 'low'].includes(value) ? value : null;
  return {
    ...common, kind: 'report', file, title: displayTitle(item.title, 'single', [{ title: meta.title, topic: meta.topic, source: meta.source }]), label: catalog.fileLabel(file), source: meta.source ?? null, method: meta.agent ?? null,
    glyph: glyphFor(meta.source, meta.agent), status: runWord(card?.fields?.status), savedAt: meta.generated_at ?? null,
    summary: trim(firstParagraph(summary), 280), retrievals: item.calls.filter(call => call.claimedBy === file).length, link: openInDig(file),
    findings: list('strongest_findings'), contradictions: list('contradictions'), followUps: list('follow_up_targets'),
    confidence: card?.partial ? null : grade(card?.fields?.confidence), evidenceGrade: card?.partial ? null : grade(card?.fields?.evidence_grade),
    schemaWarnings: card?.partial ? ['The report assessment contains unsupported structure. Read the full report for the original wording.'] : [],
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
      ...(item.reportDetails ?? []).map(report => ({ file: report.file, label: catalog.fileLabel(report.file), glyph: glyphFor(report.source, report.method), summary: report.summary, at: report.at }))];
    for (const document of documents) {
      const haystack = `${item.title}\n${document.label}\n${document.summary}`.toLowerCase();
      if (words.every(word => haystack.includes(word))) entries.push({ item, ...document });
    }
  }
  const dated = entry => {
    const own = Date.parse(entry.at);
    if (Number.isFinite(own)) return own;
    const fallback = Date.parse(entry.item.startedAt);
    return Number.isFinite(fallback) ? fallback : -Infinity;
  };
  entries.sort((a, b) => dated(b) - dated(a) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return entries.slice(0, MENTION_LIMIT).map(({ item, file, label, glyph, at, summary }) => {
    // Keep the record kind visible even when the question is long. The host can show several documents
    // from the same dig together; their shared question alone does not identify the selected evidence.
    const kind = trim(label, 48);
    const question = String(item.displayTitle || item.title || 'Saved research').replace(/\s+/g, ' ').trim();
    return {
      type: 'resource_link', uri: `dig://library/${encodeURIComponent(file)}`, name: file.split('/').at(-1),
      title: `${trim(question, 120 - kind.length - 3)} · ${kind}`,
      description: [shortDate(at) || shortDate(item.startedAt), trim(String(summary || '').replace(/\s+/g, ' ').trim(), 160)].filter(Boolean).join(' · '),
      mimeType: 'text/markdown', icons: iconFor(glyph),
    };
  });
}

/** Plain text for the settings-page button: grouped readiness of every source, presence-only. */
export function readinessText(info) {
  const enabled = info.sources.filter(source => source.enabled);
  const missing = source => [...source.credentials.filter(c => c.required && !c.available).map(c => c.name), ...source.prerequisites.filter(p => !p.available).map(p => p.name)];
  const describe = source => { const names = missing(source); return names.length ? `${source.label} (needs ${names.join(', ')})` : source.label; };
  const group = (status, title) => { const list = enabled.filter(source => source.readiness.status === status); return list.length ? `${title}: ${list.map(status === 'ready' ? s => s.label : describe).join('; ')}.` : null; };
  const disabled = info.sources.filter(source => !source.enabled);
  return [
    `${enabled.length} of ${info.sources.length} ${info.sources.some(source => source.kind === 'tool') ? 'sources & tools' : 'sources'} enabled.`,
    group('ready', 'Ready'), group('partial', 'Partly ready'), group('setup-required', 'Setup needed'),
    disabled.length ? `Disabled: ${disabled.map(s => s.label).join(', ')}.` : null,
    'Checks credential names and local prerequisites only; no provider was called.',
  ].filter(Boolean).join('\n');
}
