// UI guidance for the existing tools and methods. These examples never execute a provider request.
import { attr, button, fold, node } from './dom.mjs';
import { absTime } from './format.mjs';

export const SOURCE_GUIDES = {
  exa: { tasks: ['Fast or cache-only web discovery; page text and similar pages.', 'Snapshot reads of stored page content at a chosen date; these do not reconstruct historical rankings.'], example: 'Use Dig and Exa fast search to find primary sources for [question]. Keep the source text and save a report.' },
  perplexity: { tasks: ['Cited web answers and plain search results.', 'Reasoned comparisons; deep research only when requested.'], example: 'Use Dig and Perplexity to check [claim] against current primary sources.' },
  github: { tasks: ['Find and compare repositories, releases and maintenance activity.', 'Inspect a repository and read source files at an exact revision.'], example: 'Use Dig to compare GitHub repositories for [need]. Inspect the strongest candidates and explain the evidence and limits.' },
  deepwiki: { tasks: ['Explore a public repository’s generated documentation.', 'Ask codebase questions and identify source files to verify.'], example: 'Use Dig and DeepWiki to explain how [repository] implements [feature], then identify what needs checking in its source.' },
  hackernews: { tasks: ['Search stories, Ask HN, Show HN and comments.', 'Read a specific story and its comment tree with explicit page limits.'], example: 'Use Dig to read this Hacker News thread: [URL]. Explain the strongest arguments and what the comments do not establish.' },
  papers: { tasks: ['Find papers, related work, citations and supporting passages.', 'Read available full text, PDFs and sections through the configured Papers tools.'], example: 'Use Dig Papers to find research on [question]. Separate paper findings from your interpretation and retain the evidence.' },
  youtube: { tasks: ['Find videos and check creator claims against saved transcripts. Local captions and the optional hosted transcript route remain available.', 'Analyze supplied public YouTube videos with Gemini 3.8 Flash as the standard deeper method; choose Gemini 4 Argon for harder reasoning.', 'Focus on intervals, compare up to ten videos and ask follow-up questions. Choose fixed sampling or let Gemini direct its inspection; adjust detail and request structured findings when useful.', 'Continue or cancel longer analyses through the conversation. Optional web grounding and URL context require an explicit choice; video evidence stays separate. Glimpse remains available for a focused visual need.'], example: 'Use Dig’s YouTube video method to analyze [public YouTube URL] for [question]. Start with Gemini 3.8 Flash, identify timestamped evidence and preserve the analysis limits.' },
  video: { tasks: ['Ask a focused visual question about a supplied video or bounded clip directly in the conversation; no dig or report is required.', 'Send the media to Elorian Glimpse for model-generated analysis, then check important claims against the original. Appropriate source methods can also use this shared tool.', 'For broader YouTube analysis, use Gemini 3.8 Flash first and Argon for harder reasoning, unless you choose Glimpse or need focused visual inspection.'], example: 'Use Dig’s Video analysis tool to inspect [video or local project file] for [specific visual question]. State the clip coverage and distinguish observed details from interpretation.' },
  evidence: { tasks: ['Suggest a reading order when a supplied shortlist is burdensome to compare. A few obvious candidates usually need no extra call.', 'Compare each supplied excerpt with an optional claim; relevant contradictions deserve attention alongside supporting evidence.', 'Send only the selected text to TypeSafe Jev. Every candidate remains available; scores and confidence guide reading and do not establish truth. Full reports and important originals still need reading.'], example: 'Use Dig’s optional Evidence ranking helper to prioritize these supplied excerpts for [question]. Keep every candidate, include contradictions, and explain which originals still need reading.' },
  x: { tasks: ['Weigh claims with X judge, discover broadly with X breadth, or inspect exact posts.', 'Read threads, Communities and available media descriptions; account-only reads need the optional sign-in.'], example: 'Use Dig X judge to examine what practitioners are saying about [topic]. Read the original posts behind the important claims.' },
  reddit: { tasks: ['Find public Reddit discussions.', 'Read thread comments and separate anecdotes from corroborated claims.'], example: 'Use Dig Reddit to investigate firsthand experiences with [topic], including contrary experiences.' },
  'tikhub-reddit': { tasks: ['Explore subreddit context and advanced Reddit discovery.', 'Enrich selected posts and read available comment trees.'], example: 'Use Dig TikHub Reddit to investigate [topic] in [subreddit] and retain the relevant discussions.' },
  tiktok: { tasks: ['Search public videos and Top results, including photo posts.', 'Read selected post details and comments.'], example: 'Use Dig TikTok to find public examples of [topic] and inspect comments on the strongest matches.' },
  instagram: { tasks: ['Read public Instagram accounts, posts and reels.', 'Inspect available comments and caption evidence.'], example: 'Use Dig Instagram to inspect [public post URL], its caption and available comments.' },
  facebook: { tasks: ['Read public posts, profiles, groups and events.', 'Search available videos and inspect supported transcripts and comments.'], example: 'Use Dig Facebook to check the latest public notices from [official page] about [topic]. Preserve timestamps and coverage limits.' },
  threads: { tasks: ['Read public Threads posts and replies.', 'Inspect an account’s returned posts without assuming complete history.'], example: 'Use Dig Threads to inspect [post or account] and report what its returned posts establish.' },
  linkedin: { tasks: ['Inspect public professional and company information.', 'Read supported public posts and their context.'], example: 'Use Dig LinkedIn to check the public evidence for [company or professional question].' },
  telegram: { tasks: ['Read public Telegram channel and post previews.', 'Keep claims tied to their original public messages.'], example: 'Use Dig Telegram to inspect public posts from [channel] about [topic].' },
  'china-social': { tasks: ['Discover public material across supported Chinese social platforms.', 'Inspect original posts; provider coverage and alternative backends remain explicit.'], example: 'Use Dig China social to find firsthand examples of [topic] on [platform], and retain the original evidence.' },
  polymarket: { tasks: ['Discover markets and compare implied probabilities and liquidity.', 'Read token price history and resolution details; prices describe market beliefs.'], example: 'Use Dig Polymarket to inspect [market] and its price history. Separate market pricing from factual evidence.' },
  commerce: { tasks: ['Read Amazon product information, offers and reviews.', 'Inspect available price/rank history through the configured history provider.'], example: 'Use Dig Commerce to inspect [product] and compare its current details with available price history.' },
  'tiktok-ads': { tasks: ['Explore TikTok Creative Center analytics.', 'Read the separate public Ad Library and keep the two datasets distinct.'], example: 'Use Dig TikTok ads to find examples for [category and market], identifying which dataset each finding comes from.' },
  'facebook-ads': { tasks: ['Find Meta Ad Library advertisers and creatives.', 'Inspect ad dates and available transcripts without inferring campaign performance.'], example: 'Use Dig Facebook ads to examine [advertiser] and summarize the creative approaches in its available ads.' },
  dataforseo: { tasks: ['Research SERPs, keywords, rankings, backlinks and local businesses.', 'Use the AI visibility method to compare brand mentions, citations and historical observations.'], example: 'Use Dig’s DataForSEO AI visibility method to compare [brand] with [competitors] on [platform, market and time window]. Confirm the paid scope before retrieving data.' },
};

