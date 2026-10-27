# @pp/protocol

The contract between the web app and the server: zod schemas for commands and
snapshots, the Socket.IO event maps, error codes, `PROTOCOL_VERSION` and the per-viewer
projection (`toSnapshot`). Both apps import it; it imports `@pp/domain` for its types,
constants and `computeResults`.

## Rules

- Pure code only: schemas, types and the projection. No I/O, no Node or DOM APIs, no
  sockets.
- The server sends error codes, never sentences; the web app translates them.
- Any breaking change to a message bumps `PROTOCOL_VERSION`. Adding a cause type or an
  ack error code is breaking too: the schemas are closed unions, so one unknown member
  fails the whole parse on an older client.
- Inbound objects (commands, their payloads, `enter`) are strict: an unknown field
  answers `bad_payload`. Outbound schemas are lenient.
- `"sideEffects": false` (here and in `@pp/domain`): the web bundles only what it
  imports, so the zod schemas stay out of the room route. Keep module top levels pure.
- Exported as TypeScript source (`exports` points at `src/index.ts`), so there is no
  build step. Import siblings with their `.ts` extension.
- Tests sit next to the code as `*.test.ts` and run in the `protocol` Vitest project.

## Layout

- `commands.ts`: wire command schemas, `WIRE_LIMITS`, `toDomainCommand`.
- `schemas.ts`: snapshot, cause, ack and `enter` schemas; the view types are
  `z.output` of them, and a test asserts they equal the domain's types where they mirror one.
- `project.ts`: `toSnapshot` and `projectCauses`, the per-viewer projection. Every
  view is built field by field: a field the domain adds stays on the server until it is
  added here on purpose.
- `events.ts`: the Socket.IO event maps and `parseEnter`.
- `errors.ts`: `ACK_ERROR_CODES` (every code the web app must translate).
- `leak-scan.ts`: `stringLeaves` and `cardLeaks`, the secrecy scan; exported as
  `@pp/protocol/leak-scan` for the server's socket tests, never from the main entry.
- `test-support.ts`: fast-check generators of rooms built through `apply`; tests only,
  not exported.

Secrecy is tested as properties (`secrecy.test.ts`); a change to the projection must
keep them green, and a new card-bearing field must be added to the scan's allow-list
only if the card is public.
