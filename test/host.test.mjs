import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, hostWords } from '../src/ui/host.mjs';

test('DIG_HOST=claude-code names Claude Code and its /dig: skills; anything else keeps the Codex words', () => {
  assert.deepEqual(['claude-code', 'codex', undefined, '', 'Claude Code'].map(hostOf), ['claude-code', 'codex', 'codex', 'codex', 'codex']);
  const codex = hostWords(undefined); const claude = hostWords('claude-code');
  assert.deepEqual([codex.app, codex.plans, codex.skill('setup')], ['Codex', 'ChatGPT or Codex', '$dig:setup']);
  assert.deepEqual([claude.app, claude.plans, claude.skill('setup')], ['Claude Code', 'Claude Code', '/dig:setup']);
  assert.equal(hostWords('unknown'), codex);
});
