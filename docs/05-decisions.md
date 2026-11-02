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

**Amended (#43, 2026-11-01).** The whole motion spec runs on CSS and the Web Animations API:
no component uses Motion's `m`. See ADR-019 for how a reveal is drawn.

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

## ADR-018: Avatars printed on the person's colour, moving one at a time (2026-11-01, #42)

**Context.** W4 adds 24 small animated avatars, picked by choice and optional. The room
route has 22.6 kB of its 200 kB budget left with four more delight issues to come. Colours
already tell people apart at the table (#17), the CSP forbids inline styles and scripts,
and #27 found that an animation running on every frame restyles the page for good.

**Decision.** Each drawing is a list of paths in a TypeScript module, in a lazy chunk,
rendered inline: tones are classes on the token palette (card face, card ink, card edge,
brass), so themes, the away state and a brand reach them, and no `dangerouslySetInnerHTML`
is needed. The disc stays the person's colour; only the face on it changes, and a drawing
counts as a face in `avatarLooks`. An avatar shows initials until the chunk arrives, and
for an id it does not know. The domain lists the ids, so only those reach `live` or
`user.avatar`; a change goes through `apply` (`setAvatar`), and the user row is a nullable
column read back with the session. The picker is native radios with a save step, so the
arrow keys send nothing. Idle life is one gesture at a time, from one timer shared by every
avatar on the page, through `Element.animate`: nothing runs between gestures, reduced
motion and a hidden tab skip them.

**Consequences.** All 24 weigh 21 kB as markup, under the issue's 60 KB (a test measures
it), and a room where nobody picks one never loads them. There may be a short moment of
initials on first load. Sixteen people share one blink or bob every couple of seconds
instead of each moving on their own, which suits a calm table and costs no frames. A
drawing may repeat at a table in another colour; past eight, initials take over. Forced
colours keep the drawing as drawn. **Alternatives.** Full-colour animals (no room for the
person's colour, and each would need tuning on eight discs); `.svg` files through `<img>`
or a sprite (no tokens, no away tone, a page cannot pause an image's animations, and the
policy applies to their inline styles); a CSS loop per avatar (a restyle on every frame for
16 seats, in a tab left open all day); applying a pick on each arrow press (a command per
key).

## ADR-017: Opt-in observability that never sees a room (2026-10-29, #40)

**Context.** ADR-014 promises no tracking by default; Sentry and Umami are opt-in. A
room code is a bearer capability (architecture section 11), and both tools collect
addresses by default: Umami the page's URL and referrer, Sentry the request URL,
breadcrumbs of navigations and fetches, and the user's IP. One image serves every
self-hoster, so the switches are runtime variables, not build flags.

**Decision.** Each service is off unless its variables are set, and then nothing of it
loads: no tag in the page, no origin in the policy, no module on the server. The server
puts what the page needs in `index.html` (a `<meta>` with the DSN, Umami's tracker as an
`async` script), as #39 does for the transport; the policy gains exactly their origins.
Umami's automatic tracking is off; the web app sends each view itself, named by route
(`/r/:code`), with another site's origin as the only referrer. In the page Sentry is a lazy
chunk with three integrations (global handlers, linked errors, dedupe), every collection
in Sentry 11's `dataCollection` off, the request rewritten to the route and the browser,
and every string masked (`hideRoomCodesIn`). On the server a report is a log line at
`error` or `fatal`, as pino wrote it: what the log may hold (tested never to hold a code
or a secret) is what Sentry gets, through `@sentry/core` and its `ServerRuntimeClient`.
`@sentry/node` 11 pulls OpenTelemetry, bundler plugins and a native parser (about 30 MB
in the image) for tracing the app does not do.

**Consequences.** Umami shows pages and countries, not rooms. Sentry's server reports
carry the log's fields and the stack of the logged error (a cause stays in the message, as
in the log), not locals or request data. A Sentry outage never touches a request or the
log; an exit waits up to a second for reports in flight. The page's reports start once
the chunk has loaded (a few errors wait for it). Pinned SDKs at least two weeks old.
**Alternatives.** `@sentry/node` (size, and it instruments every request with its URL);
a hand-written envelope sender (no SDK to follow, but our own stack parsers for every
browser); Umami's `data-before-send` hook (a global function name, so a global the page
must expose before the tracker runs).

