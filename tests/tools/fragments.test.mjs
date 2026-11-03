import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  SECTIONS,
  SECTION_TITLES,
  levelFor,
  parseFragmentName,
  readFragments,
  renderSection,
  validateFragment,
} from '../../tools/lib/fragments.mjs';

const frag = (name, section, text = 'It works.') => ({
  path: `/x/changelog.d/${name}.${section}.md`,
  name,
  section,
  text,
});

describe('SECTIONS', () => {
  it('lists the seven sections with a title each', () => {
    assert.deepEqual(SECTIONS, [
      'breaking',
      'added',
      'changed',
      'deprecated',
      'removed',
      'fixed',
      'security',
    ]);
    for (const section of SECTIONS) {
      assert.equal(typeof SECTION_TITLES[section], 'string');
    }
    assert.equal(SECTION_TITLES.breaking, 'Breaking');
  });
});

describe('parseFragmentName', () => {
  it('splits a valid file name', () => {
    assert.deepEqual(parseFragmentName('csp-styling.fixed.md'), {
      name: 'csp-styling',
      section: 'fixed',
    });
  });

  it('rejects an invalid short name', () => {
    assert.equal(parseFragmentName('Bad_Name.fixed.md'), null);
    assert.equal(parseFragmentName('-lead.fixed.md'), null);
    assert.equal(parseFragmentName('double--dash.fixed.md'), null);
  });

  it('rejects an unknown section', () => {
    assert.equal(parseFragmentName('x.unknown.md'), null);
  });

  it('rejects a name without a section or the wrong extension', () => {
    assert.equal(parseFragmentName('x.md'), null);
    assert.equal(parseFragmentName('x.fixed.txt'), null);
    assert.equal(parseFragmentName('a.b.fixed.md'), null);
  });
});

describe('validateFragment', () => {
  it('accepts one sentence ending in ., ! or ?', () => {
    for (const text of ['Works now.', 'Works now!', 'Does it work?', 'Works now.\n']) {
      assert.deepEqual(validateFragment(frag('x', 'fixed', text)), [], text);
    }
  });

  it('rejects two lines', () => {
    assert.notDeepEqual(validateFragment(frag('x', 'fixed', 'One.\nTwo.')), []);
    assert.notDeepEqual(validateFragment(frag('x', 'fixed', 'One.\n\n')), []);
  });

  it('rejects a missing final punctuation mark', () => {
    assert.notDeepEqual(validateFragment(frag('x', 'fixed', 'No full stop')), []);
  });

  it('rejects a leading list marker', () => {
    assert.notDeepEqual(validateFragment(frag('x', 'fixed', '- Works now.')), []);
  });

  it('rejects an empty body', () => {
    assert.notDeepEqual(validateFragment(frag('x', 'fixed', '')), []);
    assert.notDeepEqual(validateFragment(frag('x', 'fixed', '  \n')), []);
  });

  it('rejects a bad name or section', () => {
    assert.notDeepEqual(validateFragment(frag('Bad_Name', 'fixed')), []);
    assert.notDeepEqual(validateFragment(frag('x', 'oops')), []);
  });
});

describe('levelFor', () => {
  it('maps the highest-impact section to a bump level', () => {
    assert.equal(levelFor([frag('a', 'added'), frag('b', 'fixed')]), 'minor');
    assert.equal(levelFor([frag('a', 'fixed')]), 'patch');
    assert.equal(levelFor([frag('a', 'security')]), 'patch');
    assert.equal(levelFor([frag('a', 'breaking')]), 'major');
    assert.equal(
      levelFor([frag('a', 'fixed'), frag('b', 'breaking'), frag('c', 'added')]),
      'major',
    );
    for (const section of ['changed', 'deprecated', 'removed']) {
      assert.equal(levelFor([frag('a', section)]), 'minor', section);
    }
  });

  it('throws when there are no fragments', () => {
    assert.throws(() => levelFor([]), /no fragments/);
  });
});

describe('renderSection', () => {
  const out = renderSection('1.0.0', '2026-11-03', [
    frag('b', 'fixed', 'Fixes b.'),
    frag('a', 'added', 'Adds a.'),
    frag('c', 'added', 'Adds c.'),
  ]);

  it('starts with the version heading', () => {
    assert.ok(out.startsWith('## [1.0.0] - 2026-11-03\n'));
  });

  it('lists Added before Fixed with fragments sorted by name', () => {
    assert.equal(
      out,
      [
        '## [1.0.0] - 2026-11-03',
        '',
        '### Added',
        '',
        '- Adds a.',
        '- Adds c.',
        '',
        '### Fixed',
        '',
        '- Fixes b.',
        '',
      ].join('\n'),
    );
  });

  it('puts Breaking first and omits empty sections', () => {
    const rendered = renderSection('2.0.0', '2026-12-01', [
      frag('a', 'fixed', 'Fixes a.'),
      frag('b', 'breaking', 'Breaks b.'),
    ]);
    assert.ok(rendered.indexOf('### Breaking') < rendered.indexOf('### Fixed'));
    assert.ok(!rendered.includes('### Added'));
  });
});

describe('readFragments', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fragments-'));
    await mkdir(join(dir, 'changelog.d'));
    await writeFile(join(dir, 'changelog.d', 'zeta.fixed.md'), 'Fixes zeta.\n');
    await writeFile(join(dir, 'changelog.d', 'alpha.added.md'), 'Adds alpha.\n');
    await writeFile(join(dir, 'changelog.d', '.gitkeep'), '');
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it('reads fragments sorted by file name and ignores dotfiles', async () => {
    const fragments = await readFragments(dir);
    assert.deepEqual(
      fragments.map(({ name, section, text }) => ({ name, section, text })),
      [
        { name: 'alpha', section: 'added', text: 'Adds alpha.' },
        { name: 'zeta', section: 'fixed', text: 'Fixes zeta.' },
      ],
    );
    assert.equal(fragments[0].path, join(dir, 'changelog.d', 'alpha.added.md'));
  });

  it('returns an empty list when there is no changelog.d directory', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'fragments-empty-'));
    try {
      assert.deepEqual(await readFragments(empty), []);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('throws on a file whose name does not parse', async () => {
    await writeFile(join(dir, 'changelog.d', 'Bad_Name.fixed.md'), 'Nope.\n');
    await assert.rejects(readFragments(dir), /Bad_Name\.fixed\.md/);
    await rm(join(dir, 'changelog.d', 'Bad_Name.fixed.md'));
  });
});
