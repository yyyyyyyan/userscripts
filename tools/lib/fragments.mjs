import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SECTIONS = [
  'breaking',
  'added',
  'changed',
  'deprecated',
  'removed',
  'fixed',
  'security',
];

export const SECTION_TITLES = {
  breaking: 'Breaking',
  added: 'Added',
  changed: 'Changed',
  deprecated: 'Deprecated',
  removed: 'Removed',
  fixed: 'Fixed',
  security: 'Security',
};

const SHORT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FILE_NAME = new RegExp(`^([a-z0-9]+(?:-[a-z0-9]+)*)\\.(${SECTIONS.join('|')})\\.md$`);
const MINOR_SECTIONS = ['added', 'changed', 'deprecated', 'removed'];

/**
 * @typedef {{ path: string, name: string, section: string, text: string }} Fragment
 */

/**
 * Splits `<short-name>.<section>.md`, or returns null when the file name is not
 * a valid fragment name.
 * @param {string} file
 * @returns {{ name: string, section: string } | null}
 */
export function parseFragmentName(file) {
  const match = FILE_NAME.exec(file);
  return match ? { name: match[1], section: match[2] } : null;
}

/**
 * Reads every fragment in `<scriptDir>/changelog.d/`, sorted by file name.
 * Dotfiles are skipped. A file whose name does not parse is an error, so a
 * misnamed fragment can't be silently left out of a release.
 * @param {string} scriptDir
 * @returns {Promise<Fragment[]>}
 */
export async function readFragments(scriptDir) {
  const dir = join(scriptDir, 'changelog.d');
  let files;
  try {
    files = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const fragments = [];
  for (const file of files.filter((f) => !f.startsWith('.')).sort()) {
    const parsed = parseFragmentName(file);
    if (!parsed) {
      throw new Error(`invalid fragment file name: ${file}`);
    }
    const path = join(dir, file);
    const text = (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
    fragments.push({ path, ...parsed, text });
  }
  return fragments;
}

/**
 * Checks one fragment against the fragment rules.
 * @param {{ name: string, section: string, text: string }} fragment
 * @returns {string[]} Problems found; an empty array means the fragment is valid.
 */
export function validateFragment(fragment) {
  const problems = [];
  if (!SHORT_NAME.test(fragment.name)) {
    problems.push(`short name "${fragment.name}" must be lowercase words joined by "-"`);
  }
  if (!SECTIONS.includes(fragment.section)) {
    problems.push(`section "${fragment.section}" must be one of: ${SECTIONS.join(', ')}`);
  }
  const text = fragment.text.replace(/\r?\n$/, '');
  if (text.includes('\n')) {
    problems.push('must be exactly one line');
  } else if (text.trim() === '') {
    problems.push('must not be empty');
  } else {
    if (text.startsWith('- ')) {
      problems.push('must not start with "- "');
    }
    if (!/[.!?]$/.test(text)) {
      problems.push('must end with ".", "!" or "?"');
    }
  }
  return problems;
}

/**
 * Picks the version bump the fragments call for: any `breaking` is major, any
 * of `added`, `changed`, `deprecated` or `removed` is minor, and the rest is
 * patch.
 * @param {Array<{ section: string }>} fragments
 * @returns {'major' | 'minor' | 'patch'}
 */
export function levelFor(fragments) {
  if (fragments.length === 0) {
    throw new Error('no fragments to derive a version bump from');
  }
  if (fragments.some((f) => f.section === 'breaking')) {
    return 'major';
  }
  if (fragments.some((f) => MINOR_SECTIONS.includes(f.section))) {
    return 'minor';
  }
  return 'patch';
}

/**
 * Renders a `CHANGELOG.md` section, ending in a newline. Sections follow the
 * order in `SECTIONS`; entries within a section are sorted by short name.
 * @param {string} version
 * @param {string} date
 * @param {Array<{ name: string, section: string, text: string }>} fragments
 * @returns {string}
 */
export function renderSection(version, date, fragments) {
  const blocks = [`## [${version}] - ${date}`];
  for (const section of SECTIONS) {
    const entries = fragments
      .filter((f) => f.section === section)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => `- ${f.text}`);
    if (entries.length > 0) {
      blocks.push(`### ${SECTION_TITLES[section]}`, entries.join('\n'));
    }
  }
  return `${blocks.join('\n\n')}\n`;
}
