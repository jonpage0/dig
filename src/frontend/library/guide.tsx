import React, { useEffect, useRef, useState } from 'react';
import { Button, Disclosure, Tabs, TabsList, TabsTrigger, TabsContent } from '../shared/components';
import { Frame, FrameHeader, FramePanel, FrameFooter } from '../shared/frame';
import { IconTile } from '../shared/icon-tile';
import { Timeline, TimelineContent, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from '../shared/timeline';
import { GLYPHS, glyphFor } from '../../glyphs.mjs';
import { MODULES, SOURCE_GROUPS } from '../../providers/modules.ts';
import { SOURCE_GUIDES } from '../../ui/source-guide.mjs';

type GuidePageProps = { hidden: boolean; onNavigate: (path: string) => unknown };
type UseCase = { id: string; icon: string; title: string; description: string; sources: string[]; prompt: string };

const STARTER = 'Use Dig and Hacker News to research how people choose a note-taking app. Find useful firsthand experiences, include disagreements, and save a report with links to the original discussions.';
const USE_CASES: UseCase[] = [
  { id: 'web', icon: 'globe', title: 'Get to the bottom of a question', description: 'Find useful web pages, compare claims, and read the sources behind an answer.', sources: ['exa', 'perplexity'],
    prompt: 'Use Dig to research [question]. Start with primary sources, compare the strongest evidence, and explain what is still uncertain. Tell me which sources you plan to use.' },
  { id: 'software', icon: 'folder-git-2', title: 'Choose or understand software', description: 'Compare projects, check maintenance activity, inspect code, and read developer discussions.', sources: ['github', 'deepwiki', 'hackernews'],
    prompt: 'Use Dig to compare [software options] for [what I need]. Check the repositories and recent developer experiences. Explain the tradeoffs and show the evidence.' },
  { id: 'papers', icon: 'graduation-cap', title: 'Explore a research topic', description: 'Find papers, follow related work, and inspect available full text rather than relying on a title alone.', sources: ['papers'],
    prompt: 'Use Dig Papers to investigate [research question]. Compare the strongest findings, explain limitations in plain language, and link the papers I should read.' },
  { id: 'people', icon: 'messages-square', title: 'Learn what people are saying', description: 'Read public posts, replies, communities, and firsthand experiences across social platforms.', sources: ['x', 'reddit', 'instagram', 'china-social'],
    prompt: 'Use Dig to explore firsthand experiences with [topic] on [platforms]. Include contrary experiences, read the original posts, and avoid treating popularity as proof.' },
  { id: 'video', icon: 'square-play', title: 'Understand a video or demonstration', description: 'Find videos, research what was said, or ask about what happens on screen and when.', sources: ['youtube', 'video'],
    prompt: 'Use Dig to analyze [video URL] for [question]. Use the transcript where it is enough; inspect the visuals where they matter. Give original timestamps and explain any gaps.' },
  { id: 'website', icon: 'chart-no-axes-combined', title: 'Help a website get found', description: 'Connect search and AI-answer observations to competing pages, your own pages, and specific improvements.', sources: ['dataforseo', 'exa'],
    prompt: 'Use Dig to examine how [website] could be found for [customer need] in [market]. Follow an important search result or AI answer to the competing page and our page. Propose specific changes and how to check them. Confirm the paid scope first.' },
  { id: 'ads', icon: 'megaphone', title: 'Study advertising and messaging', description: 'Explore public ad libraries and available creative data to compare angles, examples, and patterns.', sources: ['facebook-ads', 'tiktok-ads'],
    prompt: 'Use Dig to compare public ads from [advertisers] in [market]. Explain their messages and creative approaches. Keep observed ad information separate from guesses about performance.' },
  { id: 'markets', icon: 'shopping-cart', title: 'Compare products and market signals', description: 'Inspect product details, reviews, available price history, and prediction-market beliefs.', sources: ['commerce', 'polymarket'],
    prompt: 'Use Dig to investigate [product or market question]. Compare current details with available history and explain what the reviews or market prices do—and do not—establish.' },
];

const WORKFLOW = [
  { title: 'You bring the question', text: 'Say what you want to learn, why it matters, and any limits on sources, dates, or spending. A link, video, brand, or website gives Dig a useful starting point.' },
  { title: 'Your assistant chooses the sources', text: 'It can use one source or split the question among research helpers. Each source answers a particular part; Dig does not need to search everywhere.' },
  { title: 'Research becomes a record', text: 'Source research is saved as reports. When original-response retention is on and saving succeeds, the provider responses are kept too, along with call receipts.' },
  { title: 'Your assistant checks and explains', text: 'It reads the source reports and important originals, compares the findings, and explains the answer and its limits. You can return to the saved research later.' },
];

function Glyph({ name }: { name: string }) {
  const shapes = (GLYPHS as Record<string, any[]>)[name] ?? GLYPHS.shovel;
  return <svg className="guide-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {shapes.map(([tag, attributes], index) => React.createElement(tag, {
      key: index,
      ...Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])),
    }))}
  </svg>;
}

