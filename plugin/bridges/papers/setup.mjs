#!/usr/bin/env node
/**
 * Installs Dig's optional Papers bridge: openags/paper-search-mcp (MIT) at a
 * tested upstream commit plus the maintained compatibility patch beside this
 * file, inside Dig's native state directory. Ported from the existing Dig
 * edition's papers/setup-paper-search-mcp.ts. It never reads, copies or prints
 * credentials, and it makes no research request unless --live-smoke is given.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM_REPO = 'https://github.com/openags/paper-search-mcp.git';
const UPSTREAM_COMMIT = 'c8b642183bb725f0a7faec89e58b558df09079d1';
const PATCH_PATH = fileURLToPath(new URL('paper-search-mcp.patch', import.meta.url));
// The exact patch earlier Dig versions installed, kept only so setup can
// recognize and replace it. SHA-256:
// 236e7e3ce6bf8b52d2c84a4fce768c91f5158b3e7cf58f36e3d142ac7cb1c183
const PREVIOUS_PATCH_PATH = fileURLToPath(new URL('paper-search-mcp.previous.patch', import.meta.url));
/** The only patches setup removes, current first; any other change is refused. */
const RECOGNIZED_PATCHES = [PATCH_PATH, PREVIOUS_PATCH_PATH];
const EMAIL_KEY = 'PAPER_SEARCH_MCP_UNPAYWALL_EMAIL';
// src/config.mjs stateDirectory() applies this rule; the server looks for the bridge here.
const STATE = resolve(process.env.DIG_STATE_DIR || join(homedir(), '.local', 'share', 'dig'));
const TARGET = join(STATE, 'tools', 'paper-search-mcp');
// Upstream's .gitignore covers `.env`. The server, like this setup, points
// PAPER_SEARCH_MCP_ENV_FILE here unless it is exported, so neither reads a
// user-global file another installation wrote.
const ENV_FILE = join(TARGET, '.env');
const BRIDGE_ENV = { ...process.env, PAPER_SEARCH_MCP_ENV_FILE: process.env.PAPER_SEARCH_MCP_ENV_FILE?.trim() || ENV_FILE };

function print(message) {
	process.stdout.write(`${message}\n`);
}

function fail(message) {
	process.stderr.write(`ERROR: ${message}\n`);
	process.exit(1);
}

function usage() {
	print(`Usage: node ${fileURLToPath(import.meta.url)} [options]

Installs Dig's optional Papers bridge at
  ${TARGET}
inside Dig's native state directory (DIG_STATE_DIR overrides it).
Requires git and uv. Setup downloads the pinned upstream source and its Python
dependencies; it makes no research request unless --live-smoke is given.

Options:
  --email <address>   Unpaywall contact email, written to the bridge's own
                      .env (mode 600). Nothing is inferred: without it,
                      Unpaywall needs ${EMAIL_KEY} in the
                      environment Dig's server runs in (for example Dig's
                      keys.env). Other sources work without it.
  --live-smoke        After installing, run one live keyless SSRN/OpenAlex
                      search to check provider compatibility. Off by default.
  --help              Show this help

Optional provider keys are never read, copied or stored by this setup. The
bridge receives them from the environment Dig's server runs in (exported
variables or Dig's keys.env): SEMANTIC_SCHOLAR_API_KEY, OPENALEX_API_KEY and
NCBI_API_KEY, each also as PAPER_SEARCH_MCP_<name>, which takes priority when
non-empty, plus PAPER_SEARCH_MCP_CORE_API_KEY. Keyless operation remains
available with provider-specific shared rate limits and metered daily budgets.

The clone is pinned to a tested upstream commit and receives the maintained
compatibility patch beside this script. Re-running is safe: the script removes
only an exactly recognized copy of that patch, or of the patch earlier Dig
versions installed, restores the pin, and applies the current patch. Unknown
local changes are refused before patch removal.`);
	process.exit(0);
}

function parseOptions(argv) {
	const options = { email: '', liveSmoke: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') usage();
		if (arg === '--live-smoke') {
			options.liveSmoke = true;
			continue;
		}
		if (arg !== '--email') fail(`unknown option: ${arg}`);
		const value = argv[index + 1];
		if (!value) fail(`${arg} requires a value`);
		index += 1;
		options.email = value.trim();
	}
	return options;
}

