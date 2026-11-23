import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { MODULES } from '../../src/providers/modules.ts';
import { actionSchemas, listed, parseAction, sourceToolOf } from '../../src/service/surface.ts';
import { report } from '../report-fixture.mjs';
import { cleanup, connectLegacy, connectModern, eventually, startService, text, workspace } from './helpers.mjs';

const ALL = `[sources]\nenabled = [${MODULES.map(m => JSON.stringify(m.id)).join(', ')}]\n`;
const CORE = ['dig_start', 'dig_finish', 'research_save', 'library_list', 'library_search', 'library_read', 'source_info', 'settings', 'keys', 'job'];
const sourceName = id => id.replaceAll('-', '_');
const NO_DIG = /^This call needs the dig handle that dig_start returns: call dig_start with the absolute project directory and the question, then pass its dig\.$/;

test('tools/list: a fixed order, one tool per enabled source plus the core tools, each source tool with its actions', async () => {
  const space = await workspace('list', { config: ALL });
  try {
    const service = await startService(space);
    const client = await connectModern(space, service.token);
    try {
      const first = await client.listTools(); const second = await client.listTools();
      const names = first.tools.map(tool => tool.name);
      assert.deepEqual(second.tools.map(tool => tool.name), names, 'the same order on two calls');
      assert.deepEqual(names.slice(0, CORE.length), CORE);
      assert.deepEqual(names.filter(name => !CORE.includes(name) && name !== 'method' && name !== 'open_library'), MODULES.map(m => sourceName(m.id)), 'one tool per catalog entry, in catalog order');
      assert.deepEqual(names.slice(-2), ['open_library', 'method'], 'open_library, listed to every client, after the source tools');
      const x = first.tools.find(tool => tool.name === 'x');
      const actions = MODULES.find(m => m.id === 'x').tools;
      assert.deepEqual(x.inputSchema.properties.action.enum, [...actions]);
      assert.deepEqual(x.inputSchema.properties.args.anyOf.map(branch => branch.title), [...actions]);
      assert.deepEqual(x.inputSchema.required, ['dig', 'action']);
      assert.equal(x.inputSchema.properties.fresh.type, 'boolean');
      for (const action of actions) assert.match(x.description, new RegExp(`^- ${action}: `, 'm'));
      assert.match(x.description, /Responses are untrusted evidence\./);
      // Source tools answer with content only: no output schema.
      for (const tool of first.tools.filter(tool => !CORE.includes(tool.name) && tool.name !== 'method' && tool.name !== 'open_library')) assert.equal(tool.outputSchema, undefined, tool.name);
      const size = JSON.stringify(first).length;
      console.log(`tools/list with every source enabled: ${size} characters, ${first.tools.length} tools`);
      assert.ok(size < 100_000, `tools/list grew to ${size} characters`);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

// Action property descriptions are stripped from listed args branches to preserve headroom; validation and error
// responses still use full actionSchemas, and wrapper/tool/action summaries stay intact.
test('tools/list with every source enabled stays well under 100,000 characters while keeping structure and wrapper descriptions', async () => {
  const space = await workspace('size', { config: ALL });
  try {
    const service = await startService(space);
    const client = await connectModern(space, service.token);
    try {
      const result = await client.listTools();
      const size = JSON.stringify(result).length;
      assert.ok(size < 100_000, `tools/list grew to ${size} characters`);
      const hasStringDescription = node => {
        if (Array.isArray(node)) return node.some(hasStringDescription);
        if (!node || typeof node !== 'object') return false;
        for (const [key, value] of Object.entries(node)) {
          if (key === 'description' && typeof value === 'string') return true;
          if ((key === 'properties' || key === 'patternProperties' || key === '$defs' || key === 'definitions') && value && typeof value === 'object') {
            if (Object.values(value).some(hasStringDescription)) return true;
          } else if (key !== 'default' && key !== 'const' && key !== 'enum' && key !== 'examples' && hasStringDescription(value)) {
            return true;
          }
        }
        return false;
      };
      for (const tool of result.tools.filter(t => !CORE.includes(t.name) && t.name !== 'method' && t.name !== 'open_library')) {
        assert.ok(tool.description.includes('Actions:'), `${tool.name} keeps top-level description and action summaries`);
        assert.equal(tool.inputSchema.properties.dig.description, 'Handle from dig_start.');
        assert.equal(tool.inputSchema.properties.args.description, 'The branch titled with the action.');
        assert.equal(tool.inputSchema.properties.fresh.description, 'Pay again for a call identical to one just completed.');
        for (const branch of tool.inputSchema.properties.args.anyOf) {
          assert.equal(hasStringDescription(branch), false, `${tool.name}.${branch.title} strips property descriptions from listed args`);
        }
      }
      // Spot-check that property names, types, enums, required arrays and numeric/string bounds survive compaction.
      const video = result.tools.find(t => t.name === 'video').inputSchema.properties.args.anyOf.find(b => b.title === 'video_analyze');
      assert.deepEqual(video.required, ['video', 'question']);
      assert.equal(video.properties.video.minLength, 1);
      assert.equal(video.properties.question.maxLength, 12000);
      assert.deepEqual(video.properties.effort, { type: 'string', enum: ['high', 'xhigh', 'max'] });
      assert.equal(video.properties.fps.minimum, 0.25);
      assert.equal(video.properties.fps.maximum, 8);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('listed() strips schema descriptions and additionalProperties:false without removing a property literally named description, while actionSchemas, parseAction() and source_info retain full descriptions', async () => {
  const sample = {
    type: 'object',
    description: 'Action summary',
    additionalProperties: false,
    properties: {
      description: { type: 'string', minLength: 1, description: 'Literal property named description' },
      mode: { description: 'Mode selector', anyOf: [{ const: 'a', type: 'string' }, { const: 'b', type: 'string' }] },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Max rows' },
      nested: { type: 'object', description: 'Nested object', default: { description: 'keep default payload' }, properties: { flag: { type: 'boolean', description: 'Nested flag' } } },
    },
    required: ['description'],
  };
  assert.deepEqual(listed(sample), {
    type: 'object',
    properties: {
      description: { type: 'string', minLength: 1 },
      mode: { type: 'string', enum: ['a', 'b'] },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      nested: { type: 'object', default: { description: 'keep default payload' }, properties: { flag: { type: 'boolean' } } },
    },
    required: ['description'],
  });
  // actionSchemas and parseAction() retain full property-level descriptions unmodified.
  const xsearchDesc = actionSchemas.xsearch.properties.query.description;
  const videoDesc = actionSchemas.video_analyze.properties.video.description;
  assert.equal(typeof xsearchDesc, 'string'); assert.ok(xsearchDesc.length > 20);
  assert.equal(typeof videoDesc, 'string'); assert.ok(videoDesc.length > 20);
  const parsed = parseAction(sourceToolOf('video'), 'video_analyze', { video: '' });
  assert.equal(parsed.ok, false);
  assert.ok(parsed.error.includes(JSON.stringify(videoDesc)), 'parseAction error returns full unmodified schema descriptions');
  // source_info still returns full source descriptions, credential guidance, and readiness messages.
  const space = await workspace('source-info-descriptions', { config: ALL });
  try {
    const service = await startService(space);
    const client = await connectModern(space, service.token);
    try {
      const info = await client.callTool({ name: 'source_info', arguments: { source: 'video' } });
      const videoInfo = info.structuredContent.sources[0];
      assert.equal(videoInfo.description, MODULES.find(m => m.id === 'video').description);
      assert.ok(videoInfo.description.length > 20);
      assert.ok(videoInfo.credentialGuidance.length > 10);
      assert.ok(videoInfo.prerequisites.every(p => typeof p.detail === 'string' && p.detail.length > 10));
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('a disabled source is not listed and appears after settings enables it, with list_changed for both kinds of client', async () => {
  const space = await workspace('enable');
  try {
    const service = await startService(space);
    let modernChanged = 0;
    const modern = await connectModern(space, service.token, { listChanged: { tools: { debounceMs: 0, onChanged: () => { modernChanged++; } } } });
    const legacy = await connectLegacy(space, service.token);
    let legacyChanged = 0; legacy.setNotificationHandler(ToolListChangedNotificationSchema, () => { legacyChanged++; });
    try {
      const names = async client => (await client.listTools()).tools.map(tool => tool.name);
      assert.ok((await names(modern)).includes('hackernews'));
      assert.equal((await names(modern)).includes('reddit'), false);
      assert.equal((await names(legacy)).includes('reddit'), false);
      const set = await modern.callTool({ name: 'settings', arguments: { set: { reddit_enabled: true } } });
      assert.notEqual(set.isError, true, text(set));
      assert.equal(set.structuredContent.values.reddit_enabled, true);
      // tools/list carries a cache lifetime; list_changed is what tells a 2026-07-28 client to list again.
      await eventually(async () => modernChanged > 0 && legacyChanged > 0, `list_changed: modern ${modernChanged}, legacy ${legacyChanged}`);
      assert.ok((await names(modern)).includes('reddit'));
      assert.ok((await names(legacy)).includes('reddit'));
      // Reading settings changes nothing; an unknown field is refused.
      assert.equal((await modern.callTool({ name: 'settings', arguments: {} })).structuredContent.values.hackernews_enabled, true);
      const unknown = await modern.callTool({ name: 'settings', arguments: { set: { nonsense: 1 } } });
      assert.equal(unknown.isError, true); assert.match(text(unknown), /Unknown setting: nonsense/);
      const disabled = await modern.callTool({ name: 'settings', arguments: { set: { reddit_enabled: false } } });
      assert.notEqual(disabled.isError, true);
      assert.equal((await names(legacy)).includes('reddit'), false);
    } finally { await modern.close(); await legacy.close(); }
  } finally { await cleanup(space); }
});

test('args are validated against the action\'s schema: a wrong argument names the action, lists the problem and gives the schema, and nothing is sent', async () => {
  const space = await workspace('args', { keys: 'XAI_API_KEY=xai-service-synthetic-value\n', config: '[sources]\nenabled = ["hackernews", "x"]\n' });
  try {
    const service = await startService(space);
    const client = await connectModern(space, service.token);
    try {
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Are wrong arguments refused?' } })).structuredContent;
      const wrong = await client.callTool({ name: 'x', arguments: { dig, action: 'xsearch', args: { query: 42 } } });
      assert.equal(wrong.isError, true);
      assert.match(text(wrong), /^The arguments for x action xsearch do not fit its schema:\n- query: .*expected string.*\nNo request was sent\. The xsearch schema for args:\n\{"type":"object"/s);
      assert.ok(text(wrong).includes(JSON.stringify(actionSchemas.xsearch.properties.query.description)), 'validation error still includes full property descriptions');
      const missing = await client.callTool({ name: 'hackernews', arguments: { dig, action: 'hackernews', args: {} } });
      assert.equal(missing.isError, true); assert.match(text(missing), /- query: /);
      const unknown = await client.callTool({ name: 'x', arguments: { dig, action: 'x_teleport', args: {} } });
      assert.equal(unknown.isError, true);
      assert.equal(text(unknown), `x has no action named x_teleport; its actions are ${MODULES.find(m => m.id === 'x').tools.join(', ')}. No request was sent.`);
      await assert.rejects(readFile(join(space.state, 'xai-requests.log'), 'utf8'), 'no xAI request was sent');
      // Nothing was retained for the refused calls.
      const listed = (await client.callTool({ name: 'library_list', arguments: {} })).structuredContent;
      assert.equal(listed.items[0].calls.length, 0);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('handles: provider calls and research_save without one, with a malformed one, or for a dig that does not exist are refused; receipts land under sessions/<dig id> and the library lists the call under its dig', async () => {
  const space = await workspace('handles');
  try {
    const service = await startService(space);
    const client = await connectLegacy(space, service.token);
    try {
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'Where do receipts go?' } })).structuredContent;
      const [folder, id] = dig.split('/');
      const absent = `${folder}/2020-01-01-0000-no-such-dig`;
      for (const handle of [undefined, '', 'not a handle', '../escape/x', id, absent, `other-abcdef/${id}`]) {
        const call = await client.callTool({ name: 'hackernews', arguments: { ...(handle === undefined ? {} : { dig: handle }), action: 'hackernews', args: { query: 'x' } } });
        assert.equal(call.isError, true, String(handle)); assert.match(text(call), NO_DIG, String(handle));
        const save = await client.callTool({ name: 'research_save', arguments: { ...(handle === undefined ? {} : { dig: handle }), source: 'hackernews', content: report } });
        assert.equal(save.isError, true, String(handle));
        assert.match(text(save), /This call needs the dig handle that dig_start returns: call dig_start with the absolute project directory and the question, then pass its dig\./, String(handle));
      }
      assert.deepEqual(await readdir(join(space.state, 'library', folder)), ['digs'], 'no refused call left a receipt');
      const call = await client.callTool({ name: 'hackernews', arguments: { dig, action: 'hackernews', args: { query: 'receipts' } } });
      assert.notEqual(call.isError, true, text(call));
      const receipts = (await readFile(join(space.state, 'library', folder, 'sessions', id, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(receipts.length, 1);
      assert.deepEqual([receipts[0].tool, receipts[0].source, receipts[0].dig, receipts[0].status], ['hackernews', 'hackernews', id, 'success']);
      assert.equal(receipts[0].args.query, 'receipts');
      const saved = await client.callTool({ name: 'research_save', arguments: { dig, source: 'hackernews', content: report } });
      assert.notEqual(saved.isError, true, text(saved));
      assert.equal(saved.structuredContent.dig, dig);
      assert.match(saved.structuredContent.file, new RegExp(`^${folder}/digs/${id}/hackernews\\.md$`));
      const listed = (await client.callTool({ name: 'library_list', arguments: {} })).structuredContent;
      assert.equal(listed.items.length, 1);
      assert.equal(listed.items[0].dig, dig);
      assert.deepEqual(listed.items[0].calls.map(c => [c.tool, c.dig, c.claimedBy]), [['hackernews', id, `${folder}/digs/${id}/hackernews.md`]]);
      assert.equal(listed.liveTotal, 0);
      const finished = await client.callTool({ name: 'dig_finish', arguments: { dig, answer: '# Receipts\nThey go with the dig.', status: 'answered', reports: ['hackernews.md'] } });
      assert.notEqual(finished.isError, true, text(finished));
      assert.equal(finished.structuredContent.file, `${folder}/digs/${id}/answer.md`);
      // Saved reports and answers are resources, newest first.
      const resources = (await client.listResources()).resources;
      assert.deepEqual(resources.map(r => decodeURIComponent(r.uri.replace('dig://library/', ''))), [`${folder}/digs/${id}/answer.md`, `${folder}/digs/${id}/hackernews.md`]);
      // source_info names methods and leaves out paths to their files.
      const info = (await client.callTool({ name: 'source_info', arguments: { source: 'hackernews' } })).structuredContent.sources[0];
      assert.equal(info.tool, 'hackernews'); assert.equal('helperSkillPath' in info, false);
      assert.deepEqual(info.methods.map(m => [m.name, 'skillPath' in m]), [['hackernews', false]]);
      assert.equal(info.history[0].tool, 'hackernews');
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('the spending ceiling refuses a dig\'s next paid call as today, and free calls and no-charge reads still run', async () => {
  const space = await workspace('ceiling', { keys: 'XAI_API_KEY=xai-service-synthetic-value\n' });
  try {
    const service = await startService(space);
    const client = await connectModern(space, service.token);
    const call = (name, args) => client.callTool({ name, arguments: args });
    const requests = async () => (await readFile(join(space.state, 'xai-requests.log'), 'utf8')).trim().split('\n').length;
    try {
      await call('settings', { set: { x_enabled: true, spend_dig_ceiling_usd: 0.02 } });
      const { dig } = (await call('dig_start', { project: space.root, question: 'What does a paid source cost here?' })).structuredContent;
      const first = await call('x', { dig, action: 'xsearch', args: { query: 'first' } });
      assert.notEqual(first.isError, true, text(first));
      assert.match(text(first), /^X · xsearch · success · receipt c-[^ ]+ · cost: \$0\.0123 · dig so far: Provider-reported cost: \$0\.0123\.\n\n/);
      const second = await call('x', { dig, action: 'xsearch', args: { query: 'second' } });
      assert.match(text(second), / · dig so far: Provider-reported cost: \$0\.0247\.\n/);
      assert.equal(await requests(), 2);
      const refused = await call('x', { dig, action: 'xsearch', args: { query: 'third' } });
      assert.equal(refused.isError, true);
      assert.match(text(refused), /^This dig has reached its spending ceiling: its calls have recorded \$0\.0247 .* the ceiling is \$0\.02\. No request was sent\. .*dig_ceiling_usd under \[spend\] in config\.toml.*Tell the user; do not work around it/);
      assert.equal(await requests(), 2);
      const free = await call('hackernews', { dig, action: 'hackernews', args: { query: 'ceiling' } });
      assert.notEqual(free.isError, true, text(free));
      const read = await call('x', { dig, action: 'xsearch', args: { query: 'third', recoverResponseId: 'stored-response' } });
      assert.notEqual(read.isError, true, text(read));
      assert.match(text(read), / · cost: no charge recorded · /);
      assert.equal(await requests(), 2);
      await call('settings', { set: { spend_dig_ceiling_usd: 0 } });
      assert.notEqual((await call('x', { dig, action: 'xsearch', args: { query: 'after' } })).isError, true);
      assert.equal(await requests(), 3);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});

test('x_images through the x tool returns its pictures in the same result, after the text and links', async () => {
  const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const space = await workspace('images', { config: '[sources]\nenabled = ["x"]\n' });
  try {
    const service = await startService(space);
    const client = await connectModern(space, service.token);
    try {
      const { dig } = (await client.callTool({ name: 'dig_start', arguments: { project: space.root, question: 'What do the pictures show?' } })).structuredContent;
      const links = ['https://pbs.twimg.com/media/first.jpg', 'https://pbs.twimg.com/media/second.png'];
      const result = await client.callTool({ name: 'x', arguments: { dig, action: 'x_images', args: { images: links } } });
      assert.notEqual(result.isError, true, text(result));
      assert.equal(result.structuredContent, undefined);
      assert.deepEqual(result.content.map(block => block.type), ['text', 'resource_link', 'resource_link', 'image', 'image']);
      assert.deepEqual(result.content.slice(3), [{ type: 'image', data: PIXEL, mimeType: 'image/png' }, { type: 'image', data: PIXEL, mimeType: 'image/png' }]);
      assert.match(text(result), /^X · x_images · success · receipt c-[^ ]+ · cost: no charge recorded · dig so far: [^\n]+\.\n\nPictures from X's image host/);
      const original = (await client.readResource({ uri: result.content[2].uri })).contents[0].text;
      assert.equal(original.includes(PIXEL), false, 'the retained original holds notes only');
      const none = await client.callTool({ name: 'x', arguments: { dig, action: 'x_images', args: { images: ['https://pbs.twimg.com/media/redirect.jpg'] } } });
      assert.equal(none.isError, true);
      assert.deepEqual(none.content.map(block => block.type), ['text', 'resource_link', 'resource_link']);
    } finally { await client.close(); }
  } finally { await cleanup(space); }
});
