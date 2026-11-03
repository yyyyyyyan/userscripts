import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { levelFor, readFragments, renderSection, validateFragment } from './lib/fragments.mjs';
import { parseMetadata, setVersion } from './lib/metadata.mjs';
import { listScripts } from './lib/scripts.mjs';
import { bumpVersion } from './lib/semver.mjs';

const root = join(import.meta.dirname, '..');
const usage = 'usage: node tools/release-prepare.mjs <slug> [--date YYYY-MM-DD]';

/**
 * @param {string} date
 * @returns {boolean}
 */
function isCalendarDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date).toISOString().slice(0, 10) === date;
}

/**
 * @param {string} name
 * @returns {string}
 */
function newChangelog(name) {
  return (
    `# Changelog\n\nAll notable changes to ${name} are documented here. ` +
    'The format is based on Keep a Changelog, and versions follow Semantic Versioning.\n'
  );
}

/**
 * Puts a section above the existing ones, or at the end when there are none.
 * @param {string} changelog
 * @param {string} section
 * @returns {string}
 */
function insertSection(changelog, section) {
  const firstRelease = changelog.search(/^## /m);
  if (firstRelease === -1) {
    return `${changelog.trimEnd()}\n\n${section}`;
  }
  return `${changelog.slice(0, firstRelease)}${section}\n${changelog.slice(firstRelease)}`;
}

/**
 * @param {string[]} args
 * @returns {Promise<string>} The new version.
 */
async function main(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { date: { type: 'string' } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new Error(usage);
  }
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  if (!isCalendarDate(date)) {
    throw new Error(`--date must be a real date in the form YYYY-MM-DD, got "${date}"`);
  }

  const [slug] = positionals;
  const script = (await listScripts(root)).find((s) => s.slug === slug);
  if (!script) {
    throw new Error(`unknown script: ${slug}`);
  }

  const fragments = await readFragments(script.dir);
  if (fragments.length === 0) {
    throw new Error(`no pending changelog fragments for ${slug}`);
  }
  const problems = fragments.flatMap((fragment) =>
    validateFragment(fragment).map((problem) => `${relative(root, fragment.path)}: ${problem}`),
  );
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }

  const source = await readFile(script.file, 'utf8');
  const current = parseMetadata(source).get('version');
  if (!current) {
    throw new Error(`${relative(root, script.file)} has no @version`);
  }
  const version = bumpVersion(current, levelFor(fragments));

  const existing = await readFile(script.changelog, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') {
      return newChangelog(script.name ?? slug);
    }
    throw error;
  });
  if (existing.includes(`## [${version}]`)) {
    throw new Error(`${relative(root, script.changelog)} already has a section for ${version}`);
  }

  await writeFile(
    script.changelog,
    insertSection(existing, renderSection(version, date, fragments)),
  );
  await writeFile(script.file, setVersion(source, version));
  await Promise.all(fragments.map((fragment) => rm(fragment.path)));
  return version;
}

try {
  console.log(await main(process.argv.slice(2)));
} catch (error) {
  console.error(`release-prepare: ${error.message}`);
  process.exitCode = 1;
}
