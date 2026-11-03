const HEADER = /^\/\/ ==UserScript==[^\r\n]*\r?\n([\s\S]*?)^\/\/ ==\/UserScript==/dm;
const ENTRY = /^\/\/\s*@(\S+)[ \t]*(.*?)\s*$/;
const VERSION_LINE = /^(\/\/\s*@version[ \t]+)\S[^\r\n]*$/m;
const DOTTED_NUMERIC = /^\d+(\.\d+)*$/;

/**
 * Reads the metadata block of a userscript. Only lines between the
 * `==UserScript==` markers count.
 * @param {string} source
 * @returns {{ get(key: string): string | undefined, all(key: string): string[] }}
 */
export function parseMetadata(source) {
  /** @type {Map<string, string[]>} */
  const entries = new Map();
  const header = HEADER.exec(source);
  for (const line of header ? header[1].split(/\r?\n/) : []) {
    const entry = ENTRY.exec(line);
    if (entry) {
      entries.set(entry[1], [...(entries.get(entry[1]) ?? []), entry[2]]);
    }
  }
  return {
    get: (key) => entries.get(key)?.[0],
    all: (key) => [...(entries.get(key) ?? [])],
  };
}

/**
 * Replaces the `@version` value in the metadata block and leaves everything
 * else, including the value's column, untouched.
 * @param {string} source
 * @param {string} version
 * @returns {string}
 */
export function setVersion(source, version) {
  if (!DOTTED_NUMERIC.test(version)) {
    throw new Error(`invalid version: ${version}`);
  }
  const header = HEADER.exec(source);
  if (!header || !VERSION_LINE.test(header[1])) {
    throw new Error('no @version in the metadata block');
  }
  const [start, end] = header.indices[1];
  return (
    source.slice(0, start) + header[1].replace(VERSION_LINE, `$1${version}`) + source.slice(end)
  );
}
