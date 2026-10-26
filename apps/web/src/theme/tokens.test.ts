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

/** WCAG 2.2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours, from 1 to 21. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe("token contrast (WCAG 2.2 AA, docs/03-design-brief.md)", () => {
  const brief = briefTokens();
  const cases = [
    // Text: 4.5:1.
    ["--ink", 4.5],
    ["--ink-2", 4.5],
    ["--brass-ink", 4.5],
    ["--warn-ink", 4.5],
    // Control borders (WCAG 1.4.11): 3:1.
    ["--line-strong", 3],
  ] as const;

  for (const theme of ["light", "dark"] as const) {
    for (const [token, minimum] of cases) {
      for (const background of ["--bg", "--surface"]) {
        it(`${token} on ${background} reaches ${minimum}:1 in the ${theme} theme`, () => {
          const ratio = contrast(brief[theme].get(token) ?? "", brief[theme].get(background) ?? "");
          expect(ratio, `${token} on ${background}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
            minimum,
          );
        });
      }
    }
  }
});
