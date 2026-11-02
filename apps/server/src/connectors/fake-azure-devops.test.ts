/**
 * The stand-in stays out of the product, as `fake-jira.ts` does: no file the server bundles imports
 * it, and no variable points the server at another Azure DevOps.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const sources = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
  (file) => file.endsWith(".ts") && !/\.test\.ts$|(^|[\\/])fake-azure-devops/.test(file),
);

describe("the stand-in for Azure DevOps", () => {
  it("is imported by nothing that ships", () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const file of sources) {
      expect(readFileSync(join(root, file), "utf8"), file).not.toContain("fake-azure-devops");
    }
  });

  it("is not reachable by a variable: the address is a constant", () => {
    const client = readFileSync(join(root, "connectors/azure-devops.ts"), "utf8");
    expect(client).not.toContain("process.env");
    expect(client).toContain('"https://dev.azure.com"');
  });
});
