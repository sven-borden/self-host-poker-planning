# Status — what is live, what is in flight, what only Sven can do

A living page, rewritten (not appended) whenever the state changes, and kept under
about 20 kB. History: `docs/06-build-log/` (current: `2026-10.md`). Working agreement:
`CLAUDE.md`.

## Live

- Nothing is built yet. Round 1 (design and architecture) was validated on 2026-10-26;
  the decisions are in `docs/05-decisions.md`.

## Next

- **#1 (PP-001)** Scaffold the pnpm monorepo, then the rest of W0 in order.

## Order

Strictly serial, one issue at a time, in this order. Issue keys `PP-NNN` equal
issue numbers.

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
