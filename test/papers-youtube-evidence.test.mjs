import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidence, sentenceText } from '../src/ui/evidence/index.mjs';

const context = { label: source => source };
const said = (receipt, bodies) => { const e = evidence({ status: 'success', ...receipt }, bodies, context); return { text: sentenceText(e), items: e.items }; };

test('Papers reads, relations, content and sections say what they read, not a search', () => {
  const citing = said({ tool: 'papers_semantic_scholar_relations', source: 'papers', args: { paperId: 'abc123', direction: 'citations' } }, [{ data: [{ contexts: ['baseline'], citingPaper: { paperId: '2', title: 'Citing Paper', year: 2024 } }], next: 10 }]);
  assert.doesNotMatch(citing.text, /[Ss]earched/); assert.match(citing.text, /citing/); assert.match(citing.text, /abc123/); assert.match(citing.text, /1 paper/); assert.equal(citing.items[0]?.title, 'Citing Paper');
  const refs = said({ tool: 'papers_semantic_scholar_relations', source: 'papers', args: { paperId: 'abc123', direction: 'references' } }, [{ data: [{ citedPaper: { paperId: '3', title: 'Cited Paper' } }] }]);
  assert.match(refs.text, /references of abc123/); assert.equal(refs.items[0]?.title, 'Cited Paper');
  const content = said({ tool: 'papers_openalex_content', source: 'papers', args: { workId: 'W123', format: 'xml' } }, [{ workId: 'W123', format: 'xml', bytes: 10, file: '/lib/papers/openalex-W123.xml', existingFileKept: false }]);
  assert.doesNotMatch(content.text, /[Ss]earched/); assert.match(content.text, /W123/); assert.match(content.text, /openalex-W123\.xml/);
  const sections = said({ tool: 'papers_sections', source: 'papers', args: { file: 'paper.pdf' } }, [{ sections: [{ heading: 'Methods', text: 'x' }, { heading: 'Results', text: 'y' }], truncated: false }]);
  assert.doesNotMatch(sections.text, /[Ss]earched/); assert.match(sections.text, /paper\.pdf/); assert.match(sections.text, /2 sections/);
});

test('Papers recommendations name their positive seed papers, and reads name only the schema arguments', () => {
  const one = said({ tool: 'papers_semantic_scholar_recommendations', source: 'papers', args: { positivePaperIds: ['p1'] } }, [{ recommendedPapers: [] }]);
  assert.match(one.text, /papers like p1/);
  const two = said({ tool: 'papers_semantic_scholar_recommendations', source: 'papers', args: { positivePaperIds: ['p1', 'p2'] } }, [{ recommendedPapers: [] }]);
  assert.match(two.text, /papers like p1, p2/);
  const read = said({ tool: 'papers_fulltext_read', source: 'papers', args: { source: 'arxiv', doi: '10.1/x', url: 'https://x' } }, ['text']);
  assert.doesNotMatch(read.text, /10\.1\/x|https:\/\/x/); assert.match(read.text, /arxiv/);
});

test('YouTube transcript and Gemini analysis calls are not described as searches', () => {
  const transcript = said({ tool: 'youtube_transcript', source: 'youtube', args: { video: 'dQw4w9WgXcQ', language: 'fr' } }, [{ success: true, videoId: 'dQw4w9WgXcQ', language: 'fr', transcript: [{ text: 'a' }, { text: 'b' }] }]);
  assert.doesNotMatch(transcript.text, /[Ss]earched|no videos|no preview items/); assert.match(transcript.text, /transcript of dQw4w9WgXcQ/); assert.match(transcript.text, /2 segments/);
  const analysis = said({ tool: 'youtube_analyze', source: 'youtube', args: { question: 'What happens?', videos: [{ url: 'https://youtu.be/dQw4w9WgXcQ' }] } }, [{ id: 'int1', status: 'completed' }]);
  assert.doesNotMatch(analysis.text, /[Ss]earched|no preview items/); assert.match(analysis.text, /What happens\?/); assert.match(analysis.text, /1 video/); assert.match(analysis.text, /completed/);
  const status = said({ tool: 'youtube_analysis_status', source: 'youtube', args: { interactionId: 'int1' } }, [{ id: 'int1', status: 'in_progress' }]);
  assert.doesNotMatch(status.text, /[Ss]earched|no preview items/); assert.match(status.text, /int1/); assert.match(status.text, /in_progress/);
  const cancel = said({ tool: 'youtube_analysis_status', source: 'youtube', args: { interactionId: 'int1', action: 'cancel' } }, [{ id: 'int1', status: 'cancelled' }]);
  assert.match(cancel.text, /cancel/i);
  const search = said({ tool: 'youtube', source: 'youtube', args: { query: 'sqlite' } }, [{ items: [{ id: { videoId: 'v1' }, snippet: { title: 'Video', channelTitle: 'C' } }] }]);
  assert.match(search.text, /searched YouTube for/i);
});
