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
codes, never sentences. Tone per language decided in #41 (OQ-2): see the amendment of
2026-11-02.

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

**Amended 2026-11-02 (#41, OQ-2, Sven).** French says vous and German says Sie, everywhere,
to everyone: a tool that strangers open from a link addresses them formally, and one register
is one less thing to keep straight. The words each language uses are in
`docs/08-glossary.md`. `i18n.test.ts` fails on the informal pronouns and on a list of
imperatives (at a sentence start, or after "et", "und", "bitte") in a catalog, and on a German
Sie written small in an order or before the reader's own things. The lists are words, not
grammar: a verb that is not on them gets through, so a review reads the screens too.

## ADR-013: pnpm monorepo and the serial issue loop

**Decision.** `apps/web`, `apps/server`, `packages/domain`, `packages/protocol`;
TypeScript strict, Biome, Vitest, Playwright, Node 24 LTS, Docker multi-stage image,
GitHub Actions on pull requests. Work follows `CLAUDE.md`: one issue at a time,
issues keyed `PP-NNN` with `epic:*`, `P0–P3`, `type:*` and `size:*` labels, one
milestone per wave. **Alternatives.** A single package.

## ADR-014: Retention of 90 idle days

**Decision.** Rooms, their history and orphan guest users are deleted after 90 days
without activity (`ROOM_TTL_DAYS`). Rooms owned by signed-in users stay until deleted
(W5; since ADR-027, "owned" means the room's keeper, so a claim of the PO role moves nothing
here), and so does an account, until its owner deletes it (ADR-029). No analytics or tracking by default; Sentry and Umami are opt-in.

## ADR-015: Paid branding decided in W7

**Context.** The repo is MIT; under MIT anyone can remove a paywall from the code.

**Decision.** Everything stays MIT until W7. Branding is built as theme tokens,
asset slots and an entitlements check, so either open core (commercial `ee/` folder
and signed licence keys) or a paid hosted edition plugs in. Decided in #56 (OQ-3).

**Since 2026-11-03 (ADR-033):** a free tool for now. No paid option; W7 is parked.

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

**A room's code never travels.** `returnTo` is `/`, `/r/<code>` or, since #49, `/rooms`, and nothing else, checked by
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
client and no view shows it. A write-back will need the round to keep it too: not built. (Built
by #54, ADR-030.)

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

**What moves, keyed by the user id, the whole list.** In `room.live`: `ownerId`, `keeperId`
(ADR-027, on its own: a guest can hold the right to delete a room with no role and no seat, so
`roomsOf` finds those rooms through `room_keeper_apart_idx`), the key of `participants` (name, role, avatar, join time, presence), the key of `round.votes` (a seated
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
- **A room the guest keeps while someone else holds the role (ADR-027):** `keeperId` moves alone,
  and the account's list shows the room as theirs. A guest who took the role by claim moves the
  role and no right.
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

## ADR-027: My rooms: an account's list, a name through `apply`, and a delete every instance hears (2026-11-02, #49)

**Decision.** A signed-in person has a list of their rooms at `/rooms`, over `/api/my-rooms`. It
shows the rooms they own and the rooms where they hold a seat now; they can reopen any, rename a room
whose PO they are, delete one that is theirs (see *The keeper*), and leave the others. A guest has no list: the server refuses a guest on
every route, not only the page. On an install without provider keys nothing of this shows, and
`/rooms` is the page of an unknown address.

**What "joined" means.** A seat now, in `live.participants`, or the room being theirs (the PO who
is also the keeper, or the keeper). Someone who left or was removed does not see the room, and the
page says so in those words. So a PO by claim who gave up the seat is off the list as well: there
is nothing left to leave, and the role is free for anyone in the room. A record of every room a
person ever sat in would need a table, and would keep a link between a person and a room that
nobody asked to keep. The voter who left with a card on the table is the trap: `ROOM_PEOPLE` still
names them, so a row the index finds is checked again against `participants`.

**The query.** One person's rows come out of a `BitmapOr` of `room_owner_user_id_idx`,
`room_people_idx` and `room_keeper_apart_idx`, inside `with mine as materialized (...)`, cursor
included, and are then sorted and limited to 100 by `(last_active_at, id)`. The CTE is the point.
Written plainly, a person with 2,000 or more rooms older than most others got an `Index Scan
Backward` on `room_last_active_at_idx`: the `limit` made walking everyone's rooms look cheap, it
threw away 105,000 rows, took 150 to 170 ms and grew with the instance. There is an index for the
order, then, and the query must keep away from it. On about 118,000 rooms of 16 seats each, the
filter and sort take 0.6 ms and the request 6 ms for a person with 100 rooms, 13 ms and 17 ms for
5,000, the same for 5,000 rooms older than everyone's as for the 5,000 newest. So a list costs in
proportion to a person's own rooms, and never to the instance's. A test runs the real statement
(`myRoomsQuery`) on rooms older than 20,000 others, and holds the median request under the 300 ms
of the issue. One odd `round.number` reads as 0 and fails no list.

**Rounds are a number the room already holds.** `live.round.number` counts rounds started, the one
on the table included; a restart keeps its number. A count of `round_history` would read a room's
whole history per row, and a stored count would need a backfill on a live database. It differs from
the history panel by the round on the table and by rounds abandoned before a reveal, which is what
"rounds" means to someone scanning a list.

**A room's name goes through `apply`.** It was a column no command touched, and the page read it once,
so a rename would have stayed invisible in a live room. `renameRoom` is a server command: no socket
can send it, the PO alone may, from outside the room too, and `apply` holds the name to
`cleanRoomName`. Like the queue, the name is part of the state `apply` sees and has a column of its
own: `loadRoom` puts it in, `commitRoom` writes it, and `live` never holds it, so a header still
reads no state, and no migration or backfill was needed. An instance still on the old code in a
deploy reads no name and writes none. A snapshot carries `room.name`, optional, and a rename has its
cause and its line for a screen reader. Protocol version stays 5: an older page takes that snapshot as
any other, ignores the cause it does not know and the name it does not read, and shows the old name
until a reload.

**The keeper: claiming the role carries the room's use, not the right to destroy it (PO's decision).**
A claim exists so that a meeting can go on when the PO has gone. Anyone with the link can reach it, at
once from an owner with no seat, after 120 s from one who is away, and a room emptied by closing tabs
is there in about 3 minutes. It must not hand out something that cannot be undone. A review ran
it: a stranger joined by the code, claimed, deleted the room and its history, and the real owner's
list came back empty with no trace. So `live.keeperId` says who holds the right, and what the role and
the right do:

| What happens | The PO role | The right to delete (`keeperId`) |
|---|---|---|
| A room is created | the creator | the creator |
| The keeper hands the role over | moves | moves with it: it is the keeper's own act |
| Anyone else hands the role over | moves | stays: nobody can pass on what they do not hold |
| Someone claims the role | moves | stays |
| The keeper gets the role back, by a claim or from whoever holds it | moves | stays, and they can delete again |
| A guest signs in (`moveGuest`, ADR-025) | moves if the guest held it | moves if the guest held it, on its own |
| Kick, leave, rename | stays | stays |

A delete needs the person to be the PO **and** the keeper, in the statement (ADR-028 weighed a case
for a keeper the room's rule refuses, who cannot get the role back, and left it out). Rename stays
with the PO: it can be undone, and a meeting that goes on may want it. The field is server-held. No command
sets it, the strict wire schemas refuse it, `updateSettings` cannot reach it, and `toSnapshot` picks
its fields, so no frame carries it, which a test asserts; the list says `keeper` to that person alone.
The list and the page tell the truth: a role that came by a claim or from a claimer shows "You are
the product owner" with rename and leave and the reason in plain words, and no delete button; the
keeper's row says the room is theirs and how to get the role back. The server refuses all the same
(`not_keeper`, 403, an HTTP-only code). A row's `owned`, `keeper` and `seated` speak of the asker
alone.

*A room from before the field* has no `keeperId`, and `keeperOf` reads its PO. Every claim writes the
keeper down before it moves the role, so after the deploy no claim can be read as a right. What
this cannot see is a claim made **before** the deploy: that PO reads as the keeper. Refusing instead
until a hand-over was the alternative, and it is worse. A hand-over needs a second person present, so
someone alone with their own room could never delete it, and production's rooms have owners who are
guests: the rooms such a guest brings along by signing in later, months on, would be undeletable,
exempt from the purge, for ever. The fallback is exploitable only by a claim already made while the
delete did not exist, on a code the claimer already holds; nothing done after the deploy can use it.
For a guest owner the fallback changes nothing but this: a claim on that room writes the guest down,
and the guest's sign-in moves the right. In a rolling deploy an old instance can still run a claim
without writing it down, for the seconds both run; that room reads like a pre-deploy claim.

*`room_keeper_apart_idx`* (`0009`) is a partial btree on `live ->> 'keeperId'`, only for rooms whose
keeper is not their PO. A keeper with no seat is in no other index, and the list and `roomsOf` must
find that person: without it, the reviewer's stranger could no longer delete the room, yet the real
owner's list would still come back empty. Nearly no row is in it, so the migration builds next to nothing, in the moment a table scan
takes, and a commit pays nothing. The alternative, adding the keeper to `ROOM_PEOPLE`, rebuilds a big
GIN index and puts a read of it on every vote.

*What the keeper rule does not do.* Getting the role back needs the PO to be away or gone, by the
same rule as any claim, and a seat, which takes the room's password like anyone's. So a PO by claim
who sets a password and kicks the keeper shuts the keeper out until someone gives them the password:
the room survives and stays on the keeper's list, and nobody can delete it. Letting a keeper past
the password touches the enter path and the commit's grant check, for a case that destroys nothing,
so it stays out of #49. That is the price of the role being the room's use. ADR-028 has a twin: a
keeper that a room's rule shuts out has no row and no delete either, for the same reason.

**A delete is one statement, and every instance hears it.** `delete from room where id = ? and
owner_user_id = ? and coalesce(live ->> 'keeperId', owner_user_id) = ?`, judged on the row's latest
version. So the role and the right are read fresh without a lock: a claim or a hand-over that commits
first refuses the delete, and any commit after it loses its compare-and-set,
loads nothing and answers `room_not_found`. The cascades take `round_history` and `room_access` in
that statement, and a test lists every foreign key to `room`, so a later table cannot be forgotten.
Then `roomDeleted` tells every instance, and each closes the room's sockets after `deleted`, those
still entering included. The last close ends the room's timers (`forgetIfEmpty`). If Redis loses
the word, the next run on the room finds nothing and does the same. A room with a password loses its
grants with it. Not removed, on purpose: rate-limit counters, which run out; and a sign-in's return
path in `verification`, which runs out in ten minutes and then finds no room.

**A code stays out of addresses.** These routes name a room by its id, which logs already use. The
list gives codes to people already in those rooms, in the body of a `no-store` answer. Umami sees
`/rooms`, a fixed route.

**An id says nothing to a stranger.** Someone with no seat in a room and no right to it hears 404
`room_not_found` on all three routes, as for an unknown id, and nothing reaches `apply`: `apply`
resolves a passed deadline even for a command it refuses, so a refused rename could reveal a round
and move `last_active_at`. Someone who knows the room, by a seat or a right, hears why (`not_owner`,
`not_keeper`, `not_participant`), with no command run either: their page may be out of date, and
"no longer there" would be false. `apply` stays the fresh judge of whoever passes. The second of two
deletes at once reads the row again and hears 404, not that the room is someone else's.

**Settle first, within a second.** A guest's move can still be pending (ADR-025), and someone who
enters no room would wait for the next purge. So a list runs `settle` first: one read by index when
nothing is pending, at most a second otherwise. The move goes on; a list that could not wait says
`moving`, and the page offers to look again. A failing move never fails a list.

**Retention.** ADR-014's "owned by signed-in users" now reads the keeper, not the PO:
`coalesce(live ->> 'keeperId', owner_user_id)`, in a statement that reads `live` only for rows
already past the cutoff. Read by the PO it failed both ways. A guest's claim would have ended a
person's exemption with no act by that person, and the room would have gone after `ROOM_TTL_DAYS`.
An account's claim would have made a guest's room stay for ever, with nobody able to delete it. So a
claim moves no exemption: a person's room stays when a guest claims the role, and a guest's room
goes though an account claimed it, even from that account's list, so the page says any other room
"can go". Hand-overs still count, as they are the keeper's own act: a keeper who hands the role to a
guest ends the exemption, and one who hands it to an account gives it. A room moved from a guest is
the account's once its commit lands, and is held by the link until then. A room the person only
joined follows its keeper.

An abandoned room whose role was claimed: nobody but the keeper can delete it. A keeper with an
account sees it on the list, comes back, takes the free role and deletes it, or it stays, as that
person's room does. A guest keeper, or one gone: it follows the 90 days. A guest keeper's row can be
purged while the room lives on (`DELETE_GUESTS` reads the owner), since a guest with no session can
never come back; `keeperId` then names nobody, which reads as no exemption.

**Leaving** is the `leave` command as that person, through the room's queue, so the room hears it as
ever. It was cheap: `commandAs` is the room sync's own `execute`. The grant stays, as for a `leave`
over a socket.

**Considered and dropped.**
- *A `room_member` table, to order and page by index:* it would write on every join and leave, for a
  list of a few dozen rows.
- *A rename beside `apply`, writing the column and sending a signal:* a second write path, and the
  name could change under a command in flight.
- *Delete through the runner, as a step that ends the room:* the statement is already atomic, and the
  runner would grow a case for one caller. Its compare-and-set gives the same answer to everyone else.
- *Disconnecting without `deleted`:* a socket the server closes does not reconnect by itself, so the
  page would show the connection lost instead of the room gone.
- *A new `account_required` code:* the page knows who is a guest, and `not_allowed` says enough to a
  client that got here by hand.
- *Showing whether a room has a password:* the list has no need of it, and says nothing it need not.
- *Refusing delete to a role taken by claim by reading how it came:* a claim leaves no trace but a
  cause in a snapshot, and a claimer's hand-over would launder it.
- *A column for the keeper, beside `owner_user_id`:* a commit and a migration more, and a backfill, for
  what `live` and a partial index already give.
- *A backfill of `keeperId`:* it rewrites every room for what the fallback gives, and would only
  narrow a window of seconds. It cannot tell a claimed PO from a real one either.
- *`room_not_found` for everyone but the PO:* false for a person with a seat whose page is out of
  date, who would read "no longer there" about a room they are in.

**For #51** (answered by ADR-029). `deleteOwned` and `roomDeleted` are what deleting an owned room needs. An account that goes
leaves its seats in rooms it does not own: the list reads `live`, and `round.votes` can name it too.
It also has rooms it keeps without being their PO, and rooms it is the PO of without keeping them, and
`deleteOwned` refuses both. Find the first through `room_keeper_apart_idx` (`roomsOf` spells the
query). They need a decision of their own, as the person is leaving: delete them by `id` alone with
`roomDeleted`, since the right is that person's to use, even with someone else in the role, or set
`keeperId` to the PO so the room lives on. Do not leave it to name a deleted account: the purge would
take a room people still use once idle, and nobody could delete it before. In the second kind the
room is someone else's: run the account's seat out with a `leave` and hand the role on or leave it
free for a claim. A guest's sign-in never needs this: `moveGuest` moves both.

**Not tested.** Real Google and Microsoft sign-ins, as for #47.

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
Gmail address is a Gmail address and `gmail.com` in a rule admits all of Gmail. A verified address
proves that someone could once receive mail there, a shared inbox included, and the panel's hint
says so. `hd` would tell a Workspace account from a personal Google account opened on a company
address, which keeps `email_verified` after its owner leaves. The rule does not read it, as
requiring it would refuse real people on domains Google does not host. It is stored all the same
(`account.hosted_domain`, `0010`, PO's decision), as `tid` was before anything read it: a token is
not kept, and an account that exists today could never hand it over later, while production has no
keys and the column is free. Written at the account's creation, and a later sign-in writes nothing.

**Domains match exactly.** Lower-cased, whole: `example.com` admits neither `notexample.com` nor
`example.com.evil.net`, and not `mail.example.com` either. No subdomains and no wildcard: a rule says
what the PO typed, each one is a line away, and a suffix match is how the two refused above get in.
An international name is stored in its `xn--` form, made by the platform's IDNA (`domainToASCII` on
the server, `new URL` in the panel): the domain package has no `URL`, and accepts ASCII alone. The
ASCII form is what the join screen shows too: it cannot be spoofed by a look-alike letter, at the
price of reading badly. Both are URL parsers, which answer the host of whatever they are given:
`bücher.example/x` reads as `bücher.example`, and an address `a@example.com/ü` as `example.com`. So
nothing with a character no host holds (`/ \ @ : ? # % [ ]`) reaches one, and on the server what
IDNA gives back must be what went in, or a soft hyphen or a full stop of another script would be
quietly mapped: the entry stays as typed, and `cleanDomain` refuses it, as it takes ASCII alone. Plain
ASCII never meets a parser, which would turn `a@b.com/x` into `b.com`: `cleanDomain` refuses a
wildcard, an `@`, a scheme, a path, a port, an IP address, a trailing dot and a bare top-level name.
The same goes for the address a rule compares.

**Limits.** 20 entries in each list, each a domain of 253 characters at most or a GUID: in the
domain (`bad_restriction`), and in the protocol's strict schema at 64 entries of 1024 characters.
A rule with no entry is no rule: the page removes it with `null`.

**A stored rule is read as strictly as a typed one.** Only `apply` writes it, so a malformed one
takes hand-written SQL. But a rule is what keeps a room shut, and two such rules opened it: a JSON
`null` read as no rule, so the header showed the name, and `domains` as a string matched by substring.
So `requirementOf` reads the rule through `cleanRestriction`, and one that does not read as a rule
meets nobody's account: `restriction_unavailable`, for everyone but the PO, whose row shows an empty
rule to take off. `ROOM_RULE` keeps a JSON null from reading as SQL null where the state is not
loaded, and a change of another setting carries a malformed rule along instead of dropping it.

**The rule comes before the password, everywhere.** At `enter`, at `join` and at `POST
/api/rooms/:code/access`. Someone the rule refuses gets the rule's code whatever they typed: no
hash runs, no try counts, no grant is written, and the answers to a right and a wrong password
are the same bytes. A grant from before the rule does not pass it. Someone who passes the rule
still needs the password. So a refused person learns nothing of the password, and a person with
the password but the wrong account is refused.

**What a refused person learns.** Four codes: `sign_in_required` (a guest), `account_not_allowed`,
`session_too_old` and `restriction_unavailable`, the last two with a word of their own below. The
refused `enter` carries
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
it refuses, seated or not, and for a sign-in too old for the rule, as the role is exempt from the
age too: refused at the door after 31 days and handed the role, the same session would walk in as PO
and take the rule off (PO's decision, from the review). A claim goes by the claimer's socket. A
hand-over goes by the newest live `session.created_at` of the person named, from the server's row,
and someone with no live session is refused as well; `candidateOf` reads that in the statement that
reads their account, so a hand-over reads once, rule or no rule. `mayHoldRole` in `room-rule.ts` is
the one test, and #113's hand-over at an account's deletion uses it.
That costs a sliver of privacy, and it stays (PO's decision): a refused hand-over is one bit, about a
person the PO names, for each rule tried: that they would not pass, not why. It goes by the stored
rule and stores nothing, so another rule still costs a commit and `RULE_CHANGE_LIMIT` caps it as
before. The age adds what the count does not hold: someone the count passes and a hand-over refuses
has an old sign-in or none. That is the same one code and one bit, the same for every rule, and only
time moves it, so the limit does not cap it. The PO will see the same when that person next reloads,
and the rule's integrity is worth more.

**People already seated stay, and a reload is the end of that.** A rule applies to entering and
joining from then on. Nobody is kicked by the rule itself: the socket stays and keeps playing, seat
and vote. Their next `enter`, from a reload or a dropped connection, is refused, and **the seat goes
there and then, through `apply`, as `leave` takes it** (PO's decision): a seat that can never come
back helps nobody, and stored, it would stay shown, its card would count at the reveal, the panel
would count it as here, and its owner would have no way to give it up. Judged again in the run's
step, so a rule taken off meanwhile spares it. This is the choice between that and a seat that
survives until its owner leaves, and the refusal wins, for three reasons. A rule is a promise that
internal tickets stay internal, and a seat that outlives it would keep seeing them for as long as a
browser keeps reconnecting, which is days. The seat would become a way around the rule. And a
dropped connection ending a stay fails closed, which is the side to fail on (PO's decision). The
cost is that a blip of the network ends it for someone mid-round, who must sit down again with an
account that passes, which is why the PO reads it first: "They stay until they reload the page, lose
their connection or leave." A seat whose owner never comes back holds no socket and stays until the
PO removes it, as any away seat does.

**The PO sees a count, not a list, and can act on it.** `GET /api/rooms/:code/restriction`, the PO
alone, answers how many people here the stored rule would refuse, and what the PO's own account
proves. Not in the snapshot, which would read every seat's account on every vote. A count nobody can
act on is no use, so beside it stands one action, "Remove everyone who would not pass", which asks
first (PO's decision). `POST /api/rooms/:code/restriction/remove-outsiders` reads who is here and what
they prove afresh, and runs one `kick` through `apply` per person, each judged again in its step, so
a rule taken off spares them; it answers how many went, 10 presses in 10 minutes. The page names
nobody. The table shows who has gone, as with any kick, and that is the price of a list being acted
on. Anyone removed hears the removal, and is refused at the door if they come back.

**What a rule tells the PO, and what caps it.** A commit does not test one guess: a rule holds up to
40 entries, each a guess about everyone seated, read back by the count and by a refused hand-over. A
list of 20 domains and the bisection that follows found a person's employer in 2 commits in the
review. So committing a rule is capped: **5 commits an hour per account** (`RULE_CHANGE_LIMIT`, on
each instance, in a fixed window), so 200 entries an hour and at most 5 answers about one person, for
one account. It is a cap and no more: the role handed to a second account gets 5 more, and up to 10
fit around a window's end. A run that stored nothing gives its place back, whether it was refused or
the rule was already there and the version did not move; a resend is not counted twice, and taking a
rule off is free, as it tests nothing and a rule can always come off. It cannot be made nothing: a
short list of candidates needs few commits, and a PO who sets `gmail.com` and reads the count learns
something about the two
people in a room of two. The count reads the stored rule only (60 reads in 10 minutes), and there is
no preview of a candidate rule (PO's decision): a preview would test guesses with no commit, which
nobody hears. No address, provider or tenant ever comes back.

**One invariant, at the only place frames leave.** A socket on the join form holds snapshots, which
name people, and a seat is what lets someone stay past a rule. So everything about who may keep
receiving comes down to one line in `broadcast`: `admitted` keeps the gate a socket was judged
against (`gateOf`: the rule and whether there is a password), and **no frame reaches a socket with no
seat and no PO role unless that judgement is of the gate in the frame's state.** One that is not is
read again (`recheck`), gets nothing meanwhile, and hears `locked` if refused; the page enters again
and shows the refusal. A seat or the role holds no judgement at all (`UNJUDGED`), so the first frame
after they go finds it out of date. That one line closes what a list of causes kept missing: a second
tab of someone who leaves, an HTTP `leave`, an `enter` that raced a rule, a commit whose reply was
lost, a PO with no seat who loses the role to a claim. An `enter` judges its last load, reading then
whatever an earlier load gave it no reason to read, and a refused one keeps no pass. Nobody waits for
the next change to hear it: a rule's change (`settingsUpdated` with `restriction: true`, on the cause)
and a `left` are read as they are published, and an `enter` that finds a newer gate than it loaded is
read at once.

**With several instances.** Each instance sends its own sockets their frames, and the invariant runs
on each, on the state it loaded: nothing about a socket crosses Redis. The instance that commits
tells the others the causes, and each reads its own visitors, or the tabs of whoever left, when the
signal comes. A signal that is lost is met at the next version, which goes out `blind`, reading every
visitor; a visitor whose read began before it reads again, as that read may have found a grant the
lost change dropped, and gets nothing until the fresh read ends. A seat refused at `enter` on one
instance is a `leave` every instance hears.

**Sign-in, checked against #48.** A refused guest has no seat, signs in from the screen, comes
back as the account, and is judged afresh. A guest seated before the rule moves as ever: `moveGuest`
is the server's and takes no gate, and that is right, since the seat is theirs. It also opens
nothing: a seat lets nobody past the rule, so an account that does not pass finds its seat moved
and loses it at the door. A guest who reloads first loses the seat as a guest, and a sign-in then
finds none. A grant moves too, and passes nothing. Someone who signs out mid-room is a guest on the
reload and is refused, and the account's seat waits for them, as nothing refused the account. A socket
opened before a rule keeps what it had while it stays seated; a `join`, a hand-over and a claim are
each read fresh, and the session is read on every `join`.

**A sign-in is good for 30 days in a room with a rule.** What an account proves was true at sign-in.
A session slides, a day at a time, so someone who left a company would pass for ever by visiting
every 90 days. Only a new sign-in asks the provider whether the person is still there. So in a room
with a rule, a session older than `RULE_SESSION_MAX_AGE_DAYS` (30) by `session.created_at`, which
never moves, is refused with `session_too_old` at every door the rule has: `enter`, `join`, a claim,
`/access`, the header, and a visitor read again; a hand-over answers `owner_not_allowed`, above. The
screen says why, and the way is "Sign out", then
sign in. The seat stays: a new sign-in brings the person back to it, unlike a refusal of the account,
which goes first and takes the seat. The PO is exempt, as from every rule. A socket already seated
stays while it stays, like any seat; this is a door. The list hides these rooms until then, and says
so.

**"My rooms" (#49, ADR-027).** A list that named a room would undo the header's `name: null`. A row
brings the room's rule, and the person's account is read once for the page, so a list costs one
query more however many rules it holds. A room that would refuse them is off the list: the seat goes
when they next enter, and `POST /api/my-rooms/:id/leave` still gives it up. **A keeper the rule
refuses has no row and no delete** (PO's decision). A keeper is apart from the PO only after a claim,
so the person this rule shuts out is exactly someone the team has decided should not be in the room,
and a delete for them would be that person destroying what the team uses, which cannot be undone.
The other direction costs less: the room survives, nothing is lost, and it is the limit ADR-027
already records for a claimer who sets a password and removes the keeper ("The room survives; nobody
can delete it"). A loosening later is easy, and the other order could not be taken back. Their
`DELETE` is answered as anyone's without the role (`not_owner`, 403), which says nothing of the
room that its keeper did not know. So a stranger who claims a room and sets a rule that shuts its
keeper out is not answered: the keeper can neither open the room nor delete it, and it lives on.
**The keeper keeps the right**, though: if a later account or a changed rule lets them pass, the row
and the right come back, they take the role as ADR-027 says and delete as before, and retention
still follows the keeper. A delete for a refused keeper was built (`deleteKept`: the statement held
only while the rule that refused them stood) and dropped for this reason; Sven may ask for it back.
A rename stays the PO's, and the PO always passes.

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

**Protocol 6.** The refused `enter`'s `requirement`, the patch, the view and six ack codes. Each
alone is the kind of change that kept the version before, but a tab from before this has no screen
for these refusals and would strand on the generic error, so it is told to reload.

**Accepted.**
- A personal Google account opened on a company address, and a Google account whose owner has
  since left, keep `email_verified`. Requiring `hd` would close the first and refuse real people on
  domains Google does not host; the column is there for the day it is wanted.
- A provider's word is read at sign-in, and `user.email` is not updated on a later one. So someone
  removed from a tenant or a domain passes for up to 30 days in a room with a rule, and a socket that
  stays seated for longer. A room is not a company's identity system.
- A visitor with no seat keeps the feed past 30 days too: age is not in `gateOf`, so nothing reads
  them again until a `join`, a new socket or a change of the rule.
- A frame of a state from before a rule can reach someone after the rule landed, for as long as that
  instance's read takes. It is never a frame of a state under the rule.
- `outsiders` can be read as a test of a guess, and a refused hand-over as one bit, as said above.
- A stranger who claims a room and sets a rule that shuts its keeper out is not answered: the keeper
  has no delete, as said above, and the room survives with the right waiting.
- A second tab left open after a sign-out keeps the snapshots until its next command finds the
  session gone, as in any room: its seat is still there.
- An international domain reads as `xn--…` on the join screen.

**Alternatives.** A `room_restriction` table: the rule would need its own commit path and lose the
compare-and-set, for a list of 20 strings. Over HTTP like the password: there is no secret to keep
off the command pipeline, and #25's contract gives the panel its rollback for free. A domain rule
met by a Microsoft claim for verified tenants: Entra offers no proof of the kind Google's flag
gives, and the tenant rule says the thing directly. Subdomain matching: see above. Auto-kicking
those who do not pass: a table that empties itself mid-round is worse than a screen, and the PO
holds "Remove everyone who would not pass" for when it should not wait. A per-seat mark for the PO: a count at most. Checking the identity in the commit's
transaction, as `requireGrant` does: an account does not change under a command, and the state
does, which the step already sees.

**Not tested.** Real Google and Microsoft tokens, and real IDN addresses at Google: the stand-in
answers for them, so what the fields hold is read from their docs and Better Auth's code. No
provider keys are set on Sven's instance, so the row does not appear there yet.

## ADR-029: An account is exported and deleted by its owner, in an order that can always finish (2026-11-02, #51)

**Decision.** A signed-in person has a page at `/account`, linked beside "My rooms": a JSON file of
what the server holds about them, and a way to delete the account. A guest has neither: the server
refuses a guest on every route. On an install without provider keys nothing of this shows, and
`/account` is the page of an unknown address. This is the one step in the product that cannot be
undone, so most of what follows is about who may ask and what happens when it fails halfway.

**Who is asking.** A session started in the last 15 minutes (`RECENT_SIGN_IN_MS`, read from
`session.created_at`, which no visit moves), or the page sends the person through the sign-in with
`/account` as the return path (`isReturnPath`). So a browser left open, or a cookie copied a while
ago, deletes nothing. And a typed word, in a dialog, in the page's language: `DELETE`, `SUPPRIMER`
or `LÖSCHEN` (`ACCOUNT_DELETE_WORDS` in `@pp/protocol`). A word and not the person's name or address:
a Microsoft account may have no address, a name may be empty, and typing one's own name is no more
deliberate. The server does not know which language the page showed, so it takes any of the three,
in any case, NFC-normalised. The server checks the 16 KB body (the app's limit, ahead of the route),
that it is JSON, the origin, the session, that it is an account, a limit of 5 in 10 minutes per
person, the session's age, the shape of the request and the word, in that order; the page's dialog is
not the guard. The refusals are `sign_in_again` and `bad_confirmation`, HTTP only. A sign-in that picks
another account at the provider lands here as that account, whose name the page shows: `prompt:
select_account` stays, as a person who signed out must get a choice.

**The file.** `GET /api/account/export` answers a JSON attachment, `no-store`, 5 in 10 minutes per
person, after a guest's pending move (`settle`, up to 5 s; past that the file says `incomplete:
true`, and the page says so). Its shape is versioned (`ACCOUNT_EXPORT_VERSION`, `format:
"poker-planning-account"`): `profile` (name, address, avatar, when the account began), `signIns` (the
provider, since when, any `claimed_email`, any `hosted_domain`), `rooms`, `grants`, `votes` and
`connections`. In it: every
room that names the person, whether they keep it, sit in it, hold only the PO role or have only a
card on the table, and in each their own seat and whether a card of theirs lies there; the rooms a
password let them into (`room_access`), with the date; their own cards in named rounds, with the room,
round number, subject, the name they went by and the time. **Never in it:** a room's code; a token;
`account_id`, `tenant_id` or an `oid`, which they never saw; the stored Microsoft placeholder;
another person's name or card; a round's stats or final, which are the team's; the value of a card
on the table, as that round may be anonymous and no file maps a person to a value there (a named
round's card comes with `votes` once it ends). An anonymous round maps no person to a card, so it adds
nothing. Connections go by name alone (`listConnections`). A room whose rule refuses the person says
no more here than at its door (ADR-028): `{ id, withheld: true, seat }` in `rooms`, and a grant or a
card of theirs keeps its date and its value with no room name and no subject. The seat is their own
data and says nothing of the room: without it "what this server holds about you" would be untrue.
Someone the rule would pass, on a sign-in over 30 days old, reads the same for now, and that is no
refusal: a session slides and `created_at` never moves, so this is common. The file then carries
`signInAgain`, the number of rooms a new sign-in would show, and the page says so.

**No room codes.** A code is a bearer capability, and this file may be mailed around, kept in a
downloads folder or attached to a ticket. Rooms go by name and id. An id opens nothing, and the
page says so in words, beside the button.

**What happens to each room.** A room's right to delete sits with its keeper (ADR-027), and the PO
role can be elsewhere.

| The person is | Other people seated | What happens |
|---|---|---|
| The keeper | none | Deleted, with its history, even if someone else holds the role: nobody can take it. A keeper the rule refuses destroys nothing: below |
| The keeper | some, nothing chosen | PO and keeper go to the first in line, below |
| The keeper | some, one chosen | PO and keeper go to that person; if they left, as if nothing was chosen |
| The keeper | some, a room's rule allows none of them | Nobody holds the room: below |
| A keeper the room's rule refuses | any | No choice and no delete: the right goes to the first in line the rule allows, else nobody holds the room |
| The keeper | some, "delete" chosen | Deleted, with `roomDeleted`: the person chose, on a page that said what it does |
| PO by claim, someone else keeps | any | The seat goes, the role goes back to the keeper, the right stays; a keeper the rule refuses gets nothing, and the role is free |
| Seated, someone else keeps | any | The seat goes |
| A departed voter with a kept card | any | The card stays under a new id, with no name |

**A room is never deleted under other people without the person choosing that,** and a chosen
delete is the only path that does: `deleteAlone` is one statement that also requires no other seat,
judged on the row's latest version, so someone who joins first keeps the room for the hand-over. A
seat counts whether its person is here or away: an away seat is someone the room still expects.
Someone who left the room is no seat, so a room everyone left goes, with their history.

*Who is first in line* (Sven, 2026-11-02, replacing "seated longest"). One pure function, `heirsOf` in
`packages/domain`, gives the order, and `apply` and the page's overview both read it, so the default a
page names is the one the server keeps to, by rule; between the read and the deletion the room can of
course change, and the rule then decides on what is there.
1. The person chosen, if still seated and allowed.
2. Whoever else holds the PO role now, if seated and here: the person running the room keeps running
   it, and now holds the right too. The right and the role end with one person, not a split nobody
   chose.
3. People here, seated longest first.
4. People away, seated longest first.
`joinedAt`, then id, inside a step. Here means `connected`: a seat in its grace period still counts.
A person chosen who is away still comes first, as the choice was theirs to make. The page says who
the default is and why, in a line under the select, which follows the choice and which the select
points at (`aria-describedby`): the options hold names alone, as a reason does not fit one on a phone
(426 px of French in a box of 286). For a room nobody may take, the line writes out the outcome with
the days. The words above the list give the whole order. This path may not
refuse, as the id has to go, so where `transferOwner` refuses someone absent, this takes them when
nobody else is there.

*A claimed role goes back to the keeper.* `apply` has no rule that hands a free role to anyone: a PO
who left stays `ownerId`, and anyone can claim. That cannot stand here, as the id must go. So `ownerId`
becomes the keeper. With the keeper seated, they hold the role again; with no seat, the role is free
exactly as for a PO who left (`ownerClaimableAt: 0`), and the keeper's right stays. So nobody gains
a right they did not have.

*A room's rule* (ADR-028) can refuse someone, and a person a rule refuses must never become PO, by any
path. So `removeAccount` takes `mayTake`, the ids allowed to take the role; left out, everyone may.
Who is allowed is a matter of real identities, which `apply` cannot read: `removeAccount` on the sync
says. With nobody allowed, `keeperId` becomes `vacant`, and so does `ownerId` if the person held it. A
claimed role that would return to a keeper who is refused goes to `vacant` too, and `keeperId` stays:
the keeper gets nothing they did not have. In every case the person's id is gone, and `ownerChanged`
goes out only when someone seated took the role.

The one test is `mayHoldRole`, ADR-028's: it asks what the door asks, a sign-in under 30 days and a
live session included, and a guest fails any rule. It runs in the room's own step, on the state that
step will change, so a page's list that went stale and a request nobody's page sent both come to the
same answer. A step cannot read, so one that finds a person it has no reading of stores nothing, the
sync reads them (`candidateOf`, once each: at most `MAX_MEMBERS`, 32, as observers may not count, and
the keeper) and goes round again, three
times at most before a later run takes over. A room with no rule, and a seat that holds no right, read
nobody at all. The current PO passes, as every rule passes the PO. The person going is judged with
`goingCandidate`: their account, and no age, since their own deletion ended their sessions and took a
sign-in minutes old, so "no live session" says nothing of them.

*A keeper the rule refuses.* ADR-028 took such a keeper off "My rooms", with no delete: a keeper is
apart from the PO only after a claim, so a delete under a rule that shuts them out would destroy a
working room they can no longer see, for a right that needed the role. The same goes here, and more
so, as a deletion is not a thing one undoes. The page counts such a room (`held`) and says what comes
of it in one line, and nothing else: no seated name, no room's name, no delete, no heir. The file
gives the id and the person's own seat. `held` is for a real refusal alone: the page asks `mayHoldRole`
again with no age, and a person that passes is counted in `signInAgain` and told a new sign-in shows
those rooms. This reads only what the page and the file show. The deletion itself goes by
`goingCandidate`, and such a person has signed in minutes before it. On the server, `clearRooms` asks before either delete, `mayDelete` by the same
test, and each statement holds only while the rule and the PO are what was judged, so a rule or a claim
that lands between the two keeps the room for the runner to judge. There `heir` is dropped and `vacate`
is set, so a crafted `{ delete: true }` or `{ to }` changes nothing and can test nothing. With someone
allowed seated, the right goes to the first in line, as for anyone. With nobody else seated, where any
other keeper's room goes, this one stays, with `keeperId` under `vacant`, and the person's id goes all
the same. A PO who is someone else keeps the role.

*A room nobody holds.* `ownerId` is a required id, and a seatless `ownerId` is already how a room says
its role is free (`ownerClaimableAt: 0`), so `vacant` is a new random id in a user id's shape, made once
per room per run. Anyone the rule allows can claim the role, and `keeperId` stays `vacant` after a
claim, as for any claim. So a room can end with no keeper at all, which is the rule's doing: nothing
deletes it under the people seated, and nobody who is seated may hold it. `vacant` names no account, so
the room holds no exemption and follows `ROOM_TTL_DAYS`, from the hand-over, which counts as activity.
"My rooms" says so to whoever runs it, that nobody can delete it and when it goes, by a `noKeeper` it
gets from one read of `user` for the rows whose role and right are apart, and most lists have none. It
says no more than that: not who kept it. `not_keeper` no longer says the room belongs to someone. `room.owner_user_id` has no foreign key
and takes it as it took a keeper who has gone. It is not `ghost`: `ownerId` goes out on the wire, and
in a named round the same id on a card would say that card was the room's holder's.

*What a guest receiving a room means.* The exemption of ADR-014 follows the keeper, and a guest
holds none. A room handed to a guest stays while it is used, and goes after `ROOM_TTL_DAYS` idle. A
hand-over counts as activity, so that person gets the whole period, however long the room had
been exempt and idle before: otherwise the next purge would take a room just handed over. A guest
who signs in carries the right to the account (`moveGuest`) and the exemption comes with it. A seat
that merely goes is quiet: it moves no `last_active_at`, as a deletion elsewhere is nothing the room
did. The page says what a guest taking a room means.

*Who the page names.* The choice lists the people who may take the room, by name, in `heirsOf`'s
order, with `why` the first is the default, read at one `candidateOf` per person however many rooms
ask. Someone a rule refuses is not named, and with nobody left the select says it stays with no
keeper. A keeper with no seat, even one shut out by a password (ADR-027), reads those names: it is
their room, and the choice needs them. A password is a door, and a keeper may always have it changed;
a rule is about who may see the room at all, so a keeper it refuses reads none of this. The answer
holds no code.

**Every change to a live room goes through `apply`.** `removeAccount` is a server command, run by
the room's runner with the compare-and-set, as `moveGuest` is. No socket can send it, the strict wire
schema having no entry for it. The room's people see the existing paths: `ownerChanged` by
`transfer` and `left`, or `deleted`. A second run changes nothing.

*A card in a round still voting* goes, as a leaver's does. `settle` then applies the room's rule,
as for any `leave`: if the person was the last one waited for, the round reveals. No other card
moves and no other vote is lost. A deadline that has passed resolves first, as before any command,
exactly once, and then the card is a revealed card.

*A revealed card* stays. It cannot go: in an anonymous round the list that shrinks by one says
whose card it was (ADR-011), and in a named one it stands in the results on the table. It cannot
stay under the person's id. So the command carries `ghost`, 128 random bits in a user id's shape,
made once per room per run and for that card alone, and the card moves under it with no name and no
mark that it changed.
`voted` and the named `votes` list departed voters by id, so the new id puts it nowhere that follows
the person. A hash of the id would have let anyone who knows the id find the card.

*In an anonymous round nothing links the person to a card, in any frame.*
`packages/protocol/src/remove-account-secrecy.test.ts` deals the same cards differently among
everyone but one viewer and finds that viewer's frames byte for byte the same, before and after, with
the person seated or gone, with a card or without, as PO, keeper or neither, and whoever takes over.

**Named history is anonymised.** `who` and `name` go from every named round, in batches; the entry
keeps the card, and `stats` and `final` are not touched, so the results stand. An entry with `who`
null reads "Someone" in the history panel, as an old departed vote does. `changedAfterReveal`
goes too: it says something a person did, and makes the entry more recognisable.

*A place in the list must not name anyone.* A round's list runs in join order, so an entry left in
place would be "the third person who sat down". So such entries move behind the names, sorted by
card, and a second deletion sorts them again, so the order of two deletions does not show either.
The others keep their order. A hash of the id would stay the same across rounds and link them, so
there is no id at all.

*A round with one voter* keeps its one card, as its results are that card. It names nobody; but
someone who sat in that room remembers who voted, and two voters with one still named work the same
way, by elimination. The server cannot delete what people remember, and hiding the card would change
a result that belongs to the team. The page says so. The same goes for **exports other people
already hold**: the history's CSV and Markdown are round-level and never held a name, a person's
own account file holds their own cards, and a screenshot is theirs.

*A round rewritten later.* A revealed round with a recorded final has a row, and the row is written
again when the round ends, from `live`, where the card now sits under the new id: `who` is that
random id, `name` null. It names nobody and appears in that one row. Writing null there would need
`historyVotes` to tell it from an old departed vote, for nothing.

**What goes, the whole list.** `connector_token`, in the first step, with the marker: nothing needs
a token after that, so it never waits on a room, and again in every run, as a token saved after the
marker must not outlive a deletion that stays stuck. `user` (name, address, avatar); `session`; `account`
(with `claimed_email`, `hosted_domain`, `tenant_id`, `account_id`), `room_access`, `guest_link` on either side and the
marker, by cascade; `verification` rows of a sign-in in progress that name the person; a
guest still on its way to the account; in `live`: `ownerId`, `keeperId`, the seat, the vote and a kept
name; `room.owner_user_id` by the commit; `round_history.votes`, each `who` and `name`. The queue holds
no user id (ADR-024), nor do `round.stayed` and `round.advanceAt`. The password counters count per
room. Rooms and their history that go take their own rows. A place that stores a user id from now on
must be added here too: `account.db.test.ts` seeds a person into every table, searches every row of
every table in the catalog, JSON included, for the id, the name, both addresses and the `oid` as
text, and fails on a table it does not know.

**What stays, and is no longer the person's.** Cards with no name. Words typed in a room that lives
on: a room's name, a round's subject, a queue's tickets, as the server cannot know which speak of
someone. A guest's id left in an anonymous round by an earlier merge (ADR-025), which names nobody.
A room's `ownerId` naming a keeper who has gone, as ADR-027 already allows.

**What stays for a while.** In memory, all of it ending by itself: the rate limits by person
(`account|…`, `my-rooms|…`, `rename|…`, `avatar|…`, `password|…`, `restriction|…`), at the end of their
windows;
socket counts and message buckets, when the sockets close; acknowledged command ids, within their
time to live, in Redis too with several instances; presence timers, which name someone no seat holds
and do nothing. Logs hold ids, never a name or an address, and nothing in this path logs a person's
id; they age as logs do. **Backups** keep everything until they expire, and a restore brings the
account back. Nothing remembers who was deleted, since that list would be personal data of its own.
The README's Privacy section warns of it, and the page says so in plain words.

**A durable marker first, and everything can run again.** A transaction across rooms would hold a
lock per room around the runner, so each room changes alone, as for a guest (ADR-025). In order:
1. `begin`: `account_deletion` is written, with the person's choices, the person's sessions end and
   their connectors' tokens go, in one transaction. This is the only step that can leave the person
   as they were.
2. The sockets of the person and of any guest on its way to them hear `accountDeleted` and close, on
   every instance. A page reloads as a new guest.
3. Every room that names the person is dealt with, the lookup running again until none is left, for
   a command that was in flight.
4. Every named round loses the person, 200 rows a statement.
5. `finish`, in one transaction: lock the `user` row, in a statement of its own; read the guests;
   lock theirs; look again; delete `verification` rows that name the person, the guests on their way,
   and the `user` row, last. If a room or a round names the person after all, it changes nothing and
   the run goes round again.

Everything past `begin` runs again until it is done: at once, for up to 5 s while the page waits; at
every sign-in to the account and every `enter`; before every purge, so 3 to 5 minutes after a start
and then 24 hours after the end of the last run. Each step changes nothing once done, so two
instances or overlapping runs are harmless. A room that fails stops only step 5: every other room of
the person and of their guests is dealt with, and every named round loses them, in that same run.

**What fails how.**
- *The marker cannot be written:* 500 `internal`, and nothing changed. The page asks the session who
  this browser is now, and says "Nothing was deleted" only if it is still the account.
- *A room, or a later step, fails or takes over 5 s:* `{ finished: false }`. The page says the
  account is being deleted, that the person is signed out everywhere, that it finishes by itself
  within two days, and that a rare fault can take longer. It never says "deleted" unless the server
  said `finished: true`. Two days is what is true: a run that took too long goes on by itself, but a
  room that failed waits for the next sweep, up to 24 hours from the end of the last one, and a sweep
  can fail as well. Longer is real too: nothing ends a room nobody can read (below), and a sign-in or
  an `enter` that could start a run early is not something to count on.
- *The answer is lost:* the page finds no account in the session and says what it can: signed out,
  most likely deleted, and how to tell. With no answer to that read either, it says the request may
  not have arrived.
- *The session had already ended:* another tab signed out, and the server answers 401, or 403 for a
  guest. That is an answer, not a lost one: the page says the person is signed out and this request
  deleted nothing, with a way to sign in. A 403 to a browser that is still the account (a foreign
  origin, a proxy that rewrites one) says "Nothing was deleted", with the dialog open.
- *The process dies after the marker:* the next purge, 3 to 5 minutes after a start, finishes it.
- *A second request:* its session is gone, so it hears 401, and changes nothing. Two at once both
  pass the session check: `on conflict do nothing` keeps the first one's choices, and the second joins
  the run on that instance, or runs beside it on another.
- *A sign-in during it:* `session.create` asks for the marker and refuses: `account_going`, a message
  on `/`, no session, and the deletion runs again. Better Auth's `user.create` never comes into it,
  as the account row still answers. Once it is done, the same provider is a new person with nothing.
- *A sign-in that read no marker just before `begin`:* its session outlives the delete. Every run ends
  sessions again, and the cascade ends this one at the latest. That session can act for those seconds,
  and a seat it took is found by the next lookup, or stops `finish`.
- *A guest's move still pending:* the page's `settle` and the delete's give it a second. Past that,
  `begin` stops it, as `linkOf` reads nothing for an account on its way out, and the guest is the same
  person: its sockets close, its rooms are dealt with under the default, its rounds lose it, and its
  row goes in `finish`.
- *A join that passed its session check as the deletion ends:* an account's `join` commits only if
  the account's row exists (`requireAccount`, as below), so it lands wholly before, and `finish` finds
  the seat and goes round again, or wholly after, and writes nothing and is refused. No seat can name
  an id that is gone. A guest's join does not ask: a guest's row goes only by the purge, or with its
  account once the session that could join has ended.
- *A guest's move in flight on another instance as the deletion ends:* a move commits only if the
  account's row exists (`AccessWrite.requireAccount`, read `for share` in the commit), and `finish`
  takes that row `for update` before it looks. So a move lands wholly before, and `finish` finds the
  seat and goes round again, or wholly after, and writes nothing. A guest's link takes the same row
  by its foreign key, and `finish` reads the guests after the lock, so a link that lands first is
  seen, and one that lands after finds no account: the cascade never cuts a guest loose with seats.
- *A room deleted meanwhile,* by another person or the purge: the runner finds none, and it counts
  as done.
- *A retention purge beside it:* a room the person keeps stays exempt until it is dealt with, as
  they are a signed-in user until `finish`. A guest of theirs stays, held by the link.
- *A room whose state the domain cannot read:* fails every run, and the marker stands, with the person
  signed out, unable to sign in, and everything but `finish` done: every other room, every named
  round, the tokens. The `user` row, the marker and any guest on its way stay, as they hold the run
  open. Each run logs the room's id at the deletion's level, whether the room threw or its runner
  answered `failed`, and from a day on at `error`. **Nothing ends such a deletion by itself,** as for a stuck link (ADR-025): giving up
  would mean leaving a person's seat under an id that is gone. It takes someone who can look: repair
  the room's `live` or delete that row, and the next sweep finishes.

**After it.** The browser becomes a fresh guest on a page that says it is done: `get-session` finds
no session and clears the cookie, and the page's bootstrap makes a new guest. A later sign-in with the
same provider is a new person with nothing: no account row answers it, and the address is free.

**Where it goes.** A lazy `/account`, and its words stay out of the catalogs: `en.ts` loads with
every page, and the page's copy alone is more than the link costs. So `account/account-copy.ts` holds
all three languages in the route's chunk, `translateIn` reads them by the same rules, and `i18n.test.ts`
holds them to everything it holds the catalogs to. One word stays eager: the link. The room route
went from 184.9 to 185.0 kB. This is the "lazy catalog" of `docs/STATUS.md`'s chores, for one page.

**Considered and dropped.**
- *Deleting a room with other people by default:* an account's owner leaving must not take a team's
  room, and a deletion is the worst moment to find that out.
- *A grace period before the delete:* a person who asks to be gone is gone. The fresh sign-in and the
  typed word stand in for it, and a grace period keeps data nobody wants kept, for a recovery the
  product has no way to do.
- *An `account_required`-style check by the provider's `max_age`:* a provider's prompt proves nothing
  more than a new session, and two providers do it differently.
- *Keeping the `user` row as a tombstone:* it would keep an id and a date for no reader.
- *A list of deleted ids, to delete them again after a restore:* that list is personal data, in the
  backup too.
- *A stable pseudonym per person across rounds:* it links rounds, and anyone who knows one entry
  knows them all.
- *Removing the entry, or the card, from a named round:* the stats beside it would no longer add up,
  and the team's results would change.
- *Turning a round whose voters all went into `anonymous`:* more code for the same words on screen,
  and it would say less than the row does about how the round was played.
- *A `leave` run as the person, then a hand-over:* two commits and a state between them, with the
  id still in `ownerId`.
- *Clearing the cookie on the answer:* `get-session` does it on the next read, and a person whose
  answer was lost is covered the same way.
- *A retry timer in the process:* the purge's daily run and a sign-in cover it, and the page promises
  two days.
- *The person seated longest, whoever runs the room:* the first version of this. It took a room from
  the person running it, in the middle of a session, for someone who may have gone for coffee.
- *Refusing to choose, as `transferOwner` does for someone absent:* the id has to go, so this path may
  not refuse.
- *`ghost` as the free role's id:* see "A room nobody holds".

**Accepted, and not built.**
- *A copied cookie used within 15 minutes of the sign-in* can delete an account, with the typed word,
  which is on the page. That is what "recent" costs.
- *A deletion with no provider left:* an install that removes its keys leaves accounts that cannot
  sign in again, so a session older than 15 minutes cannot delete. The page stays, with no button to
  press: an operator removed the way in.
- *A room that can end with no keeper:* when nobody seated passes its rule. It has no owner who can
  delete it until someone allowed claims the role, and even then the right stays with nobody: it
  lives while it is used and goes after `ROOM_TTL_DAYS`.
- *A rule's verdict on a keeper is one sign-in old:* `goingCandidate` reads what the account proved at
  its last sign-in, as `mayHoldRole` does for anyone.
- *A very large list of choices:* 150 in a request, and the 16 KB body before that. Only rooms the
  person changed are sent.
- *An export of any size is built in memory:* there is no row cap on it. The limit of 5 in 10 minutes
  per person, and how much one person can have played, are the only bound.
- *A "delete this room" picked before the sign-in again is lost:* the redirect drops what the page
  held, so the select comes back at the default. The person sees it, and confirms again.

**Amends.** ADR-028 stands as written, and this reads against it so: a refused keeper keeps the right
for as long as the account lives, and the deletion ends that the only way that ends nothing else. Its
`mayHoldRole` is the one test here too, and #51 adds no second judgement, only `goingCandidate` for a
person whose sessions it ended itself. ADR-014: accounts no longer stay for ever. ADR-025's list of what holds a user id gains
`account_deletion`, an account's alone, which no guest move touches. ADR-027's question for #51 is
answered above: a room the person keeps goes to someone or goes, and a role by claim goes back.

**Not tested.** Real Google and Microsoft sign-ins, as for #47: the re-authentication ran on the
stand-in. A restore from a real backup. A deletion across a real rolling deploy: the races are forced
between statements, or on a second run.

## ADR-030: Jira Cloud through each person's own token, into the queue and back (2026-11-02, #54)

**Decision.** A signed-in account connects its own Jira by OAuth 2.0 (3LO). The PO of a room
imports by JQL or by a sprint, over HTTP, and the items go in through a server command, so `apply`
still decides. A recorded final goes back to the item it estimated, with that same person's token.
Everything is dark until `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `POKER_VAULT_KEY` and a sign-in
provider are all there: no route, no button, no tag in `index.html`. The code sits in
`apps/server/src/connectors/` and `apps/web/src/connectors/`, behind the seam `connector.ts`.

**Whose token.** The account comes from the session and from nothing else (`accountOf`, ADR-026).
The PO's own token imports and writes: never another seated person's, and never the keeper's for a
PO who claimed the role. A guest has none. A PO with no connection, or a new PO after a hand-over
who has none, writes nothing, and the page says so. There is no room-level connection: it would
act in Jira as someone who is not there, and Jira's history would name the wrong person.

**`state`.** Random, 32 bytes, single use, ten minutes, bound to the session that asked, and never a
room code: it goes to Atlassian. It lives in a row of Better Auth's `verification` table, so any
instance can finish what another began and the retention job already sweeps it, and the row holds
hashes: of `state`, of the session id, with the room's id to come back to. `take` is one `delete …
returning`, so two callbacks with one `state` get one row. A `state` from another session is
spent and refused. A connection starts with a POST under the same Origin check as every change, so
another site cannot begin one in a visitor's name, and the way back is `/r/<code>`, built by the
server from the id in the row: nothing the request says is read. No room code reaches any URL
sent to Atlassian.

**A token's life.** Atlassian rotates refresh tokens. They last 90 days of disuse and stay usable for
ten minutes after their use (Atlassian's "leeway"). Two instances refreshing at once is normal, so
there is no lock: `replaceToken` is the judge, the first write wins, and the loser reads what it
wrote and drops its own token. Two traps follow.

- An `invalid_grant` can be the answer to the loser of a race, outside the leeway, while the
  person's grant is fine. So the refused refresh waits 400 ms for a winner still on its way, and
  deletes the row only by compare-and-set on the version it read (`dropToken`, new). Atlassian
  says `invalid_grant`; reports from the field show `unauthorized_client` with "refresh_token is
  invalid" for the same thing, so both are believed the same way. Anything else from the token
  address (a 5xx, a timeout, a 429, whose wait goes through to the page) leaves the row. That does
  not always save the connection: a refresh that timed out after Atlassian rotated has lost the
  new token, the old one is good for ten more minutes, and past those the person connects again.
- What the connection points at (the site and the field) must not move `version`, or a person
  changing the field during a refresh would make the refresh's write lose, and drop a token Atlassian
  has already rotated. So it has a column of its own, `connector_token.settings`, unsealed since it
  is no secret, with `readSettings` and `writeSettings`. Not in the sealed value, and not a table
  of its own: it lives and dies with the row, and a save keeps it. Reconnecting keeps a site still
  on the person's list, with its field.

One instance makes one refresh per person at a time. A token Jira answers with a 401 before its time
gets one forced refresh and one more try. A 401 after that says something a refresh cannot cure,
such as Atlassian's `Unauthorized; scope does not match`, so it has a code of its own,
`connector_setup`: the row stays, the words are about the app's setup and not about connecting
again, and the instance remembers that token (by its hash, in memory) so the next call spends no
rotation. A call that works forgets it. Each instance spends one rotation to learn this, and one
more on the token that follows when this one runs out.

**Sites.** `accessible-resources` is read with the person's token. One site is taken; several are
offered. A site is stored only if it is on that person's list, read again at that moment. Every call
goes to `https://api.atlassian.com/ex/jira/{cloudId}/…`, the addresses are constants, a cloud id must
look like one before a token goes anywhere, nothing a client sends becomes a host, and redirects are
errors. The site's own address is used for one thing: the link of an item. A resource is listed once
and only with Jira in its scopes, since an id is not unique across Atlassian's products.

**Scopes.** `read:jira-work`, `write:jira-work`, `read:board-scope:jira-software`,
`read:sprint:jira-software`, `read:project:jira`, `offline_access`. The agile API takes its own
granular scopes, and `read:project:jira` is what its list of boards asks for; that is the only
reason a granular scope stands beside the classic pair. Nothing administrative, no user data.

These are not the least the code needs. `write:jira-work` covers creating and editing issues,
comments and worklogs, and deleting issues; the app only ever sends one number to one field. The
classic pair was chosen because it is short and is what Atlassian's API reference lists for search,
the field list and an issue's update, while a granular set would be longer and has to be proven on a
real site, and nothing here runs on one yet. Narrowing them is one list in `jira.ts` and one step of
the README, and it is Sven's call once he has read the consent screen: a person agrees to what that
screen says, not to what this code does.

**Import.** `POST /api/rooms/:code/connectors/jira/import`, the PO alone, signed in. `queueImport` is
a server command in `OWNER_ONLY`: the wire has no schema for it, so `source` still comes off no
socket, and `PROTOCOL_VERSION` stands. A search is a POST to `/rest/api/3/search/jql`, so a query is
in no URL. A sprint is searched by JQL too (`sprint = 7 AND issuetype not in subtaskIssueTypes()
ORDER BY rank ASC`): Jira has deprecated `GET /rest/agile/1.0/sprint/{id}/issue`, and one way of
paging is enough. The id is a number, so nothing can be written into that query. Pages are 100,
at most 10, and stop once the queue is full. A JQL has a cap of 2,000 characters and an empty
one does not leave. A page that fails in the middle adds nothing. `fitToQueue` takes what fits by
count and by bytes, as the page does for a paste, and says what was left out; what lies beyond the
last page read comes from `/search/approximate-count`, or the page says "more" when Jira will not
tell. A summary is cut to 200 characters with an ellipsis, as in a paste. One with hidden characters
keeps its key and link and loses the title, since a ticket should not vanish for a zero-width
space, and a key that is no key is counted as left out. An item already pasted stays as it is, a
duplicate, with no `source`: it can be estimated and not written back. Nothing from Jira is rendered
as HTML: an item is the queue's key, title and link, and the page draws them as text.

**`source`.** ADR-024 reserved `QueueItem.source` with `{ system, id }`, and nothing wrote it, so it
gains `site`, the cloud id, without a migration of data. `id` is Jira's issue id, not the key: a key
changes when an issue moves. A round started from an item keeps it (`Round.source`), "Vote again"
too, and `round_history.source` holds it, an additive column. It names no person. A snapshot says
only `round.system`, to the PO alone, and a history row `system`, to everyone in the room: the
tracker's name, no more than the link beside it already shows.

**Write-back.** `POST …/write-back { round }` sends the round's number and nothing else: the server
reads the final and the source from the round's row, which exists from the moment a final is
recorded, in the commit that stores it. So there is one way to read a round, for the one on the
table and for one long past, and a client can decide no value. Only `{ fields: { [fieldId]: n } }`
leaves, so an anonymous round gives nothing but its number. Refused, in order: no final, no
source, no number, no connection, another site than the item's, no field. The field is chosen from
the site's own custom number fields, with a guess by name shown and not saved until the PO
presses: nothing is written to a field no person looked at.

**Automatic, from the page.** A final this very tab recorded goes by itself, from the page, a moment
after the frame that confirms it. A press would lose to auto-advance: ten seconds later the round
is gone. On the server it would need a hook in the socket path, and a way to tell the PO how it
went. A failure stays as a line under the table, through the rounds that follow, with "Try again"
and "Dismiss"; the round is never touched.

The rule (Sven, 2026-11-02): the write carries the PO's token, so only the PO's own press may start
it. The tab marks its press of "Record" before the command leaves, and only the live frame whose
causes say that final was set, for that room, round and item, writes (`final-press.ts`).
Everything else waits for a press, with a line that says the final was not recorded on this page
and that someone else may have recorded it: a final found in a snapshot, from a re-entry, from
another tab or device, from anyone else, or after a hand-over. A snapshot from an `enter` has no
causes, so a tab that slept through a hand-over wakes to a line and writes nothing, though no
render of it ever saw the role leave. So the rule lives in `WriteBackLines`, not in the parent's
`me.isOwner`, which can only know who is PO now. A press refused confirms nothing, and a frame past
the version its answer gave is someone else's. This also
ends two tabs writing at once. A write a press would have started and a lost frame kept back
(several instances, a lost reply) waits too: that errs towards a person looking. The line goes
with a reload, and the history's "Write to Jira" on a past round is the way back to it.

**Failures.** The server sends codes (`CONNECTOR_ERROR_CODES`), HTTP only, so no socket message
changes and `ACK_ERROR_CODES` does not hold them; the page words them with the tracker's name in
`en`, `fr` and `de`. 429 carries `Retry-After` through, in seconds, at most an hour in both the
header and the body, and the page says how long. A 401 tries a refresh, then a dead grant asks to
connect again and takes the page back to "Connect", from whichever call found it, while a token
refused after the refresh is `connector_setup` (above). 403, 404, 5xx, a timeout (10 s on every
call, by `AbortSignal`, a stalled body included) and an answer that is not Jira's each have their
code, and a 400 means the query on an import, the field on a write, and a board with no sprints on a
list of sprints, which is an empty list: Atlassian answers a Kanban board that way. A failure holds
a code, never Jira's words, which can quote the query or an issue. `fetch`'s errors are dropped
for the same reason. Logs name the room by its id;
no token, code, room code, JQL, title or address is in one, and the redaction list gains `jql` and
`summary` for a mistake. Per person: 60 reads a minute, 30 changes in ten minutes, 10 imports a
minute, 60 writes a minute. They hold per instance, like every limit (architecture section 8).

A `state` that ran out while a consent screen stood open goes back to its room and says so, since
its row still names the room until the retention job sweeps it. One that is spent, swept or
another session's has no room to go to: the first page says what happened and links to "My rooms".
Keys that do nothing because the vault or a sign-in provider is missing say so at the start, in
one line naming the variable. A chunk of the connector that cannot load, as on a tab left open
across a deploy, says so in a toast and costs the room nothing: estimating never depends on a
tracker, so these chunks do not go through `lazy` and the error boundary.

**Disconnect.** Deletes the row. 3LO has no revoke endpoint in Atlassian's documentation, so the
page says that Atlassian keeps its own grant, and links to the person's connected apps.

**An account's deletion (ADR-029).** `begin` and `endSessions` delete the row. A refresh under way
cannot bring it back: `replaceToken` never creates a row. A connection under way could, since
`saveToken` is an upsert, so it writes nothing for an account with a deletion marker, in the one
statement. One that runs at the very moment `begin` commits is what `endSessions` is for.

**The seam.** `BacklogConnector` is what `routes.ts` needs: `authorizeUrl`, `exchangeCode`, `refresh`,
`sites`, `numberFields`, `guessField`, `boards`, `sprints`, `search`, `count`, `writeEstimate`.
`jira.ts` is its one implementation. `access.ts`, `oauth-state.ts` and `routes.ts` hold no word of
Jira's beyond the name a connector gives them. #55 adds a file, a `Connector` name it already has,
and whatever Azure DevOps makes of a site and a sprint.

**Alternatives.** A site and field inside the sealed value: no migration, and the race above. A table
of connections: a second thing to delete and to list for #51, for two strings. PKCE: Atlassian's 3LO
takes a client secret and asks for no PKCE, and `state` does the rest. `state` in a signed cookie:
not single use without a store anyway. A press to write: see above. A server-side outbox for
writes: a queue of retries for a harmless, repeatable call a person can repeat. The agile API's
sprint issues: deprecated. Import through `queueAdd` from the page: `source` would come off the wire.

**Not tested.** Everything here ran against a stand-in built from Atlassian's documentation and its
OpenAPI files. Real tokens, a real site, the leeway under a real race, what Atlassian does with
classic and granular scopes on one app, and the wording of its consent screen are for the live
check, which needs Sven's test site and app and a second person, since a private app refuses anyone
but its owner. The issue stays open for it. A rate limit that holds across instances does not exist
here (ADR-016).

**Limits.** A response's body is read whole by `response.json()` with no cap on its size. What bounds
it is the 10 s timeout and a fixed host at Atlassian: nothing a client sends picks the address, so
this is left as it is.

## ADR-031: Azure DevOps through a token a person pastes, for the field each item's type carries (2026-11-02, #55)

**Decision.** A signed-in account connects its own Azure DevOps organisation with a personal access
token. The PO of a room imports by WIQL or by a saved query, over HTTP and then `queueImport`, and a
recorded final goes back to the item it estimated, with that same person's token, under the rule of
ADR-030. An operator turns it on with `AZURE_DEVOPS_CONNECTOR=on`, and it also needs `POKER_VAULT_KEY`
and a sign-in provider. With any of the three missing there is no route, no button and no tag in
`index.html`.

**An operator's word.** It holds no key, so the first plan had the vault and a provider turn it on.
That would mean setting `POKER_VAULT_KEY` for Jira opens a form that stores third-party secrets for
every signed-in account, which nobody asked for. So it has a variable, though not a secret: exactly
`on`, and any other value or none leaves it dark without stopping the start. With `on` and the vault
or a provider missing, the start logs a warning that names the variables, as Jira's does.

**A PAT, not Entra, for now.** The issue allows either. A PAT needs no app registration and no keys,
and works for any organisation, also one with no Entra behind it, which suits a product others host
themselves. An Entra app is a tenant-side registration each operator would have to make, and
Microsoft's own advice is the other way round: a PAT is a long-lived secret a person pastes, it
carries that person's whole reach within its scope, and it ends by itself on a date. So the page
says what a token is used for, asks for the shortest life that suits, and shows the one scope to
tick; and the seam leaves room: Entra would be `OAuthSignIn` on this connector, a third way in
`AnyConnector`, with the routes Jira already has. Azure DevOps' own OAuth is deprecated and takes no
new apps, so that is not an alternative. A token here is made for one organisation, and the page says
so: this connector needs no more, and Microsoft is moving away from tokens for all organisations.

**Entra deserves a follow-up.** Microsoft says "Don't use PATs as long-term credentials for production
applications or services". A PAT can go inactive after 90 days in Entra-backed organisations, and
administrators can restrict PATs. Nothing is built for this now: a person's own short-lived token
for their own estimates is the modest use, and the refused state below is the way out when one stops.

**Whose token.** As ADR-030: the account comes from the session and from nothing else. The token is
used for that account's own actions, never another seated person's, never the keeper's for a PO who
claimed the role. A guest has none. A PAT is sealed by the vault as a `Grant` with an empty refresh
token and an end of `Number.MAX_SAFE_INTEGER`: the server does not know when it ends, Azure DevOps
does.

**A refusal never deletes a PAT.** A 401, a 203 and any 3xx on a call with a saved token cannot be told
apart, and none of them proves the token dead. In Entra-backed organisations a person may need to
"sign in to Azure DevOps and complete the full authentication prompt, and then try again", and "If
access is restored, a PAT that hasn't expired or been revoked works". The value is shown once, so a
token deleted over a false refusal could only be replaced by a new PAT. So all three read as
`connector_token_refused`, kept apart from Jira's `connector_reconnect`, which means the grant is
gone. No call answers that here and `refresh` answers the new code too, so `access.ts`, which did not
change, never reaches `dropToken` or the retry behind it. For the same reason `connector_setup`, whose
words name an app's scopes, cannot arise on this connector.

The page puts the alert, "Try again" and a form for a new token together, above the connection, which
stays as it was. The words are true of every cause: Azure DevOps refused the token or asked for a
sign-in; it may have expired, been revoked, or need a fresh sign-in there; try again after that, or
paste a new one. Nothing says "connect again", since the connection has not gone. "Try again" reads
the list of projects, the smallest call the saved token can make, and on success reads again what
could not be read. An import is pressed again, with the query still in its box. A new paste replaces
the row, and only if it passes the same checks as a first one. Disconnect still deletes it. A round's
line and a past round say the same and can be pressed again. No `X-TFS-FedAuthRedirect` is sent:
nothing depends on it now, and Microsoft warns it can refuse callers.

**Connecting.** `POST /api/connectors/azure-devops/connect { organization, token }`, under the same
origin check and limit as every change, and not room-bound: the token is the person's, not a
room's. The body is the only place a token ever travels. The organisation fits a strict pattern
(letters, digits and hyphens, 50 at most, no hyphen at either end) before anything leaves, and the
token has to be printable. The name is stored in lower case. The server reads before it saves,
`GET _apis/wit/fields/System.Title`:
the smallest answer that needs `vso.work`, which a token with only `vso.work_write` has by
inheritance. A refused read is followed by one more, `_apis/projects`, which any token reaches,
since `vso.project` or `vso.profile` suffice and `vso.work` inherits the latter through
`vso.hooks_write`: if that one works the token is good and lacks the scope (`connector_scope`), which
tells the two cases apart without reading Microsoft's words. Otherwise a sign-in page, a redirect or a
plain 401 is `connector_bad_token`, a 401 with TF400813 or VS30063 or a 403 is
`connector_no_access`, and a 404 is `connector_no_organization`. TF400813 also answers a made-up
token, as an anonymous user, and VS30063 is attributed to an expired token or a wrong scope, so
`connector_no_access` names all of those and does not claim the person is a stranger. A good token
costs one read here; only a
refused one costs a second. Then it lists the projects, before anything is saved, since a token that
cannot list them could not pick one: a 401, 403, 203, 3xx or 404 there is `connector_no_projects`,
which says the token works and what to tick, and a passing failure stays what it is. A row already
there is left alone. Microsoft's table supports `vso.work_write` alone listing projects on paper,
through scopes it marks as no longer public, and third-party guides list Project and Team (Read)
separately, so only a live run tells, and the README says so to the person making a token.

A read cannot show the right to write, and no read is a write. So a token with `vso.work` alone
connects, imports, and is told at its first write: a 401 on a write is followed by the same read as
above, and a token that still reads is `connector_scope`, with the row kept. A `validateOnly` write
would prove it at connecting, but it needs an item or a type, and a project picked first.

**The trap: not every failure is one.** Azure DevOps often answers a bad or expired PAT not with 401
but with 203 Non-Authoritative and an HTML sign-in page, or a 302 to one. `fetch` calls a 203 `ok`.
So `read` takes exactly one thing for an answer: status 200 with `application/json`. A 203, any 3xx
and a 401 are `connector_token_refused`. A 200 in HTML is `connector_unavailable`: a proxy's page says
nothing of the token.

**`redirect: "manual"`, and why not `"error"`.** Jira uses `"error"`, and the first plan here did too.
There, a redirect becomes a `TypeError` that reads like a dead network, so a sign-in redirect would say "not
answering" instead of what it is, and telling them apart means matching undici's message.
`"manual"` follows nothing either: a token still goes nowhere it was not sent, and a test holds that
the sign-in address is never called.

**Scope of calls.** Always `https://dev.azure.com/{organisation}/…`, from a constant, with
`api-version=7.1` pinned. Project ids are GUIDs, item ids are numbers, a field is a reference name of
a strict shape before it enters a JSON Patch path, and a type's or project's name is percent-encoded
and can be no `.` or `..`, no separator. A project comes from that person's own list, read again at
the moment of picking. Every call has a 10 s timeout and paging is bounded: five pages of projects,
five folders past the first call, 200 queries.

**No Azure DevOps Server.** Nothing a client sends becomes a host, so an on-premises server is out.
That is a limit, on purpose: its address would have to come from a person, and a server that fetches a
person's address with a token is what this design exists to avoid. It would need an operator's
allow-list.

**What a site is.** `Site` is a project: its `id` is `{organisation}/{project GUID}`, which the
connector takes apart and checks, so the seam's `site: string` carries it with no change. `Site.home`,
new and optional, is the organisation, and that is what `source.site` holds, because an item's id is
unique across an organisation and a write needs no project. So a PO connected to another project of
the same organisation can write, and one connected to another organisation gets
`connector_other_site` and no call leaves. `connector_token.settings` gains `organization`, kept
apart from `site` because a connection with several projects has no site yet. No migration: both
columns carry it. The same organisation connected again keeps its project and field. Azure DevOps
treats a name without regard to case, so a row or a queue item stored in another case is compared
in lower case and never refused for it. Jira's ids stay compared exactly.

**The seam.** It held, with four changes. `BacklogConnector` lost what only some trackers have, into
parts: `OAuthSignIn`, `PastedToken`, `SprintBoards`, `SavedQueries`, `ItemFields`. `jira.ts` has
OAuth and boards, `azure-devops.ts` the other three, and `AnyConnector` is the union `routes.ts`
narrows by `in`, so a route exists only for a tracker that has it and Jira's answers are as they
were. A connector names its import's schema (`query`), generic in `Q`, because a Jira body must stay
refused here and the reverse. `sites` takes an optional `home`, since a PAT does not say its
organisation, and `numberFields` an optional `type`. `FoundPage` gains `unreadable`.

**Import.** A WIQL is POSTed, so a query is in no URL, at most 4,000 characters, and an empty one does
not leave. A saved query is `GET wiql/{id}`. Saved queries come as a tree, and one call gives two
levels: `children` are walked, a folder is never offered, and a folder the first call left unread is
read by its id, up to five; past that the list says it is not complete. A tree or one-hop query
answers with links, not items, so ids are read from both and each kept once. Items come from
`workitemsbatch`, 200 at a time, with `errorPolicy: omit`, whose nulls for an item gone or hidden count
as left out. Only `System.Title` is asked for, and the id and a link built from constants are all that
reach the queue; the batch goes to the organisation, not the project, since a WIQL can cross
projects. `#52`'s limits hold through `fitToQueue`, and nothing from Azure DevOps is HTML.

**WIQL's cap.** Past 20,000 results Azure DevOps refuses a query (VS402337) unless `$top` is given, so
`$top=20000` always goes, and that is one answer of ids, about 1.4 MB at worst. Under the cap the page
says how many lay past the queue; at the cap it cannot know, and says "more lie past the limit". A
`VS402337` that comes anyway is `connector_query_cap`.

**The field.** The estimate goes to the one the item's type carries: Story Points (Agile), Effort
(Scrum, Basic), Size (CMMI), by reference name. A custom process can differ, so this is read and not
derived from a process's name. `fieldFor` reads the item's `System.WorkItemType` and
`System.TeamProject` for every write, then the type's fields. The type's list does not say a field's
kind, so the project's field list gives that, and a number field is `double`, `integer`,
`picklistDouble` or `picklistInteger`, writable, outside `System.`. The pair is cached for five minutes, by a hash of the token, so nothing one person
read reaches another, and it is dropped when a write is refused with a 400. A person may choose a
field for the connection from a type's own number fields; that choice wins where an item's type
carries it, and elsewhere the standard three apply: a choice made for stories must not stop bugs.
An item with none reads as `connector_no_estimate_field`, an outcome and not a failure, with no "Try
again". Unlike Jira nothing asks for a field first: a guess by name is not at stake here, since the
reference name is exact.

**Write-back.** The rule of ADR-030 unchanged, by the same code: `final-press.ts` decides, and a
final this tab did not record waits for a press. Only `[{ op: "add", path: "/fields/{field}", value }]`
leaves, as `application/json-patch+json`, to `PATCH _apis/wit/workitems/{id}`, so an anonymous round
gives nothing but its number. `add` sets a field whether or not it held a value, so writing twice is
harmless, and that also covers a `connector_timeout` on a write, which may have landed. Failures keep
ADR-030's codes where they mean the same. A `TF` or `VS` number at the start of Microsoft's message is
the only part of it ever read, and only to tell the cap and a token that is not let in. A query that
is gone is a 404 like anything else that is gone; a 400 on a write, a rule of the type, is
`connector_field_refused`.

**Words.** A site is a project here, and "Azure DevOps" takes "an" and, in French, an elision. So six
codes have `connector.azure.errors.*`, chosen by `connectorMessage`, and the rest are shared.

**Disconnect.** Deletes the row. A PAT outlives that at Microsoft, so the page says it exists until it
expires or is revoked, and links to the person's tokens page in that organisation.

**An account's deletion and export (ADR-029).** Nothing new was needed, and tests hold it: `begin` and
`endSessions` delete every `connector_token`, `saveToken` writes nothing past a deletion marker, and the
catalog-driven deletion test sees no new table or column. The export lists `azure-devops` by name.

**Alternatives.** Entra now: see above. A connection per project: a second row for one token.
`source.site` as the project: a PO changing project would be refused for an item whose id still holds.
`redirect: "error"`: see above. Reading Microsoft's words for a missing scope: they are not a contract,
and the second read does not need them. A separate route file for a pasted token: most of a route is
the same, and two copies of who may import is what ADR-030 kept to one. Deciding the field once per
connection, as Jira does: a project mixes types, and a Task has none.

**Not tested.** Everything here ran against a stand-in built from Microsoft's REST reference, and no
real organisation has seen this code. The stand-in answers as a review saw the service answer from
outside: an unknown organisation is a 404 in plain text, a bad PAT is a 302 to a sign-in address on
GET and POST and a 401 with TF400813 on PATCH, and a gone query is a 404 with TF401243. What a good
token that lost its scope, or an expired one, really answers is still a reading: a scope refusal as
401 or 403 (both are tested), `$depth` capped at 2, VS30063. That `vso.work_write` alone lists projects
rests on the inheritance table. The live check needs Sven's test organisation and a PAT, and a second
person, and the issue stays open for it.

**Limits.** A dead PAT stays sealed until a new paste, a disconnect or an account deletion: the server
cannot tell a dead token from one that needs a sign-in, so it does not guess, and a token nobody uses
again stays in the row until one of those three. It is of no use to anyone once it ended at Microsoft.
An organisation with more than 500 projects shows the first
500. A person who changes a project's process is believed for up to five minutes. A response's body
is read whole, bounded by the 10 s timeout and a fixed host, as in ADR-030. A rate limit holds per
instance (ADR-016).

## ADR-032: Azure is App Service with private Postgres, from a Bicep template and plain az (2026-11-02, #38)

**Decision.** Sven chose App Service (Web App for Containers on Linux) with Azure Database for
PostgreSQL Flexible Server, Postgres 17, over Container Apps (OQ-1). `infra/main.bicep` builds it,
and `docs/07-self-hosting-azure.md` is the guide. No image is published: the operator builds into
their own Azure Container Registry, and the site pulls through a managed identity with AcrPull,
so no registry password exists. **None of this has run on Azure.** It is written from Microsoft's
documentation of this date and compiled offline, and #38 stays open for Sven's run on a fresh
subscription. Claims below that rest on a single outside report say so.

**Plain az, not azd.** azd can deploy a container to App Service (`host: appservice` in `azure.yaml`),
so the change of service did not rule out the issue's azd. It still needs the template to own the
site and the registry, tags on resources, and an `azure.yaml` for one image, and its remote build
goes through the same ACR Tasks as below. The guide needs `az` for everything else anyway, so azd
would add a tool and save two commands.

**The image is not built with `az acr build`.** The Dockerfile's `RUN --mount` needs BuildKit. Microsoft
says tasks use `docker build` and documents `DOCKER_BUILDKIT=1` only for a task file, and one project
reports `az acr build` refusing `--mount`. Microsoft also says ACR Tasks are paused for subscriptions
funded by free credits, and a fresh subscription may be one. So the guide's main path is Docker on the
operator's machine, the same build CI runs, and `infra/acr-task.yaml` is the way without Docker,
marked as less certain. Rewriting the Dockerfile for the classic builder would give up its cache
mounts for one host.

**`X-Forwarded-For` holds `ip:port`, and `TRUST_PROXY=1`.** No Microsoft page we found says what App
Service's front end writes. One open-source project reports `203.0.113.7:51234` on a live Linux
container (ixpantia/faucet#278), and Application Gateway documents the same form. `clientIp` read that
as no address and fell back to the socket, the front end's, so every visitor would share one key and
25 wrong passwords from anyone would lock a room for all, the limit per address and room (the limit of
10 is per person). Keeping the port in the key would be worse,
since each connection would be a new client and no limit would hold. So the port goes first, for IPv4
and for IPv6 with or without brackets, which suits any proxy that writes this form. The guide's two
checks are what prove it: a forged header must not change the key, which relies on the front end
appending to what a client sends, and room creation from two networks must give two keys.
`X-Client-IP` was dropped as an alternative: one more variable for one host, and nothing from Microsoft
documents it either.

**Always On is enforced, and a tier without it is refused.** `@allowed` lists only Basic and up. The
retention purge needs a process that stays up with nobody connected, so a free tier would look fine
and quietly stop purging. A timer's server-side reveal needs the process only while someone is
connected: when the last socket leaves, the server drops its timer and the next arrival resolves the
deadline. Basic also has virtual network integration, managed certificates, and on Linux about 50,000
WebSockets per instance (Free has 5).

**Private access, no public Postgres.** A delegated subnet, a private DNS zone linked to the network,
and virtual network integration on the site, routing private addresses only. Routing all traffic would
send the connectors and Sentry into a network with no way out unless a NAT gateway is added. The price
is that `pg_dump` from a laptop does not work, and backups are Flexible Server's own. The subnet lists
the `Microsoft.Storage` endpoint because Azure adds it with the first server and warns against removing
it, and a second deployment with the subnet declared inline would otherwise remove it.

**`sslmode=verify-full`, with `require` as the way out.** `libpqUrl` gives `sslmode` libpq's meaning, so
`require` here does not check the certificate, unlike plain node-postgres 8. `verify-full` does, with
Node's built-in roots, and those hold DigiCert Global Root G2 and Microsoft RSA Root CA 2017 (checked in
the pinned base image), so the image needs no CA file. Microsoft warns that full verification may not
work with some DNS setups in a virtual network, and `verify-ca` needs a CA file in `pg`. So
`POKER_POSTGRES_SSLMODE=require` is a documented fallback: still encrypted, on a network nothing else is
in. Migrations use no `CREATE EXTENSION` (`gen_random_uuid` is core), so `azure.extensions` needs nothing.
The password is encoded with `uriComponent`, and a test holds that `pg` reads it back. The guide makes
it from a fixed `Pp1-` and hex, because Flexible Server wants three kinds of character and plain base64
misses that about once in 750 tries, at step 6.

**No Key Vault.** References are close to simple, but a reference that fails to resolve can reach the
container as literal `@Microsoft.KeyVault(...)` text, so a role still spreading fails a start in a
confusing way, and a vault adds a resource, a soft-deleted name and another role for a first-time
operator. The gain is small here: whoever can change a site's settings can get a referenced secret
through the app anyway. `@secure()` parameters keep values out of the deployment history, no output
carries one, and the two required ones have no default. `main.bicepparam` reads the environment, so it
stays committed and free of values; `infra/.env.azure` is gitignored and holds them.

**One way to deploy.** An upgrade is build, push and the same deployment, not `az webapp config
container set`: `imageTag` has no default, so a redeploy cannot roll an image back, and app settings do
not drift. `config/appsettings` replaces the whole list, so hand-made settings would be lost;
`extraAppSettings` is their place, and the template's own settings win over it. The site gets its image
last, in `config/web`, so that its first start already has its settings. The identity is user-assigned
so that AcrPull exists before the first pull.

**One instance, with affinity on.** More need `REDIS_URL` (ADR-016), and the plan's capacity is 1.
Affinity matters only when App Service runs two containers for a moment, and costs a cookie that
identifies nobody.

**No cost figure.** Microsoft's pricing pages showed `$-` to a plain reader on this date, and the retail
prices API is an Azure service, off limits for this work. The guide lists the meters and the calculator,
and names no number rather than a guessed one.

## ADR-033: A free tool for now, paid branding parked (2026-11-03, #56)

**Context.** ADR-015 left the licence and the price of branding to W7 (OQ-3). #56 asked for a
comparison of open core (a commercial `ee/` folder unlocked by signed licence keys) and a paid
hosted edition (Stripe). The comparison went to Sven as a private page, as this repo is public.

**Decision.** Sven, 2026-11-03: "free tool for now". Poker Planning stays a free tool under MIT:
no paid tier, no licence keys, no billing, no hosted edition. OQ-3 is closed.

**What follows.**
- #56 is done with this ADR. The issues name ADR-016 for it; that number went to Redis (#39).
- #57 (brand settings) and #58 (card faces) are parked, not built free. Code released under MIT
  cannot be taken back, so building branding free now gives away the one thing a paid option
  could sell later. Building them free is Sven's call.
- #59 (entitlements and billing) has nothing to gate. It stays open and parked, in case the
  question comes back.
- Nothing is added for a paid option: no `ee/` folder, no entitlement check. The seam that
  exists stays: every colour is a token (ADR-007), so branding starts from a token file.

**Revisit** when someone asks to pay, or when Sven wants branding built free.
