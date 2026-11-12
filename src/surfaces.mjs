// The views' data, derived from the existing research files: the library snapshot and its change fingerprint, and the
// saved-research card. Everything here is derived from files the library already writes; nothing is persisted.
import { MODULES } from './providers/modules.ts';
import { createCatalog } from './ui/catalog.mjs';
import { firstParagraph, frontMatter, reportParts } from './ui/markdown.mjs';
import { answerWord, runWord } from './status.mjs';
import { glyphFor } from './glyphs.mjs';
import { costSummary } from './providers/library/cost.ts';
import { displayTitle, listLibrary, libraryFolder, libraryRevision, readLibraryFile } from './library.mjs';
import { environmentPresence } from './catalog.mjs';
import { knownSecrets, redactValue } from './providers/secrets.ts';
import { VERSION } from './version.mjs';
import { createHash } from 'node:crypto';

export const catalog = createCatalog(MODULES.map(({ id, label }) => ({ id, label })));

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
      summary: trim(firstParagraph(body), 280), reports, retrievals: item.calls.length,
    };
  }
  const { card, summary } = reportParts(body);
  const lists = card && !card.partial ? card.lists : {};
  const list = name => Array.isArray(lists[name]) ? lists[name].filter(x => typeof x === 'string').slice(0, 6).map(x => trim(x, 1000)) : [];
  const grade = value => ['high', 'medium', 'low'].includes(value) ? value : null;
  return {
    ...common, kind: 'report', file, title: displayTitle(item.title, 'single', [{ title: meta.title, topic: meta.topic, source: meta.source }]), label: catalog.fileLabel(file), source: meta.source ?? null, method: meta.agent ?? null,
    glyph: glyphFor(meta.source, meta.agent), status: runWord(card?.fields?.status), savedAt: meta.generated_at ?? null,
    summary: trim(firstParagraph(summary), 280), retrievals: item.calls.filter(call => call.claimedBy === file).length,
    findings: list('strongest_findings'), contradictions: list('contradictions'), followUps: list('follow_up_targets'),
    confidence: card?.partial ? null : grade(card?.fields?.confidence), evidenceGrade: card?.partial ? null : grade(card?.fields?.evidence_grade),
    schemaWarnings: card?.partial ? ['The report assessment contains unsupported structure. Read the full report for the original wording.'] : [],
  };
}

// The views' data, built once for the service's views in a host and in a browser (src/service/views.ts).
// `activity` is a createCallActivity() instance; `host` is the wording host (views.ts clientHost).
// `version` is the service's; the view compares it with its own to notice when a host shows an older cached view.
// `libraryFolder` lets the Settings page say when the chosen library is not a folder yet.
export async function librarySnapshot(c, activity, host) {
  return { ...(await listLibrary(c)), version: VERSION, library: c.library, libraryFolder: await libraryFolder(c), configPath: c.path, enabledSources: c.sources.enabled, sources: MODULES.map(({ id, kind, label }) => ({ id, kind: kind ?? 'source', label })), keepRaw: c.keep_raw, activeCalls: activity.snapshot(c.library), host };
}
// The version is part of the fingerprint so a running view polls a fresh snapshot, and notices, after an update.
export async function libraryFingerprint(c, activity) {
  return createHash('sha256').update(JSON.stringify([VERSION, activity.revision, await libraryRevision(c), c.library, await libraryFolder(c), c.keep_raw, c.sources.enabled, c.x, c.workers, c.search, c.spend, environmentPresence()])).digest('hex').slice(0, 24);
}
/** saved_research's card for one library file, read from `snapshot` (a librarySnapshot), with known credentials redacted. */
export async function savedResearchCard(c, file, snapshot) {
  const read = await readLibraryFile(c, file, 0, Number.MAX_SAFE_INTEGER);
  return redactValue({ ...savedResearch(snapshot, read.file, read.text), path: read.path }, knownSecrets());
}
