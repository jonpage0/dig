import { randomUUID } from 'node:crypto';

/** Process-local observation of executing provider calls. Never persisted or used as receipt ownership. */
export function createCallActivity() {
  const calls = new Map();
  let revision = 0;
  return {
    get revision() { return revision; },
    snapshot(library) {
      return [...calls.values()].filter(call => call.library === library).map(({ library: _, ...call }) => ({ ...call }));
    },
    async run({ library, project, dig, session, source, tool }, execute) {
      const id = randomUUID();
      calls.set(id, { id, library, project, ...(dig ? { dig } : {}), session, source, tool, at: new Date().toISOString() });
      revision++;
      try { return await execute(); }
      finally { calls.delete(id); revision++; }
    },
  };
}
