import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');

/** @param {string} title */
function lint(title) {
  return spawnSync(
    'npx',
    ['--no-install', 'commitlint', '--config', join(root, 'commitlint.config.mjs')],
    { cwd: root, input: `${title}\n`, encoding: 'utf8' },
  ).status;
}

describe('commitlint config', () => {
  it('accepts conventional titles and the release type', () => {
    assert.equal(lint('feat(reload-until): add an alarm sound'), 0);
    assert.equal(lint('release(reload-until): 1.0.0'), 0);
  });

  it("accepts Dependabot's capitalized group titles", () => {
    assert.equal(
      lint(
        'build(deps-dev): Bump the "dependencies" group with 1 update across multiple ecosystems',
      ),
      0,
    );
    assert.equal(lint('build(deps): Bump the "dependencies" group with 3 updates'), 0);
  });

  it('still rejects other capitalized subjects and free-form titles', () => {
    assert.notEqual(lint('feat: Add an alarm sound'), 0);
    assert.notEqual(lint('build: Bump everything'), 0);
    assert.notEqual(lint('Bump the dependencies group'), 0);
    assert.notEqual(lint('chores(deps): Bump the "dependencies" group with 1 update'), 0);
  });
});
