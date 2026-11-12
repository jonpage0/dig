// The host app a Dig view runs in, and the words the views use for it. The service names the host a connected client
// identifies itself as (views.ts clientHost), and `any` for a client it does not know and for the browser; the views
// get the result as library_snapshot's `host`, and nothing stores it. Plain module, so the service and views can share it.
const SIDEBAR = 'Right-click Dig in the sidebar and choose Refresh to load the new one.';
const WORDS = {
  codex: { app: 'Codex', plans: 'ChatGPT or Codex', skill: name => `$dig:${name}`, refresh: SIDEBAR },
  'claude-code': { app: 'Claude Code', plans: 'Claude Code', skill: name => `Dig’s ${name} method`, refresh: SIDEBAR },
  any: { app: 'your assistant', plans: 'assistant', skill: name => `Dig’s ${name} method`, refresh: 'Reload this page to load the new one.' },
};
/** `claude-code` for Claude Code, `any` for a host Dig does not name, else `codex`. */
export const hostOf = value => (value === 'claude-code' || value === 'any' ? value : 'codex');
/** The host's own name (`app`), the plans its model use bills under (`plans`), how its user calls a Dig method (`skill(name)`; `$dig:` names a method the ChatGPT wrapper carries) and how to load a newer view (`refresh`). */
export const hostWords = host => WORDS[hostOf(host)];
