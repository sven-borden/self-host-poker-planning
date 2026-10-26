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
