import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const repoRoot = join(import.meta.dirname, '..', '..');
const slug = 'sample';

describe('changelog-add', () => {
  let root;
  let fragmentsDir;

  const run = (...args) =>
    spawnSync(process.execPath, [join(root, 'tools', 'changelog-add.mjs'), ...args], {
      encoding: 'utf8',
    });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'changelog-add-'));
    await cp(join(repoRoot, 'tools'), join(root, 'tools'), { recursive: true });
    const scriptDir = join(root, 'scripts', slug);
    await mkdir(scriptDir, { recursive: true });
    await writeFile(
      join(scriptDir, `${slug}.user.js`),
      '// ==UserScript==\n// @name         Sample\n// @version      0.0.0\n// ==/UserScript==\n',
    );
    fragmentsDir = join(scriptDir, 'changelog.d');
  });

  after(() => rm(root, { recursive: true, force: true }));

  it('writes a one-line fragment, creating changelog.d', async () => {
    const result = run(slug, 'fixed', 'csp-styling', 'Fixes styling on pages with strict CSP.');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(join(fragmentsDir, 'csp-styling.fixed.md'), 'utf8'),
      'Fixes styling on pages with strict CSP.\n',
    );
  });

  it('refuses to overwrite an existing fragment', async () => {
    const result = run(slug, 'fixed', 'csp-styling', 'Something else.');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists/);
  });

  it('rejects an invalid sentence, section, name or slug without writing', async () => {
    const cases = [
      [slug, 'added', 'no-stop', 'Missing the full stop'],
      [slug, 'added', 'bullet', '- Adds a bullet.'],
      [slug, 'nonsense', 'x', 'Adds x.'],
      [slug, 'added', 'Bad_Name', 'Adds x.'],
      ['nope', 'added', 'x', 'Adds x.'],
      [slug, 'added', 'trailing-newline', 'Adds x.\n'],
      [slug, 'added', 'two-lines', 'Adds x.\nAdds y.'],
    ];
    for (const args of cases) {
      const result = run(...args);
      assert.equal(result.status, 1, args.join(' '));
      assert.notEqual(result.stderr, '', args.join(' '));
    }
    assert.deepEqual(await readdir(fragmentsDir), ['csp-styling.fixed.md']);
  });

  it('prints usage when arguments are missing', () => {
    const result = run(slug, 'added');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage:/);
  });
});
