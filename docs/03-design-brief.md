# Design brief

Direction validated on 2026-10-26: **the boardroom table** (ADR-005). The clickable
prototype from round 1 is in `docs/prototype/round-1-decisions.html`. Open it in a
browser: its CSS holds the token values and the table geometry below.

## Principles

- **Calm and professional.** A work tool that happens to be pleasant, not a casino.
  One table, one accent, generous spacing.
- **The table is the stage.** Everyone sees who is still thinking; cards travel to the
  table and flip there. Results sit under the table, not on top of it.
- **Motion with a job.** Every animation explains a state change (voted, revealed,
  consensus) and is short. Reduced motion gets cross-fades.
- **Both themes designed.** Light and dark are tuned separately, never inverted.
  System default plus a toggle.
- **Phones first-class.** The table turns tall, the hand scrolls, targets are 44 px.

## Tokens

Every colour is a CSS variable; components never use literal colours. Branding (W7)
overrides a subset of these tokens.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F3F5F4` | `#0D1413` | page |
| `--surface` | `#FFFFFF` | `#141D1C` | panels |
| `--surface-2` | `#E9EFED` | `#1A2624` | chips, subtle fills |
| `--ink` | `#13201E` | `#E4EDEA` | text |
| `--ink-2` | `#4B5B58` | `#9BAEAA` | secondary text |
| `--line` | `#D3DCD9` | `#283836` | dividers and panel edges (decorative) |
| `--line-strong` | `#7A8A87` | `#647976` | control borders: inputs, switches, outline buttons |
| `--spruce` | `#1E5A53` | `#4A9B8F` | primary actions, focus of state |
| `--on-spruce` | `#F1F7F5` | `#0B1A18` | text on spruce |
| `--brass` | `#A87A22` | `#D8A744` | accent: card backs, highlights, timer, focus ring |
| `--brass-soft` | `#F4E8CC` | `#3A2E14` | badges |
| `--brass-ink` | `#5C410C` | `#F1D9A0` | brass-coloured text, on brass-soft, bg and surface |
| `--table` | `#22524C` | `#183B37` | table surface |
| `--table-rim` | `#173E39` | `#0F2926` | table rim |
| `--table-ink` | `#E7F1EE` | `#DCEBE7` | text on the table |
| `--card-face` | `#FFFDF7` | `#F5F1E6` | card faces (warm white in both themes) |
| `--card-ink` | `#13201E` | `#13201E` | card numerals |
| `--card-edge` | `#D9D3C3` | `#CFC8B5` | card border |
| `--good` / `--warn` / `--bad` | `#2F7A4D` / `#A86A12` / `#B0453B` | `#5BBE83` / `#E0A040` / `#E37468` | semantic only |
| `--warn-ink` | `#935A0C` | `#E0A040` | warning text |

Contrast rules (WCAG 2.2 AA, both themes, on `--bg` and `--surface`):

- `--brass` and `--warn` are for fills, accents and graphics (card backs, the timer
  ring, the focus ring, icons), never body text: in the light theme they reach only
  3.5:1 and 4.0:1. Text in those hues uses `--brass-ink` (8.7:1 or more) or `--warn-ink`
  (5.2:1 or more).
- Borders that show where a control is (inputs, switches, outline buttons) use
  `--line-strong` (3.3:1 or more, WCAG 1.4.11). `--line` (1.3 to 1.5:1) only
  separates content that is identifiable without it.
- `apps/web/src/theme/tokens.test.ts` checks these ratios from this table.

Avatar placeholders (until W4): initials on one of eight colours (`--av1` … `--av8`)
derived from the user id, white text, readable in both themes.

## Typography

- **Archivo** (variable width): headings at width 104–120 %, weight 700–820; card
  numerals at 110 %, weight 800. The wide, sturdy figures read like printed cards.
- **IBM Plex Sans**: interface text, 15 px base, line height 1.6.
- **IBM Plex Mono**: labels, codes, keys (`PAY-482`), small uppercase captions with
  0.06–0.08 em letter spacing.
- Self-hosted with `@fontsource`; tabular numerals for statistics and timers.

## The table

Seats sit on an ellipse; the viewer is always at the bottom, the others clockwise.
Positions are percentages of the stage, so one formula serves every width:
`left = 50 + rx·cos(θ)`, `top = 50 + ry·sin(θ)`, `θ = 90° + i·360°/n`.

