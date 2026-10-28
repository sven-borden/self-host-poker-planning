// Plain JavaScript on purpose: this file must parse on any Node major, so it can
// say clearly which one is wrong. Keep the syntax old and the logic tiny.

/** The only Node major Poker Planning runs on (ADR-013). Keep in sync with `.nvmrc`. */
export const REQUIRED_NODE_MAJOR = 24;

/**
 * The first minor of that major it runs on: 24.7 brought `crypto.argon2`, which hashes
 * room passwords (#31). Keep in sync with `engines` in package.json.
 */
export const REQUIRED_NODE_MINOR = 7;

/**
 * Returns an error line when `version` (like `process.version`, "v24.7.0") is not the
 * required major, or an older minor of it, or `null` when it is fine.
 * @param {string} version
 * @returns {string | null}
 */
export function nodeVersionError(version) {
  const match = /^v?(\d+)\.(\d+)\./.exec(version);
  const major = match ? Number(match[1]) : Number.NaN;
  const minor = match ? Number(match[2]) : Number.NaN;
  if (major === REQUIRED_NODE_MAJOR && minor >= REQUIRED_NODE_MINOR) return null;
  return (
    "Poker Planning needs Node " +
    REQUIRED_NODE_MAJOR +
    "." +
    REQUIRED_NODE_MINOR +
    " or a later Node " +
    REQUIRED_NODE_MAJOR +
    ", found " +
    version
  );
}
