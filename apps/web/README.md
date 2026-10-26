# @pp/web

The browser app: today a plain Vite page; React 19, TanStack Router, Zustand,
Tailwind v4 and react-i18next from #8 on. It renders what the server sends and never
decides the outcome of a round.

## Rules

- `pnpm dev` runs Vite on 5173 and proxies `/api` and `/socket.io` (WebSocket too) to
  the server on 3000.
- `pnpm build` writes static files to `dist/`; the server serves them in production.
- Every user-facing string exists in `en`, `fr` and `de` (from #8 on).
- Browser code only: `tsconfig.app.json` covers `src/` with DOM types and no Node types;
  `tsconfig.node.json` covers `vite.config.ts`.
