/** Transient view data. Reports and provider receipts remain the research authority. */
export interface EvidenceReference { file: string; path?: string; label: string; link?: string | null }
export interface Insight {
  title: string;
  statement: string;
  details: { label: string; value: string; url?: string }[];
  evidence: EvidenceReference[];
  limits: string[];
  nextStep?: { label: string; prompt: string };
}
export interface ResearchCard {
  file: string;
  path?: string;
  question?: string;
  title: string;
  summary?: string;
  kind: 'report' | 'answer';
  source?: string | null;
  method?: string | null;
  label: string;
  glyph?: string;
  status?: string | null;
  savedAt?: string | null;
  retrievals: number;
  reports?: string[];
  link?: string | null;
  cost?: {
    byUnit: Record<string, number>;
    unknownCalls: number;
    freeCalls: number;
    totalCalls: number;
    scope: 'report' | 'dig';
  };
  findings?: string[];
  contradictions?: string[];
  followUps?: string[];
  confidence?: string | null;
  evidenceGrade?: string | null;
  schemaWarnings?: string[];
  insights?: Insight[];
}
export interface SavedResult { file: string; path?: string; link?: string | null; card?: ResearchCard }
export interface RetainedRead {
  file: string;
  path?: string;
  text: string;
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
}

export function unwrapResult(result: any): any {
  if (result?.isError) throw new Error(result.content?.find((part: any) => part.type === 'text')?.text || 'Dig could not read this research.');
  return result?.structuredContent ?? result;
}

export function savedResult(result: unknown): SavedResult {
  const value = unwrapResult(result);
  if (!value || typeof value.file !== 'string' || !value.file) throw new Error('The tool result did not identify saved research.');
  return value;
}

/** These checks protect host navigation as well as plain browser previews. */
export function webLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function digLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'codex:' && url.hostname === 'plugins' &&
      /^\/dig@[^/]+\/app\/open_library$/.test(url.pathname) &&
      url.searchParams.get('path')?.startsWith('/read?file=') ? url.href : null;
  } catch { return null; }
}

const absolutePath = (value: unknown): value is string => typeof value === 'string' && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);

export function cardDetails(value: unknown, file: string, path?: string): ResearchCard {
  const card = unwrapResult(value);
  if (!card || (absolutePath(file) ? card.path !== file : card.file !== file) ||
    (path !== undefined && (!absolutePath(path) || card.path !== path)) ||
    typeof card.title !== 'string' || !['report', 'answer'].includes(card.kind)) {
    throw new Error('Dig returned details for a different or unreadable research file.');
  }
  return card;
}

/** Bound a view label without changing the original question or saved report. */
export function compactTitle(value: string): string {
  const title = value.replace(/\s+/g, ' ').trim();
  if (title.length <= 96) return title;
  const prefix = title.slice(0, 95).replace(/\s+\S*$/, '');
  return (prefix || title.slice(0, 95)).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

/** Selected evidence is read page by page. The caller decides whether this read still belongs to its view. */
export async function readRetained(
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  file: string,
  current: () => boolean,
  onPage: (value: RetainedRead) => void,
  knownPath?: string,
): Promise<RetainedRead | null> {
  let offset = 0;
  let text = '';
  let path = knownPath ?? (absolutePath(file) ? file : undefined);
  let relativeFile = absolutePath(file) ? undefined : file;
  let totalCharacters: number | undefined;
  if (path !== undefined && !absolutePath(path)) throw new Error('The retained evidence path is not absolute; the read was refused.');
  for (let page = 0; page < 100; page++) {
    if (!current()) return null;
    // Absolute paths remain confined by the server to the selected library. If that selection changes,
    // the old path fails instead of resolving the same relative name in a different library.
    const value = unwrapResult(await call('library_read', { file: path ?? file, offset, limit: 60000 }));
    if (!current()) return null;
    const end = offset + (typeof value?.text === 'string' ? value.text.length : 0);
    if (!value || typeof value.file !== 'string' || (relativeFile !== undefined && value.file !== relativeFile) ||
      !absolutePath(value.path) || (path !== undefined && value.path !== path) ||
      typeof value.text !== 'string' || value.offset !== offset ||
      !Number.isInteger(value.totalCharacters) || value.totalCharacters < end ||
      (totalCharacters !== undefined && value.totalCharacters !== totalCharacters) ||
      !(value.nextOffset === null ? end === value.totalCharacters :
        Number.isInteger(value.nextOffset) && value.nextOffset === end && end > offset && end < value.totalCharacters)) {
      throw new Error('Dig returned an unexpected evidence page or a different retained file; the read is incomplete.');
    }
    path = value.path;
    relativeFile = value.file;
    totalCharacters = value.totalCharacters;
    text += value.text;
    const result = { ...value, text, path };
    onPage(result);
    if (value.nextOffset === null) return result;
    offset = value.nextOffset;
  }
  throw new Error('This evidence is too large for the inline reader. Open the retained file to read the rest; the text shown here is incomplete.');
}
