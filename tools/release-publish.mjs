import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { sectionBody } from './lib/changelog.mjs';
import { blobAt, git, listFilesAt, nameStatus, readAt } from './lib/git.mjs';
import { parseMetadata } from './lib/metadata.mjs';
import { compareVersions } from './lib/semver.mjs';

const root = join(import.meta.dirname, '..');
const usage = 'usage: node tools/release-publish.mjs --before <sha> --after <sha> --dist <dir>';
const SCRIPT_PATH = /^scripts\/([^/]+)\/\1\.user\.js$/;

/**
 * Finds the scripts released between two commits. A script is released when its
 * file was modified, its `@version` changed, `CHANGELOG.md` at `afterSha` has a
 * section for the new version, and that version is at least 1.0.0.
 * @param {string} beforeSha
 * @param {string} afterSha
 * @param {string} repo Path to the git repository.
 * @returns {Promise<Array<{ slug: string, version: string, notes: string }>>} Sorted by slug.
 */
export async function findReleases(beforeSha, afterSha, repo) {
  const releases = [];
  const changes = nameStatus(repo, ['--no-renames', beforeSha, afterSha, '--', 'scripts']);
  for (const { status, path } of changes) {
    const slug = SCRIPT_PATH.exec(path)?.[1];
    if (status !== 'M' || !slug) {
      continue;
    }
    const oldVersion = parseMetadata(readAt(repo, beforeSha, path) ?? '').get('version');
    const version = parseMetadata(readAt(repo, afterSha, path) ?? '').get('version');
    if (!version || version === oldVersion || compareVersions(version, '1.0.0') < 0) {
      continue;
    }
    const notes = sectionBody(
      readAt(repo, afterSha, `scripts/${slug}/CHANGELOG.md`) ?? '',
      version,
    );
    if (notes !== null) {
      releases.push({ slug, version, notes });
    }
  }
  return releases.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/**
 * Points the README's relative `images/` links at the per-script folder in
 * `dist`. Absolute URLs and other relative paths are left alone.
 * @param {string} readme
 * @param {string} slug
 * @returns {string}
 */
function rewriteImageLinks(readme, slug) {
  return readme
    .replace(/(\]\(\s*)images\//g, `$1images/${slug}/`)
    .replace(/(\bsrc\s*=\s*["'])images\//g, `$1images/${slug}/`);
}

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
 * Writes one release into the `dist` checkout and commits it there. The commit
 * message becomes the Greasy Fork changelog.
 * @param {string} dist
 * @param {string} afterSha
 * @param {{ slug: string, version: string, notes: string }} release
 */
async function publish(dist, afterSha, { slug, version, notes }) {
  const source = `scripts/${slug}`;
  const script = readAt(root, afterSha, `${source}/${slug}.user.js`) ?? '';
  const readme = readAt(root, afterSha, `${source}/README.md`);
  if (readme === null) {
    throw new Error(`${source}/README.md is missing at ${afterSha}`);
  }
  const name = parseMetadata(script).get('name') ?? slug;

  await writeFile(join(dist, `${slug}.user.js`), script);
  await writeFile(join(dist, `${slug}.md`), rewriteImageLinks(readme, slug));

  const imagesDir = join(dist, 'images', slug);
  await rm(imagesDir, { recursive: true, force: true });
  for (const file of listFilesAt(root, afterSha, `${source}/images`)) {
    const target = join(imagesDir, file.slice(`${source}/images/`.length));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, blobAt(root, afterSha, file));
  }

  const paths = [`${slug}.user.js`, `${slug}.md`];
  if ((await exists(imagesDir)) || git(dist, ['ls-files', '--', `images/${slug}`]).trim()) {
    paths.push(`images/${slug}`);
  }
  git(dist, ['add', '-A', '--', ...paths]);
  git(
    dist,
    ['commit', '--cleanup=whitespace', '-q', '-F', '-', '--', ...paths],
    `${name} ${version}\n\n${notes}\n`,
  );
}

/**
 * @param {string[]} args
 */
async function main(args) {
  const { values } = parseArgs({
    args,
    options: {
      before: { type: 'string' },
      after: { type: 'string' },
      dist: { type: 'string' },
    },
  });
  if (!values.before || !values.after || !values.dist) {
    throw new Error(usage);
  }
  for (const release of await findReleases(values.before, values.after, root)) {
    await publish(resolve(values.dist), values.after, release);
    console.log(`${release.slug}-v${release.version}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`release-publish: ${error.message}`);
    process.exitCode = 1;
  }
}
