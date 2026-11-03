import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { blobAt, git, listFilesAt, nameStatus, readAt } from './lib/git.mjs';
import { parseMetadata } from './lib/metadata.mjs';
import { releaseOf } from './lib/release.mjs';

const root = join(import.meta.dirname, '..');
const usage = 'usage: node tools/release-publish.mjs --before <sha> --after <sha> --dist <dir>';
const SCRIPT_PATH = /^scripts\/([^/]+)\/\1\.user\.js$/;

/**
 * Walks the first-parent commits in `beforeSha..afterSha`, oldest first, and
 * compares each with its first parent. Root commits are skipped.
 * @param {string} beforeSha
 * @param {string} afterSha
 * @param {string} repo
 * @returns {Array<{ slug: string, version: string, notes: string, commit: string }>}
 */
function releasesByCommit(beforeSha, afterSha, repo) {
  const releases = [];
  const lines = git(repo, [
    'rev-list',
    '--reverse',
    '--first-parent',
    '--parents',
    `${beforeSha}..${afterSha}`,
  ])
    .split('\n')
    .filter(Boolean);
  for (const line of lines) {
    const [commit, parent] = line.split(' ');
    if (!parent) {
      continue;
    }
    const changes = nameStatus(repo, ['--no-renames', parent, commit, '--', 'scripts']);
    for (const { status, path } of changes) {
      const slug = SCRIPT_PATH.exec(path)?.[1];
      if (status !== 'M' || !slug) {
        continue;
      }
      const changelogPath = `scripts/${slug}/CHANGELOG.md`;
      const release = releaseOf({
        oldSource: readAt(repo, parent, path),
        newSource: readAt(repo, commit, path),
        oldChangelog: readAt(repo, parent, changelogPath),
        newChangelog: readAt(repo, commit, changelogPath),
      });
      if (release) {
        releases.push({ slug, ...release, commit });
      }
    }
  }
  return releases;
}

/**
 * Finds the releases between two commits. Each first-parent commit in
 * `beforeSha..afterSha` is compared with its parent, so several releases of one
 * script in a push each get their own entry.
 * @param {string} beforeSha
 * @param {string} afterSha
 * @param {string} repo Path to the git repository.
 * @returns {Promise<Array<{ slug: string, version: string, notes: string }>>} In commit
 *   order, then by slug.
 */
export async function findReleases(beforeSha, afterSha, repo) {
  return releasesByCommit(beforeSha, afterSha, repo).map(({ slug, version, notes }) => ({
    slug,
    version,
    notes,
  }));
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
 * @param {{ slug: string, version: string, notes: string, commit: string }} release
 */
async function publish(dist, { slug, version, notes, commit }) {
  const source = `scripts/${slug}`;
  const script = readAt(root, commit, `${source}/${slug}.user.js`) ?? '';
  const readme = readAt(root, commit, `${source}/README.md`);
  if (readme === null) {
    throw new Error(`${source}/README.md is missing at ${commit}`);
  }
  const name = parseMetadata(script).get('name') ?? slug;

  await writeFile(join(dist, `${slug}.user.js`), script);
  await writeFile(join(dist, `${slug}.md`), rewriteImageLinks(readme, slug));

  const imagesDir = join(dist, 'images', slug);
  await rm(imagesDir, { recursive: true, force: true });
  for (const file of listFilesAt(root, commit, `${source}/images`)) {
    const target = join(imagesDir, file.slice(`${source}/images/`.length));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, blobAt(root, commit, file));
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
  for (const release of releasesByCommit(values.before, values.after, root)) {
    await publish(resolve(values.dist), release);
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
