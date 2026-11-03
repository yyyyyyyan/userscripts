import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const tool = join(import.meta.dirname, '..', '..', 'tools', 'commitlint-main.mjs');
const ZEROS = '0'.repeat(40);

describe('commitlint-main', () => {
  let work;
  let remote;
  let root;
  let initialSha;
  let badSha;

  const git = (...args) =>
    execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const run = (remoteBranch, from, to) =>
    spawnSync('node', [tool], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        PRE_COMMIT_REMOTE_BRANCH: remoteBranch,
        PRE_COMMIT_FROM_REF: from,
        PRE_COMMIT_TO_REF: to,
      },
    });

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'commitlint-main-'));
    remote = join(root, 'remote.git');
    work = join(root, 'work');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('remote', 'add', 'origin', remote);
    writeFileSync(join(work, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: initial');
    initialSha = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(work, 'b.txt'), 'b\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'wip stuff');
    badSha = git('rev-parse', 'HEAD').trim();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lets a free-form commit through on a feature branch', () => {
    git('push', '-q', 'origin', 'HEAD:refs/heads/feature');
    const result = run('refs/heads/feature', initialSha, badSha);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it('rejects a free-form commit pushed to main', () => {
    const result = run('refs/heads/main', initialSha, badSha);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /subject/);
  });

  it('checks only the new tip when main has no previous commit', () => {
    const result = run('refs/heads/main', ZEROS, badSha);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /subject/);
  });

  it('accepts a conventional commit pushed to main', () => {
    const result = run('refs/heads/main', ZEROS, initialSha);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it('ignores deleting a branch', () => {
    const result = run('refs/heads/main', badSha, ZEROS);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});
