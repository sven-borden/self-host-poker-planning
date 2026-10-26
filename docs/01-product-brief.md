# Product brief

## Problem

Teams estimate backlog items with planning poker. The hosted tools we tried are
ad-heavy, paywall basic features, or cannot run inside a company. We want a tool that
is pleasant and professional, free in its base, and that any team can run on its own
infrastructure in minutes.

## Who it is for

- **Scrum teams of 3 to 16 people** estimating stories during refinement, on laptops
  and phones.
- **The product owner (PO)**, who runs the session: owns the room, starts rounds,
  reveals, records the final estimate.
- **Observers**: stakeholders who watch without voting.
- **Self-hosters**: a developer or IT person who runs one Docker image on Coolify,
  Azure or any Docker host.

## Requirements and how we meet them

Source: `input.md`. Decisions: `docs/05-decisions.md`.

| # | Requirement | How | Wave |
|---|---|---|---|
| R1 | Use the tool without any account | Guest sessions, a real user row without personal data (ADR-009) | W0–W1 |
| R2 | Accounts with Microsoft or Google, late | Better Auth social providers, guest linked to account (ADR-009) | W5 |
| R3 | A room is a dedicated link, optionally password protected | Random 10-character code; argon2id password (ADR-010) | W1, W2 |
| R4 | Up to 16 people per room | Server invariant; observers count by default (ADR-011) | W1 |
| R5 | A product owner (admin) per room | PO role, hand-over, claim when away (ADR-010) | W1, W2 |
| R6 | Settings: what we estimate (a link, nothing, a round), values, timer | Room settings panel; optional subject: none, title or link | W1, W2 |
| R7 | Vote timer; reveal at the end or not | Deadline timer with a setting (ADR-011) | W2 |
| R8 | Free values or presets: T-shirt, Fibonacci, numbers, increments | Presets, custom deck, range generator | W2 |
| R9 | Special cards: question mark and coffee | On by default; infinity optional | W1 |
| R10 | Live | Socket.IO, server-authoritative state (ADR-002, ADR-003) | W1 |
| R11 | Everyone sets a name when joining | Join screen, name remembered on the device | W1 |
| R12 | Small animated SVG avatars, later | Original avatar set | W4 |
| R13 | History of past rounds | History panel, visible to everyone in the room | W3 |
| R14 | The PO can force the reveal | Yes, always | W1 |
| R15 | Reveal who voted what, or only the cards | Named or anonymous mode | W2 |
| R16 | A summary of what is proposed | Average, median, agreement, spread, suggested card | W1 |
| R17 | Optionally edit a vote after reveal | Setting, off by default; changed votes are marked; named rounds only | W2 |
| R18 | Efficient, professional design around a table | The boardroom table (ADR-005) | W0–W1 |
| R19 | Jira / Azure DevOps paste or connector, later | Paste first, then connectors | W6 |
| R20 | Top-notch card animations | Motion for React and a motion spec (ADR-008) | W1, W4 |
| R21 | Paid branding later; base free | Seams now, model decided in W7 (ADR-015) | W7 |
| R22 | Background music while waiting, later | Original loops composed in code | W4 |
| R23 | Light and dark mode | Design tokens, system default plus toggle | W0 |
| R24 | Works on mobile | Tall table, scrolling hand | W1 |
| R25 | Deploy quickly and easily | One Docker image: Coolify, Azure, any Docker host. Vercel dropped for now (ADR-001) | W0, W3 |

## Room defaults

Validated on 2026-10-26; the PO can change each one inside the room (ADR-011).

| Setting | Default |
|---|---|
| Deck | Fibonacci: 0 1 2 3 5 8 13 21 |
| Special cards | `?` (unsure) and `☕` (break) on, `∞` off |
| Who can reveal | PO only (the PO can always force a reveal) |
| After reveal, show | Who voted what (named) |
| Reveal when everyone has voted | On |
| Timer | Off; presets 30 s, 60 s, 2 min |
| Reveal when the timer ends | On |
| Change a vote after reveal | Off |
| The PO votes too | On |
| Observers count toward the 16 | On |

"Change a vote after reveal" applies to named rounds only: an anonymous round locks its
votes at reveal, because a change after an anonymous reveal could tie a person to a
card. The W2 settings UI says so next to the setting.

## Success criteria

- A team of eight estimates ten stories in one refinement without anyone needing help.
- A self-hoster goes from `docker compose up` to a working room in under ten minutes.
- No vote value is ever visible to others before reveal, and in anonymous mode never
  tied to a person (tested on socket frames).
- A round is as comfortable on a phone as on a laptop.

## Non-goals for now

- Video, audio or chat: teams already sit in Teams, Slack or Meet.
- Vercel or other serverless hosting (revisit only on demand; see ADR-001).
- Offline use.
- Running a multi-tenant SaaS, unless chosen in W7.

## Waves

Each wave is a GitHub milestone; issues are built one at a time.

| Wave | Goal | Issues |
|---|---|---|
| W0 Foundations | A walking skeleton, live on Coolify at poker.borden.ch | #1–#13 |
| W1 Play a round | A team estimates a real story, no account needed | #14–#24 |
| W2 Facilitate | The PO runs the session their way | #25–#32 |
| W3 Record and self-host | History, exports, hardening and the self-hosting kit | #33–#41 |
| W4 Delight | Avatars, motion polish, sound, music, PWA | #42–#46 |
| W5 Accounts | Sign in with Google or Microsoft | #47–#51 |
| W6 Backlog import | Fill the queue from Jira or Azure DevOps | #52–#55 |
| W7 Branding | A company's look, as a paid option | #56–#59 |
