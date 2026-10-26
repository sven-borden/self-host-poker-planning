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
   └─ packages/domain: apply(state, command, now)
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
  specials: Array<"?" | "☕" | "∞">;                 // default ["?", "☕"]
  whoCanReveal: "po" | "anyone";                     // default "po"
  revealNames: boolean;                              // default true (false = anonymous)
  revealWhenAllVoted: boolean;                       // default true
  timer: { seconds: number | null; revealAtEnd: boolean }; // default { null, true }
  allowChangeAfterReveal: boolean;                   // default false
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
  subject: { kind: "none" } | { kind: "title"; text: string }
         | { kind: "link"; url: string; key?: string };  // key: "ABC-123" or ADO work item id
  phase: "voting" | "revealed";
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

## 4. The round state machine

`apply(state, command, ctx) → { state, cause } | { error }` in `packages/domain`,
where `ctx = { actor: UserId, now: number }`. Pure, synchronous, exhaustively tested.

States: **Lobby** (`round === null`) → **Voting** → **Revealed** → next round →
**Voting**. A finished round is written to history when the next round starts, when
the final estimate is set, or when the room goes idle.

| Command | Who | Rule |
|---|---|---|
| `join {name, role}` | anyone admitted | refuses when the room is full (16; observers count if the setting says so) |
| `leave`, `rename {name}`, `setRole {role}` | self | — |
| `startRound {subject}` | PO | from Lobby or Revealed; clears votes |
| `castVote {card}` / `retractVote` | voter | card must be in the deck; in Revealed only if `allowChangeAfterReveal` (marks `changedAfterReveal`) |
| `reveal` | PO, or anyone if `whoCanReveal = "anyone"` | Voting → Revealed |
| (auto) everyone voted | server | after `castVote`, if `revealWhenAllVoted` and every voter (and the PO if `poVotes`) voted |
| `startTimer {seconds}` / `stopTimer` / `extendTimer` | PO | sets or clears `deadlineAt` |
| `timeUp` | anyone | no-op unless `now ≥ deadlineAt`; then reveal if `timer.revealAtEnd` |
| `setFinal {card}` / `revote` | PO | Revealed only; `revote` restarts the same subject |
| `updateSettings {patch}` | PO | validated; a deck change during Voting restarts the round |
| `transferOwner {to}` | PO | target must be present |
| `claimOwner` | any participant | only when the PO has been away for 120 s |
| `kick {who}` | PO | not self |

Lazy deadlines: before applying any command, `apply` first resolves an elapsed
deadline. So a reveal at the deadline happens exactly once, whoever arrives first.

## 5. Sync protocol

Socket.IO with typed event maps from `packages/protocol`; every payload is validated
with zod on both ends.

- **Commands** (client → server): `cmd { id, type, payload }`, acknowledged with
  `{ ok: true, version } | { ok: false, code }`. Codes are stable strings
  (`room_full`, `not_owner`, `bad_card`, `rate_limited`, …) that the web app translates.
- **Snapshots** (server → client): after every change the server sends each socket
  its own projection: `snapshot { protocol, version, serverNow, room, cause }`.
  Rooms are small (≤ 16 people), so a full snapshot is a few kilobytes; there is no
  event replay and no gap handling. Clients drop any snapshot older than the one they hold.
- `cause` (for example `{ type: "voteCast", who }`) drives animations and screen
  reader announcements; it never carries a hidden value.
- **Projection rules** (`toSnapshot(state, viewer)`):
  - Voting: `voted: UserId[]`; the viewer's own card only for the viewer.
  - Revealed, named: `votes: { who, card, changedAfterReveal }[]`.
  - Revealed, anonymous: `cards: Card[]` sorted by deck order plus `voted: UserId[]`;
    no mapping between the two, ever.
  - Never: password hashes, session data, other people's private fields.
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
the saved choice, then the browser. `Intl` for numbers and dates. CI fails when a key
is missing in any catalog. The server sends codes, never sentences.

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
