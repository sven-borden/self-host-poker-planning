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
- The database from #7: Drizzle on `pg`, migrations at start under an advisory lock,
  the room repository with compare-and-set, a per-room command runner, and history
  rows (anonymous rounds store cards only).
- The Docker image and compose file from #11: 219 MB, non-root, with a healthcheck.
  `docker compose up` serves the app on port 3000, and a `docker` CI job tests the
  image.
- Identity from #10: Better Auth guest sessions (`__Host-` cookie on https), only
  three auth endpoints exposed, display names with strict text rules, and sockets
  refused without a session. `TRUST_PROXY` is a proxy count.
- **W0 is done except #12** (deploy), which waits for Sven's go.
- The decisions are in `docs/05-decisions.md`.

- `packages/domain` has decks, custom-deck validation, the range generator and
  results statistics from #4, and the round state machine `apply` from #3. An
  anonymous round locks its votes at reveal (decided at the merge of #5).
- `packages/protocol` from #5: wire schemas, strict inbound parsing, acks and error
  codes, and `toSnapshot`, which builds each viewer's secret-safe snapshot.

## In flight (two at once when independent; see `CLAUDE.md`)

- **#14 (PP-014)** create a room and become its PO, in `../pp-wt-14`.
- **#15 (PP-015)** realtime room sync, in `../pp-wt-15`.

## Next

- W1 order, by dependencies:
  - #16 (join) needs #13, #14 and #15. Then #17 (table), #18 (vote), #19 (reveal),
    #20 (results) and #21 (next round), one after another.
  - #22 (mobile) needs #17, #18 and #20. #23 (four-person e2e) needs #21 and #22.
  - #24 (landing page) needs only #14, so it fills the second slot.
- **W1 starts without a new go** once the W0 issues other than #12 are merged (Sven,
  2026-10-26). No W1 issue depends on #11 or #12.
- **#12** waits for Sven's go (asked on 2026-10-27, when #11 was ready). DNS needs
  nothing: `*.borden.ch` already points to his Synology.

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

- **#12**: go for the Coolify project, the Postgres resource with backups and the
  application. Sven sets the two secrets himself, runtime-only. He also adds WebSocket
  headers to the Synology reverse-proxy rule, and can let Coolify's Traefik trust the
  Synology so rate limits see real client addresses.
- **#38**: pick the Azure service (OQ-1).
- **#41**: French and German tone (OQ-2).
- **#56**: licence and pricing model for branding (OQ-3).

## Merge gate

`pnpm gate` (lint, typecheck, unit, build) green locally, then every CI job green on
the pull request (`check`, `db-tests`, `web-e2e`). From #2 on, CI is the gate.
