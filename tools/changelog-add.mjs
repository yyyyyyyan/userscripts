import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { validateFragment } from './lib/fragments.mjs';
import { listScripts } from './lib/scripts.mjs';

const root = join(import.meta.dirname, '..');
const usage = 'usage: node tools/changelog-add.mjs <slug> <section> <short-name> "<sentence>"';

/**
 * @param {string[]} args
 * @returns {Promise<string>} Path of the fragment written.
 */
async function main(args) {
  if (args.length !== 4) {
    throw new Error(usage);
  }
  const [slug, section, name, text] = args;
  const script = (await listScripts(root)).find((s) => s.slug === slug);
  if (!script) {
    throw new Error(`unknown script: ${slug}`);
  }
  const problems = validateFragment({ name, section, text });
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
  const dir = join(script.dir, 'changelog.d');
  const path = join(dir, `${name}.${section}.md`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path, `${text}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`${relative(process.cwd(), path)} already exists`, { cause: error });
    }
    throw error;
  }
  return path;
}

try {
  console.log(relative(process.cwd(), await main(process.argv.slice(2))));
} catch (error) {
  console.error(`changelog-add: ${error.message}`);
  process.exitCode = 1;
}
