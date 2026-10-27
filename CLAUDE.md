# Poker Planning — working agreement for Claude Code

Read this first in every session. Current state, issue order and owner items:
`docs/STATUS.md`. History: `docs/06-build-log/`, one file per month. Product:
`docs/01-product-brief.md`. Architecture: `docs/02-architecture.md`. Design:
`docs/03-design-brief.md`. Decisions: `docs/05-decisions.md` (ADR-001 onward).
Code conventions live next to the code (package READMEs); do not duplicate them here.

## Who and what

- Owner: Sven. Self-hosted planning poker: rooms of up to 16 people around a table,
  usable without an account, shipped as one Docker image (Coolify, Azure, any Docker
  host). The UI speaks English, French and German; docs and code are English.
- Sven's instance: https://poker.borden.ch, auto-deployed from `main` by Coolify.
  Migrations run at container start.
- Sven steers as product owner by short messages. Decide with sensible defaults,
  record the reasoning (an ADR or the build log), and ask only for choices he alone
  can make (money, credentials, deployment, irreversible things). Do not create
  outward-facing things (issues, PRs, deploys) beyond the agreed loop without saying so.

## Build process

- Two issues may be in flight at once (Sven, 2026-10-26), when both have their "Depends
  on" issues merged and they touch different parts of the repo. Otherwise one at a time.
  One implementer agent per issue; the main session orchestrates.
- Each implementer works in its own git worktree in a short sibling folder
  (`../pp-wt-NN`; pnpm 12 fails on long Windows paths), never in the main checkout. The
  main checkout stays on `main` for merges and the build log.
- When two PRs are open, the one that merges second first merges `main` into its
  branch. It regenerates `pnpm-lock.yaml` with `pnpm install` (never by hand) and is
  green again before merging.
- Order: milestones `W0` to `W7`, then issue number inside a wave. Issue keys `PP-NNN`
  equal issue numbers. Order and blockers: `docs/STATUS.md`.
- Per issue: read the issue and the "Handoff for the fixer" sections of the PRs it
  depends on; brief the agent with PO defaults; the agent works on a branch
  (`feat/pp-NNN-…`, `fix/…`, `chore/…`), commits after every working step, opens the
  PR once `pnpm gate` is green, confirms CI started and hands back at "PR open". It
  never waits on CI and never merges.
- Review: once the PR is open, one read-only reviewer agent reads it while a Haiku
  agent watches CI. Findings and CI failures go to a fresh `implementer` agent with a
  fixer brief, not back to the agent that built the PR. The orchestrator merges
  (`gh pr merge --merge --delete-branch`) only on green CI, pulls `main`, and checks
  that `https://poker.borden.ch/api/health` reports the new commit.
- CI runs on pull requests only: lint, typecheck, unit, build, then integration and
  end-to-end tests against Postgres. The repo is public, so Actions minutes are free.
- Migrations: additive, descriptively named, safe on a live database mid-deploy. After
  merging `main` into a branch that adds one, delete and regenerate it: drizzle applies
  a migration only when its journal time is newer than the last one applied.

## Subagents

- Implementation and fixer agents: `subagent_type: "implementer"` with `effort: "high"`;
  reviewers: `general-purpose`. Polling (CI, deploys, health) goes to a Haiku agent
  (`model: "haiku"`) or to a background shell command such as `gh pr checks <N>
  --watch`, which costs no model tokens. No Opus agent sits in a wait loop. Always
  pass `model` explicitly. Sonnet is fine for mechanical fixer briefs.
- A spend or session limit can kill an agent mid-run: resume it from the branch state
  with SendMessage instead of relaunching from scratch.
- Every brief says: commit after every working step; pnpm only, Node 24; never read,
  print, log or commit `.env` or any secret; never open ports or connect to the
  database at module load; commit messages are plain descriptive sentences ending with
  the `Co-Authored-By` line, written to a uniquely named file (a reused file once
  mislabelled a commit); the PR body carries `Handoff for the fixer` and ends with
  `Closes #N`; batch independent reads; stop every server and browser it started (a
  leftover process locks the worktree); done is "PR open".

## Product invariants

- The server owns the round. Every change goes through `apply(state, command, now)` in
  `packages/domain`; clients never decide outcomes, they only render projections.
- A vote value never leaves the server before reveal: others learn only that someone
  voted. In anonymous mode no message ever maps a person to a value, before or after
  reveal. Tests assert this on real socket frames.
- Timers are deadlines (`deadlineAt`). The first command or client ping after the
  deadline, or the server's own timeout, triggers the reveal, exactly once.
- Room state lives in Postgres with a version number; every command is a
  compare-and-set. A redeploy mid-round loses nothing, not even unrevealed votes.
- A room holds at most 16 people; observers count unless the room setting says otherwise.
- Room codes are random (at least 58 bits). Room passwords are argon2id hashes and
  attempts are rate-limited. Nothing secret is ever logged. A room code is a bearer
  capability: it never appears in logs, error messages, Sentry or Umami; logs name a
  room by its id.
- Every user-facing string exists in `en`, `fr` and `de`; CI fails on a missing key.
  The server returns error codes, never sentences.
- No tracking by default. Sentry and Umami are opt-in through environment variables.
- Motion respects `prefers-reduced-motion`; no information is carried by motion alone.

## Secrets and deployment

- Env vars: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BASE_URL`, `ROOM_TTL_DAYS`; later
  the Google and Microsoft provider keys (W5) and optional `REDIS_URL` (scale-out only).
  Never read or print a value; never commit one.
- Do not change Coolify (env, domains, backups) or DNS without Sven's explicit go in
  that conversation.

## Housekeeping

- Update the current month's file in `docs/06-build-log/` at every merge (dated,
  append-only; start a new `YYYY-MM.md` when the month changes) and `docs/STATUS.md`
  when the state, the order or the blockers change. This repo is the memory.
- Keep `docs/STATUS.md` under about 20 kB: every agent carries it.
