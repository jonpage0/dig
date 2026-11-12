// The views: the library, the research trail and the saved-research card. To a client that declares the MCP Apps
// extension (io.modelcontextprotocol/ui) they are `ui://` resources, with `open_library` and `open_trail` to open them
// and the tools only the views call (visibility app, so the host keeps them from the model); a client that declares
// nothing sees only `open_library`. The same pages and tools are served to a browser by service.ts, for hosts that
// render no views: there `open_library` (or the `open` command) gives the person a one-time address.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { EXTENSION_ID, RESOURCE_MIME_TYPE, getUiCapability, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { CallToolResult, ClientCapabilities, McpServer, RegisteredResource, RegisteredTool, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { loadConfig, updateConfig } from '../config.mjs';
import { settingsDocument, settingsValues } from '../catalog.mjs';
import { librarySnapshot, libraryFingerprint, savedResearchCard } from '../surfaces.mjs';
import { ALL_MODULES } from '../providers/modules.ts';
import { VERSION } from '../version.mjs';
import { activity, handleOf, NO_DIG, refused, resolveHandle } from './calls.ts';
import { jobs } from './jobs.ts';
import { askerOf, keyAddress, openInBrowser } from './ask.ts';
import { digCommand } from './service.ts';
import type { ServiceHooks } from './mcp.ts';

type Config = Awaited<ReturnType<typeof loadConfig>>;
type Json = Record<string, unknown>;
const reply = (value: Json, line = ''): CallToolResult => ({ content: line ? [{ type: 'text', text: line }] : [], structuredContent: value });
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const localWrite = { destructiveHint: false, openWorldHint: false };

// A host caches a view by its resource URI, so each version publishes its views under URIs that carry the version and
// a new version loads its own view instead of a copy cached for an earlier one.
export const LIBRARY_URI = `ui://dig/library/v${VERSION}.html`;
export const TRAIL_URI = `ui://dig/trail/v${VERSION}.html`;
export const CARD_URI = `ui://dig/saved/v${VERSION}.html`;

// The built pages: dist/ beside the bundled service, or the repository's dist/ from src/service. Read once and served
// from memory.
const DIST = ['./', '../../dist/'].map(path => new URL(path, import.meta.url)).find(url => existsSync(new URL('library.html', url))) ?? new URL('../../dist/', import.meta.url);
const pages = new Map<string, string>();
const built = (name: 'library' | 'card') => {
  let html = pages.get(name);
  if (html === undefined) { try { html = readFileSync(new URL(`${name}.html`, DIST), 'utf8'); } catch { throw new Error(`Dig's ${name} view is not built; run npm run build`); } pages.set(name, html); }
  return html;
};
const root = (html: string, attributes: string) => html.replace('<div id="root">', `<div id="root"${attributes}>`);
/** A page as served: in a host (an MCP App) or in a browser, where it calls /api instead of the host. */
export function viewPage(view: 'library' | 'trail' | 'card', browser: boolean) {
  const html = built(view === 'card' ? 'card' : 'library');
  return root(html, `${view === 'trail' ? ' data-dig-surface="trail"' : ''}${browser ? ' data-dig-browser=""' : ''}`);
}

/** Whether a client declared the MCP Apps extension (for HTML views, when it names the MIME types it renders). */
export function declaresUi(capabilities: ClientCapabilities | null | undefined) {
  const ui = getUiCapability(capabilities);
  return !!ui && (!Array.isArray(ui.mimeTypes) || ui.mimeTypes.includes(RESOURCE_MIME_TYPE));
}
/** The host a client names itself as, for the views' wording; `any` when Dig does not know it, as in a browser. */
export const clientHost = (name: unknown) => typeof name !== 'string' ? 'any' : /claude/i.test(name) ? 'claude-code' : /codex|openai|chatgpt/i.test(name) ? 'codex' : 'any';

/** What a view tool needs from where it runs: the wording host, the service's address (the key page) and the settings hook. */
export interface ViewContext { host: string; origin: string; settingsChanged(c: Config): void }

