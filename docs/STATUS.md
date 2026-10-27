# Status — what is live, what is in flight, what only Sven can do

A living page, rewritten (not appended) whenever the state changes, and kept under
about 20 kB. History: `docs/06-build-log/` (current: `2026-10.md`). Working agreement:
`CLAUDE.md`.

## Live

- **https://poker.borden.ch is live** (#12, 2026-10-27). Every merge that changes the
  image deploys in about three minutes. After a merge, check that `/api/health`
  reports the merge commit. Docs-only pushes do not deploy.
- `main` has the monorepo scaffold from #1: pnpm 12.15.0, Node 24, TypeScript 7,
  Biome, Vitest, Vite and tsdown. `pnpm gate` is green.
- CI from #2 runs on every pull request: `check` runs `pnpm gate`, `db-tests` runs
  `pnpm test:db` against Postgres 17, and `web-e2e` (from #13) runs Playwright.
- The web shell from #8: routes `/` and `/r/$code`, design tokens with light, dark and
  system themes, shadcn/ui, Motion and fonts.
- i18n from #9: our own typed `t()` (ADR-012 amended), en/fr/de with catalogs loaded
  on demand, numbers in the reader's regional format, a switcher in the header, and
  copy checks in the gate. The room route loads 168.5 kB of JS (after #22) against a
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
- Joining from #16: the join screen, the room-full screen, seats in join order with
  the viewer at the bottom, observers under the table, and rename, role switch and
  leave. Commands are bound to the room they were sent from.
- The live table from #17: presence through `apply` (15 s grace, 60 s after a
  restart), voted badges and face-down cards, the PO crown, the viewer outline, colours
  from ids, and a live region that never says a value. `PROTOCOL_VERSION` is 3.
- Voting from #18: the hand with pick, change and take back, keyboard, the card's
  flight (Web Animations API, ADR-008 amended), the PO's minimal "Start voting" and
  "Next round" until #21, and `round_changed` so a vote never lands in the next round.
  `PROTOCOL_VERSION` is 4.
- The reveal from #19: the PO's button and `R` (scoped to the table and hand), the
  automatic reveal exactly once, the staggered flip, the anonymous "Cards played" row,
  and a "Not at the table" row that keeps departed voters' names.
- Results from #20: the suggested card with the team's agreement, ties and the
  Consensus pill in the centre, then Average, Median, Agreement, Spread, the
  distribution columns and the lowest and highest voters under the table.
- The next round from #21: the PO's subject field (none, a title or a link with Jira
  and Azure DevOps keys), "Start voting" and "Next round", and the history row.
- Phones from #22: the hand docks within thumb reach while voting when there is room,
  a compact header, numbered namesakes ("Ana Lima (2)"), narrow long labels, safe
  areas and a haptic tick.
- The four-person e2e from #23 runs on every pull request: four browser contexts, one
  of them a phone, five rounds (forced, last-vote, timer and anonymous reveals), the
  results checked against hand-written sentences, and every frame scanned for leaks.
  A failure keeps the trace and each person's frames, with room codes masked.
- **W0 and W1 are complete.**
- The room settings panel from #25: "Room settings" for the PO, read-only "Room rules"
  for everyone else (a lazy sheet). The PO can change observers count, anonymous voting
  (from the next round), reveal when everyone has voted and the PO votes too; the deck,
  specials, timer, who can reveal and change after reveal are shown read-only until
  their issue. Anonymous rounds carry an "Anonymous" chip. Later settings plug in
  through the contract in the web README. The room route loads 171.0 kB.
- The final estimate from #32: after a reveal the PO's decision bar (a picker with the
  suggested card preselected, "Record 5", "Next round", "Vote again") sits under the
  table and sticks to the bottom of the screen while out of view. Everyone sees the
  final in the centre; the history row is written when it is set. "Vote again" keeps
  the subject and clears the votes. The room route loads 171.2 kB.
- Decks from #26, in the settings panel: presets, a custom deck (up to 20 cards of 4
  characters, emoji allowed, errors explained), a range generator and the special
  cards. A change during voting asks first, then restarts the round, timer included.
  Labels never draw under 7 px; one that cannot fit is clipped with its full text in a
  title. The room route loads 172.2 kB.
- The timer from #27: a per-round length in the panel (off, 30 s, 60 s, 2 min, custom)
  with "Reveal when the timer ends", and the PO's start, stop and +30 s by "Reveal
  cards". A ring drains around the centre on the server's clock (`server-clock.ts`,
  monotonic, re-synced after a sleep). The server reveals at the deadline, exactly once,
  even after a restart; pages ping `timeUp` as a fallback. A deck restart restarts the
  timer. The room route loads 172.9 kB.
- The decisions are in `docs/05-decisions.md`.

- `packages/domain` has decks, custom-deck validation, the range generator and
  results statistics from #4, and the round state machine `apply` from #3. An
  anonymous round locks its votes at reveal (decided at the merge of #5).
- `packages/protocol` from #5: wire schemas, strict inbound parsing, acks and error
  codes, and `toSnapshot`, which builds each viewer's secret-safe snapshot.

## In flight (two at once when independent; see `CLAUDE.md`)

- **#30 (PP-030)** PO powers: hand over, claim when the PO is gone or away for 120 s,
  remove someone. PR #91 reviewed (no blocker); the fixer in `../pp-wt-30` merges `main`
  and moves the claim banner onto #27's `serverTime()`.
- **#28 (PP-028)** reveal modes: who can reveal ("anyone" means anyone who votes, never
  an observer: today the domain lets an observer reveal), a voter's "Reveal cards" and
  `R`, the revealer named in the live region. Building in `../pp-wt-28`.

## Next

- W2 order, by dependencies: #29 (change after reveal) needs #28; #31 (password) needs
  #30. They start as #28 and #30 merge.
  - PO decision for #28: switching anonymity never re-projects the round on the table;
    it applies from the next round, as #25 does, since names already seen cannot be
    hidden and an anonymous round must never gain them.
- Chores to fold into a later issue: a lazy catalog for the settings panel (about
  2 kB off both pages); the burst test's one `room_not_found` (see the build log).
  - Each later setting drops its control into #25's panel (see the web README).
- Notes to carry into the briefs:
  - #29: change after reveal never applies to anonymous rounds. The panel's `locked`
    toggle shows why.
  - #31: the header GET shows a password room's name.
  - #39 (scale-out): a kick must close the person's sockets on every instance; today
    only on the one that ran it.
  - Later: a person removed while their socket was down comes back to the join form
    with no notice (accepted at #30's review).
- **W2 runs without a new go** (Sven, 2026-10-26: "once wave 0 is done, start the
  next one").

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

- Optional, after #12:
  - Rotate `BETTER_AUTH_SECRET` (it went through my session when Sven asked me to add
    it).
  - Let Coolify's Traefik trust the Synology (`forwardedHeaders.trustedIPs`), then
    set `TRUST_PROXY=2`. This restarts the proxy for all his apps. Until then,
    per-address limits see one address for everyone.
- **#38**: pick the Azure service (OQ-1).
- **#41**: French and German tone (OQ-2).
- **#56**: licence and pricing model for branding (OQ-3).

## Merge gate

`pnpm gate` (lint, typecheck, unit, build) green locally, then every CI job green on
the pull request (`check`, `db-tests`, `web-e2e`). From #2 on, CI is the gate.
