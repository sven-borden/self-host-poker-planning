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
restricting a room to an email domain or Microsoft tenant (ADR-028).

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
its end, each loop repeats itself to within 5 parts in 10 million of its level there.

**24 kHz, whatever the device runs at.** The music has nothing above 6 kHz. Rendering at
48 kHz took twice as long (3.5 to 4.5 s here, so a phone's wait would be long) and twice the
memory, and it made the peak depend on the device's rate (0.25 or 0.21 for one mood). At
24 kHz a loop keeps 4.6 MB once rendered, peaks at 13 to 15 MB while it renders, takes 1.3 to
2 s here, and comes out the same for everyone. The source node converts it as it plays; the
seam is checked after that conversion too, at 44.1 and at 48 kHz.

**The main thread.** The rendering is off it; setting it up is not, and a reload's first gesture
may be the one that reveals, where ADR-019 allows no task of 50 ms at 4x CPU. Unbroken, the
set-up took 86 to 119 ms there. So it starts from `requestIdleCallback` (a second at most, a
timer where that is missing) and hands the thread back as it goes: the impulse and the notes in
slices of 8 ms, and the convolver's setter, which cannot be cut, in a task of its own. The
longest stretch at 4x is that setter, 35 to 42 ms, with no long task.

**The level.** The first rule, music quieter than the effects, was enforced as a peak cap under
the quietest effect. That rule was wrong: it compared a sustained sound's peak with a 50 ms
transient's, and a sustained sound is as loud as its RMS. It left the music at -43 dBFS RMS at
the default 60 %, and -46 to -51 dBFS above 300 Hz, too quiet on a laptop's speakers in a room
usually on a call. So the target is now RMS: about -26 dBFS (0.05) at full volume, no sample
over 0.25, the moods within about 2 dB of each other as measured. Dusk and Tide reach it;
Embers stops at -26.7 dBFS, where its peak meets the cap. The effects stay as they were and
still stand clear: the reveal's peak is about 13 dB over the music's RMS, and a full-volume mix
peaks at 0.37, or 0.45 with a consensus on top. `e2e/sound.spec.ts` holds all of this on the
real buffers. Sven's ear has the last word: each mood is one number, its `level`.

**The audio's life.** Effects and music are independent switches, so the context lives while
either is on: `useAudioWhile`, called after the hooks that play, because effects clean up in
order and the music has to start falling away first. `release()`, not `shut()`, is the way
out: a context closed under a loop is a click, so it waits for the last loop's `ended`, an
event of the audio thread and not a timer that a hidden tab would hold back. `shut()` stays
as the hard end. Wanting the audio again during the fall cancels the release (`keep()`, no
gesture needed: a remount or another tab can want it), or the old loop's `ended` would close
the context under the new one. A context that stops during the fall, as a call on a phone
stops it, shuts at once: it would never end the loop, and it plays nothing to click. The
gesture rule holds: `unlock()` is the only place an `AudioContext` is
made, and `startLoop` drops a buffer unless the context runs. An `OfflineAudioContext` makes
no sound, so the rule does not reach it, but it too waits for a running context: a page
nobody touched does no work.

**Fades.** Every fade is `setTargetAtTime`, which takes over from wherever the last one had
got to, so a fade turned back halfway cannot jump, as a ramp cancelled halfway does. Rounds
and moods share one path: a new source fades in, the old one falls away under it and stops
twice its fade later. A change of mood leaves the old loop playing until the new buffer is
ready, so there is no gap: `endLoop` follows the switch, not the mood. Each round goes on from
where the last stopped.

**When it plays.** While the round the viewer sees is in voting. It follows the store's phase
in a task of its own, off a reveal's commit (ADR-019). It keeps playing in a hidden tab, since
the person opted in, and a timer is no reason to stop.

**Lazy.** `music-render.ts` and the compositions are a chunk behind the control's chunk, asked
for once music is on and the context runs. The room route stays at 179.3 kB. A failed load
costs the music, never the page, and the next gesture or round asks again: an old tab can lose
its chunk to a deploy.

**Consequences.** Turning it on during a vote takes a second or two here, longer on a phone
(not measured), before the fade starts. Rendering again on each change of mood keeps one
buffer in memory rather than three, at the price of the render's peak each time, and a render
cannot be cancelled: so arrow keys through the moods wait to rest (`ARROW_SETTLE_MS`), as the
settings' do, and a click acts at once. A person's two tabs of a room both play, as the effects
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

## ADR-022: An installable app with a worker that stores no page

**Decision.** A web app manifest, four icons drawn from the brand mark, and a hand-written
service worker of about 70 lines (`apps/web/src/pwa/service-worker.js`, no workbox, no
`vite-plugin-pwa`: the image has 11 MB left, and nothing here needs them). It does two things:
it answers a navigation with a plain offline page when there is no network, and it stores
files under `/assets/`, whose names hold their content's hash.

**No page is ever stored.** A navigation goes to the network, always, and its answer is
dropped. That one rule settles three things at once. A room's code, a bearer capability,
cannot land in a cache key. `index.html` carries tags the server fills per deployment (the
socket transport of #39, the opt-in services of #40), and these cannot freeze. And a redeploy
cannot pin an old app: whatever worker runs, the next navigation is the server's, with today's
script names. The cost is that an installed app needs the network to open, which it needs
anyway: a room is live state on the server. The offline page lives under its own name, with
its script and style under `/assets/`, so the worker has one rule for files, and is the same on
every URL, so it shows no code. `/api`, `/socket.io` (a sign-in's redirect, from W5, is a
navigation there), other origins and anything but a GET get no `respondWith` at all.

**Builds.** `scripts/pwa-plugin.ts` fills in a hash of the built files (the bundle, and the offline
page with its script and style, which Vite 8 keeps out of the bundle it hands a plugin), so each build that
changes them is a new `sw.js`, which the server sends with `no-cache` and the page registers
with `updateViaCache: "none"`. It installs, skips waiting, and on activate drops every older
`pp-shell-*` cache. Waiting for tabs to close protects nothing here, since no worker holds a
page in place. **An open tab is not reloaded:** it keeps running what it loaded, with its
requests now going through the new worker. A lazy chunk of the old build that it never fetched
is a 404 from the server, the same as with no worker at all, and the app already survives that
(a failed chunk costs a button or asks for a reload, and the toast or error that asks has a
Reload button, since an installed window has no browser controls). When the protocol has moved on, the room
tells the tab to reload (`protocol_mismatch`), and that reload is a navigation, so it reaches
the new app. A rollback, or an image with no `sw.js`, leaves at worst a worker that stores
hashed files and shows the offline page. To retire it, ship an `sw.js` that unregisters itself.

**The policy did not change.** A worker falls back to `script-src 'self'` and a manifest to
`default-src 'self'`, so neither needs a directive, and a narrower policy than no addition
does not exist. `e2e/fixtures.ts` fails any spec on a violation. At the root, the worker's scope
is the whole app with no `Service-Worker-Allowed`.

**Installability is proved by the browser, not Lighthouse.** Lighthouse dropped its PWA
category and its `installable-manifest` audit in version 12: 13.6.0, the latest on 2026-11-02,
lists neither that audit nor `maskable-icon`, `splash-screen` or `themed-omnibox` (checked, not
assumed). So `e2e/pwa.spec.ts` asks Chromium itself, under the production headers:
`Page.getInstallabilityErrors` returns nothing for the app and a list for a page with no
manifest, which shows the question means something. That needs a real profile (a private
context is never installable). Lighthouse 11.7.1, the last line with the check, was also run
once by hand against this build under the production headers, in Edge: PWA category 100,
`installable-manifest`, `maskable-icon`, `splash-screen` and `themed-omnibox` all pass. It is
not in CI: an old major is not worth pinning for an answer the browser gives directly.

**Icons.** A tile of the page's `--bg` with the mark on it, because the mark's spruce card
would vanish on a spruce tile. `maskable-512` and the 180 px `apple-touch-icon` are whole
squares (iOS paints transparency black and rounds the corners itself), and in the maskable
one the mark's farthest corner sits at 38 % of the side, inside the 40 % circle every launcher
keeps. They were judged by eye, also under circular masks at 192 and 48 px, on light and dark;
`scripts/make-icons.ts` draws them, with the browser Playwright already has. `short_name` is
"Poker", as a launcher cuts "Poker Planning" at about 12 characters. The name is the product's
in every language, and the manifest has no other copy, so nothing there needs translating.

**Theme colours.** The manifest holds the light `--bg`, the only value it can hold. The page
has one `theme-color` per scheme. A theme picked in the app must beat the system's, so
`theme-init.js` (before first paint) and `applyThemeColour` turn the matching tag's `media` to
`all` and the other's to `not all`, which keeps every literal in `index.html`.

**The offline page.** All three languages are in the page, from the catalogs, written by the
build. A worker cannot read `localStorage`, so a small script in `<head>` picks the saved
language or the browser's by setting `<html lang>`, and CSS shows that section: without the
script the page is English. It takes `tokens.css`, so both themes are the app's, and system
fonts, as the app's are not worth storing for one page. Its only control reloads. It shows on any
navigation the network fails to answer (no network, but also a restart that refuses connections,
a DNS failure, an expired certificate), which the worker cannot tell apart, so its words say the
app cannot be reached and to check the connection, and never that the person is offline.

**Haptics.** The reveal's two beats (20, 70, 35 ms) go to everyone, from `LiveAnnouncer`, the one
place already told of each reveal once, and never on a page that opens on a revealed round. A
new `vibrate` stops the last one, so the vote that ends a round, whose confirmation can arrive
after the reveal's snapshot, gives way to the beats. The same guards as the vote's tick apply.
On by default, on this device (`pp-haptics`), and only a saved "off" turns it off. The switch
sits in the speaker's popover, with the device's other preferences, and shows only where the
call exists, a touch screen is among the pointers (`any-pointer: coarse`, so a phone with a mouse
paired keeps its switch), and motion is allowed: Chromium has `vibrate` on a desktop too, with no
motor behind it, and under reduced motion the switch would do nothing.

**Alternatives.** Caching `index.html` as the shell (fast and offline-capable, but it freezes the
head tags, and a stale shell is what a real room cannot afford); a `vite-plugin-pwa` manifest
of every asset (precaches chunks most people never load); no worker at all (Chromium no longer
requires one to install, but offline would be the browser's error page).

**Not tested.** No real iPhone or Android phone: the home-screen icon, the standalone start and
the feel of the beats are for Sven. Plain http gets no worker and no install, as browsers
require https (localhost aside); the app runs as before.

## ADR-023: Sign-in with Google and Microsoft, narrow and without the providers' tokens (2026-11-02, #47)

**Decision.** Better Auth's social providers for Google and Microsoft Entra ID, each there only
when both its keys are set (`GOOGLE_CLIENT_ID` and `_SECRET`, `MICROSOFT_CLIENT_ID` and
`_SECRET`, `MICROSOFT_TENANT_ID`, default `common`). One half set stops the start and names the
missing variable, never a value. Without keys the routes do not exist, the page carries no tag
and no button shows. Sign-in is never required, and everything a guest could do stays.

**Only what sign-in needs reaches Better Auth.** Three more routes: `POST /sign-in/social`,
`GET /callback/google` and `GET /callback/microsoft`, the last two per configured provider.
Better Auth's sign-in body takes an `idToken`, scopes, `additionalData`, a login hint and three
return URLs, so the page never writes it: it posts `{ provider, returnTo }`, strictly, and
`signInRequest` builds the rest. Google's and Microsoft's id-token sign-in is off as well.

**A full-page navigation, in two steps.** The page posts, gets the provider's URL back in JSON
and navigates to it. A form post would follow the redirect under `form-action 'self'`, which
refuses it; a popup would need `Cross-Origin-Opener-Policy` loosened. Navigating needs no
directive at all, so neither the policy nor COOP changed, and `e2e/fixtures.ts` holds that over
the whole flow.

**A room's code never travels.** `returnTo` is `/` or `/r/<code>` and nothing else, checked by
the domain's own pattern, so no spelling leaves the site. Better Auth keeps it in the
`verification` row with the PKCE verifier (`storeStateStrategy: "database"`, set explicitly). The
provider gets a random `state`, and `redirect_uri` is the fixed callback. This was read in
Better Auth's code and is asserted on what the stand-in received, in Node and in a browser;
`Referrer-Policy: same-origin` keeps the address out of `Referer` too. The purge clears sign-ins
nobody finished, since Better Auth does so only when a callback arrives.

**The provider's tokens are not kept.** Nothing here calls a provider after sign-in, and #53's
connector tokens are a separate thing. A hook on `account` clears the access, refresh and id
tokens and both expiries before the write, on create and on update, and
`updateAccountOnSignIn: false` means a later sign-in writes nothing. So a stolen backup holds no
way into anyone's Google or Microsoft account, and no encryption is needed for what is not there.
Asked for is a name and an email: no `offline_access`, no Microsoft Graph, no profile photo
(`user.image` stays null; the policy would refuse a provider's picture anyway). `prompt:
select_account`, so that after signing out the next person at the browser gets a choice.

**One thing is kept from the id token:** Microsoft's `tid`, in `account.tenant_id`, for #50's rooms
limited to a tenant. The token is gone once written, so reading it later would mean asking
everyone to sign in again. `(provider_id, account_id)` gets a unique index: every sign-in looks
up by it, and one person at a provider is one account.

**A Microsoft person is a tenant and an object id.** Microsoft scopes `oid` to a tenant, so two
tenants can hold the same one, and the account id is `tid:oid`. Better Auth's `mapProfileToUser`
cannot set an id by design; the provider's `accountSubject` reads `profile.oid`, and the
`getUserInfo` option decides that profile. So `microsoftIdentity` replaces the provider's reading
of the id token (it read and did not verify either), without patching the library. Nothing else
in that reading was needed, as no photo is fetched.

**`MICROSOFT_TENANT_ID` is a boundary.** It picks Microsoft's URL, which only asks: a token from
another tenant got an account in review. So the token's `tid` is checked against the mode: a GUID
must match, `organizations` refuses the consumer tenant, `consumers` takes only it, `common`
takes any. It runs in Better Auth's `user.validateUserInfo`, before any write, on a first
sign-in, a link and every later sign-in, so an install that narrows its tenant holds for people
already in. A throw from `mapProfileToUser` would land on `/` with an alarm that anyone with a
personal account can raise, and the `account` hook runs after the user row is written. A refusal
here returns to the page the person came from, as `tenant_not_allowed`: `failed` says "try
again", which would never work.

**Errors.** A callback is a page a person sees, so it always ends in a redirect to the app,
on the return path when it is known, with `?sign_in_error=<code>`: `cancelled`, `account_exists`,
`no_email`, `tenant_not_allowed`, `rate_limited` or `failed`. The page takes the code out of the
address before the router or the page views read it and says it once, in the reader's language.
Better Auth's `error_description` is dropped: a provider or a crafted link can fill it with
anything. One log line has the code and a reason from a fixed list (`invalid_code` is usually a
wrong secret), never the query. Anyone can send a callback, and an `error` line reaches Sentry, so
that line is `warn` for what a stranger or a person can cause, and `error` only when this server,
its keys or a provider failed; Better Auth's own lines during a callback are `debug`. A forged
`invalid_code` still reaches `error`, but it takes a started sign-in, which is limited, and it is
the one signal of a wrong secret. A provider's name goes through `cleanName`; one it refuses is
`""`, and the join form asks.

**An address never joins two identities.** Better Auth's default links a new identity to the user
with the same address when the provider calls it verified. The first version of this ADR trusted
that default, and review broke it on the real code: a Microsoft sign-in from another tenant with
`email_verified: true` signed in as a Google user, and a new Google `sub` on the same address
joined the old user, which is a reassigned address or a domain bought again. So
`account.accountLinking.disableImplicitLinking` is on, and any sign-in whose address belongs to
another identity is refused (`account_exists`), while the owner still signs in with their own.
Entra's claim says only what a tenant's admin set, so `email_verified` is false for every Microsoft
account, whatever the token says: #48 and #50 read that column, and must not read this address as
proved. #50 relies on `tenant_id`, not on the domain of an address.

Explicit linking stays for #48 (`linkSocial`, from inside a session). It has its own check: an
identity whose provider is not in `trustedProviders` needs a verified address, so linking Microsoft
will need that list, which does not reopen implicit linking. The cost of this rule is squatting: a
Microsoft sign-in that claims an address first makes its real owner see `account_exists`. That is
#48's, with the merge rules and OQ-6. **Amended by ADR-025:** a Microsoft address no longer claims
`user.email`, so that squatting is gone, and `linkSocial` stays closed.

**The guest stays, and pays until #48.** Better Auth's anonymous plugin deletes the guest on a
sign-in; `disableDeleteAnonymousUser` keeps the row, and `auth.ts` marks where `onLinkAccount` goes.
Until #48 the user id changes: the person returns to the room as somebody new, on the join form
with the provider's name, must type a room's password again, and is not its PO any more (the old
seat goes away like any other, and the role can be claimed after 120 s). The old guest's rooms
and history stay, under the old guest. Signing out starts a fresh guest by reloading the page,
since the old session's socket cannot carry on; the page stays the same. **Amended by ADR-025:**
that was the state until #48; a guest who signs in now keeps everything.

**No production keys before #48 has merged.** Before #48, a guest who signs in loses the only link
between that guest and the account: what the callback knows is in a `verification` row it deletes,
and the guest's cookie is overwritten. Their rooms, PO role and history stay with a guest nobody
can use, and #48 cannot reach them afterwards. Merging #47 is safe, as without keys the routes do
not exist; setting keys is what opens the window.

**A test seam that production cannot reach.** The provider's address is not configurable: no option
of `authority`, `authorizationEndpoint`, `tokenEndpoint` or `redirectURI` is ever set, and no
variable feeds one. `MICROSOFT_TENANT_ID` goes into Microsoft's path, so it must be a mode or a
GUID. Tests run the real provider code against the real addresses: `fake-oidc.ts`, a real HTTP
server with one-time codes and PKCE, is reached by replacing `fetch` in the test's own process,
and in the browser by Playwright's routing. It is imported by no file that ships, and
`social-sign-in.test.ts` holds that, with every plausible variable name set, against what the
real provider objects ask for.

**Alternatives.** Keeping implicit linking and marking Microsoft unverified alone: Google's new
`sub` still joins the old user. Refusing by tenant in `mapProfileToUser` with a throw: see the
tenant above. `linkSocial`, which keeps the guest's id but fails for an account another user
owns and needs `allowDifferentEmails`: #48's call, with `onLinkAccount`. An encrypted cookie for the
state, equally private, with a replay window where the row is single-use. A base-URL override
for tests, or an env switch: exactly the hole this avoids. `better-auth/client`: 12 kB for two
fetch calls. Encrypting the tokens: there is nothing to keep them for.

**Not tested.** Real Google and Microsoft: the stand-in follows their documented shape, and the
provider code is theirs through Better Auth, but no real consent screen, real id token, or
personal Microsoft account has been through it. That check is Sven's, and #47 stays open for it.
No token request has a timeout of ours: Better Auth offers no plain option for it, so a provider
that hangs holds that one callback until its connection fails.

## ADR-024: The backlog queue lives in the room, apart from its snapshots (2026-11-02, #52)

**Decision.** A room holds an ordered queue of up to 500 tickets. The server owns it: every
change is a command through `apply`, under the compare-and-set, by the PO alone, and a change
of PO hands it over. A snapshot says only how many items wait and the next one, by its id and
the one thing that names it; the list comes by a `queue` request of its own, for the PO. The
list is stored in a column of its own, `room.queue`, which a commit writes only when the
queue changed.

**Why a snapshot carries so little.** A snapshot goes to up to 16 sockets on every vote and
every presence change, and 200 tickets with their titles and links are 33 kB of JSON, 500 are
84 kB, and the worst the rules allow is 256 KB. With the summary a 16-person snapshot costs 58
bytes more for an item named by its key, with 1 item or with 500. The worst case is an item with
no key: 1,053 bytes more for a title at its byte limit, quotes and all, and 205 bytes for a bare
link, of which a snapshot carries the first 64 characters, all the page shows. A room with an
empty queue sends exactly what it always sent. The summary carries `rev`, so the PO's open sheet
knows when to ask for the list again.

**Why a column.** The state `apply` sees still holds the queue: one model, one judge, and a
round can start from it inside `apply`. The split lives in the store alone. In `live`, every
vote rewrites the list: measured on Postgres 17, per vote, with 500 ordinary tickets, 9.4 kB of
WAL and 3.8 ms to write; with a list of 1.1 MB, which the byte limit below no longer allows, 25
kB and 56 ms. In a column a vote writes 1.3 kB and 2.0 ms, and 474 B and 2.6 ms for that list,
about what a room without a queue writes (461 B, 1.7 ms): Postgres keeps the stored value of a
column an update does not set. A load does read it: 1.3 ms for 500 ordinary tickets against 0.5
ms for none, 6 ms for that list. Reading the summary apart would need a third place for the same
facts, which that does not justify. The column is additive and nullable; the retention purge
takes it with the row.

**A paste is one or more commands.** `queueAdd` carries a batch. In a batch every item is checked
or none is stored (`bad_queue_item`), and all of them fit or none does (`queue_full`). The page
takes what fits before it sends, and says how many did not, so a person sees a count rather than
a refusal; `queue_full` only meets a queue that grew under an open sheet. A duplicate is dropped
by the page, which counts it, and by the domain too, which does not need the page's word for
it. Dropped by identity: the key, else the link, else the title in any case, so a link and its
bare key are the same ticket.

**The socket's cap stays at 16 KB, and a long paste comes in several commands.** Sven's call,
over a first version that raised it to 128 KB so a paste would be one command. The cap is
`maxHttpBufferSize`, engine-wide: it holds for every frame on both transports, before the session
is checked, so raising it for one command raised it for everyone with a cookie's name. Measured
on 100 connections with no room and no session, 134 MiB held against 15 MiB. The first version's
"1.3 MB of JSON a second" was wrong: the token bucket runs after Socket.IO has decoded the frame,
so it does not bound the parsing. That flood exists at 16 KB too, it is older than the queue and
it stays out of this decision's scope. 200 ordinary tickets take two commands, 500 take five, and
the largest list the rules allow about 18 (`queueBatches`, under 15.9 KB of JSON each); any one
item fits, at most 7 KB. The protocol has no binary, so the parser takes none
(`maxAttachments: 0`): the first half of a binary packet used to wait for its attachments with no
timeout, and now closes the connection, as a frame that does not parse does.

**A failure between commands.** Each command stands alone, so a paste is no longer all or
nothing. What can stop one: the connection, a limit, a queue that grew in another tab. The room
left is checked before anything is sent, so a list that never could fit does not start. If a
command is refused after others went in, the sheet says "120 items went in before this stopped.
The rest is still in the box: add it again, and nothing goes in twice", with the reason under it,
and the box holds the lines not sent. Adding them again is safe even when a lost answer hid a
command that landed: the domain drops what it holds. The room hears one sum, however many
commands a paste took.

**A queue has a byte limit: 256 KB of JSON.** 500 items alone do not bound it: a title may be
3,200 code units of three bytes each, one grapheme of joined characters that `cleanText` passes,
and at 11.6 KB an item a queue reached 5.54 MiB, filled in five seconds by anyone who is PO of a
room of their own, read by every load and rewritten by every move. `addToQueue` counts the list's
JSON, the only place that makes it longer, and refuses with `queue_full`. 500 ordinary tickets
take a third of it, and 500 with titles of 200 Latin characters under 60 %. A full column holds
at most 262,144 bytes of list and some 30 of `lastId` and `rev`. The page takes what fits by bytes
too, so a person sees a count here as well. Writes to the queue have a bucket of their own, 2 a second,
bursts of 30 (`QUEUE_WRITE_LIMIT`): a long paste takes 18 at most, and a PO moves a row a few
places at a time.

**Text.** A queue item obeys the rules of the subject it becomes: `cleanQueueItem` runs each
field through `cleanSubject`, so there is no second validator, and a key must be a Jira key or
an Azure DevOps id. A title is bound in bytes as well, at 800: 200 characters of the longest there
are, so real words always fit, and a snapshot's next item stays small (`MAX_ITEM_TITLE_BYTES`). The
largest a round's subject can then be is a link of 2,000 three-byte characters and such a title:
6.8 kB more in a snapshot, of which 6 kB any typed link could always take. An over-long title in a
paste is cut with an ellipsis and counted: a Jira summary may run to 255 characters and a ticket
should not vanish for 40 of them. A line with hidden or control characters is counted as
unreadable, not cleaned: stripping them would decide what the text says, and it stays in the box.
Nothing but `http(s)` becomes a link.

**A key and a title.** `Subject` had no way to hold both. A link subject gains an optional
`title`, set only from a queue item, never from the typed field (the wire refuses it there),
so a round on a pasted link shows the key's chip and the ticket's title, in the room, in the
history and in the exports. Without a link the two become one title, "ABC-123 Fix the login",
which is how a person types it and what the exports already read.

**Next item.** With the subject field empty and an item waiting, "Next item" (and "Start
voting" in the lobby) starts that item, which leaves the queue. Anything typed goes first and
leaves the queue alone, so the queue never locks the PO out of the field. `startNext` names
the item and is refused while a round is voting, so a double press or a second tab cannot take
two. `startRound` carries the round it was pressed for, 0 in the lobby, and is refused with
`round_changed` otherwise: a subject typed as a countdown ends would replace the round the
countdown just started, and that item would be out of the queue and in no history. The page says
nothing of it, since the new round is the answer, and the typed subject stays in the field. "Vote
again" keeps the subject and takes nothing. There is no separate skip: a PO who
wants to pass an item over moves or removes it, and an abandoned voting round's item is gone,
as its subject would be. To round without a subject while a queue waits, the PO types one.

**Auto-advance.** A room setting, off by default. A recorded final, with an item waiting, sets
`advanceAt` on the round, 10 seconds on, and everyone sees "Next: ABC-124, in 8 s" under the
table. It is a deadline as the timer's is (`resolveDeadline`): the server's timeout, any
command or a page's ping starts the item, exactly once, and it survives a redeploy. Another final
starts the countdown again, since the PO is still deciding; a queue emptied or the setting turned
off ends it; a hand start or "Vote again" replaces the round and it with it. An empty queue never
arms it, so the end of the list changes nothing. Three rules bound it:

- **"Stay on this round" holds for that round** (`Round.stayed`). A changed final starts no
  countdown; the next round's final does.
- **It needs the PO.** A room nobody can stop should not move on, so if the PO leaves or goes
  away, it ends and nothing starts. The domain sees a `leave` and an away, but the away comes after
  a 15-second grace and the countdown lasts ten: so the server ends it as soon as the PO's last
  socket closes (`endCountdown`, a server command). A reload in those ten seconds ends it too.
  That costs a press of "Next item", never a round. A voter leaving changes nothing.
- **A deadline never starts a round after the room emptied.** When the last socket went, the
  server used to forget the timer and leave the deadline stored, and the first `enter`, days later,
  started the item at once, even for a visitor on the join form. The same `endCountdown` clears it
  in the domain, and it does not resolve a deadline first: nobody is there for the round. So no
  later enter finds one. A restart is not an empty room: the sockets the server closes on its way
  down end nothing (`drainRealtime` has stopped taking messages by then), everyone reconnects, and
  the first command or the new timeout resolves the deadline, once. `CLAUDE.md`'s timer rule holds:
  every deadline still stored resolves exactly once, and one that was cleared no longer exists.

What stays open: a crash, or a shutdown, in those ten seconds with nobody coming back leaves the
deadline stored, and the first enter resolves it. `endCountdown` needs a process to run in.

Why a countdown: the final is the moment people read the result, and a round that starts under
them takes their cards away. Ten seconds is long enough to finish reading and to press "Stay",
short enough that the setting is worth having. A voting room is never touched: it arms only on
a recorded final, which only exists after a reveal. With the room's timer on, the timer starts
with the new round, as for any start, from when the round shows, so the countdown never eats
into it.

**Parsing.** In the page, pure, with no network: `apps/web/src/room/paste-queue.ts`. No request
ever leaves for a pasted link, and the raw text is not stored or logged; only the items go. A
header row is told by the trackers' column names in English, French and German, or, for names
it does not know, by rows of keys under a row without one, in the first five rows and above any
row with a key. A column the header does not name is found by the looks of each row. Without a
header the title is the longest text after the key, since a type column often stands between
them. On plain lines a key is read in capitals only, so "web-2 migration" stays a title, and a
key before lower-case words is a sentence, so "UTF-8 bug" after "UTF-8 support" is not dropped as
the same ticket: a title loses nothing by it, and the exports still read a key at its start, while
a false key loses the line. In brackets a key stands anyway. A line of nothing but keys or links
is an item each, bullets are no part of a line, and raw CSV reads as a table.

**Connectors.** #54 and #55 will add items through the same `apply`. `QueueItem.source` is
reserved for their external id; nothing writes it, the strict wire schema refuses it from a
client and no view shows it. A write-back will need the round to keep it too: not built.

**Alternatives.** The list in `live` (simplest, and every vote rewrites it, see above); a table
of items (a query per reorder, and `apply` could no longer see the queue); the list in the
snapshot for the PO alone (the PO's phone pays on every vote); a client-side countdown from the
PO's page (a sleeping phone would stop the room); no countdown (it starts a round on people
reading); truncating in the domain (a silent half-success for a command, where the page can
say what happened). A drag library: pointer events on a grip are about 40 lines, and the
keyboard's buttons are what a screen reader uses.

**Not tested.** The issue's first acceptance criterion, parser tests on real samples, is not
met, and #52 stays open for it: the samples are reconstructed, and nobody here has a Jira or an
Azure DevOps. Jira Cloud's unified List view has lost its bulk copy (Atlassian's JSDCLOUD-18884
suggests a CSV export, and copying from a sheet is a flow that parses), and for Azure DevOps
Microsoft documents only an "HTML-formatted table", whose plain-text flavour, which a textarea
gets, nobody here has seen. Sven pastes one real list from each tool into the box, and the
samples are replaced with what comes out. `paste-queue.test.ts` says what each one rests on.

## ADR-025: A guest who signs in keeps everything, and an unproved address locks nobody out (2026-11-02, #48)

**Decision.** A sign-in from a guest moves everything the guest holds to the account: seats, PO
roles, votes, grants and named history. Better Auth makes a new user and calls `onLinkAccount`,
and `guest-link.ts` does the rest. The guest's row goes only after a complete move. This is what
makes production keys safe to set (ADR-023).

**What moves, keyed by the user id, the whole list.** In `room.live`: `ownerId`, the key of
`participants` (name, role, avatar, join time, presence), the key of `round.votes` (a seated
voter's, or a departed voter's kept card and name). `room.owner_user_id`, by the commit.
`room_access.user_id`. `round_history.votes` for named rounds, each `who`. `user.avatar` and
`user.name`, only where the account has none. Ends with the guest: `session.user_id`, and the
`account` table has no row for a guest, and `connector_token` none either: `saveToken` refuses a
guest (ADR-026), so that table needs no move. **Not moved, on purpose:** in-memory keys that run out on
their own, namely the rate limits per user (`rename|user`, `avatar|user`, `password|user`,
`password|change`), a person's socket count and message buckets, acknowledged command ids and
presence timers. So a sign-in starts a person's count of wrong passwords afresh; the limits per
address and per room still hold. Rows an unfinished sign-in holds in `verification` name the
guest, and find it gone. Anonymous rounds store no person, so nothing of them moves, and a test
compares them byte for byte. `room.queue` holds no user id (ADR-024: an item is an id, a key, a
title, a link and a source), and neither do `round.stayed` and `round.advanceAt`.

**A room changes through `apply`.** `moveGuest` is a server command in `packages/domain`, run by
the room's runner with the compare-and-set, the way `presence` is, so the room's people get a
normal snapshot and no vote is lost in a race. It carries no cause: nobody came or went, and a
sign-in is nothing the table is told. `StepResult.quiet` leaves `last_active_at` alone and writes
no history row, so a move fakes neither activity nor a round's end. The grant moves in the same
commit (`AccessWrite.moveGrant`), so a kick lands on one id or the other, never between them.

**Finding the guest's rooms.** Seats live in JSON. `room_people_idx` is a GIN index on the
expression `ROOM_PEOPLE`: `participants` joined with `round.votes`, whose keys are user ids, read
with `?`. With `room_owner_user_id_idx` it gives a plan of two index scans. `round_history_votes_idx`
is a `jsonb_path_ops` index for `@>` on named rounds. On 20,000 rooms and rounds a test reads the
plans and finds no sequential scan; the lookup took about a millisecond on 100,000 rooms with
eight seats each. `room` updates are already not HOT, since every commit writes the indexed
`last_active_at`, so the index costs them only its own entries, in GIN's pending list. Below a few
thousand small rows Postgres may rightly prefer a scan. #49 and #51 can read through the same two
indexes. The migration is additive and its indexes are not built `concurrently`, which drizzle's
migrator cannot do inside its transaction: writes to those tables wait while they build, and fail
nothing. What the indexes cost a large database is under *Accepted*.

**All or nothing, and repeatable.** A transaction across rooms would hold a lock per room around
the runner, so each room moves alone, and a row makes the whole repeatable. In order:
1. `begin`: `guest_link (guest, account)` is written and the guest's sessions end, in one
   transaction. This is the only step that can end the sign-in.
2. The guest's sockets hear `signedIn` and close, on every instance.
3. Each room that names the guest moves. A failure does not stop the others, and rooms moved stay
   moved. The lookup runs again until a pass changes nothing, for a command that was in flight.
4. After a pass with no failure, `complete`: the remaining grants, the named rounds, the avatar and
   name, and the guest's row, in one transaction. The row's cascade takes the link. It locks the
   rooms of the grants `for share` first, as `grantAccess` does, so a new password in progress
   commits first and the grant it dropped is not copied.

**Who the guest is.** The cookie on the callback says, and if it says nothing, the plugin looks in
the OAuth state: `/sign-in/social` writes `serverContext.anonymousUserId` there, on the server, from
the session that started the sign-in. That fallback is taken only when the cookie has no anonymous
session; it finds a row only if the id is still a guest with a live session. It is bound as the
sign-in is: the id comes from no request, it lives in the `verification` row of a random single-use
`state`, and that state is honoured only with the signed state cookie of the browser that started
it, so a callback another browser started moves nothing (a test holds that).

**One user or none.** Better Auth writes a new user and its account row in one transaction
(`transaction: true` on the adapter). Without it, a crash between them left a user with no account,
and the next Microsoft sign-in met `account_exists`, which only SQL recovers. The hook runs after
that commit: the link's foreign key needs the account's user to be there.

**What fails how.**
- *The link cannot be written:* a plain error reaches `finishSignIn`, which sends no cookie. The
  person is still the guest, whole, on `/` with "Sign-in did not finish". The account row Better
  Auth wrote stays, and trying again finds it. An `APIError` would keep the new session's cookie
  on the answer: this is why none is thrown there.
- *A room or the end of the move fails, or takes over 5 s:* the person is signed in and lands where
  they were going, with a quiet toast (`still_moving`) that rooms are on their way. Every `enter`
  of the account runs the move again first, and it joins a run in progress. If that fails too,
  that one room shows them the join form or the password field, and joining is safe: the merge
  rules take the guest's seat when the move lands.
- *The process dies* after the row: the move runs again before every purge, so 3 to 5 minutes after
  a start, then daily, and at the next `enter`.
- *The process dies* between the provider's answer and the row: no cookie went out, the person is
  still the guest, and trying again finds the account.
- *The answer is lost after the row:* the guest's cookie has no session any more, and the browser
  starts a new guest. Signing in again is the way back to the rooms, which are safely the account's.
  This is the one path where a person has to do something, and it takes a crash in a moment.
- *A link that cannot finish:* a room whose state the domain cannot read fails every run, and the
  guest and its rooms stay out of the purge for as long as the link stands. Each run logs the room's
  id and the error's code and class, never a value out of the room, and from a day on it logs at
  `error`. **Nothing ends such a link by itself, on purpose.** Giving up would mean deleting a
  person or leaving rooms under an id that is gone, on a guess, in the one path that deletes people;
  and what it costs to wait is one guest row and rooms nobody can open anyway, while the person
  signs in and uses everything else. It takes someone who can look: repair the room's `live`, or
  delete that row, and the next `enter` or purge finishes the move (a test does the second).
Each step changes nothing once done, so two instances or overlapping runs are harmless.

**`disableDeleteAnonymousUser` stays on.** The plugin deletes the guest right after `onLinkAccount`
whatever came of it, which would take the grants and the link row. `complete` deletes the guest.

**The purge.** While a link row exists neither the guest nor a room it owns is purged, though the
guest has no session left. Once moved, those rooms are a signed-in user's, and exempt (ADR-014),
with `last_active_at` as it was.

**The merge rules.** The account already exists; every guest room joins it. Where both sit in one
room, one seat remains, the account's, with its name, avatar and join time: a sign-in does not
rename anyone at a table. It takes the guest's PO role. If both voted, the account's card stands;
if only one did, that card stands. History rows move, and the person is one person from then on.
A merge does not reveal: `settle` only drops for `moveGuest`.

Cases the rules did not name:
- **An observing account, and the guest's is the card that stands** while the round votes: the
  seat becomes a voter, or `settle` would drop the card. The seats counted stay the same; in a
  room that counts observers they drop by one, as two counted seats became one, which is harmless.
- **After an anonymous reveal, both cards stay**, though the rule says the account's stands. A
  card that left the table with a seat would say whose it was, so the guest's stays as a departed
  voter's card does (ADR-011, #19), under the guest's id, which then names nobody. In a named reveal
  the guest's card does go, and the results follow.
- **A round in `round_history` both of them played** keeps both entries, under the account: it is a
  record, and its stats were counted from both. The two entries show under the names they had.
- **A PO who does not vote.** A seat that becomes the PO of a room with `poVotes` off loses the card
  it held, as any hand-over does, with a `voteRetracted`. This is the one case where a merge drops
  the only card: the room's rule says that seat has none.
- **The next command after a merge may reveal.** The move does not reveal, but when the seat that
  went was the last one waited for, every eligible voter has now voted, and the next command by
  anyone lets `settle` do what the room's rule says. The person's own return counts only if the
  seat shows away, since `presence` runs only then. Holding it back would need a state of its own.
- **Two seats, one presence.** The seat that stays is as present as the more present of the two:
  connected if either is, away only if both are, then since the later of the two. An old away of
  the account's seat says nothing about a person sitting there now: kept, it would let anyone
  claim the guest's PO role at once, and take the seat out of the eligible voters.
- **A deadline that has passed** reveals first, as before any command, exactly once. A countdown
  that has run out starts the next item the same way. That commit is not quiet: the round it ended
  gets its history row and `last_active_at`, and `complete` names the account in that row.
- **A countdown to the next item (ADR-024).** A PO who signs in from the room leaves it for the
  provider, and that close ends the countdown as a reload does: it costs a press of "Next item" and
  no round. With another tab left in the room it runs on, and the PO can stop it there. When
  `signedIn` closes the PO's last socket the same rule holds, with one correction: the account is
  the same person, so a socket of the account in the room keeps the countdown, in the moment before
  the role moves. Otherwise it ends and nothing starts. The move itself changes nothing about it:
  the seat is as present as it was, and `stayed` travels on the round. After a move the question
  is asked again of the account, since with several instances a move can land before the guest's
  socket closes. If the move of that room fails while the account sits there, the countdown runs
  on under the guest's seat, and the same person can stop it by hand once the seat has moved.
- **A guest with a card and no seat** (left after a named reveal): the card, with its kept name,
  becomes the account's, so the next history row names the account.
- **A room the guest owns but left:** `ownerId` moves, and no seat appears.
- **A role claimed while the person was at the provider.** After 120 s away anyone can claim the
  PO role, and then the guest holds no role to move. A sign-in through MFA can take that long.
- **Two sign-ins of one guest at once:** the first account wins the link. The second finds no
  session for the guest and moves nothing. Both accounts stay usable, but the second browser ends
  signed out: its stale cookie wipes the new one (see *Accepted*), and it signs in again from a
  new guest. A test runs this over the whole flow.
- **A guest's seat colour changes**, as colours come from ids. Nothing else about the seat does.
- **`user.avatar` and `user.name`** come from the guest only when the account has none, such as
  a provider's name `cleanName` refuses.

**Live sockets.** Another tab of the guest hears `signedIn` before any room moves, and ignores its
socket. Its cookie's session is gone, and the callback answers only when the rooms have moved, up
to 5 s later. Reading `/get-session` in that gap makes a new guest, shows the join form and leaves
a stray row, and that answer clears the cookie it finds: landing after the callback's, it would
wipe the new one. So nothing reads it. The tab holds the `pp-identity` lock, which keeps every
bootstrap of the browser waiting, new tabs too, and reloads when the page the sign-in came back to
says it landed. That page knows by a note in `sessionStorage`, and says so on the `pp-sign-in`
`BroadcastChannel`, before it reads the session itself. If no word comes, the tab reloads after
10 s, above the callback's 5 s, and takes what the browser holds: the page may be closed, and a
lost answer ends in a new guest as it does in the first tab. The wait outlives the room page: a tab
that left the room is still the guest's. A word that overtakes `signedIn` counts for 3 s.

So while rooms move, that tab shows no join form, however long they take. After the reload it is
like any page: its `enter` waits up to 5 s more for a move in progress, and a room that failed
twice shows the form there as anywhere (*What fails how*). A tab nobody warned can still ask in
that gap: one with no socket that a person reloads, or one reconnecting as `signedIn` went out. It
takes a person acting within those seconds, or a dropped connection, and comes to a stray guest row,
which the purge takes, and at worst to a person signed out, who signs in again.

A socket `dropGuest` misses keeps the guest's snapshots until it next asks for something. It cannot
sit down: a `join` re-reads its session, past the 60 s cache of other commands, so no seat ever
names a user that is gone. The presence timers need nothing: a guest's grace names the guest, and
`markAway` finds nobody by that id, so it can never reach the account. A seat that moved showing
connected starts the account's grace, or it would stay connected if the person never returned.
Nothing about the account travels: the event has no payload.

**A Microsoft address never claims `user.email`.** The squatting of #47's review: a Microsoft
sign-in claims `owner@gmail.example` unverified, the real owner gets `account_exists` from Google,
is told to sign in another way, cannot, and only SQL recovers it. So a Microsoft account stores
`sha256(tid:oid)@microsoft.invalid`, under a reserved domain, which no provider can claim and no
mail can reach, and the address its token claims goes in `account.claimed_email`, shown to its
owner on the landing page and proof of nothing. `/get-session` gives the page the claim, never the
stored value, and it is on the `account` row since the hook that keeps `tid` already reads the id
token there; Better Auth skips `input: false` fields of a provider's profile. Checked against what
follows: #49 reads ids and is untouched; #50 relies on `tenant_id`, and a domain check on
`user.email` fails safe for a Microsoft account, which is what ADR-023 wants; #51 exports
`claimed_email` with the account row and deletes it with it. Google and Microsoft sign-ins of one
address are two users unless someone links them on purpose, and that is not built. `account_exists`
remains for one case: a new Google `sub` on an address a Google user holds. A Microsoft account
with no `email` claim can now sign in, as `oid` and `tid` are who it is. Production had no keys, so
no row needed changing.

**`linkSocial` stays unreachable,** and implicit linking stays off. Linking through the sign-in
needs neither. It would have kept the guest's id, but it fails for an account another user owns,
which is the second browser, the case that matters most here; it needs `allowDifferentEmails`,
and a `trustedProviders` list for Microsoft. **OQ-6** is answered in `docs/04-open-questions.md`:
no linking depends on `email_verified`.

**Alternatives.** The plugin's own delete, with the move in the hook: a failure strands the person
with rooms under a deleted id. A transaction over all rooms: lock order, and a long hold on live
rooms. Writing `live` by SQL: a vote cast in that moment is lost, and nobody gets a snapshot. A
side table of who is in which room: a second truth to keep, and a backfill. `user.claimed_email`:
the profile cannot reach it. A placeholder only for unverified claims: Entra's claim proves nothing
whatever it says (ADR-023). Keeping the seat colour with a stored seed: a field for a small thing.

**Accepted, and not built.**
- *A stale session cookie at the callback* wipes the new cookie, with no error. It takes a copied
  cookie, or a session that ends while the person is at the provider. The person is signed out and
  signs in again. Low impact.
- *A Google account with `email_verified: false`* can still take `user.email`: Google is the one
  provider whose address stands there, and no linking reads it. A later sign-in of that address
  gets `account_exists`.
- *A copied guest cookie, or a browser left open,* can move that guest's rooms and PO roles into
  another account for good, with no prompt and no way back. A guest's cookie is the guest; there is
  nothing else to ask.
- *What the indexes cost a large database.* Measured on 100,000 rooms: 3 to 6 % fewer writes, WAL
  per update doubled (4.8 to 9.6 kB), the worst write up from 14-76 ms to 215-296 ms under sustained
  load, and an index of 78-86 MB on a 130 MB table. The migration took 6.7 s at that size, holding
  SHARE on `room` and `round_history`, so votes wait for it rather than fail. A self-hoster with a
  database that large should expect a first start some seconds longer with a room that pauses
  XX- *Four points Sven was asked about were reviewed, and none needs fixing:* a merge can let the
  room's rule reveal on the next command; a PO who does not vote loses a card, announced as a
  hand-over is; a seat's colour changes; a sign-in resets the per-user count of wrong room passwords,
  which is no bypass, since the per-address and per-room limits hold, and a fresh guest resets the
  same count more cheaply.

**For #49.** "My rooms" should call `settle`, or a person who enters no room waits for the next
purge for a move that did not finish.

**Not tested.** Real Google and Microsoft tokens (`docs/04-open-questions.md`).

## ADR-026: The connectors' tokens are sealed to their row, with keys from the environment (2026-11-02, #53)

**Decision.** A connector's token is stored as AES-256-GCM ciphertext, one row per account and
connector, in `connector_token`, and goes with the account by `on delete cascade`. Node's
`crypto` does it all: no new dependency. Nothing reaches this yet: no route, socket event or
page, until #54 and #55. Like every integration it is optional. Without `POKER_VAULT_KEY` the
server starts as it did, and `saveToken` and `readToken` answer `vault_off`.

**The format says what it needs.** One line of text, `v1.<key id>.<iv>.<tag>.<ciphertext>`: the
format version, 8 hex digits of key id, then in base64url a fresh random 96-bit IV for each
encryption, the 128-bit tag and the ciphertext. A random IV is safe far past anything this table
will see (2^32 encryptions under one key is the limit for 96 bits). The ciphertext has the
token's length: nothing pads it, since a length tells nothing useful about an opaque token.
Only the spelling `seal` writes opens: base64url has spare bits in a last character, so other
spellings decode to the same bytes, and `open` refuses a part that does not encode back to
itself. The tag is held to 16 bytes twice, by the pattern and by `authTagLength` on the
decipher, since Node takes a 4-byte tag without that option; one test for each.

**A value is bound to its row.** The additional authenticated data is the JSON array of the
format, the key id, the user and the connector. JSON quotes each, so ids cannot run together. A
value copied onto another user or connector does not open, and neither does one whose key id was
edited. So no statement can move a token: anything that merges two accounts must have the person
connect again. A guest holds no token, so #48's move has nothing to do here.

**The key id comes from the key.** It is 32 bits of a SHA-256 over a fixed label and the key,
safe in a dump, and the operator names nothing. `POKER_VAULT_KEY` is then plainly what
`openssl rand -base64 32` prints. Ids typed by hand could give a new key the old key's id, and
every old row would look tampered with; here a missing key and a changed row are different
answers. Two keys with one id can only be one key listed twice (a chance clash of 32 bits is
caught by the same check), usually a new key that was never pasted, so that stops the start.

**Keys.** `POKER_VAULT_KEY` seals and opens; `POKER_VAULT_OLD_KEYS`, comma-separated, only opens.
`config.ts` checks both like every opt-in variable: `ConfigError` names the variable, never a
value. Refused: anything but exactly 32 bytes of plain base64, one byte repeated, a key listed
twice, old keys without a current one, and a key equal to `BETTER_AUTH_SECRET`, as text or as the
same bytes. Nothing is derived from that secret, or a session secret's leak would open the tokens,
and changing one would lose the other.

**Rotation needs no downtime and no code.** An operator generates a key, makes it
`POKER_VAULT_KEY`, moves the previous one to `POKER_VAULT_OLD_KEYS` and restarts; every token
stays readable from then on. `node dist/main.mjs vault:rotate`, one-off in the running container,
then re-encrypts every row to the current key, and the old key can go. With several instances the
new key goes into `POKER_VAULT_OLD_KEYS` everywhere first, so that no instance meets a value it
cannot open while the others restart. A subcommand of `main.mjs` means one bundle and no new
path in the image. It reads the variables of the container it runs in, which are those the
container was created with: after editing `.env`, `docker compose restart` starts the old
container again with the old values, and only `up -d` makes a new one. So the command can run
with the old key and report nothing wrong, and the next `up -d` would then make every row
`unknown_key`. The line therefore carries `keyId`, the id of the key it ran with, and the steps
(README) have the operator compare it with the id from a run before the change. It opens a
one-connection pool of its own and does not migrate, since the running image already has.

**What exit 0 proves.** Every row is on the current key and none is unreadable. A scan alone
cannot say that: a row saved behind it is never seen, and an instance still on an old key
re-encrypts what it reads to its own current key, which can move a row back. So the run ends by
asking Postgres how many rows are not on the current key (`split_part(sealed_token, '.', 2) <> id`,
`offKey`), scans again while that is above 0 and nothing is unreadable, up to three passes, and
exits 1 if any remain, with a message that names an instance on an older key. A compare lost to a
newer write counts as `changed`, never as `current`, whatever key the winner used. The counts
are those of the last pass. A row that is unreadable ends the run with 1 at once: more passes
could not change the verdict.

**Rotating is safe to repeat.** Each row is one `update` that compares the sealed value it read,
and no two seals are alike. So a token saved while the run reads is never overwritten by the older
one, no lock is needed against the server or a second run, and a run stopped halfway has lost
nothing. A read that finds a token on an old key does the same on the way out, ignoring a failed
write: the token is already open, and the command picks up what this misses. Neither moves
`updated_at` or `version`, which say when and in what state the token last changed.

**A refresh is a compare-and-set too.** A connector refreshes a token it read, and the refresh
takes time and runs on any instance, so a lock in one process does not span them. With an
unconditional upsert, a refresh that finished after the person disconnected would store a
working token again, and two refreshes of Atlassian's rotating refresh tokens would end with
the older stored and the connection dead. `connector_token.version` is a random uuid, new at
every save and replacement. `readToken` returns it, opaque, and `replaceToken` writes only over
it: `replaced`, `gone` (the row is not there: drop the new token) or `changed` (another write was
first: read again). It never inserts. A random value, not a counter, because a row that is
deleted and connected again must not look like the state a stale refresh read. Not the sealed
value, because a re-encryption changes that without changing the token, and a refresh that lost
to it would then drop a refresh token the provider has already retired. `saveToken` stays what
the person's own connecting does, replacing whatever is there; a refresh never calls it.

**A failed decryption is a state.** `readToken` answers `unreadable` with `unknown_key` (its key is
not among the server's) or `corrupt` (changed, moved, or a format this version cannot read). A
caller shows "connect again" for both, and connecting again overwrites the row. The row is never
deleted: a key that was dropped too soon can come back and everything opens again. The rotation
leaves such rows as they are, counts them apart (`unknownKey`: add the key back; `corrupt`: the
row was changed, copied or written by a format this version does not know, and the store never
writes one of those) and exits 1. Counts only: no id, no value. The store itself logs nothing,
so a tampered row shows in the run and nowhere else; a caller that meets `corrupt` should log
the class and the user's id.

**Who may hold one is decided in the statement.** The `insert` selects from `user` where
`is_anonymous is not true`, the purge's own reading, so a guest gets `no_account` with no check to
race. The store refuses because no page exists yet to do so, and a page should not be what
stands between a guest and the table.

**The store trusts the id it is given.** The sealed value is bound to the id that opens it, so
`readToken` for a victim's id returns the victim's token and nothing below can tell. The methods
take an `AccountId`, a branded string that only `accountOf(user)` makes, from the `SocketUser`
that `sessionUser` reads from the cookie, and that is `undefined` for a guest. That fits how the
server passes people (`socket.data.user`, `sessionUser`), and it makes an id from a request body,
a query or a room's seats a type error. It is not a security boundary: `as AccountId` compiles,
and a review must refuse it. The connector name is checked at run time against `CONNECTORS`,
and a name outside it throws, with a message that does not repeat the name.

**Only the store's small API is public.** `saveToken`, `replaceToken`, `readToken`,
`deleteToken`, `listConnections` and `enabled` on `database.connectorTokens`. A token is opaque text up to
16 KiB, so a connector seals what it needs (access token, refresh token, expiry, site) as one
JSON text. The row has no other column about it but its `version`: a site's name is no secret,
but no column is kept for a screen that does not exist.

**Nothing prints.** `Secret` and `Vault` keep their values in private fields, and print a fixed
text to `pino`, `JSON.stringify`, `util.inspect` and a template string; a `KeyObject` holds the
key. Only ciphertext reaches a query, so only ciphertext could reach a driver error, and `guard`
strips those too. `open` catches what Node throws and returns its state. A `Secret` prints
`[secret]` wherever it sits, whatever the depth or the name. For a plain string logged by
mistake, `logger.ts` redacts a list of names (`token`, `accessToken`, `access_token`,
`refresh_token`, `id_token`, `client_secret`, `apiToken`, `pat`, `sealed_token`, the vault
variables, headers in either case, and more) at the top level and up to three keys deep
(`a.b.token`, `list[0].token`), since pino's `*` covers one level. A secret under another name,
or deeper, prints. So a provider's response goes into a `Secret` at once, and nothing logs a
response whole. The store logs nothing, and the rotation logs no user.

**Backups.** A dump holds ciphertext, and the key is in the environment: that split is the whole
point, so they are kept apart. Restoring tokens takes the dump and every key its rows were sealed
with. Losing the keys costs everyone a new connection and nothing else.

**Alternatives.** `POKER_VAULT_KEY=<id>:<base64>`: the trap above, and one more thing to type.
Separate columns for the key id and the IV: the rotation reads every row anyway, and one opaque
value keeps a future format to one column. A key derived for each user: AAD gives the binding
without a KDF. Postgres's `pgcrypto`: the key and the token would travel in query text, into a
server's logs. Deleting a row that fails to open: a wrong key would then erase everything. A
rotation inside the server at start: every instance would run it, and it would hide how far it
got. Re-encrypting on use alone: a row nobody reads would keep the old key alive forever.

**Not tested.** `pg_dump` itself: the test reads every row of every table through SQL, which sees
the same values. A rotation across a real rolling deploy of several instances: the races are
injected between statements of one process, with a second store for the instance on the old
key. No key has been set on Sven's instance, and nothing uses the vault until #54.

## ADR-028: A room limited to accounts goes by what a provider proves (2026-11-02, #50)

**Decision.** The PO can limit a room to email domains, Microsoft tenant ids, or both: a person
passes by either list. The rule is a setting, `settings.restriction`, changed through
`updateSettings` and `apply`. The server judges it, at `enter` and at `join`, on a fresh read of
the room and of the account. A person who does not pass gets no snapshot.

**What meets a rule.** A Microsoft address proves nothing: Entra's `email` claim is whatever a
tenant's admin set, which is the takeover #47's review found. So:
- A domain is met only by an address its provider verified: today, a Google account with
  `user.email_verified`. `room-rule.ts` reads `user` joined with `account`, and takes a domain only
  from a row whose provider is Google. A Microsoft account's `user.email` is a placeholder and its
  `claimed_email` is never read here, so no claim meets a domain, whatever it says.
- A tenant is met only by `account.tenant_id`, from the token, which #47 checks. Compared as a
  GUID, whatever its case. Never the consumer tenant: every personal Microsoft account carries it,
  so a rule on it would admit them all, and `cleanTenant` refuses it.
- So a person at `contoso.com` signing in with Microsoft passes by the tenant, not the domain. The
  panel says so under the tenant list, and the refused screen says so to that person, because
  nobody should set `contoso.com` for a Microsoft shop and lock everyone out unwarned.

**Google, as it answers.** The rule reads the address Google vouched for and nothing more, so a
Gmail address is a Gmail address and `gmail.com` in a rule admits all of Gmail. `hd` is not kept.
It would tell a Workspace account from a personal Google account opened on a company address, which
keeps `email_verified` after its owner leaves the company. That is under *Accepted*.

**Domains match exactly.** Lower-cased, whole: `example.com` admits neither `notexample.com` nor
`example.com.evil.net`, and not `mail.example.com` either. No subdomains and no wildcard: a rule says
what the PO typed, each one is a line away, and a suffix match is how the two refused above get in.
An international name is stored in its `xn--` form, made by the platform's IDNA (`domainToASCII` on
the server, `new URL` in the panel): the domain package has no `URL`, and accepts ASCII alone. The
ASCII form is what the join screen shows too: it cannot be spoofed by a look-alike letter, at the
price of reading badly. ASCII input is never run through a URL parser, which would quietly turn
`a@b.com/x` into `b.com`: it meets `cleanDomain`, which refuses a wildcard, an `@`, a scheme, a
path, a port, an IP address, a trailing dot and a bare top-level name.

**Limits.** 20 entries in each list, each a domain of 253 characters at most or a GUID: in the
domain (`bad_restriction`), and in the protocol's strict schema at 64 entries of 1024 characters.
A rule with no entry is no rule: the page removes it with `null`.

**The rule comes before the password, everywhere.** At `enter`, at `join` and at `POST
/api/rooms/:code/access`. Someone the rule refuses gets the rule's code whatever they typed: no
hash runs, no try counts, no grant is written, and the answers to a right and a wrong password
are the same bytes. A grant from before the rule does not pass it. Someone who passes the rule
still needs the password. So a refused person learns nothing of the password, and a person with
the password but the wrong account is refused.

**What a refused person learns.** Three codes: `sign_in_required` (a guest), `account_not_allowed`
and `restriction_unavailable`, the last with a word of its own below. The refused `enter` carries
`requirement: { domains, organisation }`, so the join screen says what would pass: the domains, by
name, and "your organisation" for a tenant, never a GUID. Domains are shown to anyone holding the
link: that is what lets them choose the right account, and the panel's hint says so to the PO. A
link is a bearer capability already; what it now tells a stranger is where a team works. The
sign-in buttons are the providers that can pass: Google for a domain, Microsoft for a tenant.
With a wrong account, the screen says which rule failed. Sign-out reloads the page as a guest,
whose buttons then return here, so the room stays the return path.

**`GET /api/rooms/:code`.** It hands a password room's name to anyone holding the code. For a room
with a rule that is not enough: the header goes to someone refused as `{ code, name: null,
hasPassword: false }`, which is what a room with no name and no password would say. It reads a
session for a room with a rule only: every other header still costs one query. The name stays off
the socket as it always was.

**The server enforces it at each door.** `roomRefusal` in the domain takes the state and what the
account proves, so a page says nothing. `enter` reads the identity and judges it on the state it
goes on to send. A `join`, a hand-over and a claim read the identity first and are judged in the
run's step, on the very state the compare-and-set commits over, so a rule set a moment earlier
holds across instances with no lock and no second query. A rejected step stores nothing.

**The PO always stays.** `roomRefusal` lets `ownerId` through whatever the rule says, provider
gone included, so no rule locks out the one person who can change it. A rule the PO does not meet
asks first, in the panel: it may be a mistake, and handing the role over would leave them out. The
ask is the page's, since the server's answer would be the same either way. If the page cannot read
the PO's own account, it asks.

**Who sets it.** Only the PO, by `apply`. Only someone signed in: the row asks a guest PO to sign
in, and the server answers `sign_in_required`. Only for a provider this install has: domains need
Google, tenant ids need Microsoft, and the panel shows the list that can work. Removing a rule
needs neither, so a rule can always come off.

**A person the rule refuses never becomes PO.** The PO passes every rule, so the role would be a
way around it: anyone seated before a rule could claim it once the PO is away, then enter for ever
and remove the rule. So `transferOwner` and `claimOwner` answer `owner_not_allowed` for someone
it refuses, seated or not. That costs a sliver of privacy: a PO who tries to hand the role over
learns that this one person would not pass, though not why. The PO will see the same when that
person next reloads, and the rule's integrity is worth more.

**People already seated stay, and a reload is the end of that.** A rule applies to entering and
joining from then on. Nobody is kicked: the socket stays and keeps playing, seat and vote. Their
next `enter`, from a reload or a dropped connection, is refused, and the seat and its vote stay
where they are, stored, to go away after the grace like anyone's. This is the choice between that
and a seat that survives until its owner leaves, and the refusal wins, for three reasons. A rule is
a promise that internal tickets stay internal, and a seat that outlives it would keep seeing them
for as long as a browser keeps reconnecting, which is days. The seat would become a way around the
rule. And nothing is lost by the refusal: a guest who signs in with a passing account finds the
seat again, and a PO can remove the seat. The cost is that a blip of the network ends it for
someone mid-round, which is why the PO reads it first: "They stay until they reload the page or
leave." After `leave`, a socket has no seat to stay by, so it is read again like any visitor.

**The PO sees a count, not a list.** `GET /api/rooms/:code/restriction`, the PO alone, answers how
many people here the stored rule would refuse, and what the PO's own account proves. Not in the
snapshot, which would read every seat's account on every vote. It counts the stored rule only, so
that testing a guess about someone costs a commit, which the room hears, and is held by 60 reads
in 10 minutes. It cannot be made nothing: a PO who sets `gmail.com` and reads the count learns
something about the two people in a room of two. No address, provider or tenant ever comes back.

**Visitors.** A socket on the join form holds snapshots, which name people. When a rule changes,
`settingsUpdated` carries `restriction: true`, on the cause, so it reaches other instances by the
same signal as a lockout. Before the broadcast, each visitor without a seat is marked and read
again, gets nothing meanwhile, and hears `locked` if refused; the page enters again and shows the
refusal. A lost signal is met by the same read before the next version goes out (`blind`).

**Sign-in, checked against #48.** A refused guest has no seat, signs in from the screen, comes
back as the account, and is judged afresh. A guest seated before the rule moves as ever: `moveGuest`
is the server's and takes no gate, and that is right, since the seat is theirs. It also opens
nothing: a seat lets nobody past the rule, so an account that does not pass finds its seat moved
and itself refused, and the panel's count now counts it. A grant moves too, and passes nothing.
Someone who signs out mid-room is a guest on the reload and is refused, and the account's seat
waits for them. A socket opened before a rule keeps what it had while it stays seated; a `join`,
a hand-over, a claim and a `leave` are each read fresh, and the session is read on every `join`.

**A provider that goes away fails closed.** With no provider, as production is until Sven adds
keys, nobody could ever pass, so the row does not appear. A rule set before keys were removed is
judged by what is left: a list whose provider is gone admits nobody, a Google account already
signed in included. With no list left it is `restriction_unavailable`, for everyone but the PO:
refused, never open, with a message that says so and no button that cannot work. The row still
shows for such a rule, names what is gone, and takes it off.

**Privacy.** No address, provider or tenant of any person enters the state, so none can reach a
snapshot, a frame, the history or an export. The rule itself is in the snapshot for those let in:
the domains, and `organisation` for the rest; a tenant's id goes to the PO alone. Tests read real
frames for all of it, and the logs for addresses, tenants and codes. A refused `enter` spends the
socket's message budget like any other, and its answer turns on the caller's own account alone, so
it tells nobody who has an account or which addresses exist. Exports and history do not read the
rule; retention keeps or deletes it with the room's `live`.

**Protocol 6.** The refused `enter`'s `requirement`, the patch, the view and five ack codes. Each
alone is the kind of change that kept the version before, but a tab from before this has no screen
for these refusals and would strand on the generic error, so it is told to reload.

**Accepted.**
- A personal Google account opened on a company address, and a Google account whose owner has
  since left, keep `email_verified`. Requiring `hd` would close the first and refuse real people on
  domains Google does not host; it needs a column, so it stays an option for Sven (see the PR).
- A provider's word is read at sign-in. A session lives `ROOM_TTL_DAYS`, and `user.email` is not
  updated on a later sign-in, so someone removed from a tenant or a domain passes until the session
  ends. A room is not a company's identity system.
- `outsiders` can be read as a test of a guess, as said above.
- A second tab left open after a sign-out keeps the snapshots until its next command finds the
  session gone, as in any room: its seat is still there.
- An international domain reads as `xn--…` on the join screen.

**Alternatives.** A `room_restriction` table: the rule would need its own commit path and lose the
compare-and-set, for a list of 20 strings. Over HTTP like the password: there is no secret to keep
off the command pipeline, and #25's contract gives the panel its rollback for free. A domain rule
met by a Microsoft claim for verified tenants: Entra offers no proof of the kind Google's flag
gives, and the tenant rule says the thing directly. Subdomain matching: see above. Auto-kicking
those who do not pass: a table that empties itself mid-round is worse than a screen, and the PO
holds "Remove from the room" for anyone it should not wait for. A per-seat mark for the PO: a count at most. Checking the identity in the commit's
transaction, as `requireGrant` does: an account does not change under a command, and the state
does, which the step already sees.

**Not tested.** Real Google and Microsoft tokens, and real IDN addresses at Google: the stand-in
answers for them, so what the fields hold is read from their docs and Better Auth's code. No
provider keys are set on Sven's instance, so the row does not appear there yet.