// ---- The views' data ---------------------------------------------------------------------------------------------
/**
 * The library snapshot (surfaces.mjs) as this service gives it: each item with its dig handle, and the jobs running now
 * with their action and start.
 */
export async function snapshot(c: Config, host: string) {
  const base = await librarySnapshot(c, activity, host) as Json & { items: { project: string; id: string }[] };
  const running = (await jobs()).running().map(job => ({ id: job.id, dig: job.dig, source: job.source, tool: job.tool, createdAt: job.createdAt }));
  return { ...base, items: base.items.map(item => ({ ...item, dig: handleOf(item.project, item.id) })), jobs: running };
}
/** The snapshot's change fingerprint: the library's (surfaces.mjs), and which jobs are running. */
export async function revision(c: Config) {
  const running = (await jobs()).running().map(job => job.id).sort();
  return createHash('sha256').update(JSON.stringify([await libraryFingerprint(c, activity), running])).digest('hex').slice(0, 24);
}

const ASK_ABOVE = { type: 'number', minimum: 0, title: 'Ask before a paid call (US dollars)', description: 'Dig asks the person before a paid call whose action has typically cost at least this much in this library, or has no priced call yet; 0 never asks.' };
/**
 * Every settings field's value: the catalog's, and spend_ask_above_usd, which the service adds beside them.
 */
export const settingsFieldValues = (c: Config) => { const { spend_dig_ceiling_usd, ...rest } = settingsValues(c); return { spend_dig_ceiling_usd, spend_ask_above_usd: (c.spend as { ask_above_usd?: number | null }).ask_above_usd ?? 0, ...rest }; };
/** What the Settings and Sources pages read: the catalog's schema and layout with spend_ask_above_usd beside the ceiling, and the settings tool's values. */
export function settingsView(c: Config) {
  const doc = settingsDocument(c) as { schema: { type: string; properties: Record<string, Json> }; layout: { kind: string; title?: string; items?: { kind: string; property?: string }[] }[] };
  const layout = doc.layout.map(group => group.title !== 'Library' ? group : { ...group, items: (group.items ?? []).flatMap(item => item.property === 'spend_dig_ceiling_usd' ? [item, { kind: 'property', property: 'spend_ask_above_usd' }] : [item]) });
  return { schema: { ...doc.schema, properties: { ...doc.schema.properties, spend_ask_above_usd: ASK_ABOVE } }, layout, values: settingsFieldValues(c) };
}

interface ViewTool { title: string; description: string; inputSchema: z.ZodObject; resourceUri: string; write?: boolean; run(args: Json, view: ViewContext): Promise<CallToolResult> }
const guard = (run: ViewTool['run']): ViewTool['run'] => async (args, view) => { try { return await run(args, view); } catch (error) { return refused(error instanceof Error ? error.message : String(error)); } };
/** The tools only the views call. Never a source tool: none of them sends a provider request. */
export const VIEW_TOOLS: Record<string, ViewTool> = {
  library_snapshot: { title: 'Library view', description: 'The views\' library snapshot.', inputSchema: z.object({}), resourceUri: LIBRARY_URI,
    run: guard(async (_args, view) => reply(await snapshot(await loadConfig(), view.host))) },
  library_revision: { title: 'Library revision', description: 'The snapshot\'s change fingerprint.', inputSchema: z.object({}), resourceUri: LIBRARY_URI,
    run: guard(async () => reply({ revision: await revision(await loadConfig()) })) },
  saved_research: { title: 'Saved research card', description: 'One saved report or answer, for the card.', inputSchema: z.object({ file: z.string().min(1) }), resourceUri: CARD_URI,
    run: guard(async ({ file }, view) => {
      const c = await loadConfig(); const { link: _link, ...card } = await savedResearchCard(c, file as string, await librarySnapshot(c, activity, view.host)) as Json;
      return reply(card);
    }) },
  view_settings: { title: 'Settings view', description: 'Settings with schema and layout; set changes fields as the settings tool does.', inputSchema: z.object({ set: z.record(z.string(), z.unknown()).optional() }), resourceUri: LIBRARY_URI, write: true,
    run: guard(async ({ set }, view) => {
      const fields = set as Json | undefined; const changing = !!fields && Object.keys(fields).length > 0;
      const c = changing ? await updateConfig(fields) : await loadConfig();
      if (changing) view.settingsChanged(c);
      return reply(settingsView(c));
    }) },
  view_keys: { title: 'Key page', description: 'A one-time key page address; never a value.', inputSchema: z.object({ source: z.enum(ALL_MODULES as [string, ...string[]]).optional() }), resourceUri: LIBRARY_URI, write: true,
    run: guard(async ({ source }, view) => {
      const page = await keyAddress(source as string | undefined, view.origin);
      return reply(page ?? { address: null, names: [] }, page ? `Key page: ${page.address}` : 'Every credential the enabled sources use is already set.');
    }) },
};

