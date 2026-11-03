import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseMetadata, setVersion } from '../../tools/lib/metadata.mjs';

const source = [
  '// @version      9.9.9 (outside the header)',
  '// ==UserScript==',
  '// @name         Sample',
  '// @version      0.0.0',
  '// @match        https://example.com/*',
  '// @match        https://example.org/*',
  '// @noframes',
  '// ==/UserScript==',
  '',
  "console.log('// @version 1.2.3');",
  '',
].join('\n');

describe('parseMetadata', () => {
  const meta = parseMetadata(source);

  it('returns the first value for a key', () => {
    assert.equal(meta.get('name'), 'Sample');
    assert.equal(meta.get('match'), 'https://example.com/*');
  });

  it('returns every value for a repeated key', () => {
    assert.deepEqual(meta.all('match'), ['https://example.com/*', 'https://example.org/*']);
  });

  it('reads only between the header markers', () => {
    assert.equal(meta.get('version'), '0.0.0');
    assert.deepEqual(meta.all('version'), ['0.0.0']);
  });

  it('gives an empty string for a key with no value and undefined for a missing key', () => {
    assert.equal(meta.get('noframes'), '');
    assert.equal(meta.get('license'), undefined);
    assert.deepEqual(meta.all('license'), []);
  });

  it('returns nothing when there is no header', () => {
    assert.equal(parseMetadata('console.log(1);\n').get('name'), undefined);
  });
});

describe('setVersion', () => {
  it('replaces only the version value and keeps the column', () => {
    const updated = setVersion(source, '1.0.0');
    assert.equal(updated, source.replace('// @version      0.0.0', '// @version      1.0.0'));
    assert.ok(updated.includes('// @version      1.0.0\n'));
  });

  it('leaves version-looking text outside the header alone', () => {
    const updated = setVersion(source, '1.0.0');
    assert.ok(updated.startsWith('// @version      9.9.9 (outside the header)\n'));
    assert.ok(updated.includes("console.log('// @version 1.2.3');"));
  });

  it('keeps CRLF line endings', () => {
    const crlf = source.replaceAll('\n', '\r\n');
    assert.equal(setVersion(crlf, '1.0.0'), crlf.replace('0.0.0', '1.0.0'));
  });

  it('throws when the header has no @version', () => {
    assert.throws(
      () => setVersion('// ==UserScript==\n// @name X\n// ==/UserScript==\n', '1.0.0'),
      /no @version/,
    );
  });

  it('throws on a malformed version', () => {
    assert.throws(() => setVersion(source, 'v1.0.0'), /invalid version/);
  });
});
