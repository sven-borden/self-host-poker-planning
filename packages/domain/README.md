# @pp/domain

The rules of a planning-poker room: the round state machine, decks, statistics and the
projections each client is allowed to see. Both apps import it.

## Rules

- Pure TypeScript. No I/O, no Node APIs (`node:*`, `process`, `Buffer`), no DOM APIs.
  The tsconfig loads no ambient types and Biome refuses `node:*` imports here.
- Time comes in as an argument (`now`); nothing here reads the clock or randomness.
- Every state change goes through `apply(state, command, { actor, now })` (#3).
- Exported as TypeScript source (`exports` points at `src/index.ts`): Vite, tsx, Vitest
  and the server bundle compile it, so there is no build step. Import siblings with
  their `.ts` extension.
- Tests sit next to the code as `*.test.ts` and run in the `domain` Vitest project.

## Decks and results

`decks.ts`, `range.ts` and `results.ts` (#4). A card is a string and its label is
canonical: `.` is the decimal mark and the domain never localises (the UI may show
`0,5`, the card stays `0.5`).

- **Presets** (`PRESET_DECKS`): `fib` 0 1 2 3 5 8 13 21; `mfib` 0 ½ 1 2 3 5 8 13 20 40
  100; `tshirt` XS S M L XL XXL; `pow2` 0 1 2 4 8 16 32 64; `seq` 1 to 10.
- **Specials** `?`, `☕`, `∞` (`SPECIAL_CARDS`, in display order) are a room setting,
  never deck cards. `deckCards(deck, specials)` is the hand: the deck's cards, then the
  enabled specials in `SPECIAL_CARDS` order.
- **Values**: `cardValue` gives `"½"` 0.5 and parses `-?digits(.digits)?`; anything
  else (T-shirt sizes, specials, `1,5`) is `null`. A deck is numeric when every
  non-special card has a value.
- **Custom deck** (`validateCustomDeck`): 1 to 20 labels, trimmed and NFC-normalised,
  each 1 to 4 user-perceived characters (`Intl.Segmenter`, created on first use; code
  points where the engine has none; `☕` and `👍🏽` are 1). No duplicates, and labels
  with an equal numeric value (`1` and `1.0`, `½` and `0.5`, `-0` and `0`) count as
  duplicates. No specials, also with a variation selector (`☕` plus U+FE0F). Control
  and format characters (zero-width space, joiners, tag characters) give `card_invalid`;
  the one exception is a zero-width joiner between two emoji. Codes: `CustomDeckErrorCode`.
- **Range** (`generateRange`): `start` to `end` by `step`, `end` included when reached.
  Integer arithmetic scaled by the decimals of `start` and `step`, so 0 to 1 by 0.1
  is exactly `0`, `0.1` … `1`. Labels drop trailing zeros. Codes: `RangeErrorCode`.
- **Results** (`computeResults(votes, deck)`), plain and unrounded, after the round-1
  prototype's `stats()`:
  - `distribution`: the count of every voted card, specials included, in display
    order; votes outside the deck come last, sorted by code point, and count in no statistic.
  - `core`: the non-special votes, sorted by deck order. Specials count in no statistic.
  - `mode`: the core card with the highest count; a tie goes to the earlier deck card.
  - `agreement`: mode count / core count, 0 to 1; 0 without core votes.
  - `spread`: `[lowest, highest]` core card by deck order, or `null`.
  - `consensus`: at least 3 core votes, all the same card.
  - Numeric decks: `average` (mean), `median` (middle value, or the mean of the two
    middles), and `suggested`, the deck card nearest the average, a tie to the lower
    value. Non-numeric decks: `average` and `median` are `null`, `suggested` is the mode.
  - No core votes: `mode`, `spread`, `average`, `median` and `suggested` are `null`.

## The round state machine

`room.ts` (model, `DEFAULT_SETTINGS`, `createRoom`, limits), `commands.ts` (`Command`,
`Cause`, `ErrorCode`, `ApplyResult`), `apply.ts` (the machine) and `apply-input.ts`
(runtime validation of names, subjects, seconds and settings patches) (#3). The rules
are in `docs/02-architecture.md`, section 4.

- Never mutate the input; return the input object itself when nothing changed.
- A success carries `ended` when the command replaced or abandoned a round
  (`startRound`, `revote`, a deck or specials restart): that round as step 1 left it,
  so a round an elapsed timer revealed comes back revealed. The server records history
  from `ended` only when `ended.phase === "revealed"`, never from the input state.
- Look ids up with `Object.hasOwn`: an id such as `constructor` must never reach the
  prototype.
- Every `switch` is exhaustive (`never` check).
- `pnpm test:coverage` (part of `pnpm gate`) requires 100 % of statements, branches,
  functions and lines in `src/apply*.ts`. Keep new rule code in an `apply*.ts` file.
