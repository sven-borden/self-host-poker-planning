/** A segment of a row of choices: a 44 px label with its native radio laid over it. */
export const SEGMENT =
  "relative inline-flex h-11 min-w-16 flex-1 cursor-pointer items-center justify-center rounded-md border border-line bg-surface px-2 text-sm font-medium tabular-nums has-checked:border-spruce has-checked:bg-spruce has-checked:text-on-spruce has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brass has-aria-disabled:opacity-60 forced-colors:has-checked:border-[Highlight] forced-colors:has-checked:outline-2 forced-colors:has-checked:outline-[Highlight]";

/**
 * Arrow keys walk a row of choices one by one, and each step selects a segment. What a choice
 * costs (a change the room hears, a render) waits this long for the keys to rest.
 */
export const ARROW_SETTLE_MS = 400;
