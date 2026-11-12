// A source call's result is content only, so what an action returns beside its text is appended to the text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { result, type Prepared, type Ran } from '../../src/service/calls.ts';

const call = { tool: { module: { label: 'YouTube' } }, action: 'youtube_analyze', dig: { folder: 'p-1', dig: 'd-1' } } as unknown as Prepared;
const ran = (details: Record<string, unknown>): Ran => ({ outcome: { status: 'success', text: 'The structured answer is available in structuredAnswer.', details }, images: [], call: { id: 'c-1' }, retentionError: null, digCost: null });
const text = (details: Record<string, unknown>) => { const block = result(call, ran(details)).content[0]; return block.type === 'text' ? block.text : ''; };

test('what an action returns beside its text follows the text as JSON; the cost stays on the first line only', () => {
  const shown = text({ cost: [{ amount: 0.01, unit: 'USD' }], structuredAnswer: { verdict: 'supported', seconds: [35, 55] }, interactionId: 'i-1' });
  assert.match(shown, /^YouTube · youtube_analyze · success · receipt c-1 · cost: /);
  const [, json] = shown.split('\n\nDetails:\n');
  assert.deepEqual(JSON.parse(json), { structuredAnswer: { verdict: 'supported', seconds: [35, 55] }, interactionId: 'i-1' });
});

test('a result with only its cost has no details block, and long details are cut with a pointer to the original', () => {
  assert.doesNotMatch(text({ cost: [] }), /Details:/);
  const long = text({ cost: [], rows: Array.from({ length: 4000 }, (_, i) => `row ${i}`) });
  assert.match(long, /… cut at 20,000 of [\d,]+ characters; the retained original holds the response\.$/);
});
