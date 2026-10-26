# @pp/domain

The rules of a planning-poker room: the round state machine, decks, statistics and the
projections each client is allowed to see. Both apps import it.

## Rules

- Pure TypeScript. No I/O, no Node APIs (`node:*`, `process`, `Buffer`), no DOM APIs.
  The tsconfig loads no ambient types and Biome refuses `node:*` imports here.
- Time comes in as an argument (`now`); nothing here reads the clock or randomness.
- Every state change goes through `apply(state, command, now)` (#3).
- Exported as TypeScript source (`exports` points at `src/index.ts`): Vite, tsx, Vitest
  and the server bundle compile it, so there is no build step. Import siblings with
  their `.ts` extension.
- Tests sit next to the code as `*.test.ts` and run in the `domain` Vitest project.
