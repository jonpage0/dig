// Display names for sources, methods and research files, derived from the server's source catalog
// (library_snapshot `sources` or source_info). The UI keeps no source list of its own; an id the catalog
// does not name is shown as written. Method naming follows Dig's dashboard/ui/evidence/labels.ts (MIT).
import { basename } from './format.mjs';

const REPORT_FILE = /^(.+?)(?:-(\d+))?\.md$/;

export function createCatalog(sources = []) {
  const list = Array.isArray(sources) ? sources.filter(source => typeof source?.id === 'string') : [];
  const labels = new Map(list.map(source => [source.id, typeof source.label === 'string' && source.label ? source.label : source.id]));
  const methodSource = new Map();
  for (const source of list) for (const method of Array.isArray(source.methods) ? source.methods : []) if (typeof method?.name === 'string') methodSource.set(method.name, source.id);
  const label = id => labels.get(id) ?? String(id ?? '');
  /** `x-judge` → "X judge", `hackernews` → "Hacker News". */
  function methodLabel(agent) {
    const source = methodSource.get(agent) ?? (labels.has(agent) ? agent : list.find(s => agent.startsWith(`${s.id}-`))?.id);
    if (!source) return agent;
    if (agent === source) return label(source);
    const rest = agent.startsWith(`${source}-`) ? agent.slice(source.length + 1) : agent;
    return `${label(source)} ${rest.replaceAll('-', ' ')}`;
  }
  /** Reader-facing name of a dig file; the filename stays available as secondary detail. */
  function fileLabel(file) {
    const name = basename(file);
    if (name === 'dig.md') return 'Question';
    if (name === 'answer.md') return 'Answer';
    if (name.endsWith('.json')) return 'Original response';
    const match = REPORT_FILE.exec(name);
    return match ? `${methodLabel(match[1])} report${match[2] ? ` ${match[2]}` : ''}` : name;
  }
  return { sources: list, label, methodLabel, fileLabel, size: list.length };
}

export const fileKind = file => {
  const name = basename(file);
  return name === 'dig.md' ? 'question' : name === 'answer.md' ? 'answer' : name.endsWith('.json') ? 'raw' : 'report';
};