function Prompt({ title, text, featured = false }: { title: string; text: string; featured?: boolean }) {
  const [status, setStatus] = useState('');
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setStatus('Copied. Paste it into the conversation and make it your own.');
    } catch {
      setStatus('Select the example text and copy it, then paste it into the conversation.');
    }
  };
  return <div className={`guide-prompt${featured ? ' guide-prompt-featured' : ''}`}>
    <p className="guide-prompt-text">{text}</p>
    <div className="guide-prompt-actions"><Button variant={featured ? 'default' : 'ghost'} size="sm" aria-label={`Copy example: ${title}`} onClick={() => { void copy(); }}>Copy example</Button><span>Copying does not start research.</span></div>
    {status && <p className="guide-copy-status" role="status">{status}</p>}
  </div>;
}

function SectionHeading({ label, title, children }: { label: string; title: string; children?: React.ReactNode }) {
  return <div className="guide-section-heading"><span className="guide-eyebrow">{label}</span><h3>{title}</h3>{children && <p>{children}</p>}</div>;
}

const WORKED_PASSAGE = 'You can create and edit notes offline. Changes sync when you reconnect.';
function WorkedExample() {
  return <section className="guide-section guide-worked" aria-labelledby="guide-worked-title">
    <SectionHeading label="See how to check a finding" title="Follow the answer back to the words behind it" />
    <Frame spacing="sm">
      <FrameHeader className="guide-worked-header">
        <div><span className="guide-eyebrow">Illustrative example</span><h4 id="guide-worked-title">Sample Notebook</h4></div>
        <p>Made-up product and documentation for learning; no research was run.</p>
      </FrameHeader>
      <FramePanel>
        <p className="guide-worked-question"><span>Question</span>Can I edit notes without internet?</p>
        <div className="guide-worked-finding"><span className="guide-eyebrow">Finding</span><strong>Offline editing appears supported.</strong><p>Syncing requires a connection.</p></div>
        <Tabs defaultValue="finding" className="guide-worked-tabs">
          <TabsList aria-label="Inspect the illustrative evidence"><TabsTrigger value="finding">Finding</TabsTrigger><TabsTrigger value="passage">Supporting passage</TabsTrigger><TabsTrigger value="original">Original response</TabsTrigger></TabsList>
          <TabsContent value="finding" className="guide-worked-panel">
            <h5>The interpretation</h5><p>The sample documentation supports creating and editing notes while offline, with changes syncing after reconnection.</p>
            <p className="guide-worked-limit"><strong>Still unknown:</strong> this does not establish sync reliability or how conflicting edits are handled.</p>
          </TabsContent>
          <TabsContent value="passage" className="guide-worked-panel">
            <h5>The supporting words</h5><blockquote>{WORKED_PASSAGE}</blockquote><p className="guide-worked-caption">Passage from the made-up Sample Notebook documentation. Compare its exact wording with the finding.</p>
          </TabsContent>
          <TabsContent value="original" className="guide-worked-panel">
            <h5>The illustrative original response</h5><p>This small, made-up response shows where the passage came from. Real retained responses vary by provider.</p>
            <pre tabIndex={0} aria-label="Illustrative original response">{JSON.stringify({ illustrative: true, product: 'Sample Notebook', document: 'Offline editing', text: WORKED_PASSAGE }, null, 2)}</pre>
          </TabsContent>
        </Tabs>
      </FramePanel>
      <FrameFooter><p>One finding, three views: the interpretation, the supporting passage, and the original response.</p></FrameFooter>
    </Frame>
  </section>;
}

