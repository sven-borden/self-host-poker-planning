# Open questions

Questions that are not decided yet, with the default we build on until Sven decides.
Close an entry by recording the answer here (and an ADR when it changes the design).

| # | Question | Default until decided | Decided in |
|---|---|---|---|
| OQ-1 | Azure: Container Apps, App Service, or a VM with Docker? | Container Apps with Postgres Flexible Server | #38 |
| OQ-2 | French and German tone: tu or vous, du or Sie? | vous and Sie | #41 |
| OQ-3 | Licence and pricing model for branding: open core or paid hosted edition? | everything MIT until W7 | #56 |
| OQ-4 | Vercel hosting: needed by anyone? | no; containers only (ADR-001) | on demand |
| OQ-5 | Product name | "Poker Planning" | any time |
| OQ-6 | Microsoft Entra account linking: does `email_verified` block linking a guest? | test and handle in #48 | #48 |
| OQ-7 | Node 26 becomes LTS on 2026-10-28: when do we move from Node 24? | when our dependencies support it | any time |

## Answered on 2026-10-26 (round 1)

- Own instance: `poker.borden.ch` on Sven's Coolify.
- Product name: keep "Poker Planning" for now.
- Vercel: nobody runs on Vercel for now, so it is dropped (ADR-001).
- Issues: all waves opened at once (#1–#59).
- Room history: visible to everyone in the room.
- Music: original loops composed in code by Claude, no third-party licensing (#45).
