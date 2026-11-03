import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { findReleases } from '../../tools/release-publish.mjs';
import { createDist, createRepo, git, runTool, scriptSource } from '../helpers/repo.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x1a, 0x0a]);

const scriptPath = (slug) => `scripts/${slug}/${slug}.user.js`;

const changelogWith = (...sections) =>
  `# Changelog\n\nIntro.\n\n${sections.map(([version, body]) => `## [${version}] - 2026-11-03\n\n${body}\n`).join('\n')}`;

describe('release publishing', () => {
  const cleanups = [];
  let repo;

  beforeEach(async () => {
    repo = await createRepo();
    cleanups.push(repo.cleanup);
    await repo.write('README.md', 'root\n');
    repo.commit('init');
  });

  after(() => Promise.all(cleanups.map((cleanup) => cleanup())));

  const addScript = async (slug, name, readme = `# ${name}\n`) => {
    await repo.write(scriptPath(slug), scriptSource({ name }));
    await repo.write(`scripts/${slug}/README.md`, readme);
  };

  const release = async (slug, name, version, body, { previous = [] } = {}) => {
    await repo.write(scriptPath(slug), scriptSource({ name, version, body: `v${version}` }));
    await repo.write(
      `scripts/${slug}/CHANGELOG.md`,
      changelogWith([version, `### Added\n\n- ${body}`], ...previous),
    );
  };

  describe('findReleases', () => {
    it('returns nothing for a commit that only adds a script at 0.0.0', async () => {
      const before = repo.head();
      await addScript('alpha', 'Alpha');
      const after = repo.commit('add alpha');
      assert.deepEqual(await findReleases(before, after, repo.root), []);
    });

    it('does not publish a script that is added already at 1.0.0', async () => {
      const before = repo.head();
      await release('alpha', 'Alpha', '1.0.0', 'Adds alpha.');
      const after = repo.commit('add alpha');
      assert.deepEqual(await findReleases(before, after, repo.root), []);
    });

    it('returns nothing when code changes but @version does not', async () => {
      await addScript('alpha', 'Alpha');
      const before = repo.commit('add alpha');
      await repo.write(scriptPath('alpha'), scriptSource({ name: 'Alpha', body: 'two' }));
      const after = repo.commit('change alpha');
      assert.deepEqual(await findReleases(before, after, repo.root), []);
    });

    it('returns nothing when @version changes without a matching CHANGELOG section', async () => {
      await addScript('alpha', 'Alpha');
      const before = repo.commit('add alpha');
      await repo.write(scriptPath('alpha'), scriptSource({ name: 'Alpha', version: '1.0.0' }));
      await repo.write('scripts/alpha/CHANGELOG.md', changelogWith(['0.9.0', 'Other.']));
      const after = repo.commit('bump alpha');
      assert.deepEqual(await findReleases(before, after, repo.root), []);
    });

    it('returns nothing for a version below 1.0.0, even with a CHANGELOG section', async () => {
      await addScript('alpha', 'Alpha');
      const before = repo.commit('add alpha');
      await release('alpha', 'Alpha', '0.1.0', 'Adds alpha.');
      const after = repo.commit('bump alpha');
      assert.deepEqual(await findReleases(before, after, repo.root), []);
    });

    it('returns the version and notes for a release-prepare commit', async () => {
      await addScript('alpha', 'Alpha');
      const before = repo.commit('add alpha');
      await release('alpha', 'Alpha', '1.0.0', 'Adds alpha.');
      const after = repo.commit('release(alpha): 1.0.0');
      assert.deepEqual(await findReleases(before, after, repo.root), [
        { slug: 'alpha', version: '1.0.0', notes: '### Added\n\n- Adds alpha.' },
      ]);
    });

    it('finds the releases of two scripts in one range, in commit order', async () => {
      await addScript('alpha', 'Alpha');
      await addScript('beta', 'Beta');
      const before = repo.commit('add scripts');
      await release('beta', 'Beta', '1.0.0', 'Adds beta.');
      repo.commit('release(beta): 1.0.0');
      await release('alpha', 'Alpha', '1.0.0', 'Adds alpha.');
      const after = repo.commit('release(alpha): 1.0.0');
      assert.deepEqual(await findReleases(before, after, repo.root), [
        { slug: 'beta', version: '1.0.0', notes: '### Added\n\n- Adds beta.' },
        { slug: 'alpha', version: '1.0.0', notes: '### Added\n\n- Adds alpha.' },
      ]);
    });

    it('does not publish a revert to an older version', async () => {
      await addScript('alpha', 'Alpha');
      const first = repo.commit('add alpha');
      await release('alpha', 'Alpha', '1.0.0', 'Adds alpha.');
      repo.commit('release 1.0.0');
      await release('alpha', 'Alpha', '1.1.0', 'Adds more.', {
        previous: [['1.0.0', '### Added\n\n- Adds alpha.']],
      });
      const before = repo.commit('release 1.1.0');
      await release('alpha', 'Alpha', '1.0.0', 'Adds alpha.');
      const after = repo.commit('revert');
      assert.deepEqual(await findReleases(before, after, repo.root), []);
      assert.equal((await findReleases(first, before, repo.root)).length, 2);
    });

    it('does not publish a hand downgrade that brings its own CHANGELOG section', async () => {
      await addScript('alpha', 'Alpha');
      repo.commit('add alpha');
      await release('alpha', 'Alpha', '1.2.0', 'Adds alpha.');
      const before = repo.commit('release 1.2.0');
      await release('alpha', 'Alpha', '1.1.5', 'Fixes alpha.', {
        previous: [['1.2.0', '### Added\n\n- Adds alpha.']],
      });
      const after = repo.commit('hand downgrade');
      assert.deepEqual(await findReleases(before, after, repo.root), []);
    });

    it('does not publish a version whose section already existed', async () => {
      await addScript('alpha', 'Alpha');
      await repo.write(
        'scripts/alpha/CHANGELOG.md',
        changelogWith(['1.0.0', '### Added\n\n- Old.']),
      );
      const before = repo.commit('add alpha');
      await repo.write(scriptPath('alpha'), scriptSource({ name: 'Alpha', version: '1.0.0' }));
      const after = repo.commit('bump by hand');
      assert.deepEqual(await findReleases(before, after, repo.root), []);
    });

    it('finds a script that was added at 0.0.0 and released later in the same range', async () => {
      const before = repo.head();
      await addScript('alpha', 'Alpha');
      repo.commit('add alpha');
      await release('alpha', 'Alpha', '1.0.0', 'Adds alpha.');
      const after = repo.commit('release alpha');
      assert.deepEqual(await findReleases(before, after, repo.root), [
        { slug: 'alpha', version: '1.0.0', notes: '### Added\n\n- Adds alpha.' },
      ]);
    });

    it('finds two releases of one script in one range', async () => {
      await addScript('alpha', 'Alpha');
      const before = repo.commit('add alpha');
      await release('alpha', 'Alpha', '1.0.0', 'Adds alpha.');
      repo.commit('release 1.0.0');
      await release('alpha', 'Alpha', '1.1.0', 'Adds more.', {
        previous: [['1.0.0', '### Added\n\n- Adds alpha.']],
      });
      const after = repo.commit('release 1.1.0');
      assert.deepEqual(await findReleases(before, after, repo.root), [
        { slug: 'alpha', version: '1.0.0', notes: '### Added\n\n- Adds alpha.' },
        { slug: 'alpha', version: '1.1.0', notes: '### Added\n\n- Adds more.' },
      ]);
    });

    it('rejects a revision that does not exist', async () => {
      await assert.rejects(findReleases('0'.repeat(40), repo.head(), repo.root), /git/);
    });
  });

  describe('CLI', () => {
    let dist;

    beforeEach(async () => {
      dist = await createDist();
      cleanups.push(dist.cleanup);
    });

    const publish = (before, after) =>
      runTool(repo.root, 'release-publish.mjs', [
        '--before',
        before,
        '--after',
        after,
        '--dist',
        dist.dir,
      ]);

    it('makes one dist commit per release and prints one tag each', async () => {
      await addScript('alpha', 'Alpha Script', '# Alpha\n\n![shot](images/shot.png)\n');
      await addScript('beta', 'Beta Script');
      await repo.write('scripts/alpha/images/shot.png', PNG);
      await repo.write('scripts/alpha/images/nested/deep.png', PNG);
      const before = repo.commit('add scripts');
      await release('alpha', 'Alpha Script', '1.0.0', 'Adds alpha.');
      await release('beta', 'Beta Script', '1.0.0', 'Adds beta.');
      const after = repo.commit('release both');
      const distBefore = git(dist.dir, 'rev-parse', 'HEAD');

      const result = publish(before, after);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'alpha-v1.0.0\nbeta-v1.0.0\n');

      assert.equal(git(dist.dir, 'rev-list', '--count', `${distBefore}..HEAD`), '2');
      assert.equal(
        git(dist.dir, 'log', '--format=%s', `${distBefore}..HEAD`),
        'Beta Script 1.0.0\nAlpha Script 1.0.0',
      );
      assert.equal(
        git(dist.dir, 'log', '-1', '--format=%B', 'HEAD~1'),
        'Alpha Script 1.0.0\n\n### Added\n\n- Adds alpha.',
      );
      assert.equal(git(dist.dir, 'status', '--porcelain'), '');

      assert.equal(
        await readFile(join(dist.dir, 'alpha.user.js'), 'utf8'),
        scriptSource({ name: 'Alpha Script', version: '1.0.0', body: 'v1.0.0' }),
      );
      assert.equal(
        await readFile(join(dist.dir, 'alpha.md'), 'utf8'),
        '# Alpha\n\n![shot](images/alpha/shot.png)\n',
      );
      assert.deepEqual(await readFile(join(dist.dir, 'images', 'alpha', 'shot.png')), PNG);
      assert.deepEqual(
        await readFile(join(dist.dir, 'images', 'alpha', 'nested', 'deep.png')),
        PNG,
      );
      assert.ok((await readdir(dist.dir)).includes('beta.md'));
    });

    it('publishes two releases of one script as two dist commits, tags and notes', async () => {
      await addScript('alpha', 'Alpha');
      const before = repo.commit('add alpha');
      await release('alpha', 'Alpha', '1.0.0', 'Adds alpha.');
      repo.commit('release 1.0.0');
      await release('alpha', 'Alpha', '1.1.0', 'Adds more.', {
        previous: [['1.0.0', '### Added\n\n- Adds alpha.']],
      });
      const after = repo.commit('release 1.1.0');
      const distBefore = git(dist.dir, 'rev-parse', 'HEAD');

      const result = publish(before, after);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'alpha-v1.0.0\nalpha-v1.1.0\n');
      assert.equal(git(dist.dir, 'rev-list', '--count', `${distBefore}..HEAD`), '2');
      assert.equal(
        git(dist.dir, 'log', '-1', '--format=%B', 'HEAD~1'),
        'Alpha 1.0.0\n\n### Added\n\n- Adds alpha.',
      );
      assert.equal(
        git(dist.dir, 'log', '-1', '--format=%B', 'HEAD'),
        'Alpha 1.1.0\n\n### Added\n\n- Adds more.',
      );
      assert.equal(
        git(dist.dir, 'show', 'HEAD~1:alpha.user.js'),
        scriptSource({ name: 'Alpha', version: '1.0.0', body: 'v1.0.0' }).trim(),
      );
    });

    it('rewrites only relative images/ links', async () => {
      const readme = [
        '![a](images/a.png)',
        '[link](images/a.png)',
        '<img src="images/b.png" width="10">',
        "<img src='images/c.png'>",
        '![abs](https://example.com/images/d.png)',
        '![up](../images/e.png)',
        '![other](screenshots/f.png)',
        '',
      ].join('\n');
      await addScript('alpha', 'Alpha', readme);
      const before = repo.commit('add alpha');
      await release('alpha', 'Alpha', '1.0.0', 'Adds alpha.');
      const after = repo.commit('release alpha');

      assert.equal(publish(before, after).status, 0);
      assert.equal(
        await readFile(join(dist.dir, 'alpha.md'), 'utf8'),
        [
          '![a](images/alpha/a.png)',
          '[link](images/alpha/a.png)',
          '<img src="images/alpha/b.png" width="10">',
          "<img src='images/alpha/c.png'>",
          '![abs](https://example.com/images/d.png)',
          '![up](../images/e.png)',
          '![other](screenshots/f.png)',
          '',
        ].join('\n'),
      );
    });

    it('publishes a script that has no images', async () => {
      await addScript('alpha', 'Alpha');
      const before = repo.commit('add alpha');
      await release('alpha', 'Alpha', '1.0.0', 'Adds alpha.');
      const after = repo.commit('release alpha');

      const result = publish(before, after);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!(await readdir(dist.dir)).includes('images'));
    });

    it('drops images that a later release removed, in that release only', async () => {
      await addScript('alpha', 'Alpha');
      await repo.write('scripts/alpha/images/old.png', PNG);
      await repo.write('scripts/alpha/images/keep.png', PNG);
      const first = repo.commit('add alpha');
      await release('alpha', 'Alpha', '1.0.0', 'Adds alpha.');
      const second = repo.commit('release 1.0.0');
      assert.equal(publish(first, second).status, 0);

      await repo.remove('scripts/alpha/images/old.png');
      await release('alpha', 'Alpha', '1.0.1', 'Fixes alpha.', {
        previous: [['1.0.0', '### Added\n\n- Adds alpha.']],
      });
      const third = repo.commit('release 1.0.1');
      const result = publish(second, third);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'alpha-v1.0.1\n');
      assert.deepEqual((await readdir(join(dist.dir, 'images', 'alpha'))).sort(), ['keep.png']);
      assert.equal(git(dist.dir, 'status', '--porcelain'), '');
      assert.equal(
        git(dist.dir, 'show', '--format=%B', '--name-only', 'HEAD').split('\n').pop(),
        'images/alpha/old.png',
      );
    });

    it('prints nothing and commits nothing when the range has no release', async () => {
      await addScript('alpha', 'Alpha');
      const before = repo.commit('add alpha');
      await repo.write(scriptPath('alpha'), scriptSource({ name: 'Alpha', body: 'two' }));
      const after = repo.commit('change alpha');
      const distBefore = git(dist.dir, 'rev-parse', 'HEAD');

      const result = publish(before, after);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(git(dist.dir, 'rev-parse', 'HEAD'), distBefore);
    });

    it('exits 1 with usage when an option is missing', () => {
      const result = runTool(repo.root, 'release-publish.mjs', ['--before', 'a']);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /usage:/);
    });
  });
});
