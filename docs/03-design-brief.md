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
- The centre of the table shows the status (`5/8 voted so far`), the timer ring (#27,
  "The timer" below), or after reveal the suggested card with agreement or a
  **Consensus** pill.
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
  Under "Who can reveal: Anyone who votes" (#28) every voter's centre holds the same
  "Reveal cards" (and R, with the same scope), where the PO's sits: under the timer's chip
  and the count, in the PO's 10 px phone size, ending above the docked hand on a phone.
  Observers never get it; the PO always does. After a voter's reveal their focus moves to
  the result in the centre, without scrolling: voters have no decision bar. When the PO
  takes the reveal back mid-round the voter's button leaves with the next snapshot, and a
  focus on it goes to the count, never to the page; a press that crossed the change says
  "Not revealed: only the product owner can reveal the cards now." under the table. In an
  anonymous round a voter's button waits for two cards (PO decision, #28 review): until
  then it stays in place, `aria-disabled` (R does nothing either), and the line under the
  table says why, "Wait for two cards: in an anonymous round, a lone card shows whose it
  is.", which also describes the button. The PO's button never waits. The table's live
  region names a voter who revealed ("Ben revealed the cards. Consensus on 8."); the PO's reveal and
  the automatic ones keep "Cards revealed.". After the reveal the PO's focus moves to "Record 8", the
  final estimate's button under the table (#32), when it was on the button (or nowhere),
  without scrolling the page; to the picker when nothing is preselected. A named reveal turns the seats' cards face up; the
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
  of the tie: at most four, then "+12" for the rest (#26: a custom deck can tie 16 ways,
  which would cover the side cards on a phone). The figure is labelled as the team's agreement, the panel's word, because
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
  the round's deck without the specials as small cards (32 × 44 px, whole touch targets,
  8 px apart, wrapping into rows on a long deck, never scrolling sideways), then "Record
  8", "Next round" (outline) and "Vote again" (ghost), in that order for the keyboard
  too. On a desktop it is one row, 60 px tall: the label beside the cards, then the three
  buttons. The suggested card (or a consensus) is preselected, so one press records it;
  on a tie, or when nothing counts, nothing is, the tied cards wear a small "Tie" mark,
  "Record" waits, and a line asks the PO to pick. "Tie" means only the results' tie (a
  deck without numbers whose top count is shared): on a number deck split votes (3, 3,
  13, 13) preselect the suggested card, as the centre shows it. Arrow keys move the
  pick; the pick lifts with the hand's brass ring on the card, and the keyboard focus is
  an ink outline around the whole card, 2 px out, so the two never look alike and the
  focus shows in forced colours on a card nobody picked. Once recorded the button reads
  "Recorded" (a check) until the PO picks another card, which changes the final while
  the round stays revealed. A held key's repeats never record or start, and Enter and
  Space do nothing for 300 ms after the page itself put the focus in the bar (as in the
  hand, #21), so a double Enter on "Reveal cards" never records the suggestion. "Next
  round" pressed while a record is on its way follows it.
- The PO's bar docks (PO decision, 2026-10-27). While its place under the table is out of
  view it sticks to the bottom of the screen (`position: sticky`, a surface with a top
  border and the panel shadow, padded above the safe area), as #22 docks the hand: on a
  desktop the whole bar, on a phone only the action row ("Record 8", "Next round", "Vote
  again" in one row of three), since a docked picker would hide too much; the picker
  stays in the page under the table. It docks only when the result in the table's centre
  stays in sight above it at the top of the page; otherwise it stays in the page. While
  docked the page's `scroll-padding-bottom` is its height, so no focused control hides
  under it (WCAG 2.4.11). Every focus the page places uses `preventScroll`: the reveal
  never scrolls the page, the flips and the result happen where the PO was looking, and
  on a desktop "Next round" stays in sight while the PO types the next subject. Docked,
  the desktop bar's "pick" line is for screen readers only, so the bar stays one row.
  Measured at 1024 × 768, 1280 × 800, 1440 × 900 and 1920 × 1080 and on the iPhone SE,
  iPhone 13 and Pixel 7 (`final-estimate.spec.ts`): it docks on all of them, the result
  ends 19 px above it at 1024 × 768 (6 px with a recorded final), and the phone's action
  row is 62 px tall.
  Everyone's centre, named or anonymous rounds alike, then shows the final under the
  result, set apart from the suggestion: its mini card with a 2 px brass outline beside
  "Final estimate", said as "Final estimate: 8."; the result turns compact (card beside
  its caption), and on phones both cards shrink to 18 px chips, the stack at most 76 px
  wide, and the label shortens to "Final" ("Finale", "Final"): "Endgültige Schätzung" on
  two lines made the stack 76 px wide and touched the side cards at 10 seats. A final recorded on screen pops in (crossfade under reduced motion). The live
  region says "The product owner recorded 8 as the final estimate." or "The product owner changed the final
  estimate to 13.", once, to everyone. Measured clear of every card at 4, 8, 10 and 16
  seats, in English, French and German, on desktop and at 360 px, for the PO and a voter
  (`final-estimate.spec.ts`): on phones 68 to 71 px wide and 47 px tall (suggestion) or
  59 px (consensus pill); on desktop 113 to 140 px wide (German widest) and 84 px tall.
  The bar in the page never meets the table or a card, docked it never covers the
  result, and no page scrolls sideways.
- "Vote again" (#32): the PO's secondary action beside "Next round". It keeps the
  subject (the title, or the link with its key) and starts a new round with the next
  number, the votes cleared and the timer as at any start; the revealed round stays in
  the history with its votes, so it asks for no confirmation. The live region says "The
  product owner started a new vote on the same subject." (or "a new anonymous vote" when the
  room is anonymous, as a next round says "anonymous"). The focus goes to the hand, as after
  "Next round".
- Observers sit off the table (a small row under it) so voters keep the seats. Each name
  there opens the same popover as a seat (#30).
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
  while Voting, or after a named reveal while votes may change (#29): otherwise the
  results come with the reveal and sit above the hand, and the hand returns to the page
  under them. After the reveal the first row of the results (the first statistics)
  must end above the docked hand too. At 390 × 844 with 8 people the PO
  (field included) and a guest see the subject, the whole table and the docked hand at
  the top of the page without scrolling, in English, French and German and with a
  two-line title; at 150 % text, at 390 × 664 (an iPhone 13 in Safari) and on an iPhone
  SE the hand stays in the page (`e2e/mobile.spec.ts`).
- **The PO's decision** (#32) docks its action row at the bottom edge after a reveal, the
  way the hand docks while voting, when the result in the centre stays in sight above it;
  the picker stays under the table (see "The table").
- **The hand after the reveal** (#29): while the room lets votes change in a named
  round, the hand stays playable and docks as it does while voting, by the same rule;
  the PO's never does then, since the decision's action row docks there.
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
  at 11 px, "100" at 10 px, "XXL" at 7 px, and "XXL" in the PO's tie chip at 8.5 px. No
  label is drawn under 7 px (#26): a custom label that still does not fit at 7 px
  ("WWWW", "ÆÆÆÆ", two emoji) is clipped on its card, centred. The slot is a
  glance; the seat's popover says the card in words and the results' columns repeat
  every card whole.
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
  the PO votes too, observers count toward the 16 places, since #26 the deck and the
  special cards (below), since #27 the timer (see "The timer"), since #28 who can
  reveal, and since #29 changes after the reveal: a switch at the row's end, off by
  default, that applies at once, to a named round already revealed too (see "Changing a
  card after the reveal"). A wider control (the deck picker, who can reveal, the timer)
  sits across the row under its explanation.
- **Who can reveal (#28).** Two 44 px segments across the row under the explanation,
  "The product owner" and "Anyone who votes", a radio group. Unlike anonymity it applies
  at once, to the round on the table too. A click, a tap or Space sends it; arrow keys
  send the choice they rest on after 400 ms, as the timer's lengths do, so the room hears
  one change. While "Reveal when everyone has voted" is off and every present voter has
  voted, the PO reads under that switch "Everyone has voted: turning this on reveals the
  cards.", since turning it on then reveals the round at once. A setting that cannot
  change now says why under it, with a lock: while "Anonymous voting" is on and changes
  are off, "Change a vote after the reveal" reads "Anonymous rounds lock their votes at
  the reveal." (#29; an anonymous round never changes after its reveal, ADR-011). The lock
  holds one way only: with changes on when anonymity comes on, a named round may still be
  on the table, so the PO can always turn changes off; the switch locks once it is off.
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
  Switching anonymity never re-projects the round on the table (PO decision, #28): names
  already seen cannot be hidden, and an anonymous round must never gain names, so the
  change applies from the next round.
  Anonymity hides who played which card, not who played (ADR-011, amended): the seats say
  who voted, so one card, or cards that all agree, still tell whose they are. A voter may
  therefore reveal an anonymous round only once two cards are down; the PO, who
  facilitates, may reveal at any count, and the timer and the automatic reveal are
  unchanged.

- **The deck field (#26).** Across the row under the deck's explanation, for the PO:
  first a line saying when new cards apply ("New cards apply from round 4." in the lobby
  and after the reveal; "New cards restart round 4: its votes are cleared, its subject
  stays." while Voting), then a radio group of bordered rows: Fibonacci, Modified
  Fibonacci, T-shirt sizes, Powers of 2, 1 to 10, each with its cards in small mono
  under its name, and "Custom deck". The deck the room plays says "In use" at the row's
  end. Choosing only moves the choice: a "Use “T-shirt sizes”" button under the group
  applies it, so arrow keys never send a change (or ask to restart) on their way to the
  deck wanted; after it the focus stays on the chosen radio. "Custom deck" opens a text
  field, "Cards, separated by commas", whose hint gives the limits (20 cards of up to 4
  characters, emoji too) and says that a decimal takes a point, since the comma
  separates cards. Under it, a live preview of the cards as mini cards with the count
  ("4 cards"), and the first fault in plain words with the octagon icon, naming the card
  ("“Large” is too long: a card holds at most 4 characters.", "Card 2 is empty. Remove
  the extra comma.", "“1.0” has the same value as “1”.") and ringing its mini card in
  `--bad`; an empty field says nothing until the PO tries to use it, and once the PO has
  tried (Enter or the button) the fault is an alert, so a screen reader hears it. The
  preview stops at 20 cards; the count says them all. A trailing comma is
  not an empty card. "Generate a range" (a disclosure with a chevron) shows Start, End
  and Step, prefilled 0, 5 and 0.5 in the reader's notation; they accept a comma or a
  point, being numbers rather than labels. "Fill in the cards" puts the cards in the
  field, says "5 cards filled in. Check them, then use them." politely, and a range the
  deck cannot hold says why in an alert. "Use these cards" (or Enter in the field)
  applies the deck, or focuses the field when it has a fault; on the room's own deck it
  is disabled (`aria-disabled`) and asks nothing.
- **The special cards (#26)** are three rows, each a mini card, its meaning ("Not
  sure", "Need a break", "Too big to estimate") and a switch, in a group labelled
  "Special cards". A change applies like the deck's.
- **The restart question (#26).** During Voting, once someone has voted, a new deck or
  new special cards ask first, inline under the control, in a `--surface-2` box with a
  `--warn` border and a restart icon: "Changing the deck restarts round 4. The 3 votes
  cast so far are cleared; the subject stays." ("The vote cast so far is cleared" for
  one) with "Restart with “T-shirt sizes”" or "Restart with a custom deck" and
  "Cancel" ("Changing the special cards …", "Restart with the new special cards"). It
  takes the focus as a group named by the question. Cancel gives the focus back to the
  apply button or the switch; the restart sends the change and leaves the focus on the
  chosen deck or the switch. The question is about one deck: editing the cards, or
  choosing another deck, takes it away. When it goes with the focus inside it (the
  votes went, the deck moved), the focus goes to the apply button, never the dialog.
  With no vote cast the change applies at once (the round still restarts, with nothing
  to clear). A restart starts the round over, timer included: the room's timer starts
  anew, and a timer the PO started by hand stops.
- **Deck names in sentences** are quoted for a preset ("“T-shirt sizes”", « Fibonacci
  modifié », „T-Shirt-Größen“) and a phrase for a custom deck ("a custom deck", « un jeu
  personnalisé », „einem eigenen Kartendeck“, after „mit“ and „zu“).
- **What everyone else hears.** "The product owner changed the deck to “T-shirt sizes”
  from the next round." in the lobby or after the reveal; "The product owner restarted
  round 4 with “T-shirt sizes”. Vote again." during Voting, without "Vote again." for an
  observer, and no "Voting started" for the restart. Every voter's hand empties into the
  new deck; a vote sent before the restart is refused and rolls back silently.

## History

As built (#33):

- **Where.** A "History" button with a clock-arrow icon in the room header, between "Copy
  the link" and "Room settings" or "Room rules", for everyone in the room: voters,
  observers and the PO. Nobody on the join form sees it (the server refuses them too).
  Up to 900 px wide it is the 44 px icon alone, its name for screen readers. Under
  360 px the header's three buttons take a row of their own under the name, the code and
  the people count, so the name keeps the full width and the room's code never splits.
- **The panel.** The same modal sheet as the settings: from the right, up to 28 rem wide,
  on a wide screen; from the bottom on a phone, at most 88 % of the screen, rounded top
  corners; safe areas kept clear; a fade in place under reduced motion. A sticky header
  holds "History", "Every finished round, newest first." and "Close". It opens on its
  title; the focus stays inside, Esc, "Close" or the scrim close it and the focus returns
  to "History". The table's announcements are said inside while it is open.
- **A round.** One list item per finished round, newest first, divided by hairlines:
  "ROUND 3" as a small mono caption (a heading) with the time it ended on the right (the
  reader's format; the date too when it was another day); the subject (a title on two
  lines at most, or the link's key chip, opening in a new tab); then the final estimate
  under the "FINAL" caption (a mini card, or "None"), the distribution as small columns
  (the count, a spruce bar at most 20 px, the card; "5: 2 votes" for screen readers), and
  how long the voting took, from start to reveal, with a timer icon ("2 min 13 s",
  "42 s", from an hour on "1 h 2 min"; said "Voting took 2 minutes 13 seconds."). The
  captions are 11 px at the default text size, in rem, so they grow with it.
- **Its votes.** A "Votes" disclosure (a 44 px button with a chevron, `aria-expanded`,
  named "Votes of round 3") opens the votes under the round: in a named round each name
  with its card on the right and a "changed" chip for a vote changed after the reveal; in
  an anonymous round "Anonymous round", said once, and the cards alone in the deck's
  order. Never a name there. A round nobody voted in says "No votes" instead, with no
  disclosure.
- **Paging.** 20 rounds first; "Show earlier rounds" at the end loads the next 20 and
  moves the focus to the first of them.
- **Empty.** "No rounds yet. A round appears here once the next round starts."
- **Live.** The round on the table is not listed, even with a final recorded; it appears
  in an open panel as soon as the next round starts, without a reload.

## Summary and exports

As built (#34):

- **Where.** At the top of the history panel, under its sticky head, for everyone in the
  room: a "SUMMARY" caption with a two-option range on its right ("Today" | "All rounds",
  a segmented pair of radios, the chosen one on `surface-2` with a spruce inset line),
  four figures in two columns, then the "Export" menu button. Hidden while there is no
  round to count. "Today" is the rounds that ended on the reader's day; it is the
  default when a round ended today, else "All rounds". The figures and every export
  follow the range.
- **The figures.** Each a small mono caption over a 20 px value: "ROUNDS" 3; "TOTAL OF
  FINAL ESTIMATES" 10, with "1 round without a numeric estimate" under it when finals
  are `?`, ☕, T-shirt sizes or missing; "AVERAGE AGREEMENT" 67 % (only rounds where a
  vote counted; "no value" otherwise); "AVERAGE VOTING TIME" "1 min 5 s", said in words.
  The four share one grid (each figure spans its caption, value and note rows), so the
  values of a row line up when a caption wraps at 360 px. A story counts once in the
  total and in the rounds without a number: of consecutive rounds with the same subject
  (a re-vote keeps it), only the last; rounds without a subject never merge. Numbers
  follow the reader's locale ("1,5" in France and Germany, "1.5" in de-CH). The round
  on the table counts once it has a final, since the history adds it only when the next
  round starts. Until the rounds the range needs are read: "Counting the rounds…" in
  place of the figures, and "Export" waits. Past 1,000 rounds: "Only the latest 1,000
  rounds are counted."
- **Export.** An outline button with a download icon and a chevron opens a menu of four,
  each 44 px high with an icon: "Download CSV", "Download Markdown", "Copy Markdown",
  "Copy for Jira or Azure DevOps". By keyboard: Enter opens it on the first item, the
  arrows move, Enter picks, the focus returns to "Export".
- **CSV.** UTF-8 with a byte order mark, CRLF, RFC 4180 quoting; a semicolon between cells
  when the interface speaks French or German (their spreadsheets expect one, de-CH's too,
  with its "5.5") or when the reader's numbers take a decimal comma (English in en-ZA,
  en-NL, en-SE), else a comma; numbers in the reader's locale; one row per round, every
  re-vote included,
  oldest first: round, subject (the title or the link), key, final, suggested card,
  agreement (%), average, median, votes, voting time (s), end (ISO 8601 with offset).
  Round level only: no names, no per-person cards. A subject starting with = + - @, a
  tab or a CR, or their full-width forms (＝ ＋ ﹦), gets a leading `'`. File: `planning-poker-<room name or "room">-<yyyy-mm-dd>.csv`.
- **Markdown.** A heading with the room's name, the range and the summary, then a GitHub
  table with the same columns (end time in the reader's format; the agreement column
  named "Agreement", its cells carrying the "%"), pipes, backticks, `@` (no GitHub
  mention) and line breaks escaped, links kept. The heading names the product, "Poker
  Planning", in every language. Downloaded as `.md` or copied.
- **Copy for Jira or Azure DevOps.** One "KEY estimate" line per key (the link's, or a
  Jira key at the very start of a title), from its latest round, so a re-vote replaces
  the estimate: "PAY-482 5", "4521 8". A numeric final is written with a point ("½" as
  0.5): the tools' estimate field is numeric.
- **Feedback.** One line under the menu, a polite live region, says what happened once:
  "CSV downloaded.", "Markdown copied.", "2 lines copied for Jira or Azure DevOps. 1 round
  skipped: no key or no final estimate." When the browser refuses the clipboard, it says
  so and a read-only field labelled "Text to copy" shows the text, focused and selected
  (the menu does not hand the focus back to "Export" then).

## The PO's powers

As built (#30, ADR-010):

- **Where.** Everything the PO does to someone else sits in that person's popover, the
  one every seat already opens (#17): on a seat, and since #30 on an observer in the row
  under the table, whose name is now a button too (its 24 px look kept, a 44 px hit area
  around it). Under the name and the state, after a hairline, the PO reads "Make product
  owner" (crown) and "Remove from the room" (a person with a cross), ghost buttons with
  their icon, 36 px tall on a desktop and 44 px on a phone. Nobody else gets buttons
  there; the PO's own seat has none. For someone away "Make product owner" stays where
  it is, `aria-disabled` and at half opacity, with "Ben is away." under it (its
  description): the server hands the role only to someone here, and a button that
  vanished as Ben went away would drop the PO's focus on the page. Desktop and phones
  alike: the popover is the same, opened by tap, click or Enter.
- **Asking first.** Each action asks inline, in the popover, in a `--surface-2` box with
  a `--warn` border (the restart question's look, #26), which takes the focus as a group
  named by the question: "Hand the product owner role to Ben? You stay a voter." (a PO
  who votes; "You become a voter." when the PO does not vote in this room, "You stay an
  observer." when the PO observes), and when the PO does not vote in this
  room and Ben votes, a second line in `--ink-2`: "The product owner does not vote in this
  room, so Ben stops voting." "Remove Ben from the room? They can join again with the
  link." Then "Hand over" (primary) or "Remove" (destructive) and "Cancel"; "Cancel"
  gives the focus back to the action. A refusal shows under the box with the octagon
  icon. If Ben goes away while asked, "Hand over" turns `aria-disabled` with "Ben is
  away." under the question, and the focus stays where it is; it comes back if Ben does.
- **After a hand-over** the popover closes and the focus is back on the seat. The crown,
  "Room settings" (now "Room rules" for the old PO), the subject field, the centre's
  buttons and the decision bar all move with the snapshot that names the new PO. "The
  PO votes too" follows the role: with it off the new PO's hand goes ("As the product
  owner, you do not vote in this room.") and leaves the count, and the old PO's hand
  comes back.
- **Claiming.** Once the PO has been away for two minutes, or at once when the PO is not
  in the room, everyone else sees a banner above the table: a crown in a brass disc,
  "Ana, the product owner, is away." (or "The product owner left the room."), and
  "Claim the product owner role" (primary; the whole width on a phone). The server says
  when (`ownerClaimableAt`); the page shows the button from then, by its estimate of the
  server's clock (#27), 20 ms or half a round trip later, whichever is longer, since the
  estimate may run a little ahead and an early claim costs a "Not yet".
  The first claim wins; the others see the banner go and hear "Ben claimed the product
  owner role.". A claim refused because the PO is still here says "Not yet: the product
  owner is back, or has been away for less than 2 minutes." for 8 s, without the button
  (8 s even when the PO is back). After a claim in the lobby or while voting the new PO's
  subject field takes the focus; after a reveal the decision bar does, as after a reveal.
- **Removed.** Within a second the removed person's page leaves the table for the join
  form, under a notice in `--surface-2` with the same icon: "The product owner removed
  you from this room." (an alert), the focus on the name. No ban: they may join again
  with the same link, and the notice goes once they do. Their vote follows the leave
  rules (dropped while voting, kept with their name after a named reveal). The PO's
  focus goes to the seat that took their place, and so does it when anyone leaves while
  the PO has their popover open. Accepted for now: someone removed while their socket is
  down (a phone asleep) is not told; when the page connects again it shows the join form
  with no notice.
- **The live region**, once each, to everyone, the people named too: "Ana handed the
  product owner role to Ben.", "Ben claimed the product owner role.", "The product owner
  removed Cleo from the room." ("… removed 2 people …" in one batch).

## The room password

As built (#31, ADR-010):

- **The PO, in "Room settings".** A "Password" row at the end of People, across the
  row (`block`), under the hint "People already in the room stay. Anyone else enters it
  once on each device." Without a password: a password field (44 px, "Show password" as
  an eye toggle inside its right end, `aria-pressed`, its name constant) and "Set
  password" beside it (under it on a phone); Enter in the field sets it too. With one: a
  lock and "This room has a password." (a status), then "Change password" (outline),
  which opens the field again with "Cancel", and "Remove password" (outline), which does
  not ask first. After a set the focus lands on "Change password", after a removal on
  the field, after "Cancel" back on "Change password". A refusal shows under the row
  with the octagon icon: "A password needs 6 to 128 characters.", or the generic
  "Too many tries. …". While a password is changed, the field's button says "Save
  password" ("Set password" for a first one). Everyone else’s "Room rules" says "Password: On" or "Off",
  never more.
- **The header** shows a lock beside the room’s name, in `--ink-2`, 0.6 em of the
  name’s size, named "This room has a password." for screen readers (and as its
  tooltip). With a password, "Copy the link" confirms "Link copied. They also need the
  password."
- **The joiner.** The "Take a seat" card adds a "Password" field above "Your name", with
  the same eye toggle and, under it, a lock and "This room has a password. Enter it to
  join." (or "The product owner changed the password." when the page last saw the room
  with another one). The field takes the focus. One "Join the room" button checks the
  password, then enters, then joins. A blank field says "Enter the room’s password."; a
  wrong one "That password is not right." under the field, which keeps the focus with
  its text selected; past the limit "Too many tries. Try again in 3 minutes."; when the
  server checks too many at once "Many people are joining at once. Try again in a
  moment." The browser's own reveal eye (Edge) is hidden: ours is the only one. When one
  tab gets in, this browser's other tabs on the same room drop the field too. A person
  with a grant, or back in a room they never left, never sees the field. Someone the PO
  removed sees "The product owner removed you from this room." above the card, which
  then asks for the password.
- **The live region**, once each, to everyone but the PO: "The product owner set a
  password for this room.", "The product owner changed the room’s password.", "The
  product owner removed the room’s password." Someone on the join form when the PO sets
  or changes it is asked for the password at once, without a sentence.

## The timer

As built (#27; ADR-011: off by default, reveal at its end on):

- **The room's timer.** In the settings panel's "Voting and reveal" group, "Timer for
  each round" spans the row: Off, 30 s, 60 s, 2 min or Custom (44 px segments, the
  pick in spruce), and Custom opens a field for 5 s to 60 min, typed as seconds ("90")
  or minutes and seconds ("1:30"); a wrong length says how to type it and sends nothing,
  in an alert said on every try, the same length twice too. A click, a tap or Space sends
  a length at once; arrow keys show each length at once and send the one they rest on for
  400 ms, so the room does not hear every length on the way.
  Under it the switch "Reveal when the timer ends" (on); off, everyone sees that time is
  up and the PO reveals. The hint says a change applies from the next round, as the
  domain does; a running timer keeps its deadline.
- **Everyone's countdown.** While a timer runs, the centre shows the time left above the
  count: "0:45" in bold tabular numerals (15 px on a desktop, 11 px on a phone) inside a
  stadium ring, the table's own shape, 36 px tall on a desktop and 24 px on a phone. The
  ring is a faint `--table-ink` track and the time left in `--brass`, drawn from the top
  centre clockwise and draining linearly to the deadline, over the timer's whole length
  (an extension refills part of it). It drains in steps of about a device pixel of its
  length, never more than 20 a second, set by a timeout rather than a per-frame animation:
  a 30 s timer restyles the page about 5 times a second, a 60 min one every 20 s. In the last 10 s the ring turns `--warn` and the
  chip pulses at 1 Hz (scale 1.08); the text stays `--table-ink`, which reads on the felt
  in both themes. Under reduced motion there is no pulse and no smooth drain: the ring
  steps once a second with the text, and the colour and the text still say it. In forced
  colours the ring is CanvasText on a GrayText track. At 0:00 the page waits for the
  server and never shows a negative time. Once time is up in a room that does not reveal
  at the end, the chip reads "Time is up" (10 px on a phone) inside a full `--warn` ring,
  for everyone and after a reload, until the PO reveals or starts a new timer.
- **The PO's controls**, by "Reveal cards" (PO decision for phones): the chip itself is a
  button, above the count. Without a timer it reads "Timer" with a clock (the clock alone
  on a phone, its name for screen readers); it opens a small menu: "Start a timer" with
  30 s, 60 s and 2 min, and a "Length" field with "Start". While a timer runs, a desktop
  flanks the chip with "Stop" and "+30 s" (card-face buttons, 32 px, 44 px to touch), and
  the menu reads "Start again"; a phone's centre has no room beside the chip, so its menu
  puts "+30 s" and "Stop" first; "+30 s" is named "Add 30 seconds", and pressed as the
  timer ends it says nothing. The chip's name says its state only ("Timer, running",
  "Timer, time is up"), since the focus comes back to it after every choice and a name
  that changed every second would be spoken every second; the time left is in a hidden
  `timer` beside it, which is not live. A button that leaves with the timer hands the
  focus to the chip, and the menu gives it back to the chip when it closes; a menu that
  leaves with the round (the timer revealed it while the PO typed a length) hands it to
  the PO's decision, as a reveal does. R in the menu's field is a
  letter; R on the chip reveals, as anywhere on the table.
- **Where it fits.** The centre's content now stays centred on the table when it is
  taller than the 68 × 60 px phone box (it used to overflow downwards), and the phone's
  count keeps the box's 68 px whatever the chip's width. Measured clear of every card at
  4, 8, 10 and 16 seats, in English, French and German, at 1440 and 360 px, without a
  timer, running and with time up (`e2e/timer.spec.ts`): the PO's centre is at most
  205 × 109 px on a desktop while a timer runs (140 × 126 px in German without one) and
  73 × 110 px on a phone. Where the hand docks (#22), "Reveal cards", the chip and the
  PO's seat still end above it.
- **Clocks.** Each page estimates the server's clock from every snapshot (the median of
  the last nine samples, corrected by half the round trip of its `enter`), so pages whose
  clocks are 5 s apart show the same time left (measured 12 to 13 ms apart, AC 1). It
  counts on the page's monotonic clock, so a page whose clock is stepped mid-countdown
  keeps the same time left as the others.
- **A restart (#26)** starts the round over, timer included: with a room timer everyone
  hears "Timer started: 1 minute." right after the restart's sentence, and a time that
  was up starts again.
- **Announcements**, to everyone, the PO too, never a tick every second: "Timer started:
  1 minute." (also after "Voting started: Round 3." when the round starts one), "30
  seconds added.", "Timer stopped.", "10 seconds left." (once, when the page sees the
  countdown cross it) and "Time is up.", before "Cards revealed." when the timer
  revealed the round. Everyone else hears "The product owner changed the timer." for a
  change in the panel.

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
- **Labels** (#26): a label is fitted by its width as drawn, measured in the page in
  Archivo ExtraBold at the card's width axis (cached per label). It narrows to 70 %
  width before it would shrink below 80 %, then shrinks, never under 7 px. After layout,
  a label that still does not fit its fixed-size card (a slot, a results column, a mini
  card), whatever font the system drew it in, is clipped on that card, centred, with
  the whole label in a tooltip; the seat, its popover and the results' words say it
  whole, and the hand's cards are wide enough to hold every label. Before the font has loaded, an estimate stands in:
  0.72 em a digit, 1 em for ½, ¼, ¾ and any letter, 0.8 em for a lowercase ASCII letter
  other than m and w, 1.3 em an emoji.

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
the spread on its own row. A tie for most voted of up to four cards wraps between its
cards, never inside one (each card and its dot stay on one line); above four the panel
says "16 cards tie" and the distribution shows each (#26). Special cards sit beside it
under "Not counted", with a note
that they don't count toward these numbers. The "Not at the table" row marks a lowest
or highest card with the seats' arrow and says it in the label. If the results' code
cannot load (an old build gone after a redeploy), the centre says the result as a
sentence and an anonymous round lists its cards under "Cards played"; the next reveal
tries again. In anonymous
rounds these columns replace #19's "Cards played" row: the row and the columns said the
same twice, and the columns say it once, in deck order, with nothing tied to a person.

## Changing a card after the reveal

As built (#29, PO decisions). Off by default (ADR-011); the PO turns "Change a vote after
the reveal" on in the settings panel, also once the round is revealed. It never applies
to an anonymous round: an anonymous round's votes are final at its reveal, so the issue's
"a count" of changes for anonymous rounds is dropped.

- **The hand** stays playable after a named reveal while the setting is on. Its line
  says "You can still change your card."; the keyboard and the docked hand work as while
  voting. A pick changes the vote; the card already chosen pressed again does nothing,
  since taking a vote back after the reveal would drop the voter from the results (the
  server refuses it). No card flies: the seat's card turns over to its new value when the
  server confirms it, for everyone alike (a 650 ms turn; under reduced motion the new
  value replaces the old without one). With the setting off, or in an anonymous round,
  the hand stays disabled with "The cards are revealed. Votes can no longer change in
  this round." Turned off mid-way, the hand stops at once.
- **The mark.** A changed card carries a small "changed" chip on its foot, on the table
  and in the "Not at the table" row: 9 px semibold `--brass-ink` text on `--brass-soft`,
  a word, never a colour alone. On a dense phone table (more than 10 seats, 20 × 28 px
  slots) the word would cover the next cards, so the slot card carries a 6 px
  `--brass` dot in its top-right corner instead, 3 px in from its edges, clear of the
  value; 16 seats at 360 and 390 px, in every language, show no mark on another mark or
  on another card. In forced colours the word keeps a border and hangs under the card,
  not across its edge, and the dot is drawn in the text colour. The seat says "Ben, card
  8, changed after the reveal", its popover "Changed after the reveal", on every table.
  Marks stay once changes are turned off.
- **The results** recompute with each change: the suggested card, agreement, average,
  median, spread, distribution and the lowest and highest voters, as the cards now stand.
- **The PO's decision.** A recorded final stays: the final is the PO's. When a change
  moves the suggestion (a card, or a tie) away from what it was when the PO recorded,
  the bar says "Votes changed since you recorded 5." (`--ink`, under the picker, in the
  description of the picker and of "Record 8") and preselects the new suggestion, none
  on a tie. Docked on a desktop, the note is for screen readers only, as the hint is, so
  the bar stays one row and keeps docking at 1024 × 768. On a phone, where only the
  action row docks, the note is that row's first line, read without scrolling. Nothing
  is recorded until the PO acts. The note goes once the PO records again or the
  suggestion comes back.
- **The live region**, once per change, to everyone but the person who changed: "Ben
  changed their card: 8." (a special card in words: "Ben changed their card: needs a
  break."), followed by the new result when the suggested card or the consensus moved
  ("Suggested 8. Agreement 50%."). Values are said only after a named reveal, where
  everyone sees them; the person hears "You changed your card: 8." in their own region,
  and the new result in the room's when it moved.
- **Only a change.** Someone with no card in the round (a voter who had not voted, an
  observer turned voter, someone who joined after the reveal) keeps a disabled hand
  with the revealed line ("The cards are revealed. Votes can no longer change in this
  round."): a card played after seeing everyone's is anchored on them, and would move
  the suggestion without an estimate.

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
| A card changed after the reveal (#29) | the seat's card turns over to its new value, 650 ms, at once; under reduced motion the value is replaced without a turn |
| Consensus | pill pops (400 ms) and one soft ring pulse; no confetti storm |
| Timer | ring drains linearly, in steps of about a device pixel (at most 20 a second); last 10 s turns `--warn` and pulses at 1 Hz (#27: the chip scales to 1.08 and back each second; under reduced motion no pulse, and the ring steps once a second) |
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
- The audit (#37): axe finds no serious or critical WCAG 2.2 A/AA violation on any screen,
  in either theme, on a desktop or a phone; every text/background pair reaches 4.5:1 and
  every ring, control border and state mark 3:1 (`contrast.test.ts`). Over the felt, where
  brass reaches only 2.3:1 in the light theme, a focus ring keeps a 2 px band of the page
  colour between the control and the brass. A focus the page places, or a focused card the
  table pushes down, is never left out of sight: it gets the least scroll that shows it.
  The table's centre is drawn in px, like the table: a larger text setting enlarges the
  page around it, browser zoom the table too, and the centre stays 4 px clear of the slot
  cards at 150 % text from 360 px. On a phone the centre's buttons have a 32 px face and a
  44 px target; on a dense phone table "Karten aufdecken" keeps one line. A human pass
  with NVDA and VoiceOver is still to do; the scripted pass records the live regions.

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