/** An executable regular file of this name on PATH. */
function onPath(name) {
	return (process.env.PATH ?? '').split(delimiter).some((directory) => {
		if (!directory) return false;
		const path = resolve(directory, name);
		try {
			if (!statSync(path).isFile()) return false;
			accessSync(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

function run(argv, cwd, env = process.env) {
	return new Promise((settle, reject) => {
		const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
		const stdout = [];
		const stderr = [];
		child.stdout.on('data', (chunk) => stdout.push(chunk));
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.on('error', reject);
		// A process killed by a signal has no exit code; it did not succeed.
		child.on('close', (code) => settle({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
	});
}

async function runRequired(argv, cwd, env) {
	const result = await run(argv, cwd, env);
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim();
		fail(`${argv.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
	}
	return result.stdout;
}

async function exists(target) {
	try {
		await fs.stat(target);
		return true;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
		throw error;
	}
}

/**
 * The patch the clone carries. Refuses unless its only changes are exactly one
 * recognized patch at the pin.
 */
async function recognizeInstalledPatch(target) {
	const head = (await runRequired(['git', 'rev-parse', 'HEAD'], target)).trim();
	const staged = await run(['git', '--no-optional-locks', 'diff', '--cached', '--quiet', '--no-ext-diff'], target);
	if (head !== UPSTREAM_COMMIT || staged.code !== 0) {
		fail(`${target} has a different HEAD or staged changes; refusing to remove any patch`);
	}
	for (const patch of RECOGNIZED_PATCHES) {
		if (await matchesPatch(target, patch)) return patch;
	}
	fail(`${target} has changes beyond the recognized compatibility patch; refusing to overwrite them`);
}

/** Whether the clone's worktree is exactly the pin plus `patch`; a failed preflight refuses. */
async function matchesPatch(target, patch) {
	// Build the expected tree in a disposable clone. Neither the installed
	// worktree nor its index is mutated by this preflight, including on a failed match.
	const scratch = await fs.mkdtemp(join(tmpdir(), 'paper-search-patch-'));
	const preflight = async (argv, cwd) => {
		const result = await run(argv, cwd);
		if (result.code !== 0) throw new Error(`Patch preflight failed: ${(result.stderr || result.stdout).trim()}`);
		return result.stdout;
	};
	let failure = '';
	try {
		await preflight(['git', 'clone', '--shared', '--no-checkout', target, scratch]);
		await preflight(['git', 'checkout', '--detach', UPSTREAM_COMMIT], scratch);
		await preflight(['git', 'apply', '--index', patch], scratch);
		const comparison = ['git', `--git-dir=${join(scratch, '.git')}`, `--work-tree=${target}`];
		const diff = await run([...comparison, 'diff', '--quiet', '--no-ext-diff', '--no-textconv']);
		const untracked = await preflight([...comparison, 'ls-files', '--others', '--exclude-standard', '-z']);
		return diff.code === 0 && !untracked;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Patch preflight failed';
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}
	fail(failure);
}

async function prepareClone(target) {
	const gitDir = join(target, '.git');
	if (!(await exists(target))) {
		await fs.mkdir(target, { recursive: true });
		await runRequired(['git', 'init'], target);
		await runRequired(['git', 'remote', 'add', 'origin', UPSTREAM_REPO], target);
	} else if (!(await exists(gitDir))) {
		fail(`${target} exists but is not a git clone`);
	}

	const before = await runRequired(['git', '--no-optional-locks', 'status', '--porcelain'], target);
	if (before.trim()) {
		const installed = await recognizeInstalledPatch(target);
		await runRequired(['git', 'apply', '--reverse', '--check', installed], target);
		print(installed === PATCH_PATH ? 'Refreshing the recognized compatibility patch...' : 'Replacing the recognized earlier compatibility patch...');
		await runRequired(['git', 'apply', '--reverse', installed], target);
	}

	const status = await runRequired(['git', '--no-optional-locks', 'status', '--porcelain'], target);
	if (status.trim()) fail(`${target} remains dirty after patch removal; refusing to overwrite it`);

	const pinned = await run(['git', 'cat-file', '-e', `${UPSTREAM_COMMIT}^{commit}`], target);
	if (pinned.code !== 0) {
		print(`Fetching tested upstream commit ${UPSTREAM_COMMIT.slice(0, 12)}...`);
		await runRequired(['git', 'fetch', '--depth', '1', 'origin', UPSTREAM_COMMIT], target);
	}
	await runRequired(['git', 'checkout', '--detach', UPSTREAM_COMMIT], target);

	const patchCheck = await run(['git', 'apply', '--check', PATCH_PATH], target);
	if (patchCheck.code !== 0) fail('the compatibility patch no longer applies to the pinned upstream commit');
	await runRequired(['git', 'apply', PATCH_PATH], target);
	print('Applied the maintained compatibility patch.');
}

function readEnvValue(content, key) {
	const prefix = `${key}=`;
	const line = content.split('\n').find((candidate) => candidate.startsWith(prefix));
	return line?.slice(prefix.length).trim() ?? '';
}

function setEnvValue(content, key, value) {
	if (/[\r\n]/.test(value)) fail(`${key} must be a single-line value`);
	const line = `${key}=${value}`;
	const rows = content ? content.split('\n') : [];
	const index = rows.findIndex((candidate) => candidate.startsWith(`${key}=`));
	if (index >= 0) rows[index] = line;
	else rows.push(line);
	return rows.join('\n').replace(/\n*$/, '\n');
}

/** Writes only an explicitly given contact email; nothing is inferred or copied. */
async function configure(email) {
	const content = (await exists(ENV_FILE)) ? await fs.readFile(ENV_FILE, 'utf8') : '';
	if (!email) {
		print(readEnvValue(content, EMAIL_KEY)
			? `Unpaywall contact email: kept as configured in ${ENV_FILE}.`
			: `Unpaywall contact email: not configured. Rerun with --email <address>, or set ${EMAIL_KEY} where Dig's server runs; other sources work without it.`);
		return;
	}
	await fs.writeFile(ENV_FILE, setEnvValue(content, EMAIL_KEY, email), { mode: 0o600 });
	await fs.chmod(ENV_FILE, 0o600);
	print(`Configured the Unpaywall contact email in ${ENV_FILE}.`);
}

async function install(target, liveSmoke) {
	const syncArgs = (await exists(join(target, '.venv', 'bin', 'paper-search'))) ? ['--no-sync'] : [];
	print('Installing the bridge environment if needed and checking source registration (an existing environment is not reinstalled)...');
	await runRequired(['uv', 'run', ...syncArgs, '--directory', target, 'paper-search', 'sources'], undefined, BRIDGE_ENV);
	if (!liveSmoke) return;

	print('Running the live SSRN/OpenAlex compatibility smoke check...');
	const output = await runRequired([
		'uv', 'run', '--no-sync', '--directory', target, 'paper-search', 'search', 'corporate governance',
		'-s', 'ssrn', '-n', '1',
	], undefined, BRIDGE_ENV);
	let result;
	try {
		result = JSON.parse(output);
	} catch {
		fail('the SSRN smoke check returned invalid JSON, not provider evidence');
	}
	if (result.source_status?.ssrn !== 'ok' || !result.papers?.some((paper) => paper.source === 'ssrn')) {
		fail('SSRN smoke did not produce healthy SSRN evidence; inspect the provider health without exposing credentials');
	}
}

const options = parseOptions(process.argv.slice(2));
if (!onPath('git')) fail('git is required');
if (!onPath('uv')) fail('uv is required; install it from https://docs.astral.sh/uv/ (for example: brew install uv)');
for (const patch of RECOGNIZED_PATCHES) {
	if (!(await exists(patch))) fail(`missing compatibility patch: ${patch}`);
}

await prepareClone(TARGET);
await configure(options.email);
await install(TARGET, options.liveSmoke);
print(`paper-search-mcp is ready at ${TARGET}. Enable Papers in Dig's settings to use it.`);
