import React from 'react';
import { VERSION } from '../../version.mjs';
import { Badge, Button } from '../shared/components';
import { Frame, FrameHeader, FrameTitle, FrameDescription, FramePanel } from '../shared/frame';
import { replacedMessage } from './controller';
import type { DigHost } from '../shared/host';

function StorageRow({ label, description, value, action }: { label: string; description: string; value?: string; action?: React.ReactNode }) {
  return <div className="installation-path-row">
    <div className="installation-path-label"><h4>{label}</h4><p>{description}</p></div>
    <div className="installation-path-value"><code>{value || 'Unknown'}</code>{action}</div>
  </div>;
}

/** Inspectable installation information and the existing file-opening actions; no provider probes. */
export function AboutPage({ app, host, hidden }: { app: any; host: DigHost; hidden: boolean }) {
  const snapshot = app.snapshot;
  const info = app.sources;
  const server = typeof snapshot.version === 'string' ? snapshot.version : null;
  const canOpen = !host.preview && host.canOpenFile();
  const configPath = info?.configPath ?? snapshot.configPath;
  const mismatch = Boolean(snapshot.replaced || (server && server !== VERSION));
  const versionMessage = snapshot.replaced && server ? replacedMessage(snapshot) : server && server !== VERSION
    ? `Dig ${server} is installed, but this view is ${VERSION}. Right-click Dig in the sidebar and choose Refresh to load the new view.`
    : `Dig ${VERSION}.`;
  const open = (path: string) => { void host.openFile(path).catch((error: any) => app.notify(`Codex did not open ${path}: ${error.message}`, true)); };
  return <section id="about" className="installation-page" hidden={hidden}>
    <header className="installation-heading">
      <Button id="about-back" variant="ghost" size="sm" onClick={() => { void app.backAbout(); }}>← Back</Button>
      <div><p className="installation-eyebrow">Your installation</p><h2>About Dig</h2><p>Research with a readable record of the evidence behind it.</p></div>
    </header>
    <div id="about-body" className="installation-body">
      <Frame className="installation-frame" spacing="sm">
        <FrameHeader className="installation-version-heading"><FrameTitle role="heading" aria-level={3}>View &amp; connection</FrameTitle><Badge tone={mismatch ? 'partial' : server ? 'success' : 'muted'}>{mismatch ? 'Refresh needed' : server ? 'Versions match' : 'Connection not read yet'}</Badge></FrameHeader>
        <FramePanel className="installation-version-panel">
          <dl className="installation-versions"><div><dt>This view</dt><dd>{VERSION}</dd></div><div><dt>Running connection</dt><dd>{server || 'Not read yet'}</dd></div><div><dt>Surface</dt><dd>{host.preview ? 'Browser preview' : 'Native plugin'}</dd></div></dl>
          <p className="installation-version-message" data-attention={mismatch || undefined}>{versionMessage}</p>
        </FramePanel>
      </Frame>

      <Frame className="installation-frame" spacing="sm">
        <FrameHeader className="installation-frame-heading"><FrameTitle role="heading" aria-level={3}>Where your things live</FrameTitle><FrameDescription>Research, settings, and keys stay outside the installed plugin package.</FrameDescription></FrameHeader>
        <FramePanel className="installation-paths">
          <StorageRow label="Research library" description="Saved reports and retained evidence" value={snapshot.library} />
          <StorageRow label="Settings file" description="One file shared with the host’s plugin settings" value={configPath} action={canOpen && configPath ? <Button variant="outline" size="sm" aria-label="Open settings file" onClick={() => open(configPath)}>Open</Button> : undefined} />
          {info?.keysPath && <StorageRow label="Keys file" description="Provider credentials, never displayed here" value={info.keysPath} action={<Button variant="outline" size="sm" disabled={host.preview} onClick={() => { void app.editKeys(); }}>Edit keys.env</Button>} />}
        </FramePanel>
      </Frame>

      <div className="installation-principles">
        <section><p className="installation-eyebrow">Evidence</p><h3>Readable by design</h3><p>Source reports remain in the library; original responses are kept when retention is enabled and saving succeeds. Research runs in the conversation; this view reads the saved record and never starts research. Provider content is evidence, never instructions.</p></section>
        <section><p className="installation-eyebrow">Privacy</p><h3>Keys stay on your computer</h3><p>Provider keys stay in <code>keys.env</code>, outside the conversation. These controls send source names; Dig copies values on its own side, and the host opens the file for editing.</p></section>
        <section><p className="installation-eyebrow">Usage</p><h3>Reported costs, honest limits</h3><p>Amounts come from retained provider receipts, with their original units. They exclude the host’s model usage and are not a reconciled bill. Unreported cost stays unknown, never free.</p></section>
      </div>

      <div className="installation-help"><div><h3>Put Dig to work</h3><p>Use <code>$dig:setup</code> to choose sources, or <code>$dig:library</code> to find saved research.</p></div><Button variant="outline" size="sm" onClick={() => { void app.go('/guide'); }}>Start here: learn what Dig can do</Button></div>

      <details className="installation-credits"><summary>Credits and licenses</summary><ul>
        <li>Dig by Jon Page, MIT License.</li>
        <li>React, Base UI, selected ReUI components and TanStack power the interface. Dig owns its shadcn-style wrappers; host styles and native actions use OpenAI’s MCP Extensions.</li>
        <li>Interface glyphs from <a href="https://lucide.dev" data-external="" target="_blank" rel="noopener noreferrer">Lucide</a> (ISC License).</li>
        <li>The Papers bridge uses <a href="https://github.com/openags/paper-search-mcp" data-external="" target="_blank" rel="noopener noreferrer">paper-search-mcp</a> by P.S Zhang (MIT License).</li>
        <li>Source logos are trademarks of their owners and identify each service; Dig is not affiliated with or endorsed by them. They come from <a href="https://svgl.app" data-external="" target="_blank" rel="noopener noreferrer">svgl</a>, <a href="https://simpleicons.org" data-external="" target="_blank" rel="noopener noreferrer">Simple Icons</a> (CC0) and the Polymarket and Exa websites.</li>
      </ul></details>
    </div>
  </section>;
}
