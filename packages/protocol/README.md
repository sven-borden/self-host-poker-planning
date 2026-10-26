# @pp/protocol

The contract between the web app and the server: zod schemas for commands and
snapshots, the Socket.IO event maps, error codes and `PROTOCOL_VERSION`. Both apps
import it; it may import `@pp/domain` for types.

## Rules

- Schemas and types only. No I/O, no Node or DOM APIs, no sockets.
- The server sends error codes, never sentences; the web app translates them.
- Any breaking change to a message bumps `PROTOCOL_VERSION`.
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
- `test-support.ts`: fast-check generators of rooms built through `apply`; tests only,
  not exported.

Secrecy is tested as properties (`secrecy.test.ts`); a change to the projection must
keep them green, and a new card-bearing field must be added to the scan's allow-list
only if the card is public.