| | Desktop (stage 16:9, at least 540 px tall, at most 992 px wide) | Phone: 608 px of room or less, a 640 px viewport in the shell (stage 4:5.4, at most 480 px wide) |
|---|---|---|
| Table insets (left/right, top/bottom) | 17 %, 19 % — wide stadium | 23 %, 18 % — tall stadium |
| Seat radii (rx, ry) | 42 %, 42 % | 40 %, 42 % (dense: 42 %, 42 %) |
| Card slot radii | 25 %, 23 % | 17 %, 25 % (dense: 21 %, 25 %) |
| Seat | 40 px avatar, name 90 × 16 px | 32 px avatar, name 64 × 14 px (dense: initials in a 44 px target) |
| Slot card | 36 × 50 px (dense: 30 × 42 px) | 27 × 38 px (dense: 20 × 28 px) |
| Dense above | 12 people | 10 people |
| Status box in the centre | 140 × 96 px | 68 × 60 px |

- A seat's point is its avatar's centre; the name sits on the side away from the table
  (above the avatar in the top half, below it elsewhere).
- The centre of the table shows the status (`5/8 voted so far`), the timer ring, or
  after reveal the suggested card with agreement or a **Consensus** pill.
- Until #19 to #21 (#18): while Voting the centre says "1/2 voted so far" (people away
  count once they voted; a PO who does not vote never counts). In the lobby and after a
  reveal the PO gets one button there, drawn as a card face (warm face, card ink, 44 px
  tall, two lines on phones): "Start voting", then "Next round"; everyone else reads
  "Waiting for the PO" or "Cards revealed".
