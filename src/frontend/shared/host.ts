import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { VERSION } from '../../version.mjs';

export type DigHost = {
  /** Served by Dig's service in a browser (through a one-time address): the same tools through /api, without a host's own actions. */
  browser: boolean;
  start(): Promise<void>;
  dispose(): void;
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  openLink(url: string): Promise<void>;
  openFile(path: string): Promise<void>;
  requestDisplayMode(mode: 'inline' | 'fullscreen'): Promise<string | null>;
  draft(text: string): Promise<void>;
  getContext(): any;
  readDeepLink(): string | null;
  canOpenFile(): boolean;
  canDraft(): boolean;
  subscribeResult(callback: (result: any) => void): () => void;
  subscribeActivation(callback: (context: any) => void): () => void;
};

type HostOptions = {
  /** Dependency injection for isolated host protocol tests; production uses the MCP SDK. */
  appFactory?: () => any;
  extensionsFactory?: (app: any) => any;
};

function assertAccepted(result: any, fallback: string) {
  if (result?.isError) throw new Error(result.content?.find((part: any) => part.type === 'text')?.text || fallback);
}

/** Requests in a host never fall through to HTTP. The page the service serves in a browser (marked on its root
 * element) calls the service's /api with its session cookie. */
export function createDigHost(name: string, options: HostOptions = {}): DigHost {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const surface = globalThis.document?.getElementById('root')?.dataset;
  const browser = surface?.digBrowser !== undefined;
  const results = new Set<(result: any) => void>();
  const activations = new Set<(context: any) => void>();
  let app: any;
  let extensions: any;
  let startTask: Promise<void> | undefined;
  let disposed = false;
  let browserContext: any = {};
  const apply = (context: any) => {
    if (context?.theme) applyDocumentTheme(context.theme);
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
    // Host font-family variables are inherited. The package adds no network-loaded fonts.
  };
  const onContext = (context: any) => {
    if (disposed) return;
    apply(context);
    for (const callback of activations) callback(context);
  };
  const onResult = (result: any) => {
    if (!disposed) for (const callback of results) callback(result);
  };
  const requireNative = () => {
    if (disposed) throw new Error('This Dig view has closed.');
    if (browser) throw new Error('This action is available in a host that shows Dig’s views, not in the browser.');
    if (!app) throw new Error('Dig has not connected to the host yet.');
  };
  const host: DigHost = {
    browser,
    start() {
      if (disposed) return Promise.reject(new Error('This Dig view has closed.'));
      if (startTask) return startTask;
      startTask = (async () => {
        if (browser) {
          const theme = params.get('theme') ?? (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : null);
          if (theme === 'dark' || theme === 'light') apply({ theme });
          browserContext = { toolInfo: { tool: { name: params.has('panel') || surface?.digSurface === 'trail' ? 'open_trail' : 'open_library' } } };
          return;
        }
        app = options.appFactory?.() ?? new App({ name, version: VERSION });
        extensions = options.extensionsFactory?.(app) ?? new OpenAIExtensions(app);
        app.addEventListener('toolresult', onResult);
        app.addEventListener('hostcontextchanged', onContext);
        await app.connect();
        if (disposed) { await app.close?.(); return; }
        apply(app.getHostContext());
      })();
      return startTask;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      results.clear(); activations.clear();
      app?.removeEventListener('toolresult', onResult);
      app?.removeEventListener('hostcontextchanged', onContext);
      Promise.resolve(app?.close?.()).catch(() => {});
    },
    async call(name, args = {}) {
      if (disposed) throw new Error('This Dig view has closed.');
      let result;
      if (browser) {
        if (!/^[a-z][a-z0-9_.]*$/.test(name)) throw new Error('Invalid Dig operation.');
        const response = await fetch(`/api/${name}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
        if (!response.ok) {
          // The service's answer says how to open Dig again, with the command it was started with.
          if (response.status === 401) throw new Error(`This browser session has ended. ${await response.text().then(text => text.trim(), () => '') || 'Ask the assistant to open Dig\'s library again.'}`);
          const failed: any = await response.json().catch(() => null);
          throw new Error(failed?.content?.find?.((part: any) => part.type === 'text')?.text || failed?.error || `Dig request failed (${response.status}).`);
        }
        result = await response.json();
      } else {
        requireNative();
        result = await app.callServerTool({ name, arguments: args });
      }
      assertAccepted(result, 'Dig could not complete this request.');
      return result?.structuredContent ?? result;
    },
    async openLink(url) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('This link is invalid.'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('This link type cannot be opened by Dig.');
      if (browser && !disposed) { window.open(parsed.href, '_blank', 'noopener,noreferrer'); return; }
      requireNative();
      assertAccepted(await app.openLink({ url }), 'The host did not open this link.');
    },
    async requestDisplayMode(mode) {
      if (browser) return null;
      requireNative();
      const context = app.getHostContext();
      if (!context?.availableDisplayModes?.includes(mode)) return context?.displayMode ?? null;
      const result = await app.requestDisplayMode({ mode });
      assertAccepted(result, 'The host could not change Dig’s display mode.');
      return result.mode;
    },
    async openFile(path) {
      requireNative();
      if (!extensions?.files) throw new Error('This host does not offer a file opener.');
      assertAccepted(await extensions.files.open(path), 'The host did not open this file.');
    },
    async draft(text) {
      requireNative();
      if (!extensions?.message) throw new Error('This host does not support placing a draft in the composer.');
      if (!text.trim()) throw new Error('The draft is empty.');
      // Explicit send:false is the only behavior. A rejected draft never becomes a sent message.
      assertAccepted(await extensions.message.send({
        role: 'user',
        content: [{ type: 'text', text }],
        _meta: { 'openai/message': { target: 'active', send: false } },
      }), 'The host did not place this draft in the composer.');
    },
    getContext() { return browser ? browserContext : app?.getHostContext() ?? {}; },
    // A reader address (`/read?file=…`) given to the page itself; in a host there is none.
    readDeepLink() {
      const raw = browser ? params.get('path') : null;
      if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return null;
      try {
        const parsed = new URL(raw, 'https://dig.invalid');
        return parsed.origin === 'https://dig.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : null;
      } catch { return null; }
    },
    canOpenFile() { return !browser && !disposed && Boolean(extensions?.files); },
    canDraft() { return !browser && !disposed && Boolean(extensions?.message); },
    subscribeResult(callback) { results.add(callback); return () => { results.delete(callback); }; },
    subscribeActivation(callback) { activations.add(callback); return () => { activations.delete(callback); }; },
  };
  return host;
}
