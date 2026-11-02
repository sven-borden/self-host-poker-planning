# Status — what is live, what is in flight, what only Sven can do

A living page, rewritten (not appended) whenever the state changes, and kept under
about 20 kB. History: `docs/06-build-log/` (current: `2026-11.md`). Working agreement:
`CLAUDE.md`.

## Live

- **https://poker.borden.ch is live** (#12, 2026-10-27). Every merge that changes the
  image deploys in about three minutes. After a merge, check that `/api/health`
  reports the merge commit. Docs-only pushes do not deploy.
- **W0 to W2 are complete** (#1 to #32, to 2026-10-28; the build log has each). pnpm 12,
  Node 24, TypeScript 7, Biome, Vitest, Vite and tsdown; `pnpm gate`. CI on every pull request:
  `check`, `db-tests`, `web-e2e`, `docker`. Hono and Socket.IO on one port, Drizzle on `pg`
  with compare-and-set, a 239 MB image. A guest session for everyone (`TRUST_PROXY` is a
  proxy count), rooms of 58-bit codes, snapshots per viewer, en/fr/de with our own `t()`. The
  round: votes, flight, reveal, results, the next round, the final estimate, phones, a
  four-person e2e. The PO's room: settings, decks, timer, powers, reveal modes, a password,
  changing a card after the reveal.
- Round history from #33: "History" in the room header opens a lazy sheet of past
  rounds (subject, final, distribution, voting time, end time), each opening to its
  votes, names only for named rounds. A `history` socket request, for people in the
  room only, pages newest first; the round on the table shows once the next starts.
  The room route loads 175.9 kB.
- Retention from #35: a daily in-process purge (advisory lock, Postgres's clock) of
  rooms idle longer than `ROOM_TTL_DAYS`, with their history, grants and counters, and
  of orphan guests; a visit counts as activity; never a room in use or owned by a
  signed-in user. The README has a Privacy section, with a warning about restores.
- Summary and exports from #34, at the top of the history sheet: rounds, total of
  numeric finals, average agreement and voting time ("Today" or "All rounds"); CSV
  (BOM, `;` where the decimal mark is a comma, formula guard), a GFM Markdown table and
  "KEY estimate" lines; round level only, never names or the room code. The room route
  loads 176.6 kB.
- Hardening from #36: a strict CSP (no inline script or style, `frame-ancestors
  'none'`), HSTS, `Referrer-Policy: same-origin`, `Permissions-Policy`, COOP/CORP on
  every answer; every limit in one table (architecture §8); cookieless socket
  handshakes refused before the upgrade; a fuzz test over real sockets; a dependency
  audit in CI. Live at af6c1a0 with every header present.
- Scale-out from #39 (ADR-016), off unless `REDIS_URL` is set: the Socket.IO Redis
  adapter carries "room changed" signals only (each instance reads Postgres and builds
  its own viewers' snapshots), WebSocket only (a `<meta>` tells the page), command ids
  claimed in Redis, kicks, lockouts, presence and retention across instances, and an
  instance that never stops for Redis once started. Rate limits stay per instance
  (architecture §8). Redis must be reachable by the instances only. Live at bf40cf0.
- Accessibility from #37: axe in Playwright on every screen, panel and sheet (light and
  dark, desktop and phone, WCAG 2.2 A/AA, zero findings), a keyboard-only round with
  focus checks, a scripted screen-reader pass (live-region transcript and accessibility
  tree), 150 % text, 320 px reflow and reduced-motion specs, and a contrast test over
  every token pair. The table's centre and the page gutters are in px. Live at 5daa952.
- Opt-in observability from #40 (ADR-017), off unless set: `SENTRY_DSN` reports the
  server's error log lines (`@sentry/core` only) and the page's uncaught errors (a lazy
  30.5 kB chunk), `UMAMI_URL` with `UMAMI_WEBSITE_ID` sends page views by route
  (`/r/:code`), never a room code; the policy gains their origins only when on. An e2e
  round proves no request leaves by default; a second e2e server runs with both on. The
  room route loads 177.4 kB; the image is 239 MB of its 250 MB budget.
- Avatars from #42 (ADR-018): 24 original drawings on the person's own colour, optional,
  picked by keyboard or touch on the join form and in the "You" panel, saved on the user
  (`POST /api/me/avatar`, `user.avatar`) for the next room. One blink or bob at a time,
  none under reduced motion or in a hidden tab; away, grey with shut eyes. A lazy 2.6 kB
  chunk; the room route loads 178.4 kB. Live at bac3f39.
- The motion pass from #43 (ADR-019): the whole motion spec, with the voted badge's pop,
  seats fading in and out while the others glide, and a card's drop on someone else's slot.
  A 16-seat reveal has no long task on a mid-range phone: the table's cards draw first, the
  seats' labels, the decision and the hand panel a step behind, the results after them.
  `reveal-performance.spec.ts` holds it, alone after the other specs. The room route loads
  178.4 kB. Live at 2aee937.
- Sound effects from #44 (ADR-020): a card placed, a flip, the reveal, a consensus and the
  timer's last seconds, synthesised with the Web Audio API, off by default, saved on the
  device. A speaker in the top bar opens the switch and the volume. No `AudioContext` before
  a gesture; a hidden tab hears everything. A lazy chunk; the room route loads 179.3 kB. Live
  at 4e1ae00.
- Installable from #46 (ADR-022): a manifest, icons and a service worker that stores no page,
  only `/assets/*` and an offline page, and never touches `/api` or `/socket.io`; a haptic
  beat at the reveal with a "Vibrate" switch where the device can. The room route loads
  179.6 kB. Live at 093050c.
- Background music from #45 (ADR-021): three moods composed as data, rendered once in the
  page and looped, opt-in per device, playing while a round votes and fading at the reveal.
  Its own switch and a mood picker in the speaker's popover, one volume. A lazy chunk. Live
  at 2ce3c96.
- **W4 is complete** (2026-11-02).
- Sign-in with Google and Microsoft from #47 (ADR-023), merged and dark: no keys are set, so
  no route and no button exists. Implicit linking is off, provider tokens are never kept, a
  Microsoft person is `tid:oid`. The room route loads 181.6 kB. Live at f3c5955.
- The backlog queue from #52 (ADR-024): the PO pastes keys, links or a table into a lazy
  sheet, reorders it, and "Next item" starts the round; optional auto-advance with a 10 s
  countdown. A snapshot carries only the next item. At most 500 items and 256 KB. The issue
  stays open for real pastes. Live at a3ffb5a.
- A guest who signs in keeps everything from #48 (ADR-025): seats, cards, the PO role,
  password grants and named history move through `apply`, repeatably, with the guest removed
  only after a complete pass. The room route loads 183.2 kB. Live at 5b0a93a.
- The token vault from #53 (ADR-026), dark until a connector uses it: AES-256-GCM with
  `POKER_VAULT_KEY`, a table of per-user tokens, rotation by `vault:rotate`. Live at 4c8db08.
- My rooms from #49 (ADR-027), dark until sign-in has keys: a list of rooms kept or sat in,
  rename, leave and delete. Deleting needs the PO and the keeper in one: a role taken by
  claim cannot destroy a room, and retention follows the keeper. The room route loads
  184.8 kB. Live at c0a90bb.
- Rooms limited to accounts from #50 (ADR-028), dark until sign-in has keys: email domains,
  Microsoft tenants, or both. One invariant in `broadcast` keeps anyone refused off the feed. A
  keeper the rule refuses has no row and no delete. Sign-ins over 30 days cannot pass. Live at
  ff158df.
- Export and delete my account from #51 (ADR-029), dark until sign-in has keys, at `/account`.
  The deletion is repeatable and finishes from a sign-in, an `enter` or the sweep. Rooms pass
  on only to someone who may hold the role, else they stay with no keeper and follow
  `ROOM_TTL_DAYS`. Live at 439b4a3.
- The Jira Cloud connector from #54 (ADR-030), merged and dark: import by JQL or sprint, the
  final estimate written back. An estimate goes by itself only for a final the same tab
  recorded. Never run against real Atlassian. Live at 2ea5945.
- The Azure DevOps connector from #55 (ADR-031), merged and dark behind
  `AZURE_DEVOPS_CONNECTOR=on`: a personal access token, WIQL or saved queries, the estimate
  written back. A refusal never deletes a token. Never run with a valid token. Live at 3e6c7d1.
- The decisions are in `docs/05-decisions.md`.

- `packages/domain` has decks, custom-deck validation, the range generator and
  results statistics from #4, and the round state machine `apply` from #3. An
  anonymous round locks its votes at reveal (decided at the merge of #5).
- `packages/protocol` from #5: wire schemas, strict inbound parsing, acks and error
  codes, and `toSnapshot`, which builds each viewer's secret-safe snapshot.

## In flight (two at once when independent; see `CLAUDE.md`)

- #38 and #41, one agent each, since Sven answered OQ-1 and OQ-2 on 2026-11-02. After them, a
  comparison for #56 and the local reveal budget below.
- #54 and #55 are merged and stay open until the live checks at Sven's site and organisation.
- #47 is merged and stays open until the sign-ins work on poker.borden.ch.
- **Agents again, issue after issue, until the end of 2026-11-02** (Sven, 2026-11-01). The
  unblocked work ran out that day at W6 and the session stopped; his answers the same day
  started it again.

## Next

- W3 (#33–#41): all merged but #38 and #41, both in flight.
- W7 waits for his OQ-3 (#56). A comparison comes first, for him to decide from.
- The local reveal budget fails on clean `main` since 2026-11-02 (named reveal, 1 run of 4
  clean, worst 67 ms; #43 had 10 of 10). CI passes at the first try. Cause not looked for.
- Image size: 239 MB of 250 MB after #40 (236 MB before; architecture section 12 still
  quotes #11's 220 MB). A dependency of more than a few MB needs a look first.
- Chores to fold into a later issue: a lazy catalog for the panels' copy (settings and
  history, a few kB off both pages); the burst test's one `room_not_found` under load;
  a higher anonymous sign-in limit for the db tests through `SetupTuning` (about 41 of
  60 a minute used, 3 more per new block); `/dev/table` crashes in WebKit (React #185),
  with or without the CSP; no per-address cap on socket handshakes yet; nothing uses
  Motion's `m` any more (ADR-008), so `motion` could go, with `AppMotionConfig`; a new e2e
  test that creates a room on the plain `page` fixture tips a fast local run over the 20
  rooms in 10 minutes (use `newPerson`).
  - Each later setting drops its control into #25's panel (see the web README).
- Left by #39 for later: rate limits shared through Redis, a sticky-session setting
  with polling, a Redis key prefix so two deployments can share one Redis.
- Notes to carry into the briefs:
  - #29: change after reveal never applies to anonymous rounds. The panel's `locked`
    toggle shows why.
  - Later: a person removed while their socket was down comes back to the join form
    with no notice (accepted at #30's review).
  - The table's geometry is proven from 360 px; 320 px is checked for reflow only
    (#37).

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
  - **Now pressing (#31 is live):** let Coolify's Traefik trust the Synology
    (`forwardedHeaders.trustedIPs`), then set `TRUST_PROXY=2`. This restarts the proxy
    for all his apps. Until then, per-address limits (room creation, header reads, the
    password guard) see one address for everyone: 300 requests lock newcomers out of
    every password room for 10 minutes.
  - **After #36:** untick the Synology's "Enable HSTS" (every answer now carries two
    HSTS headers; the app's comes first and wins), and confirm the grade on
    securityheaders.com for poker.borden.ch (expected A+; it refuses automated scans).
- **After #37** (optional): a real screen-reader pass with NVDA (free, Windows) or
  VoiceOver; PR #100's "Screen reader pass" lists what each step should announce. One
  thing to judge: in an anonymous round a batch like "Cleo voted. Cards revealed.
  Suggested 5." names the last voter beside the group's suggestion (no card is paired
  with a name). Also the German count "0/7 haben abgestimmt" (was "haben bisher
  abgestimmt", shortened to fit 360 px), if another wording is wanted.
- **#52**: paste one real list from Jira and one from Azure DevOps into the sheet, and tell
  me what came out: the parser's fixtures are reconstructed. Then the issue can close.
- **#47: sign-in is ready for your keys.** #48 is live, so it is safe now. Follow the list in
  PR #107, do both proxy steps first (above), run the live check, then close #47.
- **After #50 and #51**, with keys set:
  - Decide how long Coolify's backups live: a restore brings deleted accounts back, and the
    server keeps no list of who was deleted (README).
  - Judge three choices made for you, each the safe way round and easy to loosen: a keeper a
    room's rule refuses has no delete, so a stranger who claims a room and shuts its owner out
    keeps it; a room can end with no keeper when nobody seated passes its rule; a seat refused
    at `enter` is gone, so a network blip ends it.
  - Read the wording of "What stays" on `/account` in all three languages. Nobody has judged
    the last line under the room select by eye.
- **#54: Jira.** After sign-in has keys: a Jira Cloud test site and an OAuth 2.0 (3LO) app, as
  in the README's "Jira Cloud". Runtime only in Coolify: `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`,
  `POKER_VAULT_KEY`. Turn on Atlassian's sharing and bring a second person, or only you can use
  it. Tell me what the consent screen lists and whether the board list works with these scopes.
  Your call there: keep the classic scopes or narrow them, as `write:jira-work` also allows
  deleting issues. Expect a press, not a write, after a reload or in a second tab. Then #54 can
  close.
- **#55: Azure DevOps.** After sign-in has keys: a test organisation, a token made as in the
  README's "Azure DevOps", and a second person with their own. Runtime in Coolify:
  `AZURE_DEVOPS_CONNECTOR=on` and `POKER_VAULT_KEY`. First question: does `vso.work_write` alone
  list projects? If not, the page and the README must say to tick Project and Team: Read too. Try
  the refused tokens in PR #115 and tell me what each page says. Then #55 can close. Later: decide
  whether to build Entra OAuth, as Microsoft warns against tokens as long-term credentials.
- **After #46**: install the app on a phone and check the icon, the name "Poker" and the bar
  colour, and on Android feel the reveal's beats. No real phone has run it. #46 closed with
  the icon judged by eye and Lighthouse's check replaced by Chromium's.
- **After #44 and #45**: turn the sound and the music on at poker.borden.ch and listen.
  Nobody has heard either; they were measured, not judged. The sounds are numbers in
  `sound-recipes.ts`, each mood's level one number in `music-moods.ts`. A real iPhone and
  Safari are untested too.
- **#56**: licence and pricing model for branding (OQ-3).

## Merge gate

`pnpm gate` (lint, typecheck, unit, build) green locally, then every CI job green on
the pull request (`check`, `db-tests`, `web-e2e`). From #2 on, CI is the gate.
