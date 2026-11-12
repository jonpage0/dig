import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { providerTools } from '../src/providers/index.ts';
import { createSchemas } from '../src/providers/schemas.ts';
import { CHECKS, SKIPPED, EXPENSIVE } from './live/checks.mjs';

test('every provider tool has exactly one live check or a stated reason it is skipped, and no unknown tool is named', () => {
  const named = [...CHECKS, ...SKIPPED].map(entry => entry.tool);
  for (const tool of Object.keys(providerTools)) assert.equal(named.filter(name => name === tool).length, 1, `${tool} must appear once in CHECKS or SKIPPED`);
  for (const tool of [...named, ...EXPENSIVE]) assert.ok(providerTools[tool], `${tool} is not a provider tool`);
  for (const tool of EXPENSIVE) assert.ok(CHECKS.some(check => check.tool === tool), `${tool} is expensive but has no check`);
  for (const { tool, reason } of SKIPPED) assert.ok(reason?.trim(), `${tool} is skipped without a reason`);
  for (const check of CHECKS) if (check.replay === false) assert.ok(check.replayNote?.trim(), `${check.tool} cannot replay but says not why`);
});

test('every live check sends arguments its tool’s schema accepts, without project or dig', () => {
  const schemas = createSchemas(Type);
  for (const { tool, args } of CHECKS) {
    assert.ok(!('project' in args) && !('dig' in args), `${tool}: the script adds project`);
    assert.ok(Value.Check(schemas[tool], args), `${tool}: ${[...Value.Errors(schemas[tool], args)].map(error => `${error.path} ${error.message}`).join('; ')}`);
  }
});
