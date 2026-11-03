import { hasSection, sectionBody } from './changelog.mjs';
import { parseMetadata } from './metadata.mjs';
import { compareVersions } from './semver.mjs';

/**
 * Decides whether a change to a script is a release. All four must hold: the
 * `@version` changed, it increased, it is at least 1.0.0, and `CHANGELOG.md`
 * gained a `## [<version>]` section.
 * @param {{ oldSource: string | null, newSource: string | null, oldChangelog: string | null, newChangelog: string | null }} change
 *   File contents before and after; null for a file that does not exist.
 * @returns {{ version: string, notes: string } | null} Null when it is not a release.
 */
export function releaseOf({ oldSource, newSource, oldChangelog, newChangelog }) {
  const oldVersion = parseMetadata(oldSource ?? '').get('version');
  const version = parseMetadata(newSource ?? '').get('version');
  if (!oldVersion || !version || version === oldVersion) {
    return null;
  }
  try {
    if (compareVersions(version, '1.0.0') < 0 || compareVersions(version, oldVersion) <= 0) {
      return null;
    }
  } catch {
    return null;
  }
  if (hasSection(oldChangelog ?? '', version) || !hasSection(newChangelog ?? '', version)) {
    return null;
  }
  return { version, notes: sectionBody(newChangelog ?? '', version) ?? '' };
}
