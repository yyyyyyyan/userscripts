import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bumpVersion, compareVersions } from '../../tools/lib/semver.mjs';

describe('bumpVersion', () => {
  it('turns 0.0.0 into 1.0.0 at every level', () => {
    assert.equal(bumpVersion('0.0.0', 'patch'), '1.0.0');
    assert.equal(bumpVersion('0.0.0', 'minor'), '1.0.0');
    assert.equal(bumpVersion('0.0.0', 'major'), '1.0.0');
  });

  it('bumps minor and resets patch', () => {
    assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  });

  it('bumps major and resets minor and patch', () => {
    assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  });

  it('bumps patch', () => {
    assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  });

  it('rejects a malformed version or an unknown level', () => {
    assert.throws(() => bumpVersion('1.2', 'patch'), /invalid version/);
    assert.throws(() => bumpVersion('1.2.3', 'huge'), /unknown bump level/);
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
    assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  });

  it('returns 0 for equal versions, ignoring trailing zero parts', () => {
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
  });

  it('rejects a malformed version', () => {
    assert.throws(() => compareVersions('1.x', '1.0'), /invalid version/);
  });
});
