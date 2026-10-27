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
- Observers sit off the table (a small row under it) so voters keep the seats.
- With more than 10 people on a phone, seats show initials only; names on tap. A name
  cut off at its width opens the same way.
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

## Cards

- **Hand cards**: 50 × 72 px (phone 44 × 64), warm face, numeral centred, corner
  indices top-left and bottom-right (rotated), 7 px radius.
- **Back**: brass diagonal stripes framed by the card face colour.
- **Specials**: `?` unsure, `☕` break, `∞` too big; never counted in statistics.
- **Mini cards** (anonymous results): 28 × 39 px.

## Results

Under the table: Average, Median, Agreement, Spread as large tabular numbers with
mono captions; a distribution of columns (one per card value, height by count). For
T-shirt decks: Most voted, Agreement, Spread. In named mode the lowest and highest
voters are highlighted to start the discussion.

## Motion spec

Easing everywhere: `cubic-bezier(.2, .8, .2, 1)` unless stated. All of it is
interruptible and disabled under `prefers-reduced-motion` (120 ms cross-fades instead).

| Moment | Spec |
|---|---|
| Hand deal-in (round start) | cards rise 12 px and fade in, 260 ms, 30 ms stagger |
| Hover / select | lift 6 px (180 ms); selected lifts 12 px with a 2 px brass ring |
| Hand → seat travel | 520 ms arc, midpoint 36 px above the line, −9° tilt, scales to the slot; lands face down with a 380 ms drop |
| Voted badge | 300 ms pop with slight overshoot |
| Reveal flip | `rotateY(180deg)` 650 ms, 90 ms stagger in seat order from the viewer |
| Anonymous reveal | slot cards shrink to 0.6 and fade (350 ms); mini cards deal into the results row, 70 ms stagger |
| Results | columns rise 500 ms, 60 ms stagger, starting after the last flip |
| Consensus | pill pops (400 ms) and one soft ring pulse; no confetti storm |
| Timer | ring drains linearly; last 10 s turns `--warn` and pulses at 1 Hz |
| Seat join / leave | fade and scale from 0.9, 220 ms |

## Accessibility

- Text contrast at least 4.5:1 in both themes; focus ring 2 px `--brass`.
- Full keyboard play: arrow keys move through the hand, Enter votes, `R` reveals for the PO.
- Live region announces "Ana voted", "Cards revealed: average 5", never a hidden value.
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
- **Join with a code** takes a bare code or a pasted room link (this site's or a full
  `https://…/r/CODE`), ignores spaces anywhere, checks the shape in the browser and opens
  `/r/:code`. A refused entry says why and keeps the focus in the field. It offers no
  history of earlier codes.
- **A missing room** shows the table with its seats empty, drawn from the tokens, never
  stock art. The server cannot tell an unknown code from a deleted room, so the page
  names both: a mistyped or cut link, or a room deleted after `ROOM_TTL_DAYS` days
  without activity (the server states the number). The way back is another code or a
  new room; there is no retry, since nothing will make the room appear.
- **The code is never echoed** on that page, in its text or in the tab title. A code is a
  bearer capability (architecture, section 11): a screenshot or a shared screen of an
  error would spread it, and the address bar already shows what was typed. The room's
  own page shows its code, because there it is meant to be shared.
- **The error page** (anything a page throws, or a chunk that cannot load) says that
  something went wrong and offers a reload and the home page. It never shows the error,
  its stack or the address. The same table carries one face-down card.
- **Tab titles** read "Page · Poker Planning" on these pages, and never hold a code.
