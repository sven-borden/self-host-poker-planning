import { configDefaults, defineConfig } from "vitest/config";

// One Vitest run over every package. Each project is named after its package; `pnpm test`
// runs every project except `db`. Unit projects pick up `*.test.ts` and `*.test.tsx` but
// never `*.db.test.ts`, which belong to the `db` project alone.
const unit = (name: string, root: string) => ({
  test: {
    name,
    root,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
    environment: "node" as const,
  },
});

export default defineConfig({
  test: {
    // `pnpm test:coverage` (run by `pnpm gate`, hence CI): the round state machine is
    // covered completely, every branch included. Only listed files are measured.
    coverage: {
      provider: "v8",
      // Globs resolve against each project root, not this file: `src/apply*.ts` is
      // packages/domain/src/apply*.ts. A glob matching nothing passes silently (0/0).
      include: ["src/apply*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: [["text", { skipFull: true }], "text-summary"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
    projects: [
      unit("domain", "./packages/domain"),
      unit("protocol", "./packages/protocol"),
      unit("server", "./apps/server"),
      unit("web", "./apps/web"),
      {
        test: {
          name: "scripts",
          root: "./scripts",
          include: ["**/*.test.mjs"],
          environment: "node",
        },
      },
      // Integration tests against a real Postgres (`pnpm test:db`), added by #2. Not part
      // of `pnpm gate`: they need DATABASE_URL and run in CI against a Postgres service.
      {
        test: {
          name: "db",
          root: ".",
          include: ["{apps,packages}/*/src/**/*.db.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
