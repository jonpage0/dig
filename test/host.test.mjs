import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, hostWords } from '../src/ui/host.mjs';

test('a view in Claude Code names Claude Code and Dig’s methods by name; an unnamed value keeps the Codex words and `any` names no host', () => {
  assert.deepEqual(['claude-code', 'codex', undefined, '', 'Claude Code'].map(hostOf), ['claude-code', 'codex', 'codex', 'codex', 'codex']);
  const codex = hostWords(undefined); const claude = hostWords('claude-code');
  assert.deepEqual([codex.app, codex.plans, codex.skill('setup')], ['Codex', 'ChatGPT or Codex', '$dig:setup']);
  assert.deepEqual([claude.app, claude.plans, claude.skill('setup')], ['Claude Code', 'Claude Code', 'Dig’s setup method']);
  assert.equal(hostWords('unknown'), codex);
  assert.deepEqual([hostWords('any').app, hostWords('any').skill('setup')], ['your assistant', 'Dig’s setup method']);
});
