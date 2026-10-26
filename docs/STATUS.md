# Status — what is live, what is in flight, what only Sven can do

A living page, rewritten (not appended) whenever the state changes, and kept under
about 20 kB. History: `docs/06-build-log/` (current: `2026-10.md`). Working agreement:
`CLAUDE.md`.

## Live

- Nothing is deployed yet; Coolify comes with #12.
- `main` has the monorepo scaffold from #1: pnpm 12.15.0, Node 24, TypeScript 7,
  Biome, Vitest, Vite and tsdown. `pnpm gate` is green.
- CI from #2 runs on every pull request: `check` runs `pnpm gate`, and `db-tests`
  runs `pnpm test:db` against Postgres 17.
- The web shell from #8: routes `/` and `/r/$code`, design tokens with light, dark and
  system themes, shadcn/ui, Motion, fonts, and en/fr/de copy. The room route loads
  138.5 kB of JS against a 200 kB budget.
- The decisions are in `docs/05-decisions.md`.

- `packages/domain` has decks, custom-deck validation, the range generator and
  results statistics from #4, and the round state machine `apply` from #3.

## In flight (two at once when independent; see `CLAUDE.md`)

- **#5 (PP-005)** the protocol and per-viewer snapshots: PR #68 in review.
- **#13 (PP-013)** the table layout engine and card components, in worktree
  `../pp-wt-13`.

## Next

- Domain and server chain: #6 after #5, then #7 and #10.
- Web chain: #9 (i18n) after #5. It translates the error codes from `@pp/protocol`.
- #11 (Docker) needs #6, #7 and #8.
- **#12** waits for Sven's go on Coolify and DNS (see Owner items). #13 does not
  depend on #12, so it can go first.

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

`pnpm gate` (lint, typecheck, unit, build) green locally, then both CI jobs green on
the pull request. From #2 on, CI is the gate.