function Catalog({ onNavigate }: Pick<GuidePageProps, 'onNavigate'>) {
  const modules: readonly any[] = MODULES;
  const placed = new Set<string>();
  const groups: { id: string; label: string; modules: any[] }[] = SOURCE_GROUPS.map(group => ({
    id: group.id, label: group.label,
    modules: group.sources.flatMap(id => {
      const module = modules.find(entry => entry.id === id);
      if (!module || module.extends) return [];
      placed.add(module.id);
      return [module];
    }),
  }));
  const other = modules.filter(module => !module.extends && !placed.has(module.id));
  if (other.length) groups.push({ id: 'other', label: 'Other sources and tools', modules: other });
  return <Disclosure title="Every source and tool" className="guide-catalog">
    <p className="guide-muted">This is the catalog included with this edition. What you can use depends on the sources you enable, the accounts you connect, and the provider’s coverage.</p>
    <div className="guide-catalog-groups">{groups.filter(group => group.modules.length).map(group => <section key={group.id} aria-labelledby={`guide-catalog-${group.id}`}>
      <h4 id={`guide-catalog-${group.id}`}>{group.label}</h4>
      <ul>{group.modules.map(module => {
        const guide = (SOURCE_GUIDES as Record<string, any>)[module.id];
        const addOns = modules.filter(entry => entry.extends === module.id);
        return <li key={module.id} data-guide-source={module.id}>
          <span className="guide-catalog-icon"><Glyph name={glyphFor(module.id)} /></span>
          <div><strong>{module.label}</strong>{module.kind === 'tool' && <span className="guide-catalog-kind">Optional helper</span>}
            <p>{module.description}</p>
            {guide?.tasks && <details className="guide-catalog-more"><summary>What it can do</summary><ul>{guide.tasks.map((task: string) => <li key={task}>{task}</li>)}</ul></details>}
            {addOns.map(addOn => <div className="guide-catalog-addon" key={addOn.id} data-guide-source={addOn.id}><strong>{addOn.label}</strong><span className="guide-catalog-kind">Optional add-on</span><p>{addOn.description}</p></div>)}
          </div>
        </li>;
      })}</ul>
    </section>)}</div>
    <Button variant="outline" size="sm" onClick={() => { void onNavigate('/sources'); }}>See setup and availability</Button>
  </Disclosure>;
}

