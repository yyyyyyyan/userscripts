import { spawnSync } from 'node:child_process';

const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * @param {string} repo
 * @param {string[]} args
 * @param {{ input?: string, encoding?: 'utf8' | 'buffer' }} [options]
 */
function run(repo, args, { input, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    input,
    encoding: encoding === 'buffer' ? 'buffer' : 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

/**
 * Runs git in `repo` and returns stdout.
 * @param {string} repo
 * @param {string[]} args
 * @param {string} [input] Text for stdin.
 * @returns {string}
 */
export function git(repo, args, input) {
  const result = run(repo, args, { input });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`);
  }
  return String(result.stdout);
}

/**
 * Returns the contents of `<rev>:<path>` as bytes.
 * @param {string} repo
 * @param {string} rev
 * @param {string} path
 * @returns {Buffer}
 */
export function blobAt(repo, rev, path) {
  const result = run(repo, ['cat-file', 'blob', `${rev}:${path}`], { encoding: 'buffer' });
  if (result.status !== 0) {
    throw new Error(`git cat-file ${rev}:${path} failed: ${String(result.stderr).trim()}`);
  }
  return Buffer.from(result.stdout);
}

/**
 * Returns the text of a file at a revision, or null when the revision has no
 * such file. The revision itself must be valid.
 * @param {string} repo
 * @param {string} rev
 * @param {string} path
 * @returns {string | null}
 */
export function readAt(repo, rev, path) {
  git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return run(repo, ['cat-file', '-e', `${rev}:${path}`]).status === 0
    ? blobAt(repo, rev, path).toString('utf8')
    : null;
}

/**
 * Lists the files under a directory at a revision, as repo-relative paths.
 * @param {string} repo
 * @param {string} rev
 * @param {string} dir
 * @returns {string[]}
 */
export function listFilesAt(repo, rev, dir) {
  return git(repo, ['ls-tree', '-r', '-z', '--name-only', rev, '--', `${dir}/`])
    .split('\0')
    .filter(Boolean);
}

/**
 * Runs `git diff --name-status` with the given arguments.
 * @param {string} repo
 * @param {string[]} args Diff options and revisions, e.g. `['-M', 'base...HEAD']`.
 * @returns {Array<{ status: string, path: string, oldPath?: string }>} For renames
 *   and copies, `path` is the new path and `oldPath` the old one.
 */
export function nameStatus(repo, args) {
  const tokens = git(repo, ['diff', '--name-status', '-z', ...args]).split('\0');
  const changes = [];
  for (let i = 0; i < tokens.length && tokens[i] !== '';) {
    const status = tokens[i];
    if (/^[RC]/.test(status)) {
      changes.push({ status, oldPath: tokens[i + 1], path: tokens[i + 2] });
      i += 3;
    } else {
      changes.push({ status, path: tokens[i + 1] });
      i += 2;
    }
  }
  return changes;
}
