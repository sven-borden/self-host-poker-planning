# Open questions

Questions that are not decided yet, with the default we build on until Sven decides.
Close an entry by recording the answer here (and an ADR when it changes the design).

| # | Question | Default until decided | Decided in |
|---|---|---|---|
| OQ-3 | Licence and pricing model for branding: open core or paid hosted edition? | everything MIT until W7 | #56 |
| OQ-4 | Vercel hosting: needed by anyone? | no; containers only (ADR-001) | on demand |
| OQ-5 | Product name | "Poker Planning" | any time |
| OQ-7 | Node 26 becomes LTS on 2026-10-28: when do we move from Node 24? | when our dependencies support it | any time |

## Answered on 2026-11-02 (Sven)

- OQ-1, Azure: **App Service** (Web App for Containers on Linux) with Postgres Flexible Server,
  not the Container Apps default. The template comes with #38.
- OQ-2, French and German tone: **vous and Sie**, the default the copy already used. The review is
  #41.

## Answered on 2026-11-02 (#48)

- OQ-6, Microsoft Entra account linking: does `email_verified` block linking a guest? **No.** No
  linking depends on it. A guest becomes an account through the sign-in itself: Better Auth's
  anonymous plugin hands the guest and the new user to `onLinkAccount`, and nothing in that path
  reads the claim (ADR-025). `apps/server/src/guest-link.db.test.ts` signs a guest in with the
  stand-in, with the claim true, false and absent, and each time the room, the role and the seat
  move and the guest goes. The claim would matter only to `linkSocial`, which refuses an
  unverified identity from an untrusted provider, and that route stays closed. Every Microsoft
  account stores `email_verified` false, whatever the token says (ADR-023). **Not proven without
  a real tenant:** what real tokens carry for `email`, `email_verified`, `tid` and `oid`, from
  a work account and from a personal one. If a token lacks `tid` or `oid` the sign-in ends in
  `failed`, before anything moves.

## Answered on 2026-10-26 (round 1)

- Own instance: `poker.borden.ch` on Sven's Coolify.
- Product name: keep "Poker Planning" for now.
- Vercel: nobody runs on Vercel for now, so it is dropped (ADR-001).
- Issues: all waves opened at once (#1–#59).
- Room history: visible to everyone in the room.
- Music: original loops composed in code by Claude, no third-party licensing (#45).
