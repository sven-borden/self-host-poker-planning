import { defineConfig } from "drizzle-kit";

// `pnpm --filter @pp/server db:generate --name <what_it_does>` writes a new SQL migration
// to ./drizzle from the schema. Generating needs no database; the server applies the
// migrations itself at start (src/database.ts).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
