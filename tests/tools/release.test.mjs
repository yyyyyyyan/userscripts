import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { releaseOf } from '../../tools/lib/release.mjs';
import { scriptSource } from '../helpers/repo.mjs';

const source = (version) => scriptSource({ version });
const changelog = (...versions) =>
  versions.map((v) => `## [${v}] - 2026-11-03\n\n### Added\n\n- Adds ${v}.\n`).join('\n');

describe('releaseOf', () => {
  it('accepts an increase to 1.0.0 or more that gained its section', () => {
    assert.deepEqual(
      releaseOf({
        oldSource: source('1.0.0'),
        newSource: source('1.1.0'),
        oldChangelog: changelog('1.0.0'),
        newChangelog: changelog('1.1.0', '1.0.0'),
      }),
      { version: '1.1.0', notes: '### Added\n\n- Adds 1.1.0.' },
    );
  });

  it('treats a missing old changelog as empty', () => {
    const release = releaseOf({
      oldSource: source('0.0.0'),
      newSource: source('1.0.0'),
      oldChangelog: null,
      newChangelog: changelog('1.0.0'),
    });
    assert.equal(release?.version, '1.0.0');
  });

  const rejected = {
    'an unchanged version': [
      source('1.0.0'),
      source('1.0.0'),
      changelog('1.0.0'),
      changelog('1.0.0'),
    ],
    'a decrease': [
      source('1.2.0'),
      source('1.1.5'),
      changelog('1.2.0'),
      changelog('1.2.0', '1.1.5'),
    ],
    'a version below 1.0.0': [source('0.0.0'), source('0.5.0'), '', changelog('0.5.0')],
    'a section that already existed': [
      source('0.9.0'),
      source('1.0.0'),
      changelog('1.0.0'),
      changelog('1.0.0'),
    ],
    'a missing section': [source('1.0.0'), source('1.0.1'), changelog('1.0.0'), changelog('1.0.0')],
    'a malformed version': [source('1.0.0'), source('1.x'), changelog('1.0.0'), changelog('1.x')],
  };
  for (const [label, [oldSource, newSource, oldChangelog, newChangelog]] of Object.entries(
    rejected,
  )) {
    it(`rejects ${label}`, () => {
      assert.equal(releaseOf({ oldSource, newSource, oldChangelog, newChangelog }), null);
    });
  }
});
