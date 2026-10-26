# Poker Planning

Self-hosted planning poker for teams: rooms of up to 16 people around a table, no
account needed, one Docker image to run on Coolify, Azure or any Docker host. In
English, French and German.

> **Status:** design and architecture done; building wave W0. See
> [docs/STATUS.md](docs/STATUS.md).

## What it does

- Create a room, share the link, protect it with a password if you like.
- Vote with Fibonacci, T-shirt, powers of two or your own deck, plus `?` and `☕` cards.
- The product owner reveals, or the room reveals when everyone has voted or the timer
  ends. Results show who voted what, or stay anonymous.
- Average, median, agreement and spread after every round; history and exports.
- Later: Google and Microsoft sign-in, Jira and Azure DevOps import, animated avatars,
  and paid branding for companies.

## Docs

- [Product brief](docs/01-product-brief.md)
- [Architecture](docs/02-architecture.md)
- [Design brief](docs/03-design-brief.md)
- [Open questions](docs/04-open-questions.md)
- [Decisions (ADR)](docs/05-decisions.md)
- [Status](docs/STATUS.md)

## Running it

Coming with the first wave: `docker compose up` will start the app and its Postgres
database.

## License

[MIT](LICENSE)
