import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

/**
 * Runs git in `cwd` and returns trimmed stdout. Fails the test on a non-zero exit.
 * @param {string} cwd
 * @param {...string} args
 * @returns {string}
 */
export function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * @param {string} cwd
 */
function configureIdentity(cwd) {
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

/**
 * Builds the text of a userscript.
 * @param {{ name?: string, version?: string, body?: string }} [options]
 * @returns {string}
 */
export function scriptSource({ name = 'Sample', version = '0.0.0', body = 'one' } = {}) {
  return [
    '// ==UserScript==',
    `// @name         ${name}`,
    '// @namespace    yyyyyyyan/sample',
    `// @version      ${version}`,
    '// @description  Log a greeting to the console on the example page.',
    '// ==/UserScript==',
    '',
    `console.log('${body}');`,
    '',
  ].join('\n');
}

/**
 * Creates a temporary git repository on `main` with a copy of `tools/`, so the
 * CLIs can run inside it.
 * @returns {Promise<{
 *   root: string,
 *   write: (path: string, content: string | Buffer) => Promise<void>,
 *   remove: (path: string) => Promise<void>,
 *   commit: (message: string) => string,
 *   head: () => string,
 *   cleanup: () => Promise<void>,
 * }>}
 */
export async function createRepo() {
  const root = await mkdtemp(join(tmpdir(), 'userscripts-repo-'));
  await cp(join(repoRoot, 'tools'), join(root, 'tools'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  configureIdentity(root);
  await writeFile(join(root, '.git', 'info', 'exclude'), 'tools/\n');
  return {
    root,
    async write(path, content) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    },
    async remove(path) {
      await rm(join(root, path), { recursive: true, force: true });
    },
    commit(message) {
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '--allow-empty', '-m', message);
      return git(root, 'rev-parse', 'HEAD');
    },
    head: () => git(root, 'rev-parse', 'HEAD'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Creates a temporary git repository with one commit, to stand in for the
 * `dist` branch checkout.
 * @returns {Promise<{ dir: string, cleanup: () => Promise<void> }>}
 */
export async function createDist() {
  const dir = await mkdtemp(join(tmpdir(), 'userscripts-dist-'));
  git(dir, 'init', '-q', '-b', 'dist');
  configureIdentity(dir);
  await writeFile(join(dir, '.gitkeep'), '');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Runs one of the repository's tools inside a temporary repository.
 * @param {string} root
 * @param {string} tool File name under `tools/`.
 * @param {string[]} args
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function runTool(root, tool, args) {
  return spawnSync(process.execPath, [join(root, 'tools', tool), ...args], { encoding: 'utf8' });
}
