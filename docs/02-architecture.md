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
  web/        Vite + React 19 SPA (TanStack Router, Zustand, Tailwind v4, shadcn/ui, Motion, own typed i18n)
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
- **Handshake**: a browser handshake must come from `BASE_URL`'s origin (checked first,
  on both transports), then carry the session cookie (section 7): the middleware
  resolves it and sets `socket.data.user = { id, name, isAnonymous }`, or refuses the
  socket with `connect_error` `unauthenticated`. The web app connects only once it has a
  session (`connectWhenIdentified`), runs the identity bootstrap once more on
  `unauthenticated`, and shows `errors.unauthenticated` after a second refusal.
- **Reconnect**: Socket.IO reconnects automatically; on every (re)join the server
  sends a fresh snapshot. `protocol` mismatch → the client reloads.

## 6. Persistence

Drizzle ORM (`drizzle-orm`, driver `node-postgres`, the `pg` package) on PostgreSQL 17.
The server, and Better Auth on the same `db` (#10), use one `pg` pool. The schema is
`apps/server/src/db/schema.ts`; drizzle-kit generates the SQL migrations into
`apps/server/drizzle/` (`pnpm --filter @pp/server db:generate --name <what_it_does>`),
and they are committed.

| Table | Content |
|---|---|
| `room` | `id` uuid, `code` text unique, `name` text null, `owner_user_id` text (a copy of `live.ownerId`, written by every commit), `live` jsonb (`RoomState`: settings, people, the round), `version` int (starts at 1), `password_hash` text null, `created_at`, `last_active_at` (indexed, for the retention purge) |
| `round_history` | `id` identity, `room_id` (cascade delete), `number`, unique `(room_id, number)`, `subject` jsonb, `deck` jsonb (`{ spec, specials }`), `votes` jsonb, `stats` jsonb (`computeResults`), `final` text null, `started_at`, `revealed_at`, `finished_at` |
| Better Auth (#10) | `user` (with `is_anonymous`), `session`, `account`, `verification`, added by a later migration |
| later | `backlog_item` (W6), `connector_token` (W6, encrypted), `brand` (W7) |

`live` is the single source of truth for the room's state, settings included; there is
no separate `settings` column. The password hash stays in its own column and never
enters `live`, so it can never reach a snapshot. Timestamps are `timestamptz`.

**Start** (`apps/server/src/database.ts`, the `setup` hook of `run()`): wait for
Postgres, retrying with backoff (0.5 s doubling to 5 s) for up to 30 s in all, each
attempt's own time included (one attempt takes at most 10 s, and `pg` adds no backoff of
its own), with one log line per failed attempt, or failing at once when Postgres refuses
the login. The connection that answers becomes the one migrating session
(`application_name` `poker-planning-migrate`, `lock_timeout` 10 s): it takes the session
advisory lock `7000007` with `pg_try_advisory_lock` every 0.5 s, logging "waiting for
another instance's migrations" every 5 s and giving up after 60 s, so instances starting
together migrate one after the other and a killed instance's session never sits blocked
holding the lock; it applies the migrations and ends. Then the pool opens (10
connections). drizzle applies the pending migrations in one transaction, so a crash or a
signal in the middle rolls them back and the lock dies with the session; restarting
applies nothing. A `SIGTERM` or `SIGINT` during the start aborts it (the session ends),
logs one line and exits 0. The server listens only after all this, and `dispose` ends the pool on
shutdown. Migrations are additive and safe on a live database mid-deploy: a new column
is nullable or has a default, nothing is renamed or dropped while an older instance may
still run. drizzle wraps them in a transaction, so `CREATE INDEX CONCURRENTLY` is not
available. The migrations folder is `apps/server/drizzle`, found from `src/` and from the
bundled `dist/main.mjs`; `MIGRATIONS_DIR` overrides it.

**Write path for every command** (`createCommandRunner` in `db/runner.ts`): per-room
in-process queue → `loadRoom(code)` → the step (`apply`) → when the step returned the
loaded state itself, no write → `UPDATE room SET live = $next, owner_user_id,
version = version + 1, last_active_at = now() WHERE id = $id AND version = $expected`
→ on zero rows, reload and run the step again on the fresh state, up to 3 retries, then
the error `conflict` → emit snapshots. The queue avoids needless conflicts on one
instance; the version check keeps several instances correct.

**History**: when the step's `ended` is a revealed round, its row is written in the same
transaction as the commit, so a lost commit writes nothing. Writing the same round again
(`room_id`, `number`) updates its row, so a retry or a later rewrite (for example by an
idle job) never duplicates it. `votes` is `{ kind: "named", votes: [{ who, name, card,
changedAfterReveal? }] }`, people still in the room by joining order, then those who
left by id with `name: null` (the room no longer knows it), or `{ kind: "anonymous",
cards }`, the cards alone in display order (expanded from `stats.distribution`): no user
id, no name, no order that follows the people.

**A lost connection** (a Postgres restart or failover terminates the backends): every
`pg` client, pooled or not, has an `error` handler, since `pg` emits that event even on a
client checked out inside a transaction, and an unhandled one would crash the process.
The call in flight rejects with a `DatabaseError`; a transaction is rolled back by
Postgres, so the room and its history row land together or not at all; the pool drops
the broken client and opens a new one for the next command. An idle client's loss logs
one line with the code. Tests: `db/connection-loss.db.test.ts`. A rejected command may
still have landed (the connection dropped after Postgres committed, before the reply):
the caller reloads and broadcasts, it never applies the command again blindly (#15).
Use a real Postgres session (port 5432), not a transaction-mode pooler such as Azure's
PgBouncer: the session advisory lock needs one (#38).

**Errors**: every database call goes through `guard`, which rethrows a `DatabaseError`
holding the step and the SQLSTATE or Node error code, without a message or a cause.
Driver errors can carry connection details, and drizzle's query errors carry the
parameters (a room's state, vote values, a password hash); neither may reach a log.

## 7. Identity

Better Auth with the Drizzle adapter on the app's `pg` pool and the anonymous plugin
(ADR-009), mounted under `/api/auth/*` (`apps/server/src/auth.ts`). No email and
password, no social provider before W5.

- **Guests**: every page load runs the web app's bootstrap: `GET /api/auth/get-session`,
  and without a session `POST /api/auth/sign-in/anonymous`, which creates a `user` row
  (`is_anonymous`, a placeholder email, no personal data) and a session. User ids are
  Better Auth's 32 alphanumeric characters, within `userIdSchema`. The web app uses a
  few typed `fetch` calls, not `better-auth/client` (12 kB gzipped).
- **Cookie**: `pp.session_token`, the session token signed with `BETTER_AUTH_SECRET`;
  httpOnly, `SameSite=Lax`, path `/`; with an https `BASE_URL` also `Secure` with the
  `__Secure-` prefix. `trustedOrigins` is `BASE_URL` alone.
- **Lifetime**: a session lasts `ROOM_TTL_DAYS` (90) after the last visit, so a guest
  keeps their identity as long as their rooms live; a visit extends it at most once a
  day. Changing `BETTER_AUTH_SECRET` signs everybody out (new guests).
- **Display name**: `user.name`, `""` until the person picks one (#16 asks on joining;
  the plugin's English "Anonymous" is never stored). `POST /api/me/name { name }` cleans
  it with the domain's `cleanName` (whitespace collapsed, 1 to 32 characters within the
  code-unit cap, well-formed) and answers `{ name }` or `{ code: "bad_name" }`; it
  refuses another `Origin` and a non-JSON body. Better Auth's `/update-user` and
  `/delete-anonymous-user` are disabled.
- **Privacy**: sessions store neither the client address nor the user agent (a database
  hook nulls both); Better Auth's telemetry is off; its log calls keep the message and
  drop the arguments.
- **Sockets**: see section 5, "Handshake". The handshake never refreshes a session.
- **Errors**: Better Auth's 404, 429 and 5xx answers become `not_found`, `rate_limited`
  and `internal`. A database failure while reading a session is a 500, never "no
  session", so an outage cannot hand out a new guest identity.
- **W5**: Google and Microsoft Entra ID. Better Auth's anonymous plugin, on a social
  sign-in, calls `onLinkAccount({ anonymousUser, newUser })` and then deletes the guest:
  the user id changes. To keep the id, rooms and PO ownership, either link the provider
  to the guest row (`linkSocial`, then clear `is_anonymous`), or move what the guest owns
  in `onLinkAccount` (room `owner_user_id`, `live.ownerId`, participants, history), and
  set `disableDeleteAnonymousUser` until that move is proven. Provider names must go
  through `cleanName` too.

## 8. Rooms, access and security

- Room code: 10 characters of base58 from `crypto.randomBytes` (about 58 bits). URL `/r/:code`.
- Password (optional): argon2id hash. A correct entry sets a signed, httpOnly
  room-access cookie for that room; attempts limited per IP and per room.
- Limits: names 32 characters, subjects 200, custom cards 4 characters × 20, payloads
  16 KB. HTTP rate limits on room creation, join and password; per-socket command rate
  limit.
- Client address for every rate limit: `clientIp(request, TRUST_PROXY)`, the entry
  `TRUST_PROXY` places from the right of `X-Forwarded-For` (each proxy appends the
  address it received the request from), else the socket address. Never logged.
- Identity limits (Better Auth's limiter, keyed on that same address, which the server
  passes in a header of its own after dropping any client copy): anonymous sign-in 60 per
  address and minute, so a team of 30 behind one office address joins at once; every
  other auth endpoint 100 per 10 s. Answer: 429 `rate_limited`. The counters live in the
  process (per instance with #39).
- Headers: strict CSP (no inline scripts), HSTS, `X-Content-Type-Options`,
  `Referrer-Policy`. Subject links are rendered with `rel="noopener noreferrer"` and
  only `http(s)` schemes.
- Retention: rooms, their history and orphan guests are deleted after
  `ROOM_TTL_DAYS` (default 90) without activity. A guest's session expires after the
  same number of days without a visit.

## 9. Timers and presence

- Timer: `deadlineAt` in the round. Snapshots carry `serverNow`; clients compute their
  clock offset and count down locally. The server also sets a timeout for the room's
  deadline; whichever fires first (timeout, `timeUp` ping, any command) reveals once.
- Presence: a socket connect marks the participant connected. After the last socket of
  a user closes, a 15 s grace period passes before `awaySince` is set, so reloads and
  network blips do not flicker. PO claim opens after 120 s away.

## 10. Internationalisation

Our own typed `t()` (ADR-012, amended) with catalogs `en`, `fr`, `de` in
`apps/web/src/i18n/`, written in i18next's JSON v4 syntax. Language from the saved
choice (`localStorage` `pp-language`), then `navigator.languages`, then English. English
is bundled; French and German are lazy chunks, fetched before the first render in
parallel with the route's chunk (no flash of the wrong language; after 3 s the page
renders in English and switches when the catalog lands) and prefetched when the switcher
opens. Only the latest pick applies. `Intl` for numbers, dates and relative times, in
the reader's region (the first browser tag in the UI language, else the bare language);
plurals follow `Intl.PluralRules` (French needs a `_many` form). CI fails when a key, a
plural form or a placeholder is missing in any catalog, when a translation equals the
English outside an allowlist, on straight quotes, and on literal copy in components. The server sends codes, never
sentences; every code in `@pp/protocol`'s `ACK_ERROR_CODES` has a message in every
language, and an unknown code gets a generic one.

## 11. Observability

- pino JSON logs on stdout (request id, connection id, room code, no secrets, no vote
  values). Each HTTP request gets an id (an incoming `x-request-id` is kept when it is at
  most 64 safe characters) echoed in `x-request-id`; each socket gets a random connection
  id. Never logged: bodies, cookies, session tokens, the signing secret, auth headers,
  query strings, config values, client addresses; the logger redacts cookies, auth headers and `auth` payloads as a backstop.
  `/api/*` requests log at `info`; `/api/health` and static files at `debug`; 5xx at
  `error`.
- `GET /api/health` → `{ status, version, commit, db, uptime }`; used by the Docker
  `HEALTHCHECK` and by the merge loop to confirm a deploy. `version` and `commit` come
  from `APP_VERSION` and `GIT_COMMIT` (`dev` and `unknown` when unset), `uptime` is whole
  seconds. `db` is the answer of a `select 1` on the pool: `ok` (200) or `error` (503,
  `status: "error"`; also when the ping has not answered within 2 s, so a hung pool
  cannot hang the `HEALTHCHECK`). Sent with `Cache-Control: no-store`, like every JSON
  404 and 500.
- A bad config stops the server with one log line naming the variables (never their
  values) and exit code 1; so do a failed startup step (the database unreachable for
  30 s, a refused login, the migration lock held elsewhere for 60 s or a failed migration,
  all before the server listens; section 6) and an uncaught exception or unhandled
  rejection. `SIGTERM`/`SIGINT` during the start abort it and exit 0 with one line; later
  they stop accepting connections, drop every socket, wait for open requests (cut after 8 s),
  release the database pool and exit 0 within 10 s, one log line per phase.
- Optional Sentry (`SENTRY_DSN`) and Umami (`UMAMI_URL`, `UMAMI_WEBSITE_ID`); nothing
  external loads when they are unset.

## 12. Deployment

- Docker image (`Dockerfile`, #11), multi-stage. The build stage is `node:24-slim` with
  pnpm 12 through corepack: `pnpm fetch` into a BuildKit cache mount, an offline frozen
  install, `pnpm build`, then `pnpm --filter @pp/server deploy --prod` keeps only the
  server's runtime dependencies (their `.d.ts`, sourcemaps and docs dropped). The runtime
  is `debian:bookworm-slim` plus the `node` binary of that same `node:24-slim`, both
  pinned by digest. Plain `node:24-slim` with this pruned app would measure 247 MB, under
  the 250 MB budget with 3 MB to spare; the binary-only runtime is kept for the headroom,
  for fewer packages to patch (fewer CVEs) and because it has no npm, corepack or yarn.
  It is about 220 MB (`du`: Debian 77, Node 127, app 16). The digests do not move by
  themselves, so Debian security fixes need the update steps in the Dockerfile header
  (README, "Base image updates"); Dependabot or Renovate is Sven's call. pnpm is installed
  by `corepack install` at the version of `packageManager` in `package.json`, the only
  place with it. `/app` holds `dist/main.mjs`, `drizzle/`, `public/` (the web app) and
  `node_modules/`, owned by root; the process runs as uid 10001 with `NODE_ENV=production`,
  `STATIC_DIR=/app/public` and `MIGRATIONS_DIR=/app/drizzle`. Node is PID 1 and handles
  `SIGTERM` itself (section 11). `HEALTHCHECK`: a Node `fetch` of `/api/health` every 30 s
  (timeout 3 s, start period 120 s for the database wait, the migration lock and the
  migrations, probing every 2 s meanwhile). Build arguments `GIT_COMMIT` (falling back to
  `SOURCE_COMMIT`, which Coolify passes) and `APP_VERSION` become the env of the same name
  and the OCI labels `revision` and `version`. They are the only `ARG`s, declared after
  the last `RUN`, and none may carry a secret: an `ARG` in scope of a `RUN` is readable in
  `docker history`. `DATABASE_URL` and `BETTER_AUTH_SECRET` reach the container at runtime
  only.
- `compose.yaml`: `app` (built from `.`, image `poker-planning:local`) and `db`
  (`postgres:17`, volume `pgdata`, `pg_isready` health check, not published on the host);
  `app` starts once `db` is healthy, both `restart: unless-stopped`, port 3000.
  `DATABASE_URL` is built from `db`; `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET` and
  `BASE_URL` are required, and `TRUST_PROXY` defaults to false there. `app` runs with a
  read-only root file system (and a `tmpfs` on `/tmp`), no capabilities and
  `no-new-privileges`. For self-hosters (README, "Self-hosting", which writes `.env`
  itself; `.env.example` leaves `BETTER_AUTH_SECRET` empty and `TRUST_PROXY` unset, so
  compose's `:?` guards cannot be bypassed by a placeholder); Coolify builds the
  Dockerfile instead.
- CI job `docker` builds the image (no layer cache: caches of one pull request never reach
  another, and exporting one cost half the job) and runs
  `scripts/docker-check.sh`: size under 250 MB, compose up until healthy, a smoke test
  (`/api/health` with `db: ok` and the PR's commit, the web app, Socket.IO over a
  WebSocket with the right `Origin`, a foreign `Origin` refused), a room row that survives
  a restart and a `down`/`up` (volume kept) without migrations running twice, an extra
  migration applied once on restart,
  and exit code 0 on `SIGTERM` while serving and while waiting for the database.
- Coolify (Sven's instance, #12): application from the Dockerfile (build pack
  `Dockerfile`, port 3000), Postgres resource with daily backups, domain `poker.borden.ch`
  (`BASE_URL=https://poker.borden.ch`), auto-deploy from `main`. Settings #12 relies on:
  - Health: use the image's own `HEALTHCHECK` and leave Coolify's HTTP health check off.
    Its check runs curl or wget inside the container, and the image has neither.
  - Commit: Coolify leaves `SOURCE_COMMIT` out of builds by default. Turn on "Advanced >
    Build > Source commit availability: Available during build". A `SOURCE_COMMIT` that
    exists only at runtime makes `/api/health` report `commit: unknown`.
  - Build arguments: Coolify variables default to "Available during build", and by
    default Coolify injects an `ARG` for each into the Dockerfile; an `ARG` in scope of a
    `RUN` ends up in `docker history` (seen as `RUN |1 BETTER_AUTH_SECRET=...`). So set
    "Build arguments" to "Managed manually in Dockerfile", and uncheck "Available at
    Buildtime" for `DATABASE_URL` and `BETTER_AUTH_SECRET`: secrets are runtime-only.
  - Proxies: TLS ends at a Synology reverse proxy in front of Coolify's Traefik; both
    must pass WebSocket upgrades (`Upgrade` and `Connection` headers).
  - Client address: with two proxies, the right-most `X-Forwarded-For` entry is the
    Synology, not the client, and a hop count alone cannot fix that: Traefik deletes
    `X-Forwarded-For` and `X-Real-Ip` from peers it does not trust, so the app sees only
    the Synology. The fix is `forwardedHeaders.trustedIPs=<Synology address>` on Coolify's
    Traefik entry points (this changes Coolify's proxy configuration: it needs Sven's go
    in #12). Then the client is second from the right, and `TRUST_PROXY=2` (a proxy
    count, #10) reads it. Before Traefik trusts the Synology, a count of 2 means nothing:
    every client of Sven's instance shares one rate-limit bucket (the Synology's). And 2
    is only safe while no client can reach Traefik without passing the Synology: a
    direct client could put any address in front of its own.
- Azure: same image. Service still open (Container Apps by default; see
  `docs/04-open-questions.md` and #38).

| Env var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection, a real session (port 5432, no transaction-mode pooler); `?sslmode=` has libpq's meaning (`require` encrypts without checking the certificate, `verify-full` checks it) |
| `BETTER_AUTH_SECRET` | yes | signs the session cookies; at least 32 characters (`openssl rand -base64 32`); never logged; changing it signs everybody out |
| `BASE_URL` | yes | public origin (no path, no credentials): cookies, OAuth callbacks, the only `Origin` Socket.IO accepts from a browser; `http://localhost:5173` for `pnpm dev` |
| `PORT` | no (3000) | HTTP and Socket.IO port |
| `ROOM_TTL_DAYS` | no (90) | retention |
| `LOG_LEVEL` | no (info) | logging: `fatal` … `trace`, `silent` |
| `TRUST_PROXY` | no (true) | client IPs for rate limits: the number of reverse proxies in front (each appends to `X-Forwarded-For`; the client is the entry that many places from the right). `true` = 1 (Traefik alone), `2` for a TLS proxy in front of Traefik, `false` = 0 (the socket address). Too high a number lets clients forge their address |
| `STATIC_DIR` | no (`apps/web/dist`) | built web app; the image sets its own path |
| `MIGRATIONS_DIR` | no (`apps/server/drizzle`) | SQL migrations applied at start; the image copies the folder next to `dist/` or sets this |
| `GIT_COMMIT`, `APP_VERSION` | no | reported by `/api/health`; set at image build (build arguments; `SOURCE_COMMIT` stands in for `GIT_COMMIT`) |
| `POSTGRES_PASSWORD` | compose only | password of the bundled Postgres; letters and digits, since it goes into `DATABASE_URL` |
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
