// Gated provider fixture for observing the native boundary before a receipt exists. No network.
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
globalThis.fetch = async () => {
  const root = process.env.DIG_ACTIVITY_GATE;
  await writeFile(join(root, 'started'), 'ready');
  for (let waited = 0; ; waited += 10) {
    try { await access(join(root, 'release')); break; } catch {}
    if (waited >= 10000) throw Error('Fixture was not released');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return Response.json({ id: 'fixture', output: [{ type: 'message', content: [{ type: 'output_text', text: 'A fixture result' }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, cost_in_usd_ticks: 0 } });
};