export function GuidePage({ hidden, onNavigate }: GuidePageProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (hidden) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  }, [hidden]);
  const sourceNames = (ids: string[]) => ids.map(id => MODULES.find(module => module.id === id)?.label).filter(Boolean).join(' · ');
  return <section id="guide" className="guide-page" hidden={hidden} aria-labelledby="guide-title">
    <div className="guide-intro">
      <div className="guide-intro-copy">
        <span className="guide-eyebrow">Start here</span>
        <h2 id="guide-title" ref={heading} tabIndex={-1}>Research a question.<br />Keep the evidence.</h2>
        <p className="guide-lede">Dig gives your assistant a wide range of places to research—and a library for keeping what it finds. Ask in the conversation, then use Dig to explore the reports, sources, and costs behind the answer.</p>
        <div className="guide-intro-actions"><Button size="sm" onClick={() => { void onNavigate('/sources'); }}>Explore sources &amp; tools</Button><Button variant="ghost" size="sm" onClick={() => { void onNavigate('/library'); }}>Open your library</Button></div>
      </div>
      <Frame className="guide-first-run" spacing="sm">
        <FrameHeader><span className="guide-eyebrow">Your first dig</span><h3>Start with one useful question</h3></FrameHeader>
        <FramePanel>
          <ol className="guide-start-steps">
            <li><span>1</span><div><strong>Choose a source</strong><p>Open Sources &amp; tools, or ask <code>$dig:setup</code> in the conversation. Hacker News needs no provider account.</p></div></li>
            <li><span>2</span><div><strong>Ask in the conversation</strong><p>Say “Use Dig…” and describe what you want to learn. You can name a source or let your assistant suggest one.</p></div></li>
            <li><span>3</span><div><strong>Open the saved report</strong><p>Read the findings, inspect the available originals, and ask a follow-up.</p></div></li>
          </ol>
        </FramePanel>
      </Frame>
    </div>

    <Frame className="guide-starter" spacing="sm">
      <FrameHeader><div><span className="guide-eyebrow">Try this</span><h3>A first question with no API key</h3></div><IconTile size="sm" variant="soft"><Glyph name="messages-square" /></IconTile></FrameHeader>
      <FramePanel><Prompt title="A first question" text={STARTER} featured /></FramePanel>
      <FrameFooter><p>Enable Hacker News first. You can change the topic to something you care about.</p></FrameFooter>
    </Frame>

    <section className="guide-section" aria-labelledby="guide-capabilities">
      <div className="guide-section-heading"><span className="guide-eyebrow">What you can do</span><h3 id="guide-capabilities">Follow the question across different kinds of evidence</h3><p>Use a focused source for a simple question, or combine several when the answer needs more than one perspective.</p></div>
      <div className="guide-use-cases">{USE_CASES.map(item => <Frame key={item.id} spacing="sm" className="guide-use-case">
        <FramePanel>
          <div className="guide-use-case-heading"><IconTile size="sm" variant="soft"><Glyph name={item.icon} /></IconTile><h4>{item.title}</h4></div>
          <p className="guide-use-case-description">{item.description}</p><p className="guide-source-names">{sourceNames(item.sources)}</p>
          <Disclosure title="Try a question" className="guide-example"><Prompt title={item.title} text={item.prompt} /></Disclosure>
        </FramePanel>
      </Frame>)}</div>
      <Catalog onNavigate={onNavigate} />
    </section>

    <div className="guide-explanation-grid">
      <section className="guide-section" aria-label="How Dig works">
        <SectionHeading label="Behind the scenes" title="From a question to an answer you can inspect" />
        <Timeline value={0} className="guide-workflow">{WORKFLOW.map((step, index) => <TimelineItem key={step.title} step={index + 1}>
          <TimelineHeader><TimelineSeparator /><TimelineTitle>{step.title}</TimelineTitle><TimelineIndicator>{index + 1}</TimelineIndicator></TimelineHeader>
          <TimelineContent><p>{step.text}</p></TimelineContent>
        </TimelineItem>)}</Timeline>
      </section>
      <section className="guide-section" aria-label="Reading your results">
        <SectionHeading label="What comes back" title="The answer, with a way to check it" />
        <Frame className="guide-results" spacing="sm" stacked>
          <FramePanel><h4>Reports explain the findings</h4><p>A report records what one source contributed, its useful links, and its limitations. A combined answer brings the sources together.</p></FramePanel>
          <FramePanel><h4>Originals let you look closer</h4><p>Available retained responses sit behind the report. Check what was actually returned, especially for a claim you plan to act on.</p></FramePanel>
          <FramePanel><h4>Cards make a finding easier to follow</h4><p>An insight card can show a comparison, supporting evidence, a limitation, or a proposed next step. A discussion draft waits for you to send it.</p></FramePanel>
          <FramePanel><h4>The library makes research reusable</h4><p>Ask Dig to find an earlier report or revisit a question with fresh information. Saved reports are a record of what was known then, not a live feed.</p></FramePanel>
        </Frame>
      </section>
    </div>

    <WorkedExample />

    <section className="guide-section" aria-label="Optional deeper understanding">
      <SectionHeading label="When the question needs more" title="A few specialist tools, used when they help" />
      <Frame className="guide-specialists" spacing="sm" stacked>
        <FramePanel><IconTile size="sm" variant="soft"><Glyph name="square-play" /></IconTile><div><h4>Video: what was said and what was shown</h4><p>Transcripts help answer speech-based questions. Optional Gemini analysis can examine a public YouTube video more deeply, compare videos, or focus on an interval. Glimpse can inspect a selected visual moment in a video or clip. Important quotes and timestamps still need checking against the original.</p></div></FramePanel>
        <FramePanel><IconTile size="sm" variant="soft"><Glyph name="list-tree" /></IconTile><div><h4>Evidence ranking: where to look first</h4><p>The optional Jev helper can suggest a reading order for excerpts already collected and flag how they relate to a claim. It keeps every candidate; a score is advice about reading, not proof that something is true.</p></div></FramePanel>
        <FramePanel><IconTile size="sm" variant="soft"><Glyph name="chart-no-axes-combined" /></IconTile><div><h4>SEO and GEO: help people find your website</h4><p>SEO means visibility in search results; GEO is the newer name for visibility in AI-generated answers. Dig can connect search or AI-answer data to the competing page and your own page, then propose a specific improvement and a way to check it. It does not publish changes or guarantee rankings or citations.</p></div></FramePanel>
      </Frame>
    </section>

    <div className="guide-practical-grid">
      <Frame className="guide-practical" spacing="sm">
        <FrameHeader><h3>Understanding costs</h3><p>You stay in control of the scope.</p></FrameHeader>
        <FramePanel>
          <dl className="guide-definitions">
            <div><dt>Money</dt><dd>When a provider reports a charge, Dig keeps that amount and currency. An incomplete amount is a known subtotal.</dd></div>
            <div><dt>Credits</dt><dd>Some services report their own credits. Those stay in their original units; credits from different services are not added together.</dd></div>
            <div><dt>Calls and unknown costs</dt><dd>Calls count uses of Dig’s research tools. One use may make several provider requests. Dig can count the activity even when its price is unknown. Unknown never means free.</dd></div>
          </dl>
          <p className="guide-practical-note">Provider services bill separately from your ChatGPT or Codex plan. Dig’s overview shows reported provider usage, not a reconciled invoice or your assistant’s model costs.</p>
        </FramePanel>
      </Frame>
      <Frame className="guide-practical" spacing="sm">
        <FrameHeader><h3>Where your information goes</h3><p>Local records, with external research services.</p></FrameHeader>
        <FramePanel>
          <ul className="guide-privacy">
            <li><strong>Saved research lives in your chosen library.</strong> Reports and call receipts stay outside the plugin package. Original responses are kept when retention is enabled and saving succeeds.</li>
            <li><strong>Research can send information to providers.</strong> The selected question, search terms, excerpts, URLs, or media go to the service being used. Video uploads and provider history have their own retention rules.</li>
            <li><strong>Keys belong outside the conversation.</strong> An API key is a credential that lets Dig use your provider account. Add it through Sources &amp; tools, never by pasting it into chat.</li>
          </ul>
        </FramePanel>
      </Frame>
    </div>

    <Frame className="guide-faq" spacing="sm">
      <FrameHeader><h3>A few useful things to know</h3></FrameHeader>
      <FramePanel>
        <Disclosure title="Do I need every source or an account for everything?"><p>No. Enable only what you want to use. Hacker News, DeepWiki, and Polymarket need no provider account; others may need a key, local software, or a separate sign-in. “Configured” means the local prerequisites are present, not that a live request has succeeded.</p></Disclosure>
        <Disclosure title="How do I ask a good research question?"><p>Include the decision you are making, the people or market you care about, and any date range. Mention links you already have. Ask for disagreements, missing evidence, and a clear next step. For paid work, state a budget or ask to review the scope first.</p></Disclosure>
        <Disclosure title="Can I trust every finding or source?"><p>Dig makes the evidence easier to inspect; it does not make a provider or AI interpretation infallible. Coverage can be incomplete, social posts can be wrong, and model confidence is not a truth certificate. For important decisions, check the original evidence and unresolved limits.</p></Disclosure>
        <Disclosure title="Will Dig keep watching a topic automatically?"><p>Opening Dig does not start research or monitoring. Ask for fresh research when you need it. If you arrange a scheduled chat task separately, that task must still have the right access and paid scope; Dig itself is not an alerting service.</p></Disclosure>
      </FramePanel>
    </Frame>
    <div className="guide-bottom">
      <div><h3>Start small. Ask the follow-up.</h3><p>A useful first report is enough to begin. The conversation is where you steer the research.</p></div>
      <div className="guide-bottom-actions"><Button variant="outline" size="sm" onClick={() => { void onNavigate('/sources'); }}>Choose sources</Button><Button variant="ghost" size="sm" onClick={() => { void onNavigate('/settings'); }}>Library settings</Button><Button variant="ghost" size="sm" onClick={() => { void onNavigate('/about'); }}>About this installation</Button></div>
    </div>
  </section>;
}
