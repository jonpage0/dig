// The host app a Dig server runs in, and the words Dig's messages use for it. The server reads the host from
// DIG_HOST (`claude-code` for Claude Code; anything else is Codex) and gives the views the result as library_snapshot's
// `host`; nothing stores it. Plain module, so the server, tools and views can share it.
const WORDS = {
  codex: { app: 'Codex', plans: 'ChatGPT or Codex', skill: name => `$dig:${name}` },
  'claude-code': { app: 'Claude Code', plans: 'Claude Code', skill: name => `/dig:${name}` },
};
/** `claude-code` for Claude Code, else `codex`. */
export const hostOf = value => (value === 'claude-code' ? 'claude-code' : 'codex');
/** The host's own name (`app`), the plans its model use bills under (`plans`) and how its user calls a Dig skill (`skill(name)`). */
export const hostWords = host => WORDS[hostOf(host)];
