import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadConfig, loadKeys } from '../src/config.mjs';
import { listLibrary, libraryFolder, libraryRevision, readLibraryFile } from '../src/library.mjs';
import { sourceInfo, settingsDocument, environmentPresence } from '../src/catalog.mjs';
import { packageReplaced, savedResearch } from '../src/surfaces.mjs';
import { VERSION } from '../src/version.mjs';
const port = Number(process.env.PORT || 43187);
loadKeys(); // Readiness reflects keys.env exactly as the server sees it.
const server = createServer(async (req, res) => {
  try {
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) { res.writeHead(403); res.end('Origin refused'); return; }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(await readFile(new URL('../plugin/dist/library.html', import.meta.url))); return; }
    if (req.method === 'GET' && url.pathname === '/card') { res.setHeader('Content-Type', 'text/html'); res.end(await readFile(new URL('../plugin/dist/card.html', import.meta.url))); return; }
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('Request too large'); }
    const args = JSON.parse(body || '{}'); const c = await loadConfig(); let value;
    if (url.pathname === '/api/library_snapshot') value = { ...(await listLibrary(c)), version: VERSION, replaced: packageReplaced(), library: c.library, libraryFolder: await libraryFolder(c), configPath: c.path, enabledSources: c.sources.enabled, sources: sourceInfo(c).sources.map(({ id, label }) => ({ id, label })), keepRaw: c.keep_raw };
    else if (url.pathname === '/api/library_revision') value = { revision: createHash('sha256').update(JSON.stringify([VERSION, packageReplaced(), await libraryRevision(c), c.library, await libraryFolder(c), c.keep_raw, c.sources.enabled, c.x, c.workers, environmentPresence()])).digest('hex').slice(0, 24) };
    else if (url.pathname === '/api/source_info') value = sourceInfo(c, args.source);
    else if (url.pathname === '/api/settings.read') value = settingsDocument(c);
    else if (url.pathname === '/api/library_read') value = await readLibraryFile(c, args.file, args.offset, args.limit);
    else if (url.pathname === '/api/saved_research') { const read = await readLibraryFile(c, args.file, 0, Number.MAX_SAFE_INTEGER); value = savedResearch(await listLibrary(c), read.file, read.text); }
    else { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
  } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: e.message }] })); }
});
server.listen(port, '127.0.0.1', () => console.log(`Read-only preview: http://127.0.0.1:${port}/?preview=1 · saved-research card: http://127.0.0.1:${port}/card?preview=1&file=<library file>`));
