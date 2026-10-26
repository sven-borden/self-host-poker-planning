import { describe, expect, it } from "vitest";
import designBrief from "../../../../docs/03-design-brief.md?raw";
import tokensCss from "../tokens.css?raw";

// The design brief's Tokens table is the colour contract. This test reads the table and
// the CSS and fails when a value drifts in either theme.

type Theme = "light" | "dark";

function briefTokens(): Record<Theme, Map<string, string>> {
  const result = { light: new Map<string, string>(), dark: new Map<string, string>() };
  const section = designBrief.split("## Tokens")[1]?.split("\n## ")[0] ?? "";
  for (const row of section.split("\n").filter((line) => line.startsWith("| `--"))) {
    const [names = "", light = "", dark = ""] = row
      .split("|")
      .slice(1)
      .map((cell) => cell.trim());
    const tokens = [...names.matchAll(/`(--[\w-]+)`/g)].map((m) => m[1] ?? "");
    const values = (cell: string) =>
      cell.split("/").map((v) => v.replaceAll("`", "").trim().toLowerCase());
    const lights = values(light);
    const darks = values(dark);
    tokens.forEach((token, i) => {
      result.light.set(token, lights[i] ?? "");
      result.dark.set(token, darks[i] ?? "");
    });
  }
  return result;
}

function cssBlock(selector: string): Map<string, string> {
  const start = tokensCss.indexOf(`${selector} {`);
  const body = tokensCss.slice(start, tokensCss.indexOf("}", start));
  return new Map(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]),
  );
}

describe("design tokens", () => {
  const brief = briefTokens();
  const light = cssBlock(":root");
  const systemDark = cssBlock(':root:not([data-theme="light"])');
  const forcedDark = cssBlock(':root[data-theme="dark"]');

  it("reads a #rrggbb value for every token of the brief, in both themes", () => {
    expect(tokensCss).toContain("--spruce");
    expect(brief.light.has("--spruce")).toBe(true);
    expect([...brief.dark.keys()]).toEqual([...brief.light.keys()]);
    for (const theme of ["light", "dark"] as const) {
      for (const [token, value] of brief[theme]) {
        expect(value, `${token} (${theme})`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("matches the light column", () => {
    for (const [token, value] of brief.light) {
      expect(light.get(token), token).toBe(value);
    }
  });

  it("matches the dark column, for the system preference and for the explicit choice", () => {
    for (const [token, value] of brief.dark) {
      // Tokens equal in both themes are only declared on :root.
      expect(systemDark.get(token) ?? light.get(token), token).toBe(value);
      expect(forcedDark.get(token) ?? light.get(token), token).toBe(value);
    }
  });

  it("declares the same overrides for the system dark theme and the forced one", () => {
    expect(forcedDark).toEqual(systemDark);
  });

  it("defines the eight avatar colours", () => {
    for (let i = 1; i <= 8; i++) {
      expect(light.get(`--av${i}`), `--av${i}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
