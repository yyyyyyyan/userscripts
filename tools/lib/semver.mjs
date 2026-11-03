const DOTTED_NUMERIC = /^\d+(\.\d+)*$/;
const THREE_PART = /^\d+\.\d+\.\d+$/;

/**
 * @param {string} version
 * @returns {number[]}
 */
function parts(version) {
  if (!DOTTED_NUMERIC.test(version)) {
    throw new Error(`invalid version: ${version}`);
  }
  return version.split('.').map(Number);
}

/**
 * Compares two dotted-numeric versions part by part. Missing parts count as 0.
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Returns the next version. A script at 0.0.0 has never been released, so its
 * first release is always 1.0.0.
 * @param {string} current
 * @param {'major' | 'minor' | 'patch'} level
 * @returns {string}
 */
export function bumpVersion(current, level) {
  if (!THREE_PART.test(current)) {
    throw new Error(`invalid version: ${current}`);
  }
  if (!['major', 'minor', 'patch'].includes(level)) {
    throw new Error(`unknown bump level: ${level}`);
  }
  if (current === '0.0.0') {
    return '1.0.0';
  }
  const [major, minor, patch] = parts(current);
  if (level === 'major') {
    return `${major + 1}.0.0`;
  }
  if (level === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}
