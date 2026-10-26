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
| `--line` | `#D3DCD9` | `#283836` | borders |
| `--spruce` | `#1E5A53` | `#4A9B8F` | primary actions, focus of state |
| `--on-spruce` | `#F1F7F5` | `#0B1A18` | text on spruce |
| `--brass` | `#A87A22` | `#D8A744` | accent: card backs, highlights, timer, focus ring |
| `--brass-soft` | `#F4E8CC` | `#3A2E14` | badges |
| `--brass-ink` | `#5C410C` | `#F1D9A0` | text on brass-soft |
| `--table` | `#22524C` | `#183B37` | table surface |
| `--table-rim` | `#173E39` | `#0F2926` | table rim |
| `--table-ink` | `#E7F1EE` | `#DCEBE7` | text on the table |
| `--card-face` | `#FFFDF7` | `#F5F1E6` | card faces (warm white in both themes) |
| `--card-ink` | `#13201E` | `#13201E` | card numerals |
| `--card-edge` | `#D9D3C3` | `#CFC8B5` | card border |
| `--good` / `--warn` / `--bad` | `#2F7A4D` / `#A86A12` / `#B0453B` | `#5BBE83` / `#E0A040` / `#E37468` | semantic only |

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

| | Desktop (stage 16:9) | Phone ≤ 640 px (stage 4:5.4) |
|---|---|---|
| Table insets (left/right, top/bottom) | 17 %, 18 % — wide stadium | 24 %, 14 % — tall stadium |
| Seat radii (rx, ry) | 44 %, 42 % | 40 %, 43 % |
| Card slot radii | 25 %, 23 % | 17 %, 28 % |
| Seat | 90 px wide, 40 px avatar | 66 px wide, 32 px avatar |
| Slot card | 36 × 50 px | 27 × 38 px |

- The centre of the table shows the status (`5/8 voted so far`), the timer ring, or
  after reveal the suggested card with agreement or a **Consensus** pill.
- Observers sit off the table (a small row under it) so voters keep the seats.
- With more than 10 people on a phone, seats show initials only; names on tap.
  #13 proves the geometry for 1–16 people from 360 px to 1440 px.

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
what to do. The tone per language (tu or vous, du or Sie) is decided in #41.
