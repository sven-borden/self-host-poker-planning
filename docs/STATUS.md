# Status — what is live, what is in flight, what only Sven can do

A living page, rewritten (not appended) whenever the state changes, and kept under
about 20 kB. History: `docs/06-build-log/` (current: `2026-10.md`). Working agreement:
`CLAUDE.md`.

## Live

- Nothing is deployed yet; Coolify comes with #12.
- `main` has the monorepo scaffold from #1: pnpm 12.15.0, Node 24, TypeScript 7,
  Biome, Vitest, Vite and tsdown. `pnpm gate` is green.
- CI from #2 runs on every pull request: `check` runs `pnpm gate`, `db-tests` runs
  `pnpm test:db` against Postgres 17, and `web-e2e` (from #13) runs Playwright.
- The web shell from #8: routes `/` and `/r/$code`, design tokens with light, dark and
  system themes, shadcn/ui, Motion and fonts.
- i18n from #9: our own typed `t()` (ADR-012 amended), en/fr/de with catalogs loaded
  on demand, numbers in the reader's regional format, a switcher in the header, and
  copy checks in the gate. The room route loads 141.4 kB of JS against a 200 kB
  budget.
- The table from #13: a pure layout engine with a pixel geometry proof for 1 to 16
  people, the seat and card components, and a `/dev/table` bench.
- The server skeleton from #6: Hono and Socket.IO on one port, `/api/health`, the
  built web app from an allowlist, a socket Origin check, logs without secrets,
  graceful shutdown, and a `setup`/`dispose` hook for the database and auth.
- The decisions are in `docs/05-decisions.md`.

- `packages/domain` has decks, custom-deck validation, the range generator and
  results statistics from #4, and the round state machine `apply` from #3. An
  anonymous round locks its votes at reveal (decided at the merge of #5).
- `packages/protocol` from #5: wire schemas, strict inbound parsing, acks and error
  codes, and `toSnapshot`, which builds each viewer's secret-safe snapshot.

## In flight (two at once when independent; see `CLAUDE.md`)

- **#7 (PP-007)** the database: PR #72. Its review fixes are in progress: the driver
  moves from postgres.js to `pg`, because postgres.js crashed the process when a
  connection died inside a transaction.

## Next

- #10 (identity) and #11 (Docker) start in parallel when #7 merges; they touch
  different parts of the repo.
- W1 needs #10: #14 needs #7, #9 and #10; #15 needs #5, #6, #7 and #10.
- **W1 starts without a new go** once the W0 issues other than #12 are merged (Sven,
  2026-10-26). No W1 issue depends on #11 or #12.
- **#12** waits for Sven's go on Coolify and DNS (see Owner items). It is asked for
  when #11 merges.

## Order

This is the order. Two independent issues may run at once (see `CLAUDE.md`). Issue
keys `PP-NNN` equal issue numbers.

| Wave (milestone) | Issues | Goal |
|---|---|---|
| W0 Foundations | #1–#13 | A walking skeleton, live on Coolify at poker.borden.ch |
| W1 Play a round | #14–#24 | A team estimates a real story, no account needed |
| W2 Facilitate | #25–#32 | The PO runs the session their way |
| W3 Record and self-host | #33–#41 | History, exports, hardening and the self-hosting kit |
| W4 Delight | #42–#46 | Avatars, motion polish, sound, music, PWA |
| W5 Accounts | #47–#51 | Sign in with Google or Microsoft |
| W6 Backlog import | #52–#55 | Fill the queue from Jira or Azure DevOps |
| W7 Branding | #56–#59 | A company's look, as a paid option |

Inside a wave an issue may be taken out of number order only when its "Depends on"
issues are merged.

## Owner items (only Sven)

- **#12**: go for the Coolify application, the Postgres resource with backups, the
  env vars and the `poker.borden.ch` DNS record.
- **#38**: pick the Azure service (OQ-1).
- **#41**: French and German tone (OQ-2).
- **#56**: licence and pricing model for branding (OQ-3).

## Merge gate

`pnpm gate` (lint, typecheck, unit, build) green locally, then every CI job green on
the pull request (`check`, `db-tests`, `web-e2e`). From #2 on, CI is the gate.
