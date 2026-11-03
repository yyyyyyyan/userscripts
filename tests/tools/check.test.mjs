import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { createRepo, runTool, scriptSource } from '../helpers/repo.mjs';

const scriptPath = 'scripts/alpha/alpha.user.js';
const intro = '# Changelog\n\nIntro.\n';
const section = (version, body = '### Added\n\n- Adds alpha.') =>
  `## [${version}] - 2026-11-03\n\n${body}\n`;

describe('check', () => {
  const cleanups = [];
  let repo;
  let base;

  beforeEach(async () => {
    repo = await createRepo();
    cleanups.push(repo.cleanup);
    await repo.write(scriptPath, scriptSource({ name: 'Alpha', version: '1.0.0' }));
    await repo.write('scripts/alpha/README.md', '# Alpha\n');
    await repo.write('scripts/alpha/CHANGELOG.md', `${intro}\n${section('1.0.0')}`);
    await repo.write('scripts/alpha/changelog.d/.gitkeep', '');
    base = repo.commit('base');
  });

  after(() => Promise.all(cleanups.map((cleanup) => cleanup())));

  const check = (...extra) => runTool(repo.root, 'check.mjs', ['--base', base, ...extra]);

  const editScript = (body = 'two') =>
    repo.write(scriptPath, scriptSource({ name: 'Alpha', version: '1.0.0', body }));

  it('passes when nothing relevant changed', () => {
    const result = check();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });

  it('fails a modified script that has no new fragment', async () => {
    await editScript();
    repo.commit('change alpha');
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scripts\/alpha\/alpha\.user\.js: needs a changelog fragment/);
  });

  it('passes the same change with --allow-no-changelog', async () => {
    await editScript();
    repo.commit('change alpha');
    const result = check('--allow-no-changelog');
    assert.equal(result.status, 0, result.stderr);
  });

  it('passes a modified script with a new fragment', async () => {
    await editScript();
    await repo.write('scripts/alpha/changelog.d/tweak.fixed.md', 'Fixes the tweak.\n');
    repo.commit('change alpha');
    const result = check();
    assert.equal(result.status, 0, result.stderr);
  });

  it('does not count a fragment that already existed at the base', async () => {
    await repo.write('scripts/alpha/changelog.d/old.fixed.md', 'Fixes the old thing.\n');
    base = repo.commit('pending fragment');
    await editScript();
    repo.commit('change alpha');
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs a changelog fragment/);
  });

  it('fails an @version change without a matching CHANGELOG section', async () => {
    await repo.write(scriptPath, scriptSource({ name: 'Alpha', version: '1.0.1' }));
    await repo.write('scripts/alpha/changelog.d/x.fixed.md', 'Fixes x.\n');
    repo.commit('bump by hand');
    const result = check();
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /scripts\/alpha\/alpha\.user\.js: @version changed outside a release/,
    );
  });

  it('fails an @version change whose section already existed at the base', async () => {
    await repo.write(scriptPath, scriptSource({ name: 'Alpha', version: '0.9.0' }));
    await repo.write(
      'scripts/alpha/CHANGELOG.md',
      `${intro}\n${section('0.9.0')}\n${section('1.0.0')}`,
    );
    base = repo.commit('older section');
    await repo.write(scriptPath, scriptSource({ name: 'Alpha', version: '1.0.0' }));
    repo.commit('bump by hand');
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@version changed outside a release/);
  });

  it('fails a hand downgrade that brings its own CHANGELOG section', async () => {
    await repo.write(scriptPath, scriptSource({ name: 'Alpha', version: '1.0.5' }));
    await repo.write('scripts/alpha/CHANGELOG.md', `${intro}\n${section('1.0.5')}`);
    base = repo.commit('at 1.0.5');
    await repo.write(scriptPath, scriptSource({ name: 'Alpha', version: '1.0.2' }));
    await repo.write(
      'scripts/alpha/CHANGELOG.md',
      `${intro}\n${section('1.0.5')}\n${section('1.0.2', '### Fixed\n\n- Fixes alpha.')}`,
    );
    repo.commit('downgrade by hand');
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@version changed outside a release/);
  });

  it('fails a version below 1.0.0 even with a matching section', async () => {
    await repo.write(scriptPath, scriptSource({ name: 'Alpha', version: '0.0.0' }));
    await repo.write('scripts/alpha/CHANGELOG.md', intro);
    base = repo.commit('back to 0.0.0');
    await repo.write(scriptPath, scriptSource({ name: 'Alpha', version: '0.5.0' }));
    await repo.write('scripts/alpha/CHANGELOG.md', `${intro}\n${section('0.5.0')}`);
    repo.commit('release 0.5.0');
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@version changed outside a release/);
  });

  it('accepts a release-prepare commit without demanding a new fragment', async () => {
    await repo.write('scripts/alpha/changelog.d/x.added.md', 'Adds x.\n');
    base = repo.commit('pending fragment');
    await repo.write(scriptPath, scriptSource({ name: 'Alpha', version: '1.1.0' }));
    await repo.write(
      'scripts/alpha/CHANGELOG.md',
      `${intro}\n${section('1.1.0', '### Added\n\n- Adds x.')}\n${section('1.0.0')}`,
    );
    await repo.remove('scripts/alpha/changelog.d/x.added.md');
    repo.commit('release(alpha): 1.1.0');
    const result = check();
    assert.equal(result.status, 0, result.stderr);
  });

  it('reports an invalid fragment with the validator message', async () => {
    await editScript();
    await repo.write('scripts/alpha/changelog.d/bad.added.md', '- no full stop\n');
    repo.commit('change alpha');
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /changelog\.d\/bad\.added\.md: must not start with "- "/);
    assert.match(result.stderr, /changelog\.d\/bad\.added\.md: must end with "\.", "!" or "\?"/);
  });

  it('reports a misnamed fragment instead of crashing', async () => {
    await repo.write('scripts/alpha/changelog.d/Bad_Name.md', 'Fixes x.\n');
    repo.commit('misnamed fragment');
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid fragment file name: Bad_Name\.md/);
    assert.doesNotMatch(result.stderr, /at .*\.mjs/);
  });

  it('fails a script directory without a README', async () => {
    await repo.remove('scripts/alpha/README.md');
    repo.commit('drop readme');
    const result = check('--allow-no-changelog');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scripts\/alpha\/README\.md: missing/);
  });

  it('passes a newly added script at 0.0.0 with a README', async () => {
    await repo.write('scripts/beta/beta.user.js', scriptSource({ name: 'Beta' }));
    await repo.write('scripts/beta/README.md', '# Beta\n');
    repo.commit('add beta');
    const result = check();
    assert.equal(result.status, 0, result.stderr);
  });

  it('fails a newly added script that does not start at 0.0.0', async () => {
    await repo.write('scripts/beta/beta.user.js', scriptSource({ name: 'Beta', version: '1.0.0' }));
    await repo.write('scripts/beta/README.md', '# Beta\n');
    repo.commit('add beta');
    const result = check();
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /scripts\/beta\/beta\.user\.js: new script must start at @version 0\.0\.0/,
    );
  });

  it('fails a renamed published path', async () => {
    await repo.write(
      'scripts/alpha/alpha2.user.js',
      scriptSource({ name: 'Alpha', version: '1.0.0' }),
    );
    await repo.remove(scriptPath);
    repo.commit('rename alpha');
    const result = check('--allow-no-changelog');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scripts\/alpha\/alpha\.user\.js: published path renamed/);
  });

  it('prints one line per violation', async () => {
    await editScript();
    await repo.write('scripts/alpha/changelog.d/bad.added.md', '- no full stop\n');
    await repo.remove('scripts/alpha/README.md');
    repo.commit('everything wrong');
    const result = check();
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trimEnd().split('\n').length, 3);
  });

  it('exits 1 with usage when --base is missing', () => {
    const result = runTool(repo.root, 'check.mjs', []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage:/);
  });
});