- The reveal (#19). While Voting the PO's centre holds the count above a "Reveal cards"
  button in the same card-face style (key R, shown to assistive tech as
  `aria-keyshortcuts` and named in the button's title). On phones the count drops to
  10 px; the two still stand about 71 px tall in English and French and 84 px in German
  (the button wraps), so they overflow the 68 × 60 box onto the felt, centred, without
  reaching a card even with 16 seats.
  Nobody else gets a button. After the reveal the PO's focus moves to "Record 8", the
  final estimate's button under the table (#32), when it was on the button (or nowhere);
  to the picker when nothing is preselected. A named reveal turns the seats' cards face up; the
  seats then read "Ana, card 5". An anonymous reveal leaves each voter's seat with its
  voted badge and an empty outline (the card went to the row), and a "Cards played" row
  of mini cards under the table holds every card in the deck's order, with nothing that
  points at a person. After a named reveal, every vote without a seat shows in a "Not
  at the table" row under the table (mini card, then the name on up to two lines): a
  voter who left after the reveal keeps their name, and one who switched to observer, or
  came back as one, shows there too, since their vote still counts.
- The results (#20). After the reveal the centre shows the suggested card as a mini
  card with "Agreement 29%" under it, or the card and a **Consensus** pill (brass-soft,
  brass-ink) when at least three votes agree, or "Nothing to count." when no card
  counts. A deck without numbers suggests its most voted card; when the top count is
  shared it shows the tied cards with "Tie", as the panel shows "M · L", never one card
  of the tie. The figure is labelled as the team's agreement, the panel's word, because
  that is what it measures: the share of the most voted card, not support for the
  suggestion. Votes 3, 3 and 13 suggest 5, which nobody played, with "Agreement 67%"
  (PO decision, 2026-10-27). Since #32 the PO's centre is everyone's: "Next round" moved
  under the table with the final estimate, and the centre stacks the card over the pill
  or the caption. With a recorded final it turns compact (below). Named rounds whose
  cards differ mark the lowest and highest voters with an arrow (down, up) in a spruce
  disc at the avatar's bottom right, the voted check's corner, free after a reveal; the
  seat's label adds "lowest card" or "highest card". Anonymous rounds never do.
- The round's subject (#21). Above the table everyone reads the round: "Round 3" alone,
  or "Round 3" in ink-2 before the title (semibold, at most two lines, then an ellipsis;
  the whole title on hover) or the link. A link is a small surface-2 pill that opens in
  a new tab: the key's chip ("PAY-482" in mono spruce, "#12345" for Azure DevOps) when the server found one, else the shortened
  URL (no scheme or `www.`, at most 40 characters, the full URL in its title), then an
  external-link icon; 44 px tall on phones. The PO's controls sit above that line: a
  "Subject of the next round" field (max 576 px wide, the whole width on phones) with
  "Leave it empty for Round 4, type a title, or paste a link to the ticket." under it;
  while Voting the hint reads "Round 4 will start with this subject after the reveal."
  The field stays in every phase (PO decision, 2026-10-27): the table never jumps at a
  reveal, and the PO can paste the next ticket while the team votes. Only the centre's
  "Start voting", "Next round" under the table after a reveal (#32), and "Vote again"
  start a round, or Enter in the field in the lobby or after a reveal; while Voting the PO cannot abandon the round from the page. A refused
  subject shows under the field (`bad` icon, the reason: too long, a link that is not
  http or https or carries a user name) and nothing is cut.
- The final estimate (#32). Recording is explicit: nothing is recorded by itself, so the
  history shows decisions, not guesses. After a reveal the PO's decision sits right
  under the table (and above the results): a radio group labelled "Final estimate" with
  the round's deck without the specials as small cards (36 × 48 px, 32 × 44 on phones,
  wrapping on a long deck), then "Record 8", "Next round" (outline) and "Vote again"
  (ghost), in that order for the keyboard too. The suggested card (or a consensus) is
  preselected, so one press records it; on a tie, or when nothing counts, nothing is,
  the tied cards wear a small "Tie" mark, "Record" waits, and a line asks the PO to pick.
  Arrow keys move the pick; the pick lifts with the hand's brass ring. Once recorded the
  button reads "Recorded" (a check) until the PO picks another card, which changes the
  final while the round stays revealed. A held key's repeats never record or start.
  Everyone's centre, named or anonymous rounds alike, then shows the final under the
  result, set apart from the suggestion: its mini card with a 2 px brass outline beside
  "Final estimate", said as "Final estimate: 8."; the result turns compact (card beside
  its caption), and on phones both cards shrink to 18 px chips, the stack at most 76 px
  wide. A final recorded on screen pops in (crossfade under reduced motion). The live
  region says "The PO recorded 8 as the final estimate." or "The PO changed the final
  estimate to 13.", once, to everyone. Measured clear of every card at 4, 8, 10 and 16
  seats, in English, French and German, on desktop and at 360 px, for the PO and a voter
  (`final-estimate.spec.ts`): SIZES.
- "Vote again" (#32): the PO's secondary action beside "Next round". It keeps the
  subject (the title, or the link with its key) and starts a new round with the next
  number, the votes cleared and the timer as at any start; the revealed round stays in
  the history with its votes, so it asks for no confirmation. The live region says "The
  PO started a new vote on the same subject." The focus goes to the hand, as after
  "Next round".
- Observers sit off the table (a small row under it) so voters keep the seats.
- The others follow the viewer clockwise in join order, starting with whoever joined
  after the viewer, so the order around the table is the same for everyone (#16).
- Joining (#16): the room page shows a "Take a seat" card (name, prefilled with the last
  one used; voter or observer, voter by default) until the viewer is in the room; the PO
  joins the same way. A full room shows "This room is full" instead, and turns back into
  the card as soon as someone leaves; the name field then takes the focus and "A seat is
  free" is announced politely. When observers do not count and only the seats are
  taken, a voter is told so on the card and can join as an observer. Under the table a
  "You" panel renames, switches between voter and observer, and leaves the room.
- With more than 10 people on a phone, seats show initials only; names on tap. Every
  seat opens the same way, on tap or by keyboard: a popover with the whole name and what
  its badges mean ("Product owner · Away · Voted"). Every seat is a button whatever its
  state, so the focus never drops when someone votes or goes away.
- Seat states (#17). Badges sit on the avatar, never under the name (a chip there breaks
  the geometry), each a shape in a disc overhanging by 4 px, inside the seat's halo:
  the check (voted, `--good`) bottom right, a crown (the PO, `--brass-soft` with
  `--brass-ink`) top left, a moon (away, `--surface-2` with `--ink-2`) top right. Away:
  the avatar's disc turns `--surface-2` with a dashed `--line-strong` edge and its
  initials `--ink-2`, at full opacity (about 6:1 in both themes: on a dense phone table
  the initials are the only name), and the name turns `--ink-2` (still 4.5:1); the dashed
  edge also marks it in forced colours. The seat's label says "away" and its popover
  "Away". The viewer: a 2 px `--spruce`
  outline 2 px outside the avatar's ring (an outline, so forced colours keep it) and the
  name in `--spruce`. The observers' row writes "Product owner" and "Away" after the
  name. A voter's face-down card stays in the slot while they are away.
- Avatars (#17): initials and colour are unique at the table. Colours come from the id:
  the first person in join order with each colour keeps it, whatever the others do; the
  people who gave way then take, in join order, the least used colour after their own
  that nobody with the same initials has. So a rename changes no colour, and a leave
  moves only people who gave way. Up to 8 people get 8 different colours, and past 8
  twins the second letter becomes a number ("A2"). A name ending in a number keeps up
  to two of its digits, so "Guest 1" to "Guest 16" read "G1" to "G16".
- The table picks its variant from the width its container gives it, not from the
  viewport, so any page can host it.
- #13 proves the geometry for 1–16 people in every room from 328 px (a 360 px phone)
  to 1600 px (`apps/web/src/table/layout.test.ts`, and Playwright on the real page with
  the same rules): no seat within
  4 px of another seat or of the table's stadium shape, no two cards within 2 px, every
  card on the felt inside the 7 px rim and clear of the status box. The first numbers
  (round 1) failed it: names dipped into the rounded table ends, and 16 slots touched on
  narrow screens. The changes above are the smallest set that passes; the code holds
  them in `GEOMETRY` (`apps/web/src/table/layout.ts`).

## Phones

As built (#22), for 640 px and below (the `phone:` variant) unless stated:

- **Page.** `viewport-fit=cover`; the shell's gutters are `max(16 px, the safe-area
  inset)` on each side and its header clears the top inset, so nothing sits under a notch
  and the table still gets 608 px of a 640 px screen. The room page starts 8 px under the
  app's header (12 px on a short screen).
- **Header.** Two rows: the room's name (20 px) beside the copy-link button, drawn as a
  44 px icon whose name stays "Copy the link"; then the code chip, the connection and the
  people count on one line. The code's label is for screen readers only, and a live room
  shows a `--good` dot (`CanvasText` in forced colours) with "Connected" for screen
  readers; connecting and reconnecting are written out. On every width the connection and the count now sit in the header
  beside the code (`RoomPresence`), not on a line of their own above the table.
- **The PO's subject field.** On a phone and on a short screen (the `squat` variant), the
  label sits small (0.6875 rem, 11 px at the default text size, `--ink-2`) inside the
  field's top edge. The hint shows only while the field has the focus, as a small surface over
  the subject line, not in the flow: a tap on "Start voting" blurs the field, and a hint
  that collapsed then would move the button from under the finger. After a refusal the
  hint and the reason show in the flow, as on desktop. The field now costs 44 px instead
  of 140.
- **The hand.** One line that scrolls, with mandatory snap points: a swipe comes to rest
  with a card in the middle, never half under an edge fade. Cards stay 44 × 64 px, whole
  touch targets. When the vote lies under a fade or beyond (a reload), the hand scrolls it
  to the middle, itself a snap point. Arrow keys, Home and End, the roving tab stop and
  the 300 ms guard after a placed focus are #18's and #21's; a card the arrow keys focus
  is centred the same way when it lies under a fade, and the page does not move.
- **The docked hand (PO default).** While the team votes, on an upright phone (640 px
  wide or less and at least 520 px tall), the hand's panel can be sticky on the bottom
  edge: a sheet with rounded top corners and the panel shadow, its padding above the home
  indicator (`env(safe-area-inset-bottom)`), within thumb reach whatever part of the table
  is in view. It docks only when the screen is tall enough: at the top of the page the
  table, the PO's "Reveal cards" in its centre and the viewer's seat and slot must end
  above the docked hand. Otherwise the hand stays in the page under the table, as on a
  phone on its side, and the person scrolls to it. Docked, the hand's hint is for screen
  readers only, so the dock is one card high (about 97 px) in every language. Sticky, not
  fixed, so it keeps its place at the end of the flow and can only cover what lies above
  it (the table, scrolled up), never the "You" panel under it; the page's
  `scroll-padding-bottom` is the dock's height while it is docked, so a seat or "Reveal
  cards" that takes the focus stops above it. A vote's card flies to the seat only when
  the slot is on screen and above the dock; otherwise the card just lifts. It docks only
  while Voting: the results come with the reveal and sit above the hand, so after a
  reveal the hand returns to the page under them. At 390 × 844 with 8 people the PO
  (field included) and a guest see the subject, the whole table and the docked hand at
  the top of the page without scrolling, in English, French and German and with a
  two-line title; at 150 % text, at 390 × 664 (an iPhone 13 in Safari) and on an iPhone
  SE the hand stays in the page (`e2e/mobile.spec.ts`).
- **Results** stack under the table, then the hand, then the "You" panel.
- **Seats.** Initials only above 10 people, in 44 px targets (#13). Initials and colours
  are unique at the table (#17); two people with the same name share initials in two
  colours, and the second one is "Ana Lima (2)" wherever a name shows: the seat's name
  and its popover, the observers' row, the results' lowest and highest, the votes not at
  the table and the "You" panel, so every seat has a name of its own, seen and heard.
  The numbers follow the people in the room now, in join order: when the first Ana
  leaves, the second one's "(2)" goes. Someone who left keeps the plain name the server
  kept for their vote. With 16 seats at 360 px no avatar, badge or target touches
  another (`e2e/mobile.spec.ts`).
- **Slot cards at 16 people.** The dense phone slot stays 20 × 28 px: 21 × 29 px already
  touches its neighbours at 328 px (`layout.test.ts`). Its label gets an 11 px font and
  1 px a side instead. Any card label that would shrink below 80 % of its size uses
  Archivo's width axis at 70 % instead of 110 % and grows back: "13", "XL" and "XS" show
  at 11 px, "100" at 10 px, "XXL" at 7 px, and "XXL" in the PO's tie chip at 8.5 px. The
  slot is a glance; the seat's popover says the card in words and the results' columns
  repeat every card at 24 px.
- **A phone on its side** (844 × 390) is wider than 640 px, so it gets the desktop table
  and header in a compact form (the `squat` variant, 480 px tall or less: a smaller name,
  tighter gaps, and the PO's subject field in its phone form, the label inside and the
  hint shown only while it has the focus). `squat` comes after `phone` in the stylesheet,
  so a small phone on its side (568 × 320) gets the squat rules. The hand never docks
  there, where it would cover a third of the screen. The table, the hand and the
  controls do not overlap; the page scrolls between them: the table keeps the desktop's
  540 px stage, and a table drawn for short screens is for later (PO decision, #22).
- **Haptics.** A 12 ms `navigator.vibrate` tick once the server confirmed the viewer's
  vote, where the browser has it (Android). Safari on iOS has none, so nothing happens
  and nothing fails; never under reduced motion; never the only feedback (the card lifts,
  the seat turns, the hand's live region speaks).
- **No sideways scroll** from 320 to 640 px in English, French and German, in the join
  form, the lobby, voting (with a long title, and with the field focused) and after a
  reveal (`e2e/mobile.spec.ts`).

## Room settings

As built (#25):

- **Where.** A button in the room header beside "Copy the link": "Room settings" with a
  sliders icon for the PO, "Room rules" with a checklist icon for everyone else (on a
  phone and up to 900 px wide, the 44 px icon alone, its name for screen readers, so a
  long room name keeps its room). Everyone sees the same panel; only the PO gets
  controls.
- **The panel.** A modal sheet: from the right, up to 28 rem wide, on a wide screen; from
  the bottom on a phone (640 px or less), the screen's full width, at most 88 % of its
  height, rounded top corners. Both keep clear of a notch and the home indicator on
  their open sides (safe areas); with reduced motion the sheet fades in place instead of
  sliding. `--surface` on the
  `--scrim`. A sticky header keeps the title, one line saying what the panel is ("Each
  change reaches everyone in the room at once." or "The product owner sets how this
  room plays.") and a 44 px "Close" in sight while the settings scroll. Focus stays
  inside; Esc, "Close" or a tap on the scrim closes it and the focus returns to the
  header's button. It opens at its top: the PO lands on the first control when it shows
  whole under the sticky header (on a short screen, and for anyone else, on the title).
  No focused control ever hides under the sticky header. While it is open, the panel
  says the table's announcements itself ("Voting started: Round 2.", "Cards revealed."),
  since a modal hides the page from screen readers.
- **The settings.** Three groups under small mono headings, Cards, Voting and reveal,
  People, in ADR-011's order. Each setting is one row: the label, the value or the switch
  on the right, and a one-line explanation under the label in `--ink-2`, sometimes with a
  second line in `--ink` (the deck's cards, the special cards in words, what the timer
  does at its end, "This round still shows names." when anonymity waits for the next
  round). The explanation of "Change a vote after the reveal" says it never applies to
  an anonymous round.
- **Editable now (PO decision).** Only settings whose behaviour the room already shows:
  reveal when everyone has voted, anonymous voting (from the next round, said under it),
  the PO votes too, observers count toward the 16 places. The deck and special cards
  (#26), the timer (#27), who can reveal (#28) and changes after the reveal (#29) show
  their value and explanation to the PO too until their issue adds the control in the
  same row: a switch at the row's end, or a wider control (the deck picker, a choice of
  who can reveal, the timer) across the row under its explanation. A setting that cannot
  change now says why under it, with a lock (#29: never after the reveal in an
  anonymous round).
- **A change.** The switch moves at once and the row says "Saving…" until the server's
  snapshot confirms it; the switch looks unavailable meanwhile and another press of it
  does nothing. If the connection drops, the change moves back at once and the row says
  "Not saved: the connection dropped." until the room is back. A refusal moves it back
  and says why under the setting, scrolled into view, with the octagon icon: turning
  observers back on with
  more than 16 people says how many may count. Switches keep their 18 px look with a
  44 px hit area, and the label toggles too. In forced colours an on switch is a
  Highlight track, an off one an outlined Canvas track.
- **Everyone else** sees the new values in the same snapshot, also in an open "Room
  rules", and the table's live region says the change once, in plain words, in the
  order things happened: "The cards now wait for a reveal, even once everyone has
  voted.", "The product owner no longer votes.", "The product owner changed the deck:
  T-shirt sizes.", "Voting started: Round 1. Anonymous voting starts with round 2." Not
  to the PO, whose switch says it.
- **An anonymous round** (PO decision) is marked for everyone before anyone votes: a
  small "Anonymous" chip with an eye-off icon follows "Round N" in the round line above
  the table, in every phase, its hint "Cards are shown without names." on hover and for
  screen readers; the round's start says "Voting started: Round 4, anonymous."

## Cards

- **Hand cards**: 50 × 72 px (phone 44 × 64), warm face, numeral centred, corner
  indices top-left and bottom-right (rotated), 7 px radius.
- **The hand** (#18): under the table, in a surface panel, the round's deck then the
  enabled specials, one line that scrolls on phones. Picking a card votes, picking it
  again takes the vote back, another card changes it; the pick shows at once (lifted,
  brass ring, the seat's slot face down) and rolls back if the server refuses. A line
  under the cards says how to play, or why the cards are dimmed (40 %): in the lobby
  ("Your cards open when the product owner starts the round") and after the reveal.
  Observers have no hand; a PO who does not vote reads a line instead.
- **Back**: brass diagonal stripes framed by the card face colour.
- **Specials**: `?` unsure, `☕` break, `∞` too big; never counted in statistics.
- **Mini cards** (results): 28 × 39 px.

## Results

Under the table: Average, Median, Agreement, Spread as large tabular numbers with
mono captions; a distribution of columns (one per card value, height by count). For
T-shirt decks: Most voted, Agreement, Spread. In named mode the lowest and highest
voters are highlighted to start the discussion.

As built (#20): a surface panel, a region labelled "Results". The numbers are the
domain's `computeResults`, formatted in the reader's region (5,3 and 33 % in French):
the average and median to one decimal, the agreement as a whole percentage, the spread
as "2–13" ("2 to 13" for screen readers), a tie for most voted as "M · L"; a statistic
with no value shows "—". In named rounds a line under the numbers names the lowest and
highest voters, each with its arrow and mini card. Lowest and highest compare values on
a numeric deck, so a custom deck in any order stays right, and deck order otherwise. The
distribution has one column per card played that counts, in deck order: the count above
a spruce bar (at most 56 px,
`CanvasText` in forced colours) above the card's mini card, with an arrow on the lowest
and highest in named rounds; screen readers hear "5: 2 votes". On phones the columns
narrow to 24 px, 2 px apart, so the eleven cards of the modified Fibonacci deck fit one
row at 360 px. Spreads never break ("XS–XXL"): on a phone a deck without numbers puts
the spread on its own row. Special cards sit beside it under "Not counted", with a note
that they don't count toward these numbers. The "Not at the table" row marks a lowest
or highest card with the seats' arrow and says it in the label. If the results' code
cannot load (an old build gone after a redeploy), the centre says the result as a
sentence and an anonymous round lists its cards under "Cards played"; the next reveal
tries again. In anonymous
rounds these columns replace #19's "Cards played" row: the row and the columns said the
same twice, and the columns say it once, in deck order, with nothing tied to a person.

## Motion spec

Easing everywhere: `cubic-bezier(.2, .8, .2, 1)` unless stated. All of it is
interruptible and disabled under `prefers-reduced-motion` (120 ms cross-fades instead).

| Moment | Spec |
|---|---|
| Hand deal-in | cards rise 12 px and fade in, 260 ms, 30 ms stagger; when the hand appears (not each round, so the focus stays) |
| Hover / select | lift 6 px (180 ms); selected lifts 12 px with a 2 px brass ring |
| Hand → seat travel | 520 ms arc, midpoint 36 px above the line, −9° tilt, scales to the slot; lands face down with a 380 ms drop |
| Seat → hand (vote taken back, #18) | the face-down card flies back on the same 520 ms arc and fades over its hand card |
| Voted badge | 300 ms pop with slight overshoot |
| Reveal flip | `rotateY(180deg)` 650 ms, 90 ms stagger in seat order from the viewer (#19: only the face-up cards count, so an empty seat adds no pause; the last vote, which arrives with the reveal, turns from its empty slot in its place, its back showing while it waits; built as a turn to the edge with the back on, then back bare, so nothing keeps a transform at rest) |
| Anonymous reveal | slot cards shrink to 0.6 and fade (350 ms); mini cards deal into the results row, 70 ms stagger (#19: the row starts as the seats' cards are gone, at 350 ms; each card drops 12 px and fades in over 320 ms; a card whose vote came with the reveal never lay on its seat, so only the row shows it) |
| Results | columns rise 500 ms, 60 ms stagger, starting after the last flip (#20: or 350 ms after an anonymous reveal, once the seats' cards are gone; the centre's result fades in 300 ms then, and the lowest and highest seats' arrows pop in 300 ms; the panel's numbers show at once, so no empty panel waits for the flips) |
| Consensus | pill pops (400 ms) and one soft ring pulse; no confetti storm |
| Timer | ring drains linearly; last 10 s turns `--warn` and pulses at 1 Hz |
| Seat join / leave | fade and scale from 0.9, 220 ms |

## Accessibility

- Text contrast at least 4.5:1 in both themes; focus ring 2 px `--brass`.
- Full keyboard play: arrow keys move through the hand, Enter votes, `R` reveals for the PO
  while the focus is on the table or the hand (WCAG 2.1.4: a single-key shortcut acts
  only where it belongs), never in a field, menu, listbox, dialog or popover.
  The hand is one tab stop (a toolbar of toggle buttons): the arrows wrap, Home and End
  jump, Enter or Space votes and again takes it back; dimmed cards keep the focus.
- The viewer's own vote is said to them alone, once the server confirmed it ("Your vote:
  5.", "Your vote: needs a break.", "Vote taken back."), in the hand's own polite region,
  also when it was the last vote and the reveal follows at once. A double click counts
  once; a held Enter does not repeat. After "Start voting" the focus moves to the hand
  (or the centre's status for a PO who does not vote), also when Enter in the subject
  field started it, and the table's region says "Voting started: PAY-482." (the key, the
  title, or "Round 3" for no subject or a link without a key; #21). On a phone the selected card stays in view, and a fade on an edge
  says more cards lie that way.
- Live region announces "Ana voted", "Cards revealed: average 5", never a hidden value.
  The table's region (#17) says joins, leaves, away and back, others' first votes and a
  new round; a burst becomes one sentence per kind ("3 people voted."), after 600 ms of quiet or
  1.5 s at most, and the viewer's own actions are never announced there. The reveal (#19)
  is said once, to everyone, the PO too, whether forced, automatic or at the deadline:
  "Cards revealed.", after the votes of its batch ("Ana voted. Cards revealed."); a new
  round in the same batch drops it. It never says whose card is what; #20 adds the
  result, which belongs to nobody: "Cards revealed. Consensus on 8.", "Cards revealed.
  Suggested 5, agreement 60%.".
- Touch targets at least 44 px; no hover-only controls.

## Copy

Plain, short, active voice, in English, French and German. Name things as people
know them: room, round, card, reveal, product owner (PO). Errors say what happened and
what to do. The tone per language (tu or vous, du or Sie) is decided in #41; until
then French uses vous and German uses Sie.

- **Language switcher**: in the header, before the theme toggle. Each language is named
  in itself (English, Français, Deutsch) and marked with its `lang`, so a reader finds
  theirs whatever the page speaks. On phones the trigger is the icon alone. The choice
  is saved; without one the browser's languages decide, then English.
- **Numbers** the app computes or counts (averages, "6/8 voted so far", timers) follow
  the language: 5.5 reads 5,5 in French and German, and 1 234 groups with a narrow
  no-break space in French and a dot in German.
- **Region**: numbers and dates use the reader's region within the UI language: the
  first browser language tag whose language matches the UI's, else the bare language.
  A `de-CH` reader with German UI reads 6.5 and 1’234; an `fr-CH` reader gets French UI
  with Swiss French formatting (CLDR keeps the decimal comma and groups with ’); an
  `en-GB` reader gets 24-hour times. `fr-FR`, `de-DE` and readers whose browser lists no
  tag in the UI language (an English browser that picked Français) read 5,5. Swiss German
  (`gsw`) counts as German, formatted as `de-CH`.
- **A language that cannot load** (offline, or an old chunk gone after a redeploy) keeps
  the page in its language and shows a toast that asks for a reload.
- **Card faces** show the label exactly as the deck holds it, in every language. No
  preset deck holds a decimal mark (the modified Fibonacci deck uses ½, which reads the
  same everywhere), and custom labels, including those a range generates, stay as typed:
  "0.5" is "0.5" on a French screen. A card is what the team agreed to play; localising
  it would make the face, the deck editor and the vote disagree.
- **French typography**: a narrow no-break space (U+202F) before `:`, `;`, `!` and `?`,
  and typographic apostrophes (’); guillemets as « x » with U+202F inside. German quotes
  as „x“. Unit tests check these rules and reject straight quotes and "..." everywhere.

## Landing, missing rooms and errors

- **Landing page** (`/`): one screen that says what the tool is and how a round goes:
  the pitch, four steps (create a room, share the link, vote, reveal) numbered on small
  card faces, the "Create a room" card and "Join with a code". From 1024 px the creation
  card stands on the right; on phones the order is pitch, create, join, steps.
- **Join with a code** takes a bare code or a pasted room link (`/r/CODE` or a full
  `https://…/r/CODE`), ignores spaces, zero-width characters and dashes anywhere, trims
  surrounding quotes, brackets and punctuation, checks the shape in the browser and opens
  `/r/:code`. A refused entry says why and keeps the focus in the field. The message on a
  malformed code sets the characters a code never holds (0, O, I, l) in Plex Mono, since
  Plex Sans draws 0 and O, and I and l, alike. It offers no history of earlier codes.
- **A link from another host** (a full http or https link whose host is not this page's)
  is not opened here (PO decision, 2026-10-27): the same code on another instance is
  another room or none, and opening it here would only lead to the not-found page. The
  card says "This link is for {{host}}." with an "Open it there" link to the URL as
  pasted (http and https only, `rel="noopener noreferrer"`), and the focus stays in the
  field.
- **A missing room** shows the table with its seats empty, drawn from the tokens, never
  stock art. The server cannot tell an unknown code from a deleted room, so the page
  names both: a mistyped or cut link, or a room deleted after `ROOM_TTL_DAYS` days
  without activity (the server states the number). The way back is another code or a
  new room; there is no retry, since nothing will make the room appear. Its heading takes
  the focus each time the page comes, also after another unknown code typed on it, so a
  screen reader announces it again. The same page replaces the room when the socket's
  `enter` answers `room_not_found` (a room deleted after its header loaded).
- **The code is never echoed** on that page, in its text or in the tab title. A code is a
  bearer capability (architecture, section 11): a screenshot or a shared screen of an
  error would spread it, and the address bar already shows what was typed. The room's
  own page shows its code, because there it is meant to be shared.
- **The error page** (anything a page throws, or a chunk that cannot load) says that
  something went wrong and offers a reload and the home page. It never shows the error,
  its stack or the address. The same table carries one face-down card with the card back
  above (stripes in a face-coloured frame).
- **Tab titles** read "Page · Poker Planning" on these pages, and never hold a code.