// ---- MCP Apps ----------------------------------------------------------------------------------------------------
// The SDK fixes a request's client capabilities after the server instance is built (from the request's envelope on
// 2026-07-28, from the handshake on a 2025-era session), so whether a view tool or resource exists is read when it is
// listed or called rather than when it is registered.
const onlyWhen = <T extends RegisteredTool | RegisteredResource>(registered: T, when: () => boolean) => { Object.defineProperty(registered, 'enabled', { get: when, set: () => {}, configurable: true }); return registered; };
// Where a host places a view (ChatGPT's sidebar for the library, beside the conversation for the trail).
const entrypoint = (type: 'global' | 'thread', resourceUri: string) => ({ ui: { resourceUri }, 'openai/ui': { entrypoints: [{ type }] }, 'openai/iconStyle': 'monochrome' });
const OPEN = z.object({ view: z.enum(['library', 'panel']), dig: z.string().nullable(), library: z.string() });
// open_library's result for a client without views: the same fields, whether the host opened the page, else the address.
const OPEN_BROWSER = OPEN.extend({ opened: z.boolean(), address: z.string().optional(), expiresAt: z.string().optional() });
const NO_NETWORK = () => ({ connectDomains: [] as string[], resourceDomains: [] as string[] });
const RESOURCES: { name: string; uri: string; view: 'library' | 'trail' | 'card'; meta: { ui: { csp: ReturnType<typeof NO_NETWORK>; prefersBorder?: boolean }; 'openai/ui': Json } }[] = [
  { name: 'dig-library', uri: LIBRARY_URI, view: 'library', meta: { ui: { csp: NO_NETWORK() }, 'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } } },
  { name: 'dig-saved', uri: CARD_URI, view: 'card', meta: { ui: { csp: NO_NETWORK(), prefersBorder: true }, 'openai/ui': { preferredDisplayMode: 'inline', availableDisplayModes: ['inline'] } } },
  { name: 'dig-trail', uri: TRAIL_URI, view: 'trail', meta: { ui: { csp: NO_NETWORK(), prefersBorder: true }, 'openai/ui': { preferredDisplayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } } },
];

/**
 * Serves the views on one server instance, to a client that declares the extension or is ChatGPT or Codex: the three `ui://` resources,
 * open_library and open_trail, and the view tools. Returns `showsCard`, which gives a tool the saved-research card as
 * its view for such a client (research_save and dig_finish).
 */
export function registerViews(server: McpServer, hooks: ServiceHooks, era: 'modern' | 'legacy') {
  // ChatGPT desktop and Codex render MCP Apps from a tool's own metadata and declare no extension (Codex 0.167.2
  // declares none at all, on a 2025 revision), so a client that names itself as that host gets the views too.
  const ui = () => declaresUi(server.server.getClientCapabilities()) || clientHost(server.server.getClientVersion()?.name) === 'codex';
  server.server.registerCapabilities({ extensions: { [EXTENSION_ID]: {} } });
  const context = (): ViewContext => ({ host: clientHost(server.server.getClientVersion()?.name), origin: hooks.origin, settingsChanged: hooks.settingsChanged });
  for (const resource of RESOURCES) {
    onlyWhen(registerAppResource(server, resource.name, resource.uri, { _meta: { ui: resource.meta.ui } }, async () => ({ contents: [{ uri: resource.uri, mimeType: RESOURCE_MIME_TYPE, text: viewPage(resource.view, false), _meta: resource.meta }] })), ui);
  }
  // open_library is every client's. With views, the view loads its own snapshot through library_snapshot and the model
  // only learns which view was requested. Without them, the client is asked to open the library in the person's browser,
  // and its listing carries neither the view metadata nor the view's result shape.
  const library = registerAppTool(server, 'open_library', {
    title: 'Dig', description: 'Open the retained research library: as a view where the host shows views, else in the person\'s browser. This never launches research.', inputSchema: z.object({}), outputSchema: OPEN, annotations: readOnly, _meta: entrypoint('global', LIBRARY_URI),
  }, async (_args, ctx) => {
    const base = { view: 'library' as const, dig: null, library: (await loadConfig()).library };
    // Codex in a terminal names itself as ChatGPT desktop's client does, so it is given the views and shows none: the
    // text carries the command that opens the library in a browser there.
    if (ui()) return reply(base, `Requested the Dig library view. Where the host shows no view (Codex in a terminal), the person runs: ${digCommand()} open`);
    try {
      const opened = await openInBrowser(askerOf(era, server, ctx), hooks.openAddress);
      return 'pending' in opened ? opened.pending : reply({ ...base, ...opened.value }, opened.line);
    } catch (error) { if (ctx.mcpReq.signal.aborted) throw error; return refused(error instanceof Error ? error.message : String(error)); }
  });
  const viewMeta = library._meta; const viewOutput = library.outputSchema;
  Object.defineProperty(library, '_meta', { get: () => (ui() ? viewMeta : undefined), set: () => {}, configurable: true });
  Object.defineProperty(library, 'outputSchema', { get: () => (ui() ? viewOutput : OPEN_BROWSER as StandardSchemaWithJSON), set: () => {}, configurable: true });
  onlyWhen(registerAppTool(server, 'open_trail', {
    title: 'Research trail', description: 'Show one dig\'s compact activity beside the conversation: its executing provider calls and running jobs, source counts and saved results. Pass the dig handle dig_start returned. Call it once in the initiating conversation, never from a source worker; the host decides whether and where the view opens, so do not retry or wait for it. Never launches research.',
    inputSchema: z.object({ dig: z.string().min(1).optional().describe('The dig handle dig_start returned.') }), outputSchema: OPEN, annotations: readOnly, _meta: entrypoint('thread', TRAIL_URI),
  }, async ({ dig }) => {
    const c = await loadConfig(); let handle: string | null = null;
    if (dig) try { handle = (await resolveHandle(c, dig)).handle; } catch { return refused(NO_DIG); }
    return reply({ view: 'panel', dig: handle, library: c.library }, handle ? `Requested the Research trail of dig ${handle}.` : 'Requested the Research trail.');
  }), ui);
  for (const [name, tool] of Object.entries(VIEW_TOOLS)) {
    onlyWhen(registerAppTool(server, name, {
      title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.write ? localWrite : readOnly,
      _meta: { ui: { resourceUri: tool.resourceUri, visibility: ['app'] } },
    }, async args => tool.run(args as Json, context())), ui);
  }
  const showsCard = (registered: RegisteredTool) => {
    const base = registered._meta;
    Object.defineProperty(registered, '_meta', { get: () => (ui() ? { ...base, ui: { resourceUri: CARD_URI }, 'ui/resourceUri': CARD_URI } : base), set: () => {}, configurable: true });
  };
  return { showsCard };
}
