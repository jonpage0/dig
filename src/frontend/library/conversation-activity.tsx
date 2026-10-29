import React, { useState } from 'react';
import { Button } from '../shared/components';
import { costShort, plural } from '../../ui/format.mjs';
import { projectConversationActivity } from './research-state';
import { SourceIcon } from './source-icon';

const toolLabel = (tool: string) => ({ xsearch: 'Semantic search', x_search_posts: 'Post search', x_post: 'Reading posts',
  exa_search: 'Search', exa_contents: 'Reading pages', youtube_analyze: 'Video analysis', video_analyze: 'Video analysis' } as Record<string, string>)[tool] || tool.replace(/_/g, ' ');

export function ConversationActivity({ app, hidden }: { app: any; hidden: boolean; host?: any }) {
  const scope = projectConversationActivity(app.snapshot, app.thread);
  const [allSources, setAllSources] = useState(false);
  const [allResults, setAllResults] = useState(false);
  const sourceLimit = Math.max(5, scope.sources.filter(row => row.active.length).length);
  const shownSources = allSources ? scope.sources : scope.sources.slice(0, sourceLimit);
  const shownResults = allResults ? scope.digs : scope.digs.slice(0, 3);
  const liveAvailable = scope.liveAvailable && !app.updatesFailed;
  const active = scope.activeCalls.length;
  const status = app.updatesFailed ? 'Updates paused' : !scope.identified ? 'Conversation not identified'
    : !scope.liveAvailable ? 'Live status unavailable' : active ? `${plural(active, 'call')} running` : 'No active calls';
  const read = (item: any) => { void app.showDig(item); };
  return <section id="panel" className="conversation-activity" hidden={hidden} aria-label="Dig conversation activity">
    <header className="activity-header"><div><strong>Dig</strong><span id="panel-scope">This conversation</span></div>
      <Button size="sm" variant="ghost" onClick={() => { void app.go('/library'); }}>Open library <span aria-hidden="true">↗</span></Button>
    </header>
    <div className="activity-status" role="status"><span className="activity-indicator" data-running={liveAvailable && active > 0} aria-hidden="true" />{status}</div>
    {scope.identified ? <>
      <dl id="panel-figures" className="activity-counts">
        <div><dt>Running</dt><dd>{liveAvailable ? active : '—'}</dd></div>
        <div><dt>Calls</dt><dd>{scope.totalCalls}</dd></div>
        <div><dt>{app.catalog.groupLabel(scope.sources.map(row => row.source))}</dt><dd>{scope.sources.length}</dd></div>
        <div><dt>Reports</dt><dd>{scope.reports}</dd></div>
      </dl>
      <div className="activity-sources" aria-label="Source activity">
        {shownSources.map(row => <div className="activity-source" key={row.source} data-running={row.active.length > 0 && liveAvailable}>
          <SourceIcon id={row.source} />
          <div className="activity-source-name"><strong>{app.catalog.label(row.source)}</strong>
            {!!row.active.length && <span>{[...new Set(row.active.map(call => toolLabel(call.tool)))].join(' · ')}</span>}
          </div>
          <div className="activity-source-counts">
            {!!row.active.length && <span className="activity-active">{row.active.length} {liveAvailable ? 'running' : 'last seen active'}</span>}
            {!!row.finished.length && <span>{row.finished.length} finished</span>}
            {!!row.partial && <span>{row.partial} partial</span>}{!!row.failed && <span className="activity-problem">{row.failed} failed</span>}
            {!!row.stopped && <span>{row.stopped} stopped / skipped</span>}{!!row.empty && <span>{row.empty} empty</span>}
          </div>
        </div>)}
        {scope.sources.length > sourceLimit && <Button size="sm" variant="ghost" className="activity-expand" aria-expanded={allSources} onClick={() => setAllSources(!allSources)}>{allSources ? 'Show fewer sources' : `Show all ${scope.sources.length} sources`}</Button>}
        {!scope.sources.length && <p className="activity-empty">{app.snapshotLoaded ? 'Source activity will appear here when a call starts.' : 'Loading activity…'}</p>}
      </div>
      {!!scope.digs.length && <div id="panel-digs" className="activity-results" aria-label="Saved research">
        {shownResults.map(item => <button type="button" key={`${item.project}:${item.id}`} className="activity-result" onClick={() => read(item)}>
          <span>{item.displayTitle || item.title}</span><span>{item.answer ? 'Answer' : plural(item.reports?.length ?? 0, 'report')} <span aria-hidden="true">↗</span></span>
        </button>)}
        {scope.digs.length > 3 && <Button size="sm" variant="ghost" className="activity-expand" aria-expanded={allResults} onClick={() => setAllResults(!allResults)}>{allResults ? 'Show fewer results' : `Show all ${scope.digs.length} results`}</Button>}
      </div>}
      <footer className="activity-footer"><span>{plural(scope.calls.length, 'finished call')}{scope.calls.length ? ` · ${costShort(scope.cost, scope.calls.length)}` : ''}</span>
        <details><summary aria-label="Activity scope">Scope</summary><p>Only calls attributed to this conversation or its research groups are counted. Live status covers this Dig connection; separate worker connections and provider background jobs may continue elsewhere. Finished calls include partial, empty and failed results. Provider usage excludes the conversation model.</p></details>
      </footer>
    </> : <p className="activity-empty">The host has not identified this conversation, so Dig cannot select its calls. Open the library to see saved research.</p>}
  </section>;
}
