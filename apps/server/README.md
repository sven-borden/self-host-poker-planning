# @pp/server

The Node server: today a `node:http` placeholder; Hono, Socket.IO, Better Auth and
Drizzle from #6 on. It owns every round and, in production, serves the built web app.

## Rules

- `src/main.ts` is the only start path. Nothing else opens a port or connects to the
  database at module load: modules export factories (`createApp()`), `main.ts` calls them.
- Never read, log or print a secret or a vote value.
- `pnpm dev` runs `tsx watch src/main.ts` on `PORT` (default 3000).
- `pnpm build` bundles `src/main.ts` with tsdown into `dist/main.mjs`. The `@pp/*`
  workspace packages are bundled in (they ship TypeScript source); npm dependencies stay
  external, so the Docker image installs production dependencies next to `dist/`.
  `pnpm start` runs the bundle with plain Node 24.
- Import siblings with their `.ts` extension.
