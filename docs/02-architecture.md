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
  restarts?: number;                // deck or specials changes that restarted it (#26); absent for none
  votes: Record<UserId, { card: Card; changedAfterReveal?: true; name?: string }>;
                                    // name: kept when the voter leaves after a named reveal (#19)
  startedAt: number;
  revealedAt?: number;
  deadlineAt?: number;              // timer running
  timerStartedAt?: number;          // when the running timer started (#27): the ring's whole
                                    //   is deadlineAt - timerStartedAt; an extension keeps it
  timeUpAt?: number;                // a deadline that passed without a reveal (#27): "Time is
                                    //   up" until the reveal or a new timer
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

Creating a room is not a command: `POST /api/rooms` (section 8) stores
`createRoom({ ownerId })` with the chosen preset deck as the room's first state
(version 1), the creator as PO and nobody inside; the PO then enters through `join`
like everyone else (#16).

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
   deadline, keep it as `timeUpAt` (#27) and emit `timeUp`. The deadline is cleared either way, so this happens once,
   whoever arrives first, and it stands even when the command is then refused.
2. **Run the command.** Every command except `join`, `timeUp` and `presence` needs the
   actor to be a participant (`not_participant`); PO-only commands answer `not_owner`.
3. **Settle** (on success, while Voting): drop the votes of people who are no longer
   voters, each with a `voteRetracted { who }` cause, then reveal (by `"everyoneVoted"`) when `revealWhenAllVoted` is on, the
   eligible voters are not empty and all of them have voted. Eligible: role `voter`, not
   away (`awaySince` unset), not the PO when `poVotes` is off. So a leave, kick, role
   change, settings change or owner transfer can complete a round, not only a vote.
   `timeUp` succeeds as a no-op command, so it runs this settle step too: the server's
   own timeout settles the round like any other command.

Presence (#17): `awaySince` changes the eligible voters, so presence changes it through
`apply` with the server-only command `presence { who, connected }`, never by writing the
state. `connected: false` sets `awaySince` to `now` and `connected` to false (cause
`away { who }`); `connected: true` clears `awaySince` and sets `connected` (cause
`back { who }`); when the state already says so, nothing changes. Like every success it
runs the settle step, so someone going away after everyone else voted reveals the round.
The wire protocol has no schema for it (`ClientCommand` in the domain excludes it), so a
client that sends one gets `bad_payload`; the server's timers send it (section 9).

| Command | Who | Rule (error codes) |
|---|---|---|
| `join {name, role}` | anyone admitted | name with whitespace runs (tabs, line breaks) collapsed to one space and trimmed, 1–32 chars and at most 512 code units, no lone surrogate, at most 3 combining marks in a row (`bad_name`; titles follow the same rules with 200 chars); `already_joined`; `room_full` past 16 counted or 32 in all |
| `leave` | self | removes the person (and their vote while Voting); after a named reveal the vote stays with the `name` they had (#19), after an anonymous one the card stays alone; a leaving PO keeps ownership |
| `rename {name}` | self | as `join` |
| `setRole {role}` | self | voter → observer drops the vote while Voting; observer → voter checks capacity when observers do not count |
| `kick {who}` | PO | `cannot_kick_self`, `unknown_participant`; the vote as for `leave` |
| `startRound {subject}` | PO | any phase; from Voting it abandons the round (the web offers it only in the lobby and after a reveal, #21); number + 1; captures deck, specials, anonymity; starts `timer.seconds` (`bad_subject`). A link's `key` is read here (`cleanSubject` → `linkKey`, in `apply-subject.ts`, so by the server; a client's own is dropped): a Jira key (`[A-Z][A-Z0-9_]{1,31}-[1-9][0-9]{0,9}`, read in any case, stored in capitals) from a path ending in `/browse/KEY` or Jira Cloud's `/projects/{project}/issues/KEY`, or a query's `selectedIssue=KEY`, on any host; an Azure DevOps work item id from a path ending in `/_workitems/edit/{id}` after one to three segments, on any host (Azure DevOps Server is self-hosted), or a query's `workitem={id}` on `dev.azure.com` and `*.visualstudio.com`, stored as the digits |
| `castVote {card, round, restart?}` | voter | `no_round`; `round_changed` when `round` (the number of the round the press was made for) is not the current round's, or `restart`, when given, not its `restarts` (#26: a deck change restarts the round under the same number; the wire takes a vote without it, from a tab older than #26), so a vote in flight when the next round starts or the round restarts never lands in it; `not_voter` (observers; the PO when `poVotes` is off), `bad_card` (not in the round's cards); in Revealed only in a named round with `allowChangeAfterReveal`, and only from someone who already has a vote in that round (a change, marked `changedAfterReveal`); a first card after the reveal is refused (`round_revealed`), from a voter who had not voted, an observer turned voter or someone who joined after the reveal: the setting changes a vote, never adds one, since a card played after seeing everyone's is anchored on them (#29); an anonymous round locks its votes at reveal, whatever the setting, decided by the round's own `anonymous` flag (`round_revealed`), because the people who could still change shrink as voters leave and a change would then point at someone; the `voteCast` cause always carries `who` |
| `retractVote {round, restart?}` | self | `round_changed` as for `castVote`; Voting only (`not_voting`), also while `allowChangeAfterReveal` is on: after the reveal a voter changes, never withdraws, which would drop them from the results (#29); no-op without a vote |
| `reveal` | PO (whether or not they vote), or, if `whoCanReveal = "anyone"`, every voter (`isVoter`); observers never (`not_allowed`, #28) | Voting only (`not_voting`); zero votes allowed; stops the timer; the cause `revealed { by: "manual", who }` names the revealer |
| `setFinal {card}` | PO | Revealed only (`not_revealed`); a non-special card of the round (`bad_card`) |
| `revote` | PO | Revealed only; a new round with the same subject; its `roundStarted` cause carries `revote: true` (#32) |
| `startTimer {seconds}` | PO | Voting only; integer 5–3600 (`bad_seconds`); restarts a running timer; no change when the deadline stays the same; sets `timerStartedAt` and clears `timeUpAt` (#27), as `startRound` does with the room's timer |
| `stopTimer` | PO | no-op without a timer; clears the deadline and `timerStartedAt` |
| `extendTimer {seconds}` | PO | running timer only (`no_timer`); 5–3600 |
| `timeUp` | anyone, also non-participants | nothing beyond steps 1 and 3 (the server's own timeout sends it) |
| `updateSettings {patch}` | PO | shallow merge, `timer` one level deep; unknown keys and bad values give `bad_settings` or the custom-deck code; turning `observersCount` on past 16 gives `room_full`; a deck or specials change during Voting restarts the round (votes cleared, same subject and number, and the timer starts over: a new deadline at `now + timer.seconds`, or none without a room timer, so a timer started by hand stops); anonymity applies from the next round; a running timer ignores `timer.seconds` |
| `transferOwner {to}` | PO | target present (participant, not away) and not the PO (`target_not_present`) |
| `claimOwner` | participant | not the PO (`already_owner`); only when the PO is not in the room or away for 120 s (`owner_present`) |
| `presence {who, connected}` | the server only (refused on the wire) | `unknown_participant`; away sets `awaySince = now`, back clears it; no change when the state already says so |

## 5. Sync protocol

Socket.IO with typed event maps from `packages/protocol` (`ClientToServerEvents`,
`ServerToClientEvents`). The server validates every inbound payload with the protocol's
zod schemas; the web checks the server's messages by shape (`isSnapshot`, `isEnterAck`,
`isCmdAck`), not with zod, which would cost the room route about 27 kB gzipped.
`PROTOCOL_VERSION` is 4 (4 added the `round` of `castVote` and `retractVote` and the
`round_changed` ack code, #18; 3 the `away` and `back` causes, #17; 2 the `busy` ack
code, #15; 1 was the first deploy). Adding an optional field to an outbound view is not
breaking (the web checks shapes, the schemas are lenient), so #19's departed `name`
kept version 4, and so did #21: the snapshot's link `key` was already in the schema,
and `startRound {subject}` did not change. An optional field on an inbound command is
not breaking either: #26's `restart` on `castVote` and `retractVote` (the round's
`restarts` when the press was made) is optional, the server checks it when present and
takes any restart when it is missing, as for a command it built, and the web app always
sends it. So every tab open across that deploy kept its room instead of reloading.

| Event | Direction | Payload | Ack |
|---|---|---|---|
| `enter` | client → server | `{ code, protocol }`: subscribe to a room's snapshots | `{ ok: true, snapshot }` or `{ ok: false, code }` |
| `cmd` | client → server | `{ id, type, payload }`: one domain command | `{ ok: true, version }` or `{ ok: false, code }` |
| `snapshot` | server → client | the viewer's projection | none |
| `kicked` | server → client | none; the server disconnects the socket next (the web app connects again and shows the join form, #30) | none |

- **Commands**: one zod schema per domain command, a discriminated union on `type`;
  `id` is the client's correlation string; `payload` may be left out on commands without
  fields. `toDomainCommand(input)` parses and returns `{ ok: true, id, command }` with the
  flat domain `Command`, or `{ ok: false, code: "bad_payload" }`. zod checks the shape and
  caps strings and arrays well above the domain's limits (`WIRE_LIMITS`), and strips
  unknown fields (a link's `key` too: the server detects it). The domain stays the judge
  of the exact rules (grapheme counts, deck rules, ranges), so its codes reach the user.
- **Ack codes** (`AckErrorCode`, listed in `ACK_ERROR_CODES`): the domain's `ErrorCode` plus
  `bad_payload`, `protocol_mismatch`, `room_not_found`, `password_required`,
  `unauthenticated`, `rate_limited`, `busy`, `internal`. snake_case strings the web app
  translates. `busy` (#15): the runner's `conflict`, every compare-and-set retry lost to
  another instance; nothing was stored, so the same command id may be sent again (the web
  does so up to 4 times). `internal` is kept for "unknown whether it landed".
- **Enter**: `parseEnter(input)` answers `protocol_mismatch` to any other `protocol` number
  before it looks at the rest (an old client must learn to reload), else `bad_payload`
  or the payload.
- **Snapshots** (server → client): after every change the server sends each socket
  its own projection, `toSnapshot(state, viewer, { code, version, now, causes })`:
  `{ protocol, version, serverNow, room, causes }`, where `room` is
  `{ code, ownerId, ownerClaimableAt?, settings, participants, you, round }`.
  `ownerClaimableAt` (#30, optional, so version 4 stayed) is when anyone else may claim
  the PO role, in epoch ms by the server's clock: the PO's `awaySince` plus 120 s while
  the PO is away, 0 while the PO is not in the room, absent while the PO is here. It is
  the one place the PO's `awaySince` shows; the page shows "Claim the product owner role"
  from then on, by its offset to `serverNow`, and `claimOwner` decides with the same rule. `participants` is sorted by
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
  A manual reveal's `who` (#28, optional) names the person who revealed; it maps nobody
  to a value, so it travels in anonymous rounds too, and the page names a voter who
  revealed in its live region.
- **Projection rules** (the round view, built field by field from an allow-list):
  - Every phase: `number`, `subject`, `startedAt`, `deadlineAt?`, `timerStartedAt?` and
    `timeUpAt?` (#27; a reveal clears all three, so only a voting round carries them),
    `deck`, `specials`, `anonymous`, `voted` (user ids in participant order) and
    `yourVote?` (the viewer's
    own card, only for the viewer).
  - Voting: no other card anywhere.
  - Revealed: plus `revealedAt`, `final?` and `results` (`computeResults`).
  - Revealed, named: plus `votes: { who, card, changedAfterReveal, name? }[]` in
    participant order; `name` only for a voter who left after the reveal (#19), the name
    the domain kept with the vote, since no participant row names them any more.
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
  socket with `connect_error` `unauthenticated`; a database failure refuses it with
  `internal`. The web app connects only once it has a session (`connectWhenIdentified`),
  runs the identity bootstrap once more on `unauthenticated`, and shows
  `errors.unauthenticated` after a second refusal. After `internal` or `rate_limited` it
  connects again with backoff (1 s doubling to 30 s, jittered, at least a `retryAfter`
  the server sends), and the connection status stays `reconnecting`.
- **Reconnect**: Socket.IO reconnects automatically; the client sends `enter` on every
  connect and gets a fresh snapshot. `protocol_mismatch` → the room page shows "a new
  version is available" with a Reload button, and the socket stops.

### The realtime path as built (#15)

Server: `apps/server/src/sync/room-sync.ts` (the `handlers` of `createRealtime`). Web:
`apps/web/src/realtime/room-connection.ts` and `stores/room-store.ts`.

- **Message limit**: one token bucket per person, shared by all their sockets, 10
  messages a second with bursts of 20, for `enter` and `cmd` alike, before any parsing.
  Past it: `rate_limited`; the socket and the room stay up. A person holds at most 8
  sockets: the next handshake is refused with `rate_limited`. The bucket outlives the
  person's last socket until it would be full again, so reconnecting does not refill it.
- **Enter**: the session is checked again (`sessionChecker`; a socket outlives a
  sign-out or a deleted user) → `unauthenticated`; the socket joins the room's channel
  `room:<id>` (never the code, a bearer capability) *before* the room is loaded when this
  instance knows the id, so a commit in between reaches it; otherwise it loads, joins and
  loads again. Then `room_not_found` or `{ ok: true, snapshot }` for this viewer (also
  for someone who has not joined: `you: null`). One room per socket: a socket's enters
  run one after the other, a failed one leaves the channel it joined, an enter stops when
  the socket disconnects mid-way, and `socket.data.room` is set only after every check.
  A command sent during an enter waits for it.
- **Command**: bucket → `toDomainCommand` (`bad_payload`) → entered room
  (`room_not_found`) → idempotency → `runner.run(code, s => apply(s, cmd, { actor, now }))`
  (per-room queue, load, apply, compare-and-set, retry) → broadcast → ack. Each socket of
  the room gets `toSnapshot(state, its user, { causes })` *before* the ack goes out, so a
  client holds the new snapshot when its command resolves. A refused command acks the
  domain code, and whatever the run stored anyway (a timer reveal resolved first) is
  broadcast. A `kicked` cause sends `kicked` to that person's sockets and closes them.
- **Idempotency**: the last 100 results of each person (by room id and command id), for
  the 1000 people who sent a command last, in process memory; one person's flood evicts
  only their own results. A repeated id (in flight or done) gets the same ack and runs
  once. `busy` is not remembered. A restart or another instance forgets it, so on
  shutdown the server stops taking socket messages, waits up to 5 s until every message
  it took is answered, and only then closes the connections.
- **Session**: a command checks the session again once the last check is a minute old;
  when it is gone it answers `unauthenticated` and closes the connection, and the
  client's reconnect meets the handshake's check.
- **History** (#33): `history { before?, limit? }` with an ack, beside `enter` and
  `cmd` (same bucket; `parseHistoryRequest`, strict, `bad_payload` otherwise). Only
  someone in the room reads it: the socket must have entered (else `room_not_found`, so
  a password keeps out whoever it keeps out of the room), and the reader must be a
  participant or the PO in a fresh load of the room (else `not_participant`: someone
  still on the join form, a grant holder who has not joined, a removed person), checked
  on every request after the session check. It answers `{ ok, rounds, next? }`, newest
  first, paged by round number: `before` asks for the rounds numbered below it, 20 a page
  by default and 50 at most (`HISTORY_PAGE`), `next` is the `before` of the next page
  while older rounds remain. The round on the table (any phase) is left out even when it
  has a row (#32's final), so it shows once the next round starts. A row is `{ number,
  subject, final, stats, startedAt, revealedAt, finishedAt, votes }`, times in epoch ms;
  named votes are `{ name, card, changedAfterReveal? }` without the voter's id, an
  anonymous round's are the stored cards. The answer's schemas are strict, and
  `historyLeaks` (`@pp/protocol/leak-scan`) checks real frames for a user id or an
  anonymous name. The web panel fetches the first page on open and again when the table's
  round number or final changes; nothing is pushed. A new client event with its own ack:
  `PROTOCOL_VERSION` stays 4. Logs name the room by id and the count of rows.
- **Database failure**: a `DatabaseError` may hide a commit that landed. The server
  reloads the room, broadcasts it, acks `internal`, and never runs the command again.
- **Versions**: each socket remembers the version it holds and never gets the same or an
  older one; the web store keeps a snapshot only when it is newer than the one it holds.
- **Deadline timeout** (section 9): one timer per room that has a voting round with a
  `deadlineAt` and a socket on this instance; re-armed after each broadcast and enter,
  cleared when the round changes or the last local socket leaves. It runs `timeUp`
  through the runner; `apply` reveals, the compare-and-set lets only one instance store it
  (tested with two instances on one database). An instance that lost sends the stored
  state without causes.
- **Web**: `openRoom(code)` connects through `connectWhenIdentified` (#10's backoff),
  sends `enter` on every connect and keeps `status` (`connecting`, `live`, `reconnecting`,
  `error`). Only an `enter` refused with `internal`, `rate_limited` or `busy` is retried;
  `unauthenticated` runs the identity bootstrap once more; other refusals are final.
  `sendCommand(command)` waits for `live`, sends with a fresh id, and resends the same id
  after a lost ack or `busy`. Messages are checked by shape, not with zod (27 kB gzipped).
- **Voting from the web** (#18, `apps/web/src/room/hand-state.ts`): the hand shows a
  pick at once and settles on the snapshot's `yourVote`. One `castVote` or `retractVote`
  is on the wire at a time; when its ack resolves the store holds its snapshot, so the
  next command goes out only if the latest pick still differs (fast clicks collapse, and
  the same command is never sent twice in a row). A refusal (`round_revealed`,
  `not_voting`, `offline`, a `busy` that gave up) drops the pick: the hand rolls back to
  the snapshot. A pick belongs to its round (number and `startedAt`) and its phase, so a
  new round or the reveal drops it. After a named reveal, while `allowChangeAfterReveal`
  is on (#29), the hand stays playable: a press sends `castVote` (a change), and the card
  shown pressed again sends nothing, since `retractVote` is refused after the reveal. Each command carries the round number it was made for, and its
  `restarts` (#26): one still in flight when the PO starts the next round, or restarts
  this one with a new deck, is refused with `round_changed`, and the
  hand rolls back without a message (the new round's hand is empty anyway). The pick changes only the viewer's own screen; the others learn
  the vote from the server's `voted`, never the card.
- **Revealing from the web** (#19, `apps/web/src/room/round-centre.tsx`): the PO's
  "Reveal cards" (or the key R, on the table or the hand) sends `reveal` and renders nothing of its own: the
  forced, automatic and timer reveals all reach the page as the same revealed snapshot,
  and the page shows them alike. Under `whoCanReveal: "anyone"` every voter's centre has
  the same button (#28, `mayReveal` in `table-data.ts`). A `reveal` the rule refuses (an
  observer's, or a voter's while only the PO may) gets `not_allowed` and stores nothing; the last two votes sent together reveal once, one version each, on one
  instance or two (`room-sync.db.test.ts`). The page animates only a change it saw (a
  slot it showed face down or empty); a reload or a late joiner gets the revealed room at
  rest. A named vote whose voter has no seat (gone, or an observer now) shows under the
  table, so every vote the results count is on screen.
- Measured on one instance with Postgres (`room-sync.db.test.ts`): a join reaches the
  other client in about 4 ms median, 17 ms worst of ten.

## 6. Persistence

Drizzle ORM (`drizzle-orm`, driver `node-postgres`, the `pg` package) on PostgreSQL 17.
The server, and Better Auth on the same `db` (#10), use one `pg` pool. The schema is
`apps/server/src/db/schema.ts`; drizzle-kit generates the SQL migrations into
`apps/server/drizzle/` (`pnpm --filter @pp/server db:generate --name <what_it_does>`),
and they are committed.

| Table | Content |
|---|---|
| `room` | `id` uuid, `code` text unique, `name` text null, `owner_user_id` text (a copy of `live.ownerId`, written by every commit), `live` jsonb (`RoomState`: settings, people, the round), `version` int (starts at 1), `password_hash` text null (argon2id PHC string), `password_failures` int and `password_failures_since` null (the per-room count of wrong passwords, #31), `created_at`, `last_active_at` (indexed, for the retention purge) |
| `room_access` | `room_id` (cascade delete), `user_id` (cascade delete with the user), `granted_at`; primary key `(room_id, user_id)`: who may enter a room with a password without typing it (#31) |
| `round_history` | `id` identity, `room_id` (cascade delete), `number`, unique `(room_id, number)`, `subject` jsonb, `deck` jsonb (`{ spec, specials }`), `votes` jsonb, `stats` jsonb (`computeResults`), `final` text null, `started_at`, `revealed_at`, `finished_at` |
| Better Auth (#10) | `user` (with `is_anonymous`), `session`, `account`, `verification`, added by a later migration |
| later | `backlog_item` (W6), `connector_token` (W6, encrypted), `brand` (W7) |

`live` is the single source of truth for the room's state, settings included; there is
no separate `settings` column. The password hash stays in its own column and never
enters `live`, so it can never reach a snapshot; `live.hasPassword` is the flag alone,
written in the same transaction as the hash and the grants. Timestamps are `timestamptz`.

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
transaction as the commit, so a lost commit writes nothing. So is the revealed round on
the table once the PO recorded its final estimate (#32, `historyRound` in
`db/history.ts`): every step that changes that round (the final set or changed, a vote
changed after the reveal, a departed voter's name kept) writes its row, so the decision
is stored when it is made, even if nobody starts another round. `finished_at` is the
end of the round (the next round or a re-vote writes the row again); while the round is
still on the table it is the time of the row's last write, which a vote changed or a
voter leaving after the final also moves, so it is not the decision's time. The round
still on the table may already have a history row: the history request (#33) leaves the
round on the table out, so it shows once, after the next round starts (section 5). Writing the same round again
(`room_id`, `number`) updates its row, so a retry or a later rewrite (for example by an
idle job) never duplicates it. `votes` is `{ kind: "named", votes: [{ who, name, card,
changedAfterReveal? }] }`, people still in the room by joining order, then those who
left by id with the name the vote kept (#19), or `null` for a vote stored before it, or `{ kind: "anonymous",
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
  (`is_anonymous`, a placeholder email, no personal data) and a session, then reads the
  session back. User ids are Better Auth's 32 alphanumeric characters, within
  `userIdSchema`. The web app uses a few typed `fetch` calls, not `better-auth/client`
  (12 kB gzipped).
  - Two tabs at once: the bootstrap holds the `pp-identity` Web Lock, so the second tab
    finds the first one's session. Without the lock API, the server's `not_allowed` to a
    second sign-in makes the tab read the session instead.
  - Temporary failures (`network`, `internal`, `rate_limited`, a 502 during a redeploy)
    are retried with backoff (1 s doubling to 30 s, jittered, at least `Retry-After`);
    the root layout shows a quiet "Connecting to the server" toast meanwhile.
  - Cookies blocked (`navigator.cookieEnabled` false, or the new session does not read
    back): `cookies_blocked`, no further guest on that page, and a message that the site
    needs cookies.
- **Cookie**: the session token signed with `BETTER_AUTH_SECRET`, httpOnly,
  `SameSite=Lax`, `Path=/`, never a `Domain`. With an https `BASE_URL` it is
  `__Host-pp.session_token`, `Secure`: the browser accepts that prefix only without
  `Domain`, so a sibling site (`*.borden.ch`) cannot plant a session cookie that would be
  sent first (`__Secure-` allows `Domain`). With an http `BASE_URL` (a LAN address,
  compose without TLS) it is `pp.session_token` without `Secure`, so the browser keeps it.
  Every other Better Auth cookie follows the same naming. `trustedOrigins` is `BASE_URL`
  alone.
- **Endpoints**: only `GET /api/auth/get-session`, `POST /api/auth/sign-in/anonymous` and
  `POST /api/auth/sign-out` reach Better Auth (`AUTH_ROUTES`); every other path under
  `/api/auth` is a JSON 404 before its rate limiter (`/list-sessions` would hand out raw
  tokens, and the limiter keeps a counter per path). A POST from another `Origin` is
  refused with `not_allowed`. Bodies under `/api/auth/*` and `/api/me/*` are capped at
  4 KB, every other `/api/*` body at 16 KB (`bad_payload`, 413). No answer carries a
  `token` field: the cookie carries the session.
- **Lifetime**: a session lasts `ROOM_TTL_DAYS` (90) after the last visit, so a guest
  keeps their identity as long as their rooms live; a visit extends it at most once a
  day. Changing `BETTER_AUTH_SECRET` signs everybody out (new guests).
- **Display name**: `user.name`, `""` until the person picks one (#16 asks on joining;
  the plugin's English "Anonymous" is never stored). `POST /api/me/name { name }` cleans
  it with the domain's `cleanName` (whitespace collapsed, 1 to 32 characters within the
  code-unit cap, well-formed, nothing invisible: see section 8) and answers `{ name }` or
  `{ code: "bad_name" }`; it refuses another `Origin` and a non-JSON body, and allows 10
  changes per user and 60 per address a minute. Better Auth's `/update-user` is never
  forwarded.
- **Privacy**: sessions store neither the client address nor the user agent (a database
  hook nulls both); Better Auth's telemetry is off.
- **Logs**: a failed query's error carries its parameters (a session token), so no
  Better Auth or driver error is ever printed: Better Auth's logger goes to pino with a
  fixed message and at most its error code (`INTERNAL_SERVER_ERROR`);
  `onAPIError.throw` keeps better-call from printing its `# SERVER_ERROR` dump to stderr
  and Better Auth from printing 4xx lines; the handler logs only the code of a thrown
  error; `sessionUser` rethrows a `DatabaseError` with the code alone.
- **Sockets**: see section 5, "Handshake". The handshake never refreshes a session.
- **Errors**: Better Auth's answers become the app's codes, never its sentences: 404
  `not_found`, 401 `unauthenticated`, 403 and a guest's second anonymous sign-in
  `not_allowed`, 429 `rate_limited` (with `Retry-After`), any other 4xx `bad_payload`,
  5xx `internal`. A database failure while reading a session is a 500, never "no
  session", so an outage cannot hand out a new guest identity.
- **W5**: Google and Microsoft Entra ID. Better Auth's anonymous plugin, on a social
  sign-in, calls `onLinkAccount({ anonymousUser, newUser })` and then deletes the guest:
  the user id changes. To keep the id, rooms and PO ownership, either link the provider
  to the guest row (`linkSocial`, then clear `is_anonymous`), or move what the guest owns
  in `onLinkAccount` (room `owner_user_id`, `live.ownerId`, participants, history), and
  set `disableDeleteAnonymousUser` until that move is proven. Provider names must go
  through `cleanName` too.

## 8. Rooms, access and security

- Room code: 10 characters of base58 (no 0, O, I or l) from `crypto.randomBytes`, about
  58.6 bits, drawn by rejection sampling (bytes from 232 up are dropped, so no character
  is favoured). URL `/r/:code`. The `code` column is unique: on a clash the server draws
  again, up to 5 times, then answers `internal`. A code is a bearer capability, so it
  never reaches a log line, an error message, Sentry or Umami (section 11).
- Room API: `POST /api/rooms` (a session, this origin, a JSON body `{ name?, deck? }`,
  strict, `deck` a preset id, Fibonacci by default) answers 201 `{ code }`; the creator
  is the PO. `GET /api/rooms/:code` answers `{ code, name }` to anyone holding the code,
  never the room's state, or 404 `{ code: "room_not_found", retentionDays }` (a
  malformed code is not looked up; `retentionDays` is `ROOM_TTL_DAYS`, so the not-found
  page can say how long an idle room is kept). The shape of a code (`isRoomCode`,
  `ROOM_CODE_PATTERN`) lives in `@pp/domain`, shared by the server and the web app's
  "Join with a code".
  Both are limited per client address: 20 creations in 10 minutes, 120 header reads a
  minute, the read counted before its database query.
  Errors are `{ code }` with an `AckErrorCode`: `unauthenticated` 401, `not_allowed`
  403, `bad_payload` 400 (a body that does not parse), 413 (over 16 KB) or 415 (not
  JSON), `bad_room_name` 400, `rate_limited` 429, `internal` 500.
- Password (optional, #31). The PO sets, changes or removes it over HTTP, never over
  the socket, so a password never enters the command pipeline, its idempotency cache or
  a log line: `PUT /api/rooms/:code/password { password }` and `DELETE
  /api/rooms/:code/password` (the PO only, `not_allowed` 403, checked before any hash;
  this origin; JSON; `no-store`; 30 changes per PO in 10 minutes). A password is 6 to 128
  characters (code points) after NFC normalisation, any text, never trimmed; otherwise
  `bad_password` 400. The change runs through the room's command runner as the
  server-only `password` command (`{ on }`, the PO's alone), so it is ordered with the
  round's commands, and the runner's commit writes `live.hasPassword`, `password_hash`
  and the grants in one transaction (`AccessWrite` in `db/rooms.ts`). The snapshot's
  settings carry `hasPassword` (optional, protocol 4 kept) and `settingsUpdated` its
  `password` (`set`, `changed`, `removed`); `GET /api/rooms/:code` adds
  `hasPassword`.
  - **Hashing**: Node's own `crypto.argon2` (24.7 and later, so `engines` and the Node
    check ask for 24.7), argon2id with OWASP's parameters (19 MiB, t = 2, p = 1, a 16-byte
    random salt, a 32-byte tag), stored as a PHC string with its parameters. A check
    derives the key again with the stored salt and parameters and compares with
    `timingSafeEqual`. About 25 to 35 ms per hash or check. Only the parameters above
    are accepted: a stored hash with others (a cost of gigabytes, or a cheap one) is
    corrupt, logged by room id and refused (`internal`) before any work. At most 2 run
    at once (19 MiB each, on libuv's 4 threads); the next ones wait in line, first come
    first served, at most 32 of them and each at most 2 s; past that, 503 `busy`. Sixteen
    right passwords sent at once all pass, in about 250 ms.
  - **Access is a grant keyed by the session's user**, in `room_access`, not a cookie per
    room (amended from the original plan): the guest session cookie (#10) is already
    signed, httpOnly and per device, so "once per device" holds without another cookie;
    a cookie per room would grow every request's headers with each room visited, and it
    could not be revoked for one person. With accounts (W5) the grant follows the account,
    so "once per account". Who enters a room with a password: a participant, the PO
    (`live.ownerId`, even after leaving), or a user with a grant; anyone else's `enter`
    (and `join`) answers `password_required`, and a socket in the room's channel that
    has not passed this gate gets no snapshot of it. A correct password grants that user;
    setting a password grants everyone in the room then (and the PO), so people already
    in the room stay; changing it drops every grant and grants everyone in the room again;
    removing it drops them all; a kick (#30) drops the removed person's grant in the
    kick's own commit, so they must type it again. When it is set or changed, the sockets
    of anyone else on this instance (someone on the join form) hear `locked` and leave
    the room; their page enters again and is asked for the password.
  - **Checking**: `POST /api/rooms/:code/access { password }` answers 204 and grants
    the caller, or 403 `{ code: "wrong_password" }`. The PO, a participant and a grant
    holder get 204 at once, whatever the password, with no hash run. A password outside
    the bounds is `wrong_password` at once, neither checked nor counted: it cannot be
    right. The grant is written only while the room still holds the hash the password was
    checked against (one statement that reads the room's row `for share`, so a change in
    progress commits first); a change that won the race answers `wrong_password`, not
    counted, so a grant never outlives the password it was given for. On the socket, an
    `enter` that read a grant before a lockout of that room ran on this instance is
    refused with `password_required`. A `join` by someone neither in the room nor its PO,
    while it has a password, commits only with their grant: the commit's transaction
    checks `room_access` after its compare-and-set took the room's row, so a kick or a new
    password that dropped the grant has committed first, on any instance; a miss writes
    nothing, answers `password_required`, and the socket leaves the room.
  - **Limits** (`PASSWORD_LIMITS`, each in 10 minutes): 10 wrong passwords per person
    (session user) and room, in the process, so one person's typos never lock out a team
    that shares an address; 25 wrong passwords per address and room, in the process, so
    one address with a handful of guest sessions cannot spend the room's 50 alone; 50
    wrong passwords per room whatever the people or addresses,
    in the database (`room.password_failures`, a fixed window updated atomically), so
    every instance shares it: the cap on a brute force (about 7,200 tries a day per room,
    hence 6 characters at least); and 300 checks per address, right, wrong or for a room
    that does not exist, in the process: the CPU one client can burn, and how many codes
    it can test (a 204 or 404 tells whether a room exists). Each try is reserved before
    the check and released when the password was right, so tries sent at once are
    counted exactly and a right password costs nothing. Past a limit: `rate_limited` 429
    with `Retry-After`, the right password included. There is no limit per address across
    rooms: room codes are 58-bit secrets, and behind a shared address it would let one
    client lock every password room on the instance.
  - **Behind proxies the app is not told about** (`TRUST_PROXY` too low; Sven's instance
    needs `TRUST_PROXY=2`, an owner item in STATUS), every client shares one address, so
    every per-address limit applies to everyone at once: the 300 checks in 10 minutes
    are the whole instance's (300 requests, even without a session, lock everyone out of
    password checks for 10 minutes), the 25 wrong tries per room are every client's
    together, and the identity limits below too. The per-person
    and per-room limits are as meant whatever the proxies.
  - Logs name the room by its id ("room password changed", "room access granted",
    "wrong room password"); never the password, the hash, the code or the address.
- Limits: names 32 characters, room names 60, subjects 200, custom cards 4 characters
  × 20, payloads 16 KB.
- Text (names, round titles, room names: the domain's `cleanText`): control characters,
  bidi controls and default-ignorable code points are refused (zero-width space, soft
  hyphen, LRM, Hangul fillers, U+FEFF …), except ZWJ, ZWNJ and VS16, and tag characters
  inside an emoji flag. Text that is blank once cleaned (whitespace, format characters,
  the braille blank, combining marks without a base) is refused, and so is a character
  with more than 3 combining marks in a row (ZWJ, ZWNJ and VS16 between them do not
  break the row): Vietnamese, Thai and Hindi stack up to 3, "Zalgo" text paints over the
  lines around it. Nothing is stripped silently (`bad_name`, `bad_subject`,
  `bad_room_name`). The web app renders
  every user-provided name inside `<bdi>` (W1), so a right-to-left name cannot reorder
  the text around it. HTTP rate limits on room creation, join and password; per-socket command rate
  limit.
- Client address for every rate limit: `clientIp(request, TRUST_PROXY)`, the entry
  `TRUST_PROXY` places from the right of `X-Forwarded-For` (each proxy appends the
  address it received the request from), else the socket address. Never logged. The
  address is turned into a key: an IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is the
  IPv4 address, any other IPv6 address its /64 network (`2001:db8:0:1::`), because a client
  on a /64 can take a new address for every request; a zone id is dropped.
- Identity limits (Better Auth's limiter, keyed on that same address, which the server
  passes in a header of its own after dropping any client copy): anonymous sign-in 60 per
  address and minute, so a team of 30 behind one office address joins at once; every
  other auth endpoint 100 per 10 s; display name changes 10 per user and 60 per address
  a minute; room creation 20 per address in 10 minutes, so an office behind one
  address creates rooms freely while a loop gets two a minute; room header reads 120 per
  address and minute. Answer: 429
  `rate_limited` with `Retry-After`. The counters live in the process (per instance
  with #39), at most 50,000 at once: expired ones are swept every 30 s, and when full the
  oldest tenth goes.
- Headers: strict CSP (no inline scripts), HSTS, `X-Content-Type-Options`,
  `Referrer-Policy`. Subject links are rendered with `rel="noopener noreferrer"`,
  `target="_blank"` and only `http(s)` schemes: the web makes an `<a>` only of a link
  the domain's `cleanSubject` accepts (no other scheme, no credentials), so even an odd
  stored subject never becomes a `javascript:` link (#21).
- History (#33): a room's finished rounds go only to someone in it (a voter, an
  observer or the PO), checked on a fresh load at every `history` request (section 5).
  Holding the code, or a password grant without joining, is not enough. No row carries a
  user id; an anonymous round's carries no name either.
- Retention: rooms, their history and orphan guests are deleted after
  `ROOM_TTL_DAYS` (default 90) without activity. A guest's session expires after the
  same number of days without a visit.

## 9. Timers and presence

- Timer: `deadlineAt` in the round. Snapshots carry `serverNow`; clients compute their
  clock offset and count down locally. The server also sets a timeout for the room's
  deadline (one per room per instance with sockets in it, section 5); whichever fires
  first (timeout, `timeUp` ping, any command) reveals once.
- Clock offset (#27, `apps/web/src/realtime/server-clock.ts`): each snapshot is one sample,
  `serverNow + roundTrip / 2 − arrival` in the page's own clock, where the round trip is
  the last `enter`'s (sent to its snapshot back). The offset is the median of the last 9
  samples, so one late packet does not move the ring; time left is `deadlineAt −
  (localNow() + offset)`, never below 0, where `localNow()` is the page's monotonic clock
  (`performance.timeOrigin + performance.now()`), not `Date.now()`: a step of the wall
  clock moves nothing. A browser may pause that clock while the computer sleeps, which
  raises every later sample by the time asleep: a sample more than 1 s above the median
  starts the window over from it. A sample far below it is a snapshot that arrived late,
  and the median outvotes it. `serverTime()`, `onClockOffset` and `useClockOffset` are
  what any other page part that compares a server timestamp with now reads. At 0:00 the
  page waits for the server and never reveals. Three pages with clocks at −5 s, 0 and +5 s agree within
  about 15 ms locally (`e2e/timer.spec.ts`, AC 1 asks 0.5 s). The ring drains over
  `deadlineAt − timerStartedAt`; a round from a server that sends no start (before #27)
  drains over the time left when the page first saw it.
- The client ping (#27): each page sends `timeUp` once per deadline, 1 s plus a random
  0 to 1 s after its estimate of the deadline, if the round it shows still votes with that
  deadline. Normally the server's timeout got there first and nothing is sent. A `timeUp`
  that finds nothing to do returns the loaded state, so the runner writes nothing, bumps no
  version and broadcasts nothing (`room-sync.db.test.ts`: with the timeout off through the
  test-only `deadlineTimeouts: false`, four pings give one reveal and one write).
- No arming at start-up (#27 decision): after a restart a room's deadline is armed again
  by the first socket that enters it (`armDeadline` on enter), not by a scan of every room
  at boot. The stored result is the same whoever resolves the deadline, since `apply`
  stamps a timer reveal with `revealedAt = deadlineAt` (or keeps `timeUpAt = deadlineAt`);
  a room nobody is in has nobody to show the reveal to, which is already the case for a
  room whose last socket left mid-countdown; and a boot scan would make every instance
  (#39) fire for every room. The clients reconnect within seconds, so the reveal still
  comes at the deadline (`apps/server/src/sync/restart.db.test.ts`, AC 3).
- Presence (#17, `apps/server/src/sync/room-sync.ts` and `sync/presence.ts`): a person
  is connected while at least one of their sockets has entered the room on this
  instance. When the last one leaves (closed, another room entered, session gone), a
  grace timer of 15 s (`PRESENCE_GRACE_MS`) starts for that person and room; a socket of
  theirs that enters again cancels it, so reloads and network blips change nothing and
  store nothing. When it fires, the server runs `presence { who, connected: false }`
  through the runner and broadcasts. Every entering socket of a participant runs the
  back step, which sends `presence { who, connected: true }` when the stored state shows
  them away and stores nothing otherwise: the enter's own load may have read the room
  before an away run committed, so it never decides alone. Each run decides at its turn
  in the room's queue, from the stored state and the sockets actually there, so a return
  during a run is not lost. An away run that fails (database error, lost
  compare-and-set) starts the grace again, at most 3 times in a row. PO claim opens
  after 120 s away (#30): the snapshot's `ownerClaimableAt` says when, and the server
  needs no timer for it, since nothing changes in the room at that moment.
- After a restart the timers are gone: the first socket of a room on an instance starts
  a grace for everyone the room shows as connected who has no socket there. That grace
  is 60 s (`PRESENCE_RESTART_GRACE_MS`, a PO decision of 2026-10-27), not 15 s: every
  client reconnects at once and some take longer than a reload, and a person marked
  away while the others voted would reveal the round without them. A normal disconnect
  keeps 15 s. A room's timers are dropped when its last socket leaves the instance, and
  all of them on shutdown; the people still shown connected then get their grace from
  the next first socket.
- Two instances (#39): the password's `locked` (#31) reaches the sockets on the
  instance that ran the change only; a viewer on the other one keeps watching until their
  next `enter` or `join`, which the database's grants refuse. Each judges presence from
  its own sockets only, so a person whose
  sockets sit on the other instance can be marked away by this one's first-socket timers,
  until they enter again. Likewise a removal (#30) sends `kicked` and closes the sockets
  on the instance that ran the `kick` only: a removed person whose socket sits on the
  other one sees the room without them but keeps that socket. The adapter in #39 must
  share presence and the kick (or route a room's sockets to one instance) before the app
  runs on two.

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

- pino JSON logs on stdout (request id, connection id, room id, no secrets, no vote
  values). A room code is a bearer capability: anyone holding it enters a room that has
  no password. Treat it like a session token: never in a log line, an error message, a
  page title, Sentry or Umami; logs name a room by its id. The request log writes the matched route
  (`/r/:code`); for a path that matched only the web app's fallback or the 404 it
  writes a normalised path (decoded, `//` collapsed, case ignored) with the segment
  after `/r` or `/api/rooms` and every code-shaped segment replaced by `:code`.
  Every later issue follows the rule. Each HTTP request gets an id (an incoming `x-request-id` is kept when it is at
  most 64 safe characters) echoed in `x-request-id`; each socket gets a random connection
  id. Never logged: bodies, cookies, session tokens, the signing secret, room passwords
  and their hashes, auth headers,
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
| `BETTER_AUTH_SECRET` | yes | signs the session cookies; at least 32 random characters (`openssl rand -base64 32`; the old `.env.example` placeholder and one repeated character are refused); never logged; changing it signs everybody out |
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
| End-to-end | Playwright, several browser contexts | full rounds; secrecy asserted on WebSocket frames; `four-person.spec.ts` (#23) plays W1 end to end on every PR |
| Visual | Playwright screenshots | table with 1–16 seats, both themes, 360 px to 1440 px |
| Accessibility | axe in Playwright + manual screen reader passes | room, settings, history |

`pnpm gate` = lint + typecheck + unit + build, and is what CI runs first.

## 14. Budgets

- Initial JavaScript under 200 KB gzipped for the room route and for the landing page
  (`apps/web/scripts/check-budget.ts` checks both after every build).
- Command to snapshot under 150 ms p95 on one instance.
- Reveal with 16 seats at 60 fps on a mid-range phone.
