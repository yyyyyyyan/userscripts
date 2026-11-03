import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseMetadata } from './metadata.mjs';

/**
 * Lists the scripts under `<root>/scripts/`, sorted by slug. A directory counts
 * as a script when it holds `<slug>.user.js`.
 * @param {string} root Repository root.
 * @returns {Promise<Array<{ slug: string, dir: string, file: string, readme: string, changelog: string, name: string | undefined }>>}
 */
export async function listScripts(root) {
  const entries = await readdir(join(root, 'scripts'), { withFileTypes: true });
  const scripts = [];
  for (const entry of entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const slug = entry.name;
    const dir = join(root, 'scripts', slug);
    const file = join(dir, `${slug}.user.js`);
    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    scripts.push({
      slug,
      dir,
      file,
      readme: join(dir, 'README.md'),
      changelog: join(dir, 'CHANGELOG.md'),
      name: parseMetadata(source).get('name'),
    });
  }
  return scripts;
}
