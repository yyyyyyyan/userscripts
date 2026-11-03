import { stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { hasSection } from './lib/changelog.mjs';
import { parseFragmentName, readFragments, validateFragment } from './lib/fragments.mjs';
import { git, nameStatus, readAt } from './lib/git.mjs';
import { parseMetadata } from './lib/metadata.mjs';
import { listScripts } from './lib/scripts.mjs';

const root = join(import.meta.dirname, '..');
const usage = 'usage: node tools/check.mjs --base <sha> [--allow-no-changelog]';
const SCRIPT_PATH = /^scripts\/([^/]+)\/\1\.user\.js$/;
const FRAGMENT_PATH = /^scripts\/([^/]+)\/changelog\.d\/([^/]+)$/;

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  return stat(path).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    },
  );
}

/**
 * Checks every script directory as it is now: it needs a README, and its
 * pending fragments must be well formed.
 * @returns {Promise<string[]>}
 */
async function checkTree() {
  const violations = [];
  for (const script of await listScripts(root)) {
    if (!(await exists(script.readme))) {
      violations.push(`${relative(root, script.readme)}: missing`);
    }
    let fragments;
    try {
      fragments = await readFragments(script.dir);
    } catch (error) {
      violations.push(`${relative(root, join(script.dir, 'changelog.d'))}: ${error.message}`);
      continue;
    }
    for (const fragment of fragments) {
      for (const problem of validateFragment(fragment)) {
        violations.push(`${relative(root, fragment.path)}: ${problem}`);
      }
    }
  }
  return violations;
}

/**
 * Checks what the branch changed relative to its merge base with `base`.
 * @param {string} base
 * @param {boolean} allowNoChangelog
 * @returns {string[]}
 */
function checkDiff(base, allowNoChangelog) {
  const violations = [];
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  const changes = nameStatus(root, ['-M', `${base}...HEAD`]);

  const slugsWithNewFragment = new Set(
    changes
      .filter(({ status }) => status === 'A' || /^[RC]/.test(status))
      .flatMap(({ path }) => {
        const match = FRAGMENT_PATH.exec(path);
        return match && parseFragmentName(match[2]) ? [match[1]] : [];
      }),
  );

  for (const { status, path, oldPath } of changes) {
    if (oldPath && SCRIPT_PATH.test(oldPath)) {
      violations.push(`${oldPath}: published path renamed`);
    } else if (status === 'D' && SCRIPT_PATH.test(path)) {
      violations.push(`${path}: published path removed`);
    }

    const slug = SCRIPT_PATH.exec(path)?.[1];
    if (!slug) {
      continue;
    }
    const version = parseMetadata(readAt(root, 'HEAD', path) ?? '').get('version');

    if (status === 'A') {
      if (version !== '0.0.0') {
        violations.push(`${path}: new script must start at @version 0.0.0`);
      }
    } else if (status === 'M') {
      const oldVersion = parseMetadata(readAt(root, mergeBase, path) ?? '').get('version');
      const changelogPath = `scripts/${slug}/CHANGELOG.md`;
      const isRelease =
        version !== oldVersion &&
        hasSection(readAt(root, 'HEAD', changelogPath) ?? '', String(version)) &&
        !hasSection(readAt(root, mergeBase, changelogPath) ?? '', String(version));

      if (version !== oldVersion && !isRelease) {
        violations.push(`${path}: @version changed outside a release`);
      }
      if (!isRelease && !allowNoChangelog && !slugsWithNewFragment.has(slug)) {
        violations.push(
          `${path}: needs a changelog fragment in scripts/${slug}/changelog.d/ ` +
            `(or the no-changelog label)`,
        );
      }
    }
  }
  return violations;
}

/**
 * @param {string[]} args
 * @returns {Promise<string[]>} One line per violation.
 */
async function main(args) {
  const { values } = parseArgs({
    args,
    options: { base: { type: 'string' }, 'allow-no-changelog': { type: 'boolean' } },
  });
  if (!values.base) {
    throw new Error(usage);
  }
  return [...(await checkTree()), ...checkDiff(values.base, values['allow-no-changelog'] ?? false)];
}

try {
  const violations = await main(process.argv.slice(2));
  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`check: ${error.message}`);
  process.exitCode = 1;
}