export function sourceGuide(id) {
  const guide = SOURCE_GUIDES[id];
  if (!guide) return null;
  const prompt = node('p', 'prompt-example', guide.example);
  const status = attr(node('p', 'meta'), 'role', 'status');
  const copy = button('btn-ghost', 'Copy example', async () => {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(guide.example);
      status.textContent = 'Copied. Paste it into the conversation and replace the bracketed text.';
    } catch {
      status.textContent = 'Select the example text and copy it, then paste it into the conversation.';
    }
  });
  const example = fold('source-example', `example:${id}`, node('span', 'fold-title', 'Example for the conversation'), prompt, copy, status);
  return node('section', 'source-guide', node('h5', '', 'What you can do'), node('ul', '', guide.tasks.map(task => node('li', '', task))), example.element);
}

/** Latest observed receipt per source, including calls not yet claimed by a report. No network probe or stored state. */
export function latestSourceCalls(snapshot) {
  const latest = new Map();
  for (const call of [...(snapshot.items ?? []).flatMap(item => item.calls ?? []), ...(snapshot.live ?? [])]) {
    const at = Date.parse(call.at);
    if (!call.source || !Number.isFinite(at)) continue;
    if (!latest.has(call.source) || at > Date.parse(latest.get(call.source).at)) latest.set(call.source, call);
  }
  return latest;
}

export function activityNote(call) {
  if (!call) return 'No retained call to show. Configuration alone does not verify provider access.';
  const outcome = { success: 'completed', partial: 'returned partial results', empty: 'returned no results', failed: 'failed', cancelled: 'was stopped', skipped: 'was skipped' }[call.status] ?? 'has an unknown outcome';
  return `Last retained call ${outcome} · ${absTime(call.at)} · ${call.tool}. This describes that call, not a current connection check.`;
}
