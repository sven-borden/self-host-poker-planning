// Plain JavaScript on purpose: this file must parse on any Node major, so it can
// say clearly which one is wrong. Keep the syntax old and the logic tiny.

/** The only Node major Poker Planning runs on (ADR-013). Keep in sync with `.nvmrc`. */
export const REQUIRED_NODE_MAJOR = 24;

/**
 * Returns an error line when `version` (like `process.version`, "v24.1.0") is not the
 * required major, or `null` when it is.
 * @param {string} version
 * @returns {string | null}
 */
export function nodeVersionError(version) {
  const match = /^v?(\d+)\./.exec(version);
  const major = match ? Number(match[1]) : Number.NaN;
  if (major === REQUIRED_NODE_MAJOR) return null;
  return `Poker Planning needs Node ${REQUIRED_NODE_MAJOR}, found ${version}`;
}
