import { defineConfig } from "vitest/config";

// One Vitest run over every package. Each project is named after its package; `pnpm test`
// runs every project except `db`.
const unit = (name: string, root: string) => ({
  test: {
    name,
    root,
    include: ["src/**/*.test.ts"],
    environment: "node" as const,
  },
});

export default defineConfig({
  test: {
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
