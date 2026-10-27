# Status — what is live, what is in flight, what only Sven can do

A living page, rewritten (not appended) whenever the state changes, and kept under
about 20 kB. History: `docs/06-build-log/` (current: `2026-10.md`). Working agreement:
`CLAUDE.md`.

## Live

- Nothing is deployed yet. The Coolify resources for #12 exist and wait for Sven's part
  (see Owner items).
- `main` has the monorepo scaffold from #1: pnpm 12.15.0, Node 24, TypeScript 7,
  Biome, Vitest, Vite and tsdown. `pnpm gate` is green.
- CI from #2 runs on every pull request: `check` runs `pnpm gate`, `db-tests` runs
  `pnpm test:db` against Postgres 17, and `web-e2e` (from #13) runs Playwright.
- The web shell from #8: routes `/` and `/r/$code`, design tokens with light, dark and
  system themes, shadcn/ui, Motion and fonts.
- i18n from #9: our own typed `t()` (ADR-012 amended), en/fr/de with catalogs loaded
  on demand, numbers in the reader's regional format, a switcher in the header, and
  copy checks in the gate. The room route loads 164.0 kB of JS (after #24) against a
  200 kB budget; see the budget watch in the build log.
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
- Rooms from #14: `POST /api/rooms` (58-bit codes, 20 per address per 10 minutes),
  `GET /api/rooms/:code`, the create card and the room header with a copy link.
- Realtime from #15: `enter` and `cmd` over Socket.IO with acks, per-viewer
  snapshots, idempotent command ids, one message bucket and at most 8 sockets per
  person, `room:<id>` channels, deadline timers, and a drain on shutdown. On the web:
  `openRoom`, the room store and `sendCommand`. `PROTOCOL_VERSION` is 2.
- Landing, join by code, not-found and error pages from #24. A link to another host
  shows a warning instead of opening here, and the not-found page never shows the
  code.
- **W0 is done except #12** (deploy). It is ready on Coolify; the first webhook deploy
  failed only because the two secrets are missing (see Owner items).
- The decisions are in `docs/05-decisions.md`.

- `packages/domain` has decks, custom-deck validation, the range generator and
  results statistics from #4, and the round state machine `apply` from #3. An
  anonymous round locks its votes at reveal (decided at the merge of #5).
- `packages/protocol` from #5: wire schemas, strict inbound parsing, acks and error
  codes, and `toSnapshot`, which builds each viewer's secret-safe snapshot.

## In flight (two at once when independent; see `CLAUDE.md`)

- **#16 (PP-016)** join a room as voter or observer: PR #78, CI green, review running.
  Its fixer merges `main` (#77 touched `routes/r/$code.tsx`, the catalogs and the
  READMEs).
- **#12** deploy: waiting for Sven (Owner items). Then I redeploy and check
  `/api/health` and a WebSocket through the proxies.

## Next

- W1 order, by dependencies:
  - After #16: #17 (table), #18 (vote), #19 (reveal), #20 (results) and #21 (next
    round), one after another.
  - #22 (mobile) needs #17, #18 and #20. #23 (four-person e2e) needs #21 and #22.
- **W1 runs without a new go** (Sven, 2026-10-26).
- Once #12 is live, every merge deploys: after each merge, check that
  `https://poker.borden.ch/api/health` reports the merge commit. Pushes that only
  touch docs, Markdown or tests do not deploy (Coolify watch paths).

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

- **#12** (go given 2026-10-27; project, `poker-db` with daily backups and the app are
  created, with `BASE_URL` and `TRUST_PROXY=1`). Sven's part:
  - In the app, set `DATABASE_URL` (poker-db's internal URL) and `BETTER_AUTH_SECRET`
    (`openssl rand -base64 32`), with "Available at Buildtime" unticked.
  - In Advanced > Build, set "Source commit availability: Available during build"
    and "Build arguments: Managed manually in Dockerfile" (the API cannot).
  - On the Synology, add a reverse-proxy rule for `poker.borden.ch` with WebSocket
    headers, and give the host the `*.borden.ch` certificate.
  - Optional, his call: let Coolify's Traefik trust the Synology
    (`forwardedHeaders.trustedIPs`), then `TRUST_PROXY=2`. It restarts the proxy for
    all his apps. Until then, per-address limits see one address for everyone.
- **#38**: pick the Azure service (OQ-1).
- **#41**: French and German tone (OQ-2).
- **#56**: licence and pricing model for branding (OQ-3).

## Merge gate

`pnpm gate` (lint, typecheck, unit, build) green locally, then every CI job green on
the pull request (`check`, `db-tests`, `web-e2e`). From #2 on, CI is the gate.