## ADR-019: A reveal draws in steps, and a commit reads no layout (2026-11-01, #43)

**Context.** #43 asks for no long task of 50 ms or more during a 16-seat reveal on a
mid-range phone. Measured on a Pixel 7 profile at 4x CPU, the last vote's reveal ran 253 and
137 ms. The flips were never the cost, since they are composited: the time went to a layout
forced per card label inside the commit, between the flips' `animate()` calls (187 ms); to
inherited custom properties on `:root`, which restyle every element; and to one commit that
mounted the table's new state, the PO's decision and the results at once.

**Decision.** Three rules. A commit on the table's side does not read layout: a measure
that can wait takes a ResizeObserver's first delivery, which comes after the frame's layout
(`CardValue`). Nothing changes an inherited custom property on the root for a value
only the root needs: the docks set `scroll-padding-bottom` themselves
(`keepScrollPadding`). What lies under the table draws a step behind it: `UnderTable` in
`seated.tsx` gives the decision a deferred copy of the room (`useDeferredValue`), and the
results one step later (a transition after that commit); the hand panel's disabled cards,
dock and hint follow in the first deferred render, as do the seats' labels and badges
(`SeatList`, unless someone joins or leaves); the hand is memoised so a commit that does
not change it skips its labels, and the stage has `contain: layout`, so what changes on it
relays out nothing else. `focusSoon` looks for its target for up to 30
frames, so the PO's focus lands on "Record" when it arrives.
`reveal-performance.spec.ts` holds the line at a speed set from a benchmark, so a slower CI
runner tests the same phone, and it runs alone after the other specs, on a quiet machine,
with three tries.

**Consequences.** The table answers first, and React can pause the rest for the page. The
decision and the results arrive a few frames after the first flip, which nobody can see:
the first flip takes 650 ms, and what follows it is timed from the settled cards. A press
in the instant before the hand turns off goes to the server, which refuses it as any late
press. For one frame a label that does not fit can overflow its card. The decision still
measures its dock in its own commit, a step behind the flips: the focus that lands on it
must find it docked, or it scrolls the page. The table and what lies under it can differ
for those frames, so nothing under the table may be read to decide what the table shows.
The budget is near: a slot or a results row that adds work will fail the spec. **Alternatives.** Moving
everything into a transition (commits are not interruptible, so the frame stays long, and
the store's `useSyncExternalStore` opts out); `content-visibility` on the panels (does not
reach the commit, and the page's height jumps); a smaller results panel on phones (removes
what the team came for).

## ADR-020: Sound effects synthesised in the page, off by default

**Decision.** Five sounds (a card placed, a flip, the reveal, a consensus, the timer's last
seconds) as data (`sound/sound-recipes.ts`), played with oscillators and a short noise
buffer through the Web Audio API. Off until a person turns them on; on or off and the
volume stay on the device (`pp-sound`), not on the user or the room.

**The gesture.** The `AudioContext` is made in a gesture's handler, never at load: the
switch, or after a reload the first click or key. `play` drops a sound unless the context
runs, so nothing queues up for the first click and a reveal missed before it stays missed.
The button says so meanwhile. `Permissions-Policy: autoplay=()` stays: it blocks audio
without a gesture, and Chromium lets a context start after one (checked under the
production headers, `e2e/sound.spec.ts`).

**What a sound follows.** The live region's news (`liveEvents`), so a sound obeys the rules a
sentence does: a changed card before the reveal is not news, and no sound depends on a
value before the reveal. The viewer's own card comes from `yourVote`. Each cue lands on
what the eye sees; under reduced motion nothing turns, so there are no flicks.

**Hidden tabs are the point.** The story is noticing a reveal while looking elsewhere, and a
hidden tab holds timers back. So the timer's five ticks are laid out ahead on the audio
clock and taken back with the timer, and cues run from a `MessageChannel`, not a timeout.
That task is also what keeps them out of the reveal's commit: laying out 16 flicks and a
chord takes 7 ms at 4x CPU, more than that task has to spare (ADR-019).

**Where it lives.** A speaker in the top bar, beside language and theme, which are device
preferences too, shown only to someone in the room. A fourth button in the room's header
broke the room's code across lines at 360 px. The control, the synth and the cues are a
lazy chunk; a failed load costs the button, never the page.

