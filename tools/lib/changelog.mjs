/**
 * @param {string} changelog
 * @param {string} version
 * @returns {number} Index of the section's heading line, or -1.
 */
function headingIndex(changelog, version) {
  return changelog.split(/\r?\n/).findIndex((line) => line.startsWith(`## [${version}]`));
}

/**
 * @param {string} changelog
 * @param {string} version
 * @returns {boolean} Whether the changelog has a `## [<version>]` section.
 */
export function hasSection(changelog, version) {
  return headingIndex(changelog, version) !== -1;
}

/**
 * Returns the body of a version's section: everything after its heading line up
 * to the next `## ` heading, trimmed.
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null} Null when the version has no section.
 */
export function sectionBody(changelog, version) {
  const start = headingIndex(changelog, version);
  if (start === -1) {
    return null;
  }
  const rest = changelog.split(/\r?\n/).slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
