import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, hostWords } from '../src/ui/host.mjs';

test('a view in Claude Code or Antigravity names its host and method syntax; an unnamed value keeps the Codex words and `any` names no host', () => {
  assert.deepEqual(['claude-code', 'antigravity', 'codex', undefined, '', 'Claude Code'].map(hostOf), ['claude-code', 'antigravity', 'codex', 'codex', 'codex', 'codex']);
  const codex = hostWords(undefined); const claude = hostWords('claude-code'); const agy = hostWords('antigravity');
  assert.deepEqual([codex.app, codex.plans, codex.skill('setup')], ['Codex', 'ChatGPT or Codex', '$dig:setup']);
  assert.deepEqual([claude.app, claude.plans, claude.skill('setup')], ['Claude Code', 'Claude Code', 'Dig’s setup method']);
  assert.deepEqual([agy.app, agy.plans, agy.skill('setup'), agy.refresh], ['Antigravity', 'Antigravity', '/setup', 'Reload Dig in Antigravity to load the new one.']);
  assert.equal(hostWords('unknown'), codex);
  assert.deepEqual([hostWords('any').app, hostWords('any').skill('setup')], ['your assistant', 'Dig’s setup method']);
});