**Alternatives.** Audio files (bytes, licences, `media-src` in the CSP, and no pitch per
tick); an `AudioWorklet` (needs `script-src` for a worklet, and nothing here needs it); a
setting on the user (a person's phone and laptop want different answers).

**Not heard yet.** The recipes were checked by rendering them offline (no clipping, every
voice ends in silence, the reveal stronger than a card), not by ear. They are numbers in
one file.

## ADR-021: Background music rendered once, then looped, off by default (2026-11-02, #45)

**Decision.** Three original moods, written as data (`sound/music-moods.ts`: notes, tones, no
sample, nothing to license). Each is rendered once by an `OfflineAudioContext`
(`sound/music-render.ts`), on its own thread, into a stereo `AudioBuffer` of 48 seconds that an
`AudioBufferSourceNode` then plays with `loop = true`. That gives a sample-exact loop and next
to no work while it plays, with no file, no CSP change and no worklet. Off by default, on or
off and the mood in `pp-sound`, beside the effects: one store, one volume, per device.

**The seam.** What rings past the end must also sound at the start. A second pass that adds
the tail to the start after rendering would work for notes, but not for the state of the room
(a convolver) and it spends main-thread time. So the render starts with a lead-in as long as
anything can ring, the note and the room after it, in which the loop's own last bars play.
What crosses the seam is then already ringing when the kept part starts. Rendered on past
its end, each loop repeats itself to within 3 in 100 million, against a peak of 0.06.

**24 kHz, whatever the device runs at.** The music has nothing above 6 kHz. Rendering at
48 kHz took twice as long (3.5 to 4.5 s here, so a phone's wait would be long) and twice the
memory, and it made the peak depend on the device's rate (0.25 or 0.21 for one mood). At
24 kHz a loop is 4.6 MB, takes 1.3 to 2 s here, and comes out the same for everyone. The
source node converts it as it plays; the seam is checked after that conversion too.

**The audio's life.** Effects and music are independent switches, so the context lives while
either is on: `useAudioWhile`, called after the hooks that play, because effects clean up in
order and the music has to start falling away first. `release()`, not `shut()`, is the way
out: a context closed under a loop is a click, so it waits for the last loop's `ended`, an
event of the audio thread and not a timer that a hidden tab would hold back. `shut()` stays
as the hard end. The gesture rule holds: `unlock()` is the only place an `AudioContext` is
made, and `startLoop` drops a buffer unless the context runs. An `OfflineAudioContext` makes
no sound, so the rule does not reach it, but it too waits for a running context: a page
nobody touched does no work.

**Fades.** Every fade is `setTargetAtTime`, which takes over from wherever the last one had
got to, so a fade turned back halfway cannot jump, as a ramp cancelled halfway does. Rounds
and moods share one path: a new source fades in, the old one falls away under it and stops
twice its fade later. Each round goes on from where the last stopped.

**When it plays.** While the round the viewer sees is in voting. It follows the store's phase
in a task of its own, off a reveal's commit (ADR-019). It keeps playing in a hidden tab, since
the person opted in, and a timer is no reason to stop.

**Lazy.** `music-render.ts` and the compositions are a chunk behind the control's chunk, asked
for once music is on and the context runs. The room route stays at 179.3 kB. A failed load
costs the music, never the page.

**Consequences.** Turning it on during a vote takes a second or two here, longer on a phone
(not measured), before the fade starts. Rendering again on each change of mood keeps one
buffer in memory rather than three. A person's two tabs of a room both play, as the effects
do. Measured in headed Edge on a desktop i7-11700F with the music audible at 60 %: 0.6 to
1.9 % of one core for the whole browser, no different from the same room in silence (0.5 to
1.9 %), or 0.12 % of the machine.

**Alternatives.** Live oscillators (a CPU cost for as long as it plays, and a loop only as
exact as the scheduling); audio files built ahead (bytes and `media-src` in the CSP, which
the render does without); adding the tail after rendering (see above); a
fourth mood (three carry the range, and each one is more to judge by ear); keeping the source
running silently through the reveal (work for nothing, and "off" would not mean stopped).

**Not heard yet.** Nobody has listened to this: the compositions were written and checked as
numbers. Whether they sound good, and whether the level is right, is Sven's ear; both are
numbers in one file.
