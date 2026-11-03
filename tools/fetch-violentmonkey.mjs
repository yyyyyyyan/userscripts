import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '2.50.0';
export const SHA256 = '72f1de5a2edc4bc3cd3b3ca06c2b3631cdde4f06f8ed9e8b2b565bf77258b36c';

const root = join(import.meta.dirname, '..');
const cacheDir = join(root, '.cache', 'violentmonkey');
export const extensionDir = join(cacheDir, VERSION);
const zipPath = join(cacheDir, `${VERSION}.zip`);
const assetUrl = `https://github.com/violentmonkey/violentmonkey/releases/download/v${VERSION}/Violentmonkey-mv3-v${VERSION}.zip`;

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the cached zip when its hash matches, downloading the pinned release
 * asset otherwise.
 * @returns {Promise<Uint8Array>}
 */
async function pinnedZip() {
  if (await exists(zipPath)) {
    const cached = await readFile(zipPath);
    if (sha256(cached) === SHA256) {
      return cached;
    }
  }
  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText} for ${assetUrl}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== SHA256) {
    throw new Error(`sha256 mismatch for ${assetUrl}: expected ${SHA256}, got ${actual}`);
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(zipPath, bytes);
  return bytes;
}

/**
 * Makes sure the pinned unpacked Violentmonkey exists. Does nothing when it is
 * already unpacked.
 * @returns {Promise<string>} The unpacked extension directory.
 */
export async function ensureViolentmonkey() {
  if (await exists(join(extensionDir, 'manifest.json'))) {
    return extensionDir;
  }
  await pinnedZip();
  const staging = `${extensionDir}.partial`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', staging]);
  await rm(extensionDir, { recursive: true, force: true });
  await rename(staging, extensionDir);
  return extensionDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(await ensureViolentmonkey());
  } catch (error) {
    console.error(`fetch-violentmonkey: ${error.message}`);
    process.exitCode = 1;
  }
}
