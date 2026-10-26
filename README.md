# Poker Planning

Self-hosted planning poker for teams: rooms of up to 16 people around a table, no
account needed, one Docker image to run on Coolify, Azure or any Docker host. In
English, French and German.

> **Status:** design and architecture done; building wave W0. See
> [docs/STATUS.md](docs/STATUS.md).

## What it does

- Create a room, share the link, protect it with a password if you like.
- Vote with Fibonacci, T-shirt, powers of two or your own deck, plus `?` and `☕` cards.
- The product owner reveals, or the room reveals when everyone has voted or the timer
  ends. Results show who voted what, or stay anonymous.
- Average, median, agreement and spread after every round; history and exports.
- Later: Google and Microsoft sign-in, Jira and Azure DevOps import, animated avatars,
  and paid branding for companies.

## Docs

- [Product brief](docs/01-product-brief.md)
- [Architecture](docs/02-architecture.md)
- [Design brief](docs/03-design-brief.md)
- [Open questions](docs/04-open-questions.md)
- [Decisions (ADR)](docs/05-decisions.md)
- [Status](docs/STATUS.md)

## Running it

Coming with the first wave: `docker compose up` will start the app and its Postgres
database.

## Run locally

Prerequisites: Node 24 (see `.nvmrc`; any other major is refused) and pnpm. The exact
pnpm version is pinned in `packageManager` (pnpm 12): an installed pnpm 9.7 or later
downloads and runs that version by itself, otherwise use corepack (`corepack enable`).

```sh
pnpm install   # install the workspace
pnpm dev       # server on http://localhost:3000, web app on http://localhost:5173
pnpm gate      # Node check, lint, typecheck, unit tests and build: run before every PR
```

Other scripts: `pnpm test` (unit tests), `pnpm test:db` (integration tests against
Postgres, one file at a time because they share one database), `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm build`. The layout and
the rules of each package are in `apps/*/README.md` and `packages/*/README.md`.

Workspace conventions:

- TypeScript strict from `tsconfig.base.json`; `pnpm typecheck` runs `tsc --build` over
  the project references in `tsconfig.json` (declarations go to gitignored `.tsbuild/`).
- `moduleResolution: "bundler"`: Vite, tsx, Vitest and the server bundle resolve our
  imports, never bare Node. Relative imports carry their `.ts` extension (Biome checks).
- `@pp/domain` and `@pp/protocol` export TypeScript source; nothing to build first.
- Tests sit next to the code: `*.test.ts` are unit tests (`pnpm test`), `*.db.test.ts`
  need Postgres (`pnpm test:db`). Each package is a Vitest project in `vitest.config.ts`.
- Biome formats and lints everything except Markdown formatting; `pnpm format` fixes.
- pnpm settings live in `pnpm-workspace.yaml`. Dependency build scripts are blocked
  unless listed under `allowBuilds` there.
- Scripts must run on Windows and Linux: no `rm -rf`, no `VAR=value cmd`.

## License

[MIT](LICENSE)
