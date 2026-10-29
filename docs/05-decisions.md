# Decisions

Architecture decision records. All accepted on 2026-10-26 in round 1, after Sven
reviewed the options in the round-1 decisions page (`docs/prototype/round-1-decisions.html`).
To change one, add a new ADR that supersedes it; do not rewrite history.

## ADR-001: Containers only

**Context.** `input.md` asks for deployment on Vercel, Coolify or Azure. Coolify and
Azure keep a container alive for days. Vercel Functions accept WebSockets only since
22 June 2026 (public beta): each socket is pinned to one instance and closed after
300 s (Hobby) or 800 s (Pro), so rooms need Redis for fan-out and clients must
reconnect regularly. Nobody needs Vercel today.

**Decision.** Ship one Docker image for Coolify, Azure and any Docker host. Drop Vercel.

**Consequences.** One process, in-memory fan-out, no Redis by default. Socket.IO's
long-polling fallback works. Because state lives in Postgres with a version (ADR-004),
scale-out or serverless can come back later behind `REDIS_URL` (#39).

**Alternatives.** Container plus Vercel through adapters (recommended in round 1,
rejected as unneeded); serverless first; split frontend and backend hosting.

## ADR-002: Custom TypeScript backend

**Context.** The hard parts of planning poker are hidden votes, reveal rules, timers
and the PO's powers, which need server logic. `input.md` suggested PocketBase.

**Decision.** Our own server: Hono (HTTP), Socket.IO (realtime), Drizzle (Postgres),
Better Auth (identity). Room logic is a pure state machine in `packages/domain`.

**Consequences.** One language end to end; rules tested in one place. We wire auth
and the protocol ourselves. **Alternatives.** PocketBase (pre-1.0 in 2026; rules would
become API rules and JS hooks; SQLite locking on Azure Files); Convex or Supabase
(lock-in, heavy self-hosting).

## ADR-003: Socket.IO for realtime

**Decision.** Socket.IO with typed event maps and zod validation. Commands are
acknowledged; the server answers every change with a per-viewer snapshot (see the
architecture, section 5).

**Why.** Rooms, acknowledgements and reconnect come built in, and the HTTP
long-polling fallback survives corporate proxies that break WebSockets.
**Alternatives.** Plain `ws` (rebuild rooms, reconnect, fan-out); SSE plus POST.

## ADR-004: Postgres for everything, live state included

**Decision.** PostgreSQL via Drizzle. The live room is a JSON column with a version;
every command is a compare-and-set. History rows in their own table.

**Consequences.** A redeploy mid-round loses nothing; several instances stay correct;
a database is needed even for tiny installs (compose ships one). **Alternatives.**
SQLite by default (locks on Azure Files); both dialects (two migration sets).

## ADR-005: The boardroom table

**Decision.** A calm table in the middle with up to 16 seats, the hand along the
bottom, staggered flips on reveal, results under the table; tall table and scrolling
hand on phones. Spruce table, warm card faces, brass card backs. Details:
`docs/03-design-brief.md`. **Alternatives.** Focus grid (less presence); poker felt
(reads as a game, hard to brand).

## ADR-006: React 19 and Vite, as a single-page app

**Decision.** A React SPA built by Vite, served by our server. TanStack Router,
Zustand for the room store.

**Why.** Live rooms gain nothing from server rendering, and Next.js would need a
custom server for sockets. **Alternatives.** Next.js; SvelteKit.

## ADR-007: Tailwind CSS v4, shadcn/ui and design tokens

**Decision.** Tailwind v4 with every colour a CSS variable; accessible primitives from
shadcn/ui (Radix) copied into the repo. Dark mode and branding are token overrides.
**Alternatives.** CSS Modules with Radix; Mantine.

## ADR-008: Motion for React

**Decision.** Motion (motion.dev) for springs, layout travel (hand to seat), enter
and exit, gestures; CSS 3D for the flip. The motion spec in the design brief bounds it.
**Alternatives.** GSAP (imperative, own licence); CSS and WAAPI only (more code).

**Amended (#18, 2026-10-27).** The card's travel from the hand to the seat uses the Web
Animations API (`Element.animate`), not Motion. Importing the shell's `motion.tsx` (or
Motion's `m`) from the room's lazy chunk made Vite 8's rolldown split shared modules out
of the entry chunk: +12.8 kB gzipped on the room route. The trip is pure keyframes and
needs none of Motion's features. Two measured splits keep Motion within budget: one lazy
boundary for the room's Motion components (room route 167.6 kB), or a dynamic
`import("motion/mini")` inside the effect (3.2 kB lazy). #19's flip and #20's columns
may use either, or the Web Animations API; whichever they pick, the budget check decides.

## ADR-009: Guest-first identity with Better Auth

**Decision.** Every visitor gets an anonymous Better Auth session: a real user row
without personal data. In W5, Google and Microsoft Entra ID sign-in link the guest so
rooms, PO ownership and history carry over.

**Consequences.** One identity model from day one; no migration when accounts land.
Entra linking needs a test (OQ-6). **Alternatives.** A cookie token now and auth later
(two models); hosted identity (external dependency, per-user pricing).

## ADR-010: Room access and roles

**Decision.** A random 10-character code in the URL; an optional password (argon2id,
rate-limited). Roles: product owner, voter, observer. The PO can hand over the role;
when the PO has been away for 2 minutes, anyone in the room can claim it. W5 adds
restricting a room to an email domain or Microsoft tenant.

## ADR-011: Room defaults

**Decision.** New rooms start with: Fibonacci deck; `?` and `☕` cards (`∞` off); PO
only reveals; named results; **reveal when everyone has voted: on**; timer off with
reveal at its end on; no vote changes after reveal; the PO votes; observers count
toward the 16. The PO can change each setting in the room. A round's subject is
optional: nothing, a title, or a link (Jira and Azure DevOps keys detected).
Changing a vote after reveal, when allowed, applies to named rounds only: an anonymous
round locks its votes at reveal (review of #68), and the W2 settings UI says so.

**Amended 2026-10-28 (#28 review).** Switching anonymity never re-projects the round on
the table: it applies from the next round, since names already seen cannot be hidden and
an anonymous round must never gain names. This overrides #28's scope line "switching the
mode after reveal re-projects for everyone". Anonymity hides who played which card, not
who played: the seats say who voted, so one card, or cards that all agree, still tell
whose they are. Under "anyone who votes" a voter may therefore reveal an anonymous round
only once two cards are down (the domain refuses an earlier one with `too_few_cards`).
The PO keeps the reveal at any count, as the facilitator, so a room with one voter still
moves on; the timer's and the automatic reveal are unchanged.

## ADR-012: English, French and German at launch

**Decision.** Every user-facing string exists in `en`, `fr` and `de` from the first
UI issue. react-i18next with typed keys; CI fails on a missing key; the server sends
codes, never sentences. Tone per language decided in #41 (OQ-2).

**Consequences.** Every UI issue carries its French and German copy.
**Alternatives.** English only, translation-ready (recommended in round 1); English and French.

**Amended 2026-10-27 (#9 review).** Our own typed `t()` replaces i18next and
react-i18next. Measured on the room route, gzipped: i18next costs 13.7 kB and is
monolithic (its backends, saveMissing and nesting ship unused), react-i18next 2.9 kB and
its use-sync-external-store shim 0.5 kB. With i18next the route built at 156.0 kB; with
about 70 lines of `t()` on `Intl.PluralRules` behind the same API (`useT`, `useLanguage`,
`useFormat`, `fixedT`, `changeLanguage`, `loadLanguage`, `errorMessage`) it builds at
141.4 kB, and W1's socket.io-client will add 13.1 kB against the 200 kB budget. Keys and
each key's placeholders stay checked by `tsc` (template-literal types); React 19's
`useSyncExternalStore` re-renders on a language change. The catalogs keep i18next's JSON
v4 syntax (`{{x}}`, `{{x, number}}`, `_one`/`_other`/`_many` keys), so translation
platforms (Weblate, Crowdin) read them and a switch back stays cheap. Numbers and dates
follow the reader's region: the first `navigator.languages` tag in the UI language
(`de-CH` writes 6.5 and 1’234), else the bare language (French and German write 5,5).

## ADR-013: pnpm monorepo and the serial issue loop

**Decision.** `apps/web`, `apps/server`, `packages/domain`, `packages/protocol`;
TypeScript strict, Biome, Vitest, Playwright, Node 24 LTS, Docker multi-stage image,
GitHub Actions on pull requests. Work follows `CLAUDE.md`: one issue at a time,
issues keyed `PP-NNN` with `epic:*`, `P0–P3`, `type:*` and `size:*` labels, one
milestone per wave. **Alternatives.** A single package.

## ADR-014: Retention of 90 idle days

**Decision.** Rooms, their history and orphan guest users are deleted after 90 days
without activity (`ROOM_TTL_DAYS`). Rooms owned by signed-in users stay until deleted
(W5). No analytics or tracking by default; Sentry and Umami are opt-in.

## ADR-015: Paid branding decided in W7

**Context.** The repo is MIT; under MIT anyone can remove a paywall from the code.

**Decision.** Everything stays MIT until W7. Branding is built as theme tokens,
asset slots and an entitlements check, so either open core (commercial `ee/` folder
and signed licence keys) or a paid hosted edition plugs in. Decided in #56 (OQ-3).

## ADR-016: Several instances through Redis, signals only (2026-10-29, #39)

**Context.** ADR-001 ships one container and leaves scale-out for `REDIS_URL`. Every
instance sends its own sockets per-viewer snapshots, and room state lives in Postgres with
a compare-and-set (ADR-004), so instances only need to hear of each other's changes.

**Decision.** Off by default. With `REDIS_URL`: Socket.IO's Redis adapter on
`@redis/client` (node-redis, the client Redis maintains, TypeScript native, no ioredis
dependency tree; the core package without the module packages), loaded only then.
Instances exchange signals, never state: a change sends the room's id, its version and
the causes; an instance with sockets in the room loads it from Postgres and builds each
viewer's snapshot, so no card and no room code crosses Redis. Presence asks the other
instances before marking anyone away; command ids are claimed in Redis so a resend to
another instance runs once; retention asks every instance which rooms are in use. Sockets
use WebSocket only, so no sticky sessions are needed; the server tells the web app with a
`<meta>` in `index.html` (the CSP forbids inline script). Rate limits and the socket cap
stay per instance (documented in architecture section 8).

**Consequences.** Without Redis nothing changes, not even the transports. With it, one
Postgres read per instance and change, a few milliseconds of fan-out, no long-polling
fallback (sticky sessions would bring it back, as a later option), and Redis must be up
for cross-instance correctness (each instance degrades to serving its own sockets, and
never stops for it once started). Redis is trusted: the adapter answers any Redis
client's FETCH_SOCKETS with every socket's handshake (session cookie included) and room
code, and obeys anyone's BROADCAST or REMOTE_DISCONNECT, so it must be reachable by the
instances only, with a password, and TLS off a private network; "no room code crosses
Redis" holds for the app's own messages. Signals are lossy pub/sub, so an instance sends
each version after the signals of the versions before it (waiting 100 ms at most) and
reads every visitor's grant again when one is missing in a room with a password.
**Alternatives.** Sending the state (or each viewer's snapshot) through Redis (no extra
read, but cards in Redis); sticky sessions with polling (a balancer setting every
self-hoster must get right); Postgres `LISTEN/NOTIFY` (no new service, but no request and
answer between instances, and one more long-lived connection per instance on the pool).
