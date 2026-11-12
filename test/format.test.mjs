import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callOutcome, costAmounts, costShort, costText } from '../src/ui/format.mjs';

test('mixed provider amounts show USD first and other units alphabetically regardless of arrival order', () => {
  const units = [['Scrape.do credits', 9], ['tokens', 12], ['USD', .111], ['ScrapeCreators credits', 4], ['EUR', 2]];
  const expected = ['$0.1110', '2 EUR', '4 ScrapeCreators credits', '9 Scrape.do credits', '12 tokens'];
  for (const entries of [units, [...units].reverse(), [...units.slice(2), ...units.slice(0, 2)]]) {
    const byUnit = Object.freeze(Object.fromEntries(entries));
    const orderBefore = Object.keys(byUnit);
    const summary = { byUnit, unknownCalls: 1 };
    assert.deepEqual(costAmounts(summary), expected);
    assert.equal(costText(summary), `Provider-reported subtotal: ${expected.join(' + ')}; total unknown`);
    assert.equal(costShort(summary, 6), `${expected.join(' + ')} + unpriced`);
    assert.deepEqual(Object.keys(byUnit), orderBefore, 'formatting never mutates receipt-derived unit order or values');
  }
});

test('display ordering preserves separate legacy unit entries and positive amounts below visible precision', () => {
  const summary = { byUnit: { 'ScrapeCreators credits': 2, credits: 3, USD: .000001 }, unknownCalls: 0 };
  assert.deepEqual(costAmounts(summary), ['<$0.0001', '3 ScrapeCreators credits', '2 ScrapeCreators credits']);
  assert.equal(costText({ byUnit: {}, unknownCalls: 2 }), 'Provider cost unknown');
  assert.equal(costShort({ byUnit: {}, unknownCalls: 0 }, 0), '');
});

test('X read counts are singular for one, like credits', () => {
  assert.deepEqual(costAmounts({ byUnit: { 'X post reads': 25, 'X account reads': 1, 'ScrapeCreators credits': 1 } }), ['1 ScrapeCreators credit', '1 X account read', '25 X post reads']);
  assert.equal(costShort({ byUnit: { 'X post reads': 1 }, unknownCalls: 0 }, 1), '1 X post read');
});

test('a call receipt’s outcome has one wording on every page', () => {
  assert.deepEqual(['success', 'partial', 'empty', 'failed', 'cancelled', 'skipped', 'running', undefined].map(callOutcome), ['Succeeded', 'Partial', 'Empty', 'Failed', 'Stopped', 'Skipped', 'Unknown outcome', 'Unknown outcome']);
});
