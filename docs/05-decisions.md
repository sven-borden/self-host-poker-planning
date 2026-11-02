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

## ADR-024: The backlog queue lives in the room, apart from its snapshots (2026-11-02, #52)

**Decision.** A room holds an ordered queue of up to 500 tickets. The server owns it: every
change is a command through `apply`, under the compare-and-set, by the PO alone, and a change
of PO hands it over. A snapshot says only how many items wait and the next one, by its id and
the one thing that names it; the list comes by a `queue` request of its own, for the PO. The
list is stored in a column of its own, `room.queue`, which a commit writes only when the
queue changed.

**Why a snapshot carries so little.** A snapshot goes to up to 16 sockets on every vote and
every presence change, and 200 tickets with their titles and links are 33 kB of JSON, 500 are
84 kB, and the worst the rules allow is 1.1 MB. With the summary a 16-person snapshot costs
at most about 60 bytes more than without a queue, with 1 item or with 500, and a room with an
empty queue sends exactly what it always sent. The summary carries `rev`, so the PO's open
sheet knows when to ask for the list again.

**Why a column.** The state `apply` sees still holds the queue: one model, one judge, and a
round can start from it inside `apply`. The split lives in the store alone. In `live`, every
vote rewrites the list: measured on Postgres 17, per vote, with 500 ordinary tickets, 9.4 kB of
WAL and 3.8 ms to write; with the worst allowed list 25 kB and 56 ms. In a column a vote writes
1.3 kB and 2.0 ms, and 474 B and 2.6 ms for the worst list, about what a room without a queue
writes (461 B, 1.7 ms): Postgres keeps the stored value of a column an update does not set. A
load does read it: 1.3 ms for 500 ordinary tickets against 0.5 ms for none, 6 ms for the worst
list. Reading the summary apart would need a third place for the same facts, which that does
not justify. The column is additive and nullable; the retention purge takes it with the row.

**A paste is one command.** `queueAdd` carries a batch. Every item is checked or none is
stored (`bad_queue_item`), and all of them fit or none does (`queue_full`). The page takes what
fits before it sends, and says how many did not, so a person sees a count rather than a
refusal; `queue_full` only meets a queue that grew under an open sheet. A duplicate is dropped
by the page, which counts it, and by the domain too, which does not need the page's word for
it. Dropped by identity: the key, else the link, else the title in any case, so a link and its
bare key are the same ticket.

**The socket's cap goes from 16 KB to 128 KB.** One command cannot carry 200 ordinary tickets
in 16 KB. 128 KB holds 500 of them; a list of very long links, which does not fit, the page
splits into several commands, the one case where a paste is not atomic. The wire schemas still
cap every string and list, each person's messages are still limited, and a message over the
cap still closes the connection. Worst case for one person, 1.3 MB a second of JSON to parse,
up from 160 kB. HTTP bodies stay at 16 KB.

**Text.** A queue item obeys the rules of the subject it becomes: `cleanQueueItem` runs each
field through `cleanSubject`, so there is no second validator, and a key must be a Jira key or
an Azure DevOps id. An over-long title in a paste is cut with an ellipsis and counted: a Jira
summary may run to 255 characters and a ticket should not vanish for 40 of them. A line with
hidden or control characters is counted as unreadable, not cleaned: stripping them would decide
what the text says. Nothing but `http(s)` becomes a link.

**A key and a title.** `Subject` had no way to hold both. A link subject gains an optional
`title`, set only from a queue item, never from the typed field (the wire refuses it there),
so a round on a pasted link shows the key's chip and the ticket's title, in the room, in the
history and in the exports. Without a link the two become one title, "ABC-123 Fix the login",
which is how a person types it and what the exports already read.

**Next item.** With the subject field empty and an item waiting, "Next item" (and "Start
voting" in the lobby) starts that item, which leaves the queue. Anything typed goes first and
leaves the queue alone, so the queue never locks the PO out of the field. `startNext` names
the item and is refused while a round is voting, so a double press or a second tab cannot take
two. "Vote again" keeps the subject and takes nothing. There is no separate skip: a PO who
wants to pass an item over moves or removes it, and an abandoned voting round's item is gone,
as its subject would be. To round without a subject while a queue waits, the PO types one.

**Auto-advance.** A room setting, off by default. A recorded final, with an item waiting, sets
`advanceAt` on the round, 10 seconds on, and everyone sees "Next: ABC-124, in 8 s" under the
table. It is a deadline as the timer's is (`resolveDeadline`): the server's timeout, any
command or a page's ping starts the item, exactly once, and it survives a redeploy. The PO can
stay on the round; another final starts the countdown again, since the PO is still deciding;
a queue emptied or the setting turned off ends it; a hand start or "Vote again" replaces the
round and it with it. An empty queue never arms it, so the end of the list changes nothing.

Why a countdown: the final is the moment people read the result, and a round that starts under
them takes their cards away. Ten seconds is long enough to finish reading and to press "Stay",
short enough that the setting is worth having. A voting room is never touched: it arms only on
a recorded final, which only exists after a reveal. With the room's timer on, the timer starts
with the new round, as for any start, from when the round shows, so the countdown never eats
into it.

**Parsing.** In the page, pure, with no network: `apps/web/src/room/paste-queue.ts`. No request
ever leaves for a pasted link, and the raw text is not stored or logged; only the items go. A
header row is told by the trackers' column names in English, French and German, or, for names
it does not know, by rows of keys under a row without one. On plain lines a key is read in
capitals only, so "web-2 migration" stays a title; "UTF-8 support" reads as a key and a title,
and without a link becomes the same text again.

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

**Not tested.** The list samples are reconstructed from each product's documented columns, not
copied from a live board: nobody here has a Jira. Sven should paste one real list from each
tool after the merge.
