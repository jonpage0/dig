// Read-only presentation of retained research. These shapes are tool/view data, never a second saved record.
import { z } from 'zod';
import { basename } from 'node:path';
import { readLibraryFile } from './library.mjs';
import { savedResearch, openInDig } from './surfaces.mjs';
import { frontMatter } from './ui/markdown.mjs';

const bounded = max => z.string().trim().min(1).max(max);
const http = bounded(2048).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'An absolute HTTP(S) URL without credentials is required');
const details = z.strictObject({ label: bounded(80), value: bounded(1000), url: http.optional() });
const nextStep = z.strictObject({ label: bounded(80), prompt: bounded(4000) });
export const INSIGHT_SCHEMA = z.strictObject({
  title: bounded(180), statement: bounded(1500),
  details: z.array(details).max(4).default([]),
  evidence: z.array(bounded(4096)).min(1).max(4),
  limits: z.array(bounded(500)).max(4).default([]),
  nextStep: nextStep.optional(),
});
export const PRESENTATION_INPUT = { file: bounded(4096), insights: z.array(INSIGHT_SCHEMA).min(1).max(6) };
const schema = z.strictObject(PRESENTATION_INPUT);
const nullableText = z.string().nullable();
export const CARD_SCHEMA = z.looseObject({
  file: z.string(), path: z.string().optional(), kind: z.enum(['report', 'answer']), title: z.string(), question: z.string(), label: z.string(), glyph: z.string(),
  status: nullableText, savedAt: nullableText, summary: z.string(), retrievals: z.number().int().nonnegative(), link: nullableText,
  cost: z.object({ byUnit: z.record(z.string(), z.number().nonnegative()), unknownCalls: z.number().int().nonnegative(), freeCalls: z.number().int().nonnegative(), totalCalls: z.number().int().nonnegative(), scope: z.enum(['report', 'dig']) }),
  findings: z.array(z.string()), contradictions: z.array(z.string()), followUps: z.array(z.string()), confidence: nullableText, evidenceGrade: nullableText,
  schemaWarnings: z.array(z.string()),
  insights: z.array(z.object({
    title: z.string(), statement: z.string(), details: z.array(details),
    evidence: z.array(z.object({ file: z.string(), path: z.string(), label: z.string(), link: nullableText })), limits: z.array(z.string()), nextStep: nextStep.optional(),
  })),
});
export const PRESENTATION_OUTPUT = { file: z.string(), path: z.string(), card: CARD_SCHEMA };

export async function presentResearch(config, snapshot, input) {
  const args = schema.parse(input);
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 48000) throw new Error('Presentation exceeds 48000 UTF-8 bytes; select fewer findings. Nothing was truncated.');
  const report = await readLibraryFile(config, args.file, 0, Number.MAX_SAFE_INTEGER);
  const card = savedResearch(snapshot, report.file, report.text);
  const item = snapshot.items.find(item => item.answer === report.file || item.reports.includes(report.file));
  const namedReports = card.kind === 'answer' ? frontMatter(report.text).meta.reports : null;
  const reportPrefix = report.file.slice(0, report.file.lastIndexOf('/') + 1);
  const allowedReports = card.kind === 'answer'
    ? (Array.isArray(namedReports) ? namedReports.filter(name => typeof name === 'string').map(name => reportPrefix + name).filter(file => item.reports.includes(file)) : [])
    : item.reports;
  // Whole calls.jsonl files can contain other digs. Only individually associated raw responses qualify.
  const allowed = new Set([report.file, ...allowedReports, ...item.calls.map(call => call.rawFile).filter(Boolean)]);
  const references = new Map();
  for (const file of new Set(args.insights.flatMap(insight => insight.evidence))) {
    const read = await readLibraryFile(config, file, 0, 1);
    if (!allowed.has(read.file)) throw new Error('Presentation evidence must be a report or retained original associated with the selected dig. Composed answers may reference only their named reports.');
    references.set(file, { file: read.file, path: read.path, label: basename(read.file), link: openInDig(read.path) });
  }
  const insights = args.insights.map(insight => ({ ...insight, evidence: [...new Map(insight.evidence.map(file => [references.get(file).file, references.get(file)])).values()] }));
  return { file: report.file, path: report.path, card: { ...card, path: report.path, link: openInDig(report.path), insights } };
}
