# Architecture

Decisions behind this page: `docs/05-decisions.md` (ADR-001 to ADR-015).

## 1. Topology

One container runs everything; Postgres holds all state.

```
Browser (React SPA)
   │  HTTPS + WebSocket (Socket.IO; long-polling fallback)
   ▼
Reverse proxy (Traefik on Coolify, Container Apps ingress on Azure, nginx…)
   ▼
app container (Node 24)
   ├─ Hono: /api/*, Better Auth (/api/auth/*), static SPA with history fallback
   ├─ Socket.IO: room channel, commands in, per-viewer snapshots out
   └─ packages/domain: apply(state, command, { actor, now })
   ▼
PostgreSQL 17: rooms (live state + version), round history, auth tables
```

- Default and target: **one replica**. Fan-out happens in memory.
- Scale-out is possible later without redesign: state is already in Postgres with
  compare-and-set; set `REDIS_URL` to enable the Socket.IO Redis adapter (#39) and
  use sticky sessions or websocket-only transport.
- Vercel and other serverless hosts are out of scope (ADR-001).

## 2. Repository layout

pnpm workspaces, TypeScript strict, Biome, Vitest, Playwright.

```
apps/
  web/        Vite + React 19 SPA (TanStack Router, Zustand, Tailwind v4, shadcn/ui, Motion, react-i18next)
  server/     Hono + Socket.IO + Better Auth + Drizzle; serves the built SPA
packages/
  domain/     pure TypeScript: state machine, decks, statistics, projections. No I/O.
  protocol/   zod schemas for commands and snapshots; Socket.IO event maps; protocol version
docs/         product, architecture, design, decisions, status, build log, prototype
compose.yaml  app + Postgres for local runs and Coolify
Dockerfile    multi-stage, non-root runtime
```

`packages/domain` and `packages/protocol` are imported by both apps. The web app may
call domain functions for optimistic rendering, but the server's result always wins.

## 3. Domain model

```ts
type UserId = string;               // Better Auth user id (guest or account)
type Card = string;                 // "0" "1" "½" "13" "XL" "?" "☕" "∞" or a custom label

type RoomSettings = {
  deck: { kind: "preset"; id: "fib" | "mfib" | "tshirt" | "pow2" | "seq" }
      | { kind: "custom"; cards: Card[] };          // max 20 cards, max 4 characters each
  specials: Array<"?" | "☕" | "∞">;                 // default ["?", "☕"]; stored in that order
  whoCanReveal: "po" | "anyone";                     // default "po"
  revealNames: boolean;                              // default true (false = anonymous)
  revealWhenAllVoted: boolean;                       // default true
  timer: { seconds: number | null; revealAtEnd: boolean }; // default { null, true }
  allowChangeAfterReveal: boolean;                   // default false; named rounds only
  poVotes: boolean;                                  // default true
  observersCount: boolean;                           // default true
};

type Participant = {
  name: string;                     // 1–32 characters, trimmed
  role: "voter" | "observer";
  avatar?: string;                  // avatar id (W4)
  joinedAt: number;
  connected: boolean;
  awaySince?: number;               // set after the presence grace period
};

type Round = {
  number: number;
  subject: { kind: "none" } | { kind: "title"; text: string }      // title: 1–200 characters
         | { kind: "link"; url: string; key?: string };  // http(s), ≤ 2000; key: "ABC-123" or ADO id, server-detected
  phase: "voting" | "revealed";
  deck: RoomSettings["deck"];       // captured at the round's start: votes are checked
  specials: RoomSettings["specials"]; //   against deckCards(deck, specials)
  anonymous: boolean;               // !settings.revealNames at the start; a change applies next round
  votes: Record<UserId, { card: Card; changedAfterReveal?: true }>;
  startedAt: number;
  revealedAt?: number;
  deadlineAt?: number;              // timer running
  final?: Card;
};

type RoomState = {
  ownerId: UserId;                  // the PO
  settings: RoomSettings;
  participants: Record<UserId, Participant>;
  round: Round | null;              // null = lobby
};
```

`createRoom({ ownerId })` gives the ADR-011 defaults (`DEFAULT_SETTINGS`), no participants
and `round: null`; the PO enters through `join` like everyone else. Character counts are
user-perceived characters (`cardLength`). Capacity: at most 16 counted people (voters,
plus observers when `observersCount`) and at most 32 participants in all.

## 4. The round state machine

`apply(state, command, ctx)` in `packages/domain` (`apply.ts`), where
`ctx = { actor: UserId, now: number }` (epoch ms). Pure, synchronous, never mutates its
input, 100 % branch coverage enforced by the gate. Commands are a flat union
(`{ type: "castVote", card }`). It returns `{ ok: true, state, causes, ended? }` or
`{ ok: false, error, state, causes }`; when nothing changed, `state` is the input object
itself (`===`), so the server can skip the write. Error codes are one snake_case union
(`ErrorCode`); causes never carry a card value except the public `finalSet`.

States: **Lobby** (`round === null`) → **Voting** → **Revealed** → next round →
**Voting**. A finished round is written to history when the next round starts, when
the final estimate is set, or when the room goes idle.

`ended` is the round an `apply` replaced or abandoned (`startRound`, `revote`, or a deck
or specials change that restarts a voting round), in its final form after step 1. The
input state is not enough: when a timer has elapsed, `startRound` first reveals the old
round and then replaces it in the same call, so only `ended` holds that revealed round.
The server writes `ended` to history only when `ended.phase === "revealed"`; an
abandoned or restarted voting round is not history.

Every `apply` runs three steps:
1. **Resolve an elapsed deadline**: if Voting and `deadlineAt <= now`, reveal (by
   `"timer"`, `revealedAt = deadlineAt`) when `timer.revealAtEnd`, otherwise clear the
   deadline and emit `timeUp`. The deadline is cleared either way, so this happens once,
   whoever arrives first, and it stands even when the command is then refused.
2. **Run the command.** Every command except `join` and `timeUp` needs the actor to be a
   participant (`not_participant`); PO-only commands answer `not_owner`.
3. **Settle** (on success, while Voting): drop the votes of people who are no longer
   voters, each with a `voteRetracted { who }` cause, then reveal (by `"everyoneVoted"`) when `revealWhenAllVoted` is on, the
   eligible voters are not empty and all of them have voted. Eligible: role `voter`, not
   away (`awaySince` unset), not the PO when `poVotes` is off. So a leave, kick, role
   change, settings change or owner transfer can complete a round, not only a vote.
   `timeUp` succeeds as a no-op command, so it runs this settle step too: the server's
   own timeout settles the round like any other command.

TODO (presence, #17): `awaySince` changes the eligible voters, so presence must change
it through `apply` with a server-only command (for example
`presence { who, connected, awaySince }`, refused from a client), never by writing the
state directly. Otherwise someone going away after everyone else voted leaves the round
in Voting until the next command arrives. Not built in #3.

| Command | Who | Rule (error codes) |
|---|---|---|
| `join {name, role}` | anyone admitted | name with whitespace runs (tabs, line breaks) collapsed to one space and trimmed, 1–32 chars and at most 512 code units, no lone surrogate (`bad_name`; titles follow the same rules with 200 chars); `already_joined`; `room_full` past 16 counted or 32 in all |
| `leave` | self | removes the person (and their vote while Voting); a leaving PO keeps ownership |
| `rename {name}` | self | as `join` |
| `setRole {role}` | self | voter → observer drops the vote while Voting; observer → voter checks capacity when observers do not count |
| `kick {who}` | PO | `cannot_kick_self`, `unknown_participant` |
| `startRound {subject}` | PO | any phase; from Voting it abandons the round; number + 1; captures deck, specials, anonymity; starts `timer.seconds` (`bad_subject`) |
| `castVote {card}` | voter | `no_round`, `not_voter` (observers; the PO when `poVotes` is off), `bad_card` (not in the round's cards); in Revealed only in a named round with `allowChangeAfterReveal` (a change or a first vote, marked `changedAfterReveal`); an anonymous round locks its votes at reveal, whatever the setting, decided by the round's own `anonymous` flag (`round_revealed`), because the people who could still change shrink as voters leave and a change would then point at someone; the `voteCast` cause always carries `who` |
| `retractVote` | self | Voting only (`not_voting`); no-op without a vote |
| `reveal` | PO, or anyone if `whoCanReveal = "anyone"` | Voting only (`not_voting`, `not_allowed`); zero votes allowed; stops the timer |
| `setFinal {card}` | PO | Revealed only (`not_revealed`); a non-special card of the round (`bad_card`) |
| `revote` | PO | Revealed only; a new round with the same subject |
| `startTimer {seconds}` | PO | Voting only; integer 5–3600 (`bad_seconds`); restarts a running timer; no change when the deadline stays the same |
| `stopTimer` | PO | no-op without a timer |
| `extendTimer {seconds}` | PO | running timer only (`no_timer`); 5–3600 |
| `timeUp` | anyone, also non-participants | nothing beyond steps 1 and 3 (the server's own timeout sends it) |
| `updateSettings {patch}` | PO | shallow merge, `timer` one level deep; unknown keys and bad values give `bad_settings` or the custom-deck code; turning `observersCount` on past 16 gives `room_full`; a deck or specials change during Voting restarts the round (votes cleared, same subject and number); anonymity applies from the next round; a running timer ignores `timer.seconds` |
| `transferOwner {to}` | PO | target present (participant, not away) and not the PO (`target_not_present`) |
| `claimOwner` | participant | not the PO (`already_owner`); only when the PO is not in the room or away for 120 s (`owner_present`) |

## 5. Sync protocol

Socket.IO with typed event maps from `packages/protocol` (`ClientToServerEvents`,
`ServerToClientEvents`); every payload is validated with zod on both ends.
`PROTOCOL_VERSION` is 1.

| Event | Direction | Payload | Ack |
|---|---|---|---|
| `enter` | client → server | `{ code, protocol }`: subscribe to a room's snapshots | `{ ok: true, snapshot }` or `{ ok: false, code }` |
| `cmd` | client → server | `{ id, type, payload }`: one domain command | `{ ok: true, version }` or `{ ok: false, code }` |
| `snapshot` | server → client | the viewer's projection | none |
| `kicked` | server → client | none; the server disconnects the socket next | none |

- **Commands**: one zod schema per domain command, a discriminated union on `type`;
  `id` is the client's correlation string; `payload` may be left out on commands without
  fields. `toDomainCommand(input)` parses and returns `{ ok: true, id, command }` with the
  flat domain `Command`, or `{ ok: false, code: "bad_payload" }`. zod checks the shape and
  caps strings and arrays well above the domain's limits (`WIRE_LIMITS`), and strips
  unknown fields (a link's `key` too: the server detects it). The domain stays the judge
  of the exact rules (grapheme counts, deck rules, ranges), so its codes reach the user.
- **Ack codes** (`AckErrorCode`, listed in `ACK_ERROR_CODES`): the domain's `ErrorCode` plus
  `bad_payload`, `protocol_mismatch`, `room_not_found`, `password_required`,
  `unauthenticated`, `rate_limited`, `internal`. snake_case strings the web app translates.
- **Enter**: `parseEnter(input)` answers `protocol_mismatch` to any other `protocol` number
  before it looks at the rest (an old client must learn to reload), else `bad_payload`
  or the payload.
- **Snapshots** (server → client): after every change the server sends each socket
  its own projection, `toSnapshot(state, viewer, { code, version, now, causes })`:
  `{ protocol, version, serverNow, room, causes }`, where `room` is
  `{ code, ownerId, settings, participants, you, round }`. `participants` is sorted by
  `joinedAt`, then id (never by vote order), each `{ id, name, role, avatar?, connected,
  away, isOwner }`; `you` is the viewer's id once joined, else `null`; `round` is `null`
  in the lobby. Rooms are small (≤ 16 people), so a full snapshot is a few kilobytes;
  there is no event replay and no gap handling. Clients drop any snapshot older than the
  one they hold.
- `causes` is an array, the causes of one `apply` in order (one command can give
  several: a timer reveal, then `roundStarted`). Each one (for example
  `{ type: "voteCast", who }`) drives animations and screen reader announcements and
  never carries a hidden value. `projectCauses` copies each cause field by field (an
  unknown cause is dropped); only `finalSet` carries a card; in an anonymous round after
  reveal no vote cause carries `who`, even one the domain sent with it (defence in depth).
- **Projection rules** (the round view, built field by field from an allow-list):
  - Every phase: `number`, `subject`, `startedAt`, `deadlineAt?`, `deck`, `specials`,
    `anonymous`, `voted` (user ids in participant order) and `yourVote?` (the viewer's
    own card, only for the viewer).
  - Voting: no other card anywhere.
  - Revealed: plus `revealedAt`, `final?` and `results` (`computeResults`).
  - Revealed, named: plus `votes: { who, card, changedAfterReveal }[]` in participant order.
  - Revealed, anonymous: plus `cards: Card[]` in deck order (deck cards, specials, then
    unknown labels by code point); no mapping between `voted` and `cards`, ever, and
    nothing per person (no `changedAfterReveal`).
  - Votes of people who left after the reveal stay (the domain keeps them), listed after
    the participants by id: dropping a card when its owner leaves would name the owner.
  - Never: password hashes, session data, other people's private fields.
  - Tested as fast-check properties over rooms built from random command sequences:
    while Voting no string in a snapshot equals a card label outside the decks and
    `yourVote`, and changing the others' cards changes nothing; in an anonymous round,
    swapping votes between people or reordering how they were cast changes nothing.
- **Reconnect**: Socket.IO reconnects automatically; on every (re)join the server
  sends a fresh snapshot. `protocol` mismatch → the client reloads.

## 6. Persistence

Drizzle ORM on PostgreSQL 17. Migrations generated with drizzle-kit and applied at
container start, before the server listens.

| Table | Content |
|---|---|
| `room` | `id` uuid, `code` unique, `name`, `owner_user_id`, `settings` jsonb, `live` jsonb (`RoomState`), `version` int, `password_hash` null, `created_at`, `last_active_at` |
| `round_history` | `room_id` (cascade), `number`, `subject` jsonb, `deck` jsonb, `votes` jsonb (named: who/name/card; anonymous: cards only), `stats` jsonb, `final`, `started_at`, `revealed_at`, `finished_at` |
| Better Auth | `user` (with `is_anonymous`), `session`, `account`, `verification` |
| later | `backlog_item` (W6), `connector_token` (W6, encrypted), `brand` (W7) |

**Write path for every command**: per-room in-process queue → load `live` + `version`
→ `apply` → `UPDATE room SET live = $next, version = version + 1, last_active_at =
now() WHERE id = $id AND version = $expected` → on zero rows, reload and retry (max 3)
→ emit snapshots. The queue avoids needless conflicts on one instance; the version
check keeps several instances correct.

## 7. Identity

Better Auth with the anonymous plugin (ADR-009).

- The first visit creates a guest user and an httpOnly session cookie (`SameSite=Lax`,
  `Secure` in production). The display name lives on the user.
- The Socket.IO middleware reads the cookie from the handshake and resolves the session
  with `auth.api.getSession`; unauthenticated sockets are refused.
- W5 adds Google and Microsoft Entra ID; signing in links the guest so rooms, PO
  ownership and history carry over (`onLinkAccount`).

## 8. Rooms, access and security

- Room code: 10 characters of base58 from `crypto.randomBytes` (about 58 bits). URL `/r/:code`.
- Password (optional): argon2id hash. A correct entry sets a signed, httpOnly
  room-access cookie for that room; attempts limited per IP and per room.
- Limits: names 32 characters, subjects 200, custom cards 4 characters × 20, payloads
  16 KB. HTTP rate limits on room creation, join and password; per-socket command rate
  limit.
- Headers: strict CSP (no inline scripts), HSTS, `X-Content-Type-Options`,
  `Referrer-Policy`. Subject links are rendered with `rel="noopener noreferrer"` and
  only `http(s)` schemes.
- Retention: rooms, their history and orphan guests are deleted after
  `ROOM_TTL_DAYS` (default 90) without activity.

## 9. Timers and presence

- Timer: `deadlineAt` in the round. Snapshots carry `serverNow`; clients compute their
  clock offset and count down locally. The server also sets a timeout for the room's
  deadline; whichever fires first (timeout, `timeUp` ping, any command) reveals once.
- Presence: a socket connect marks the participant connected. After the last socket of
  a user closes, a 15 s grace period passes before `awaySince` is set, so reloads and
  network blips do not flicker. PO claim opens after 120 s away.

## 10. Internationalisation

react-i18next with catalogs `en`, `fr`, `de` in `apps/web/src/i18n/`. Language from
the saved choice (`localStorage` `pp-language`), then `navigator.languages`, then
English. English is bundled; French and German are lazy chunks, fetched before the
first render in parallel with the route's chunk (no flash of the wrong language) and
prefetched when the switcher opens. `Intl` for numbers, dates and relative times;
plurals follow `Intl.PluralRules` (French needs a `_many` form). CI fails when a key,
a plural form or a placeholder is missing in any catalog. The server sends codes, never
sentences; every code in `@pp/protocol`'s `ACK_ERROR_CODES` has a message in every
language, and an unknown code gets a generic one.

## 11. Observability

- pino JSON logs (request id, room code, no secrets, no vote values).
- `GET /api/health` → `{ status, version, commit, db, uptime }`; used by the Docker
  `HEALTHCHECK` and by the merge loop to confirm a deploy.
- Optional Sentry (`SENTRY_DSN`) and Umami (`UMAMI_URL`, `UMAMI_WEBSITE_ID`); nothing
  external loads when they are unset.

## 12. Deployment

- Docker image: multi-stage build, Node 24 slim runtime, non-root, < 250 MB.
- `compose.yaml`: app + Postgres 17 with a volume; used locally and on Coolify.
- Coolify (Sven's instance): application from the Dockerfile, Postgres resource with
  daily backups, domain `poker.borden.ch`, auto-deploy from `main`.
- Azure: same image. Service still open (Container Apps by default; see
  `docs/04-open-questions.md` and #38).

| Env var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection |
| `BETTER_AUTH_SECRET` | yes | session signing |
| `BASE_URL` | yes | public URL, cookies and OAuth callbacks |
| `ROOM_TTL_DAYS` | no (90) | retention |
| `LOG_LEVEL` | no (info) | logging |
| `TRUST_PROXY` | no (true) | client IPs behind the proxy |
| `REDIS_URL` | no | scale-out only (#39) |
| `SENTRY_DSN`, `UMAMI_URL`, `UMAMI_WEBSITE_ID` | no | opt-in observability |
| Google / Microsoft keys | no (W5) | social sign-in |

## 13. Testing

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest | every `apply` rule, decks, statistics, projections, parsers |
| Integration | Vitest + Postgres (CI service) | write path with version conflicts, migrations, auth, sockets |
| End-to-end | Playwright, several browser contexts | full rounds; secrecy asserted on WebSocket frames |
| Visual | Playwright screenshots | table with 1–16 seats, both themes, 360 px to 1440 px |
| Accessibility | axe in Playwright + manual screen reader passes | room, settings, history |

`pnpm gate` = lint + typecheck + unit + build, and is what CI runs first.

## 14. Budgets

- Initial JavaScript under 200 KB gzipped for the room route.
- Command to snapshot under 150 ms p95 on one instance.
- Reveal with 16 seats at 60 fps on a mid-range phone.
