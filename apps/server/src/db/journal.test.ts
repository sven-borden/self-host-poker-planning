/**
 * drizzle applies a migration only when its journal `when` is newer than the newest
 * applied one (`created_at`), not by hash. A hand-merged `_journal.json` that keeps an
 * older `when` after a newer one would be skipped in production, silently, and applied in
 * CI. Rule (README): after merging main into a branch that adds a migration, delete your
 * migration and generate it again.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR } from "../database.ts";

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

const journal = JSON.parse(
  readFileSync(join(DEFAULT_MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
) as Journal;

describe("the migration journal", () => {
  it("numbers its entries 0, 1, 2 and so on, with a strictly increasing when", () => {
    expect(journal.entries.length).toBeGreaterThan(0);
    journal.entries.forEach((entry, index) => {
      expect(entry.idx).toBe(index);
      const previous = journal.entries[index - 1];
      if (previous) expect(entry.when).toBeGreaterThan(previous.when);
    });
  });

  it("has a SQL file for every entry, and an entry for every SQL file", () => {
    for (const { tag } of journal.entries) {
      expect(existsSync(join(DEFAULT_MIGRATIONS_DIR, `${tag}.sql`)), tag).toBe(true);
    }
    const files = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
    expect(files.sort()).toEqual(journal.entries.map(({ tag }) => `${tag}.sql`).sort());
  });
});
