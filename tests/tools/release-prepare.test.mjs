import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const repoRoot = join(import.meta.dirname, '..', '..');
const slug = 'sample';
const header = [
  '// ==UserScript==',
  '// @name         Sample',
  '// @namespace    yyyyyyyan/sample',
  '// @version      0.0.0',
  '// @description  Log a greeting to the console on the example page.',
  '// ==/UserScript==',
  '',
  "console.log('sample');",
  '',
].join('\n');

const intro =
  '# Changelog\n\nAll notable changes to Sample are documented here. ' +
  'The format is based on Keep a Changelog, and versions follow Semantic Versioning.\n';

describe('release-prepare', () => {
  const roots = [];
  let root;
  let scriptDir;

  const run = (...args) =>
    spawnSync(process.execPath, [join(root, 'tools', 'release-prepare.mjs'), ...args], {
      encoding: 'utf8',
    });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'release-prepare-'));
    roots.push(root);
    await cp(join(repoRoot, 'tools'), join(root, 'tools'), { recursive: true });
    scriptDir = join(root, 'scripts', slug);
    await mkdir(join(scriptDir, 'changelog.d'), { recursive: true });
    await writeFile(join(scriptDir, `${slug}.user.js`), header);
    await writeFile(join(scriptDir, 'changelog.d', 'x.fixed.md'), 'Fixes the thing.\n');
  });

  after(() => Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))));

  it('prepares the first release as 1.0.0', async () => {
    const result = run(slug, '--date', '2026-11-03');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '1.0.0\n');
    assert.equal(result.stderr, '');

    const script = await readFile(join(scriptDir, `${slug}.user.js`), 'utf8');
    assert.equal(script, header.replace('0.0.0', '1.0.0'));

    const changelog = await readFile(join(scriptDir, 'CHANGELOG.md'), 'utf8');
    assert.equal(
      changelog,
      `${intro}\n## [1.0.0] - 2026-11-03\n\n### Fixed\n\n- Fixes the thing.\n`,
    );

    assert.deepEqual(await readdir(join(scriptDir, 'changelog.d')), []);
  });

  it('defaults the date to today in UTC', async () => {
    const result = run(slug);
    assert.equal(result.status, 0, result.stderr);
    const today = new Date().toISOString().slice(0, 10);
    const changelog = await readFile(join(scriptDir, 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog.includes(`## [1.0.0] - ${today}`));
  });

  it('inserts the new section above older ones and bumps from the current version', async () => {
    await writeFile(join(scriptDir, `${slug}.user.js`), header.replace('0.0.0', '1.0.0'));
    await writeFile(
      join(scriptDir, 'CHANGELOG.md'),
      `${intro}\n## [1.0.0] - 2026-11-03\n\n### Added\n\n- First release.\n`,
    );
    await writeFile(join(scriptDir, 'changelog.d', 'y.added.md'), 'Adds y.\n');

    const result = run(slug, '--date', '2026-12-01');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '1.1.0\n');

    const changelog = await readFile(join(scriptDir, 'CHANGELOG.md'), 'utf8');
    assert.equal(
      changelog,
      `${intro}\n## [1.1.0] - 2026-12-01\n\n### Added\n\n- Adds y.\n\n### Fixed\n\n- Fixes the thing.\n\n` +
        '## [1.0.0] - 2026-11-03\n\n### Added\n\n- First release.\n',
    );
  });

  it('exits 1 when there are no pending fragments', async () => {
    assert.equal(run(slug, '--date', '2026-11-03').status, 0);
    const again = run(slug, '--date', '2026-11-04');
    assert.equal(again.status, 1);
    assert.equal(again.stdout, '');
    assert.match(again.stderr, /no pending changelog fragments/);
  });

  it('changes nothing when a fragment is invalid', async () => {
    await writeFile(join(scriptDir, 'changelog.d', 'bad.added.md'), '- no full stop');
    const result = run(slug, '--date', '2026-11-03');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bad\.added\.md/);
    assert.equal(await readFile(join(scriptDir, `${slug}.user.js`), 'utf8'), header);
    assert.deepEqual((await readdir(join(scriptDir, 'changelog.d'))).sort(), [
      'bad.added.md',
      'x.fixed.md',
    ]);
  });

  it('exits 1 for an unknown slug', () => {
    const result = run('nope');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown script: nope/);
  });

  it('exits 1 for a malformed date', () => {
    const result = run(slug, '--date', '03/11/2026');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /YYYY-MM-DD/);
  });

  it('exits 1 with usage when no slug is given', () => {
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage:/);
  });
});
