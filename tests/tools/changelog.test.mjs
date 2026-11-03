import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasSection, sectionBody } from '../../tools/lib/changelog.mjs';

const changelog = [
  '# Changelog',
  '',
  'Intro text.',
  '',
  '## [1.1.0] - 2026-12-01',
  '',
  '### Added',
  '',
  '- Adds y.',
  '',
  '## [1.0.0] - 2026-11-03',
  '',
  '### Fixed',
  '',
  '- Fixes x.',
  '',
].join('\n');

describe('hasSection', () => {
  it('matches the exact version heading', () => {
    assert.equal(hasSection(changelog, '1.1.0'), true);
    assert.equal(hasSection(changelog, '1.0.0'), true);
    assert.equal(hasSection(changelog, '1.1'), false);
    assert.equal(hasSection(changelog, '2.0.0'), false);
  });
});

describe('sectionBody', () => {
  it('returns the trimmed text between the heading and the next section', () => {
    assert.equal(sectionBody(changelog, '1.1.0'), '### Added\n\n- Adds y.');
  });

  it('runs to the end of the file for the last section', () => {
    assert.equal(sectionBody(changelog, '1.0.0'), '### Fixed\n\n- Fixes x.');
  });

  it('returns null when the version has no section', () => {
    assert.equal(sectionBody(changelog, '3.0.0'), null);
  });
});
