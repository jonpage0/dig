// The accounts fold in the Accounts and keys section at the top of Dig's Sources page, closed by default: one entry
// per provider account (ACCOUNTS in the catalog), because one key can serve several sources. Each entry links the
// provider's page for the key and shows the account's keys.env names (then any optional ones), the sources it serves
// (from source_info's credentials, which say whether a source needs it), how it bills and whether keys.env holds it.
// Then what this computer needs, from source_info's prerequisites. Names and presence only, never values. The fold's
// summary counts what is set.
import { ACCOUNTS } from '../providers/modules.ts';
import { attr, externalLink, fold, keyName, keyed, node, rebuild } from './dom.mjs';

const list = new Intl.ListFormat('en', { type: 'conjunction' });
const ACCOUNT_STATES = { set: 'set', partial: 'partly set', unset: 'not set' };
const TOOL_STATES = { set: 'installed', missing: 'not installed' };
/** A presence chip in the readiness chips' patterns: the word carries the meaning, the pattern repeats it. */
const presence = (state, words) => attr(node('span', 'state', words[state]), 'data-state', state);
const groupsOf = account => account.keys.map(k => (typeof k === 'string' ? [k] : k));
/** `A and B`, an alias group as `A or B`. */
const namesLine = groups => groups.flatMap((group, i) => [i ? (i === groups.length - 1 ? ' and ' : ', ') : null, ...group.flatMap((name, j) => [j ? ' or ' : null, keyName(name)])]);
const labels = items => [...new Set(items.map(item => item.source.label))];

function accountState(account, credentials) {
  const groups = groupsOf(account);
  const uses = credentials.filter(c => groups.flat().includes(c.name));
  const held = groups.filter(group => uses.some(c => group.includes(c.name) && c.available)).length;
  return { groups, uses, state: held === groups.length ? 'set' : held ? 'partial' : 'unset' };
}

function accountRow(account, { groups, uses, state }) {
  const needed = labels(uses.filter(c => c.required));
  const optional = labels(uses.filter(c => !c.required)).filter(label => !needed.includes(label));
  const served = [needed.length ? `Needed by ${list.format(needed)}.` : null, optional.length ? `Optional for ${list.format(optional)}.` : null].filter(Boolean).join(' ');
  const link = keyed(attr(externalLink(account.signup, account.name), 'aria-label', `${account.name}: create or find your key`), `account:${account.id}`);
  // Optional names never change the account's state; they follow its own names.
  const extra = account.optional?.length ? ['; optional: ', ...namesLine(account.optional.map(name => [name]))] : [];
  return node('li', 'account',
    node('div', 'account-head', node('p', 'account-name', link), presence(state, ACCOUNT_STATES)),
    node('p', 'account-keys', [...namesLine(groups), ...extra]),
    node('p', 'meta', [served, account.billing].filter(Boolean).join(' ')));
}

/** Each local prerequisite once, with the sources that need it. */
function localTools(sources) {
  const tools = new Map();
  for (const source of sources) for (const p of Array.isArray(source.prerequisites) ? source.prerequisites : []) {
    const tool = tools.get(p.name) ?? { ...p, sources: [] };
    tool.sources.push(source.label); tools.set(p.name, tool);
  }
  return [...tools.values()];
}
const toolRow = tool => node('li', 'account',
  node('div', 'account-head', node('p', 'account-name', tool.name), presence(tool.available ? 'set' : 'missing', TOOL_STATES)),
  node('p', 'meta', `Used by ${list.format(tool.sources)}.${tool.detail ? ` ${tool.detail}` : ''}`));

// The fold is built once per container, so a refresh changes only its gist and contents and leaves it open or closed.
const folds = new WeakMap();

/**
 * Renders the list into `container` from source_info's `sources`; hidden without them. Each refresh rebuilds the fold's
 * contents, keeping focus on a provider link or the fold's summary.
 */
export function renderAccounts(container, sources) {
  container.hidden = !Array.isArray(sources) || !sources.length;
  if (container.hidden) return;
  let accounts = folds.get(container);
  if (!accounts) {
    accounts = fold('accounts-fold', 'accounts', node('span', 'fold-title', 'Where to get each key'));
    container.replaceChildren(accounts.element); folds.set(container, accounts);
  }
  const credentials = sources.flatMap(source => (Array.isArray(source.credentials) ? source.credentials.map(c => ({ ...c, source })) : []));
  const states = ACCOUNTS.map(account => [account, accountState(account, credentials)]);
  const tools = localTools(sources);
  const set = states.filter(([, s]) => s.state === 'set').length;
  const absent = tools.filter(tool => !tool.available).length;
  accounts.gist.textContent = [`${set} of ${ACCOUNTS.length} accounts set in keys.env`, absent ? `${absent} local tool${absent > 1 ? 's' : ''} not installed` : null].filter(Boolean).join(' · ');
  rebuild(accounts.body, [
    node('p', 'meta', 'Each name links to the provider’s page for creating or finding the key. Set means keys.env holds every name the account needs (either name of an “or” pair is enough); Dig doesn’t check that the provider accepts it.'),
    node('ul', 'account-list', states.map(([account, state]) => accountRow(account, state))),
    ...(tools.length ? [node('h4', 'accounts-subtitle', 'On this computer'), node('ul', 'account-list', tools.map(toolRow))] : []),
  ]);
}
