import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every foreground/background pair the UI draws, checked in both themes from the
// stylesheets themselves (#37): text at 4.5:1 (WCAG 1.4.3; all our text is under 18.66 px
// bold, so no large-text allowance is taken), and what WCAG 1.4.11 asks 3:1 of: icons,
// focus rings, the borders that show where a control is, and the marks that carry a state.
// tokens.test.ts holds the brief's table to the CSS; this file holds the CSS to the UI.
//
// A new text colour must join PAIRS before it ships: the last test scans the components
// for `text-*` utilities and `color:` declarations and fails on a token no pair names.

type Theme = "light" | "dark";

// Read from disk: Vitest empties CSS imports, `?raw` included, but for tokens.css.
const SRC = join(import.meta.dirname, "..");
const tokensCss = readFileSync(join(SRC, "tokens.css"), "utf8");
const stylesCss = readFileSync(join(SRC, "styles.css"), "utf8");
type Token = `--${string}`;

/** The custom properties a CSS block declares, in source order. */
function declarations(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("}", start));
  return new Map(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]),
  );
}

const light = declarations(tokensCss, ":root");
const themes: Record<Theme, Map<string, string>> = {
  light,
  dark: new Map([...light, ...declarations(tokensCss, ':root[data-theme="dark"]')]),
};
/** shadcn/ui's names (`--primary`, `--muted-foreground`, …), each `var()` of a token. */
const aliases = declarations(stylesCss.slice(stylesCss.indexOf("/* shadcn/ui variables")), ":root");

/** A token's #rrggbb value in `theme`, through any alias. */
export function colour(token: string, theme: Theme): string {
  const value = themes[theme].get(token) ?? aliases.get(token);
  if (value === undefined) throw new Error(`unknown token ${token}`);
  const target = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  if (target) return colour(target, theme);
  if (!/^#[0-9a-f]{6}$/.test(value)) throw new Error(`${token} is not #rrggbb: ${value}`);
  return value;
}

/** WCAG 2.2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

interface Pair {
  fg: Token;
  on: Token[];
  /** 4.5 for text, 3 for non-text (WCAG 1.4.11). */
  min: 4.5 | 3;
  where: string;
}

const PAGE: Token[] = ["--bg", "--surface", "--surface-2"];
const AVATARS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `--av${n}` as Token);

export const PAIRS: Pair[] = [
  // Text, 4.5:1.
  { fg: "--ink", on: PAGE, min: 4.5, where: "body text, panels, chips, the stage's pool of light" },
  { fg: "--ink-2", on: PAGE, min: 4.5, where: "secondary text, captions, muted text" },
  { fg: "--spruce", on: ["--bg", "--surface"], min: 4.5, where: "issue keys, deck captions" },
  {
    fg: "--brass-ink",
    on: ["--brass-soft", "--bg", "--surface"],
    min: 4.5,
    where: "brass badges (agreement, the changed mark) and brass words",
  },
  { fg: "--warn-ink", on: PAGE, min: 4.5, where: "warnings, the timer's last seconds" },
  { fg: "--on-spruce", on: ["--spruce"], min: 4.5, where: "primary buttons, extreme badges" },
  { fg: "--on-bad", on: ["--bad"], min: 4.5, where: "destructive buttons" },
  {
    fg: "--table-ink",
    on: ["--table", "--table-rim"],
    min: 4.5,
    where: "words on the felt: the centre's status, the timer",
  },
  {
    fg: "--card-ink",
    on: ["--card-face"],
    min: 4.5,
    where: "card numerals, the centre's card-face buttons",
  },
  { fg: "--on-avatar", on: AVATARS, min: 4.5, where: "avatar initials" },
  { fg: "--bg", on: ["--ink"], min: 4.5, where: "tooltips (text-background on bg-foreground)" },

  // Non-text, 3:1.
  {
    fg: "--line-strong",
    on: PAGE,
    min: 3,
    where: "control borders: inputs, switches when off, outline buttons",
  },
  {
    fg: "--brass",
    on: PAGE,
    min: 3,
    where: "the focus ring, the selected hand card's ring, the PO's picked final",
  },
  {
    fg: "--brass",
    on: ["--table"],
    min: 3,
    where: "the focus ring on the felt, in the dark theme only: see FELT_RING",
  },
  {
    fg: "--spruce",
    on: PAGE,
    min: 3,
    where: "the viewer's outline, a checked option's border, results columns",
  },
  { fg: "--bad", on: PAGE, min: 3, where: "error icons" },
  { fg: "--warn-ink", on: PAGE, min: 3, where: "warning icons" },
  { fg: "--good", on: PAGE, min: 3, where: "the live dot in the phone header" },
  { fg: "--surface", on: ["--good"], min: 3, where: "the voted badge's tick" },
  { fg: "--card-face", on: ["--table"], min: 3, where: "a card's frame and the centre's buttons" },
];

/**
 * In the light theme brass on the felt reaches only 2.3:1, and no single brass can pass
 * on both the light page and the dark felt. A focus ring over the felt therefore keeps a
 * band of the page colour between the control and the ring (`ring-offset-background`, as
 * every Button does), and that band stands out against the felt.
 */
const FELT_RING: { band: Token; ring: Token; felt: Token } = {
  band: "--bg",
  ring: "--brass",
  felt: "--table",
};

/**
 * Pairs that are measured but not held to a ratio, each with its reason: information
 * that another part of the screen carries in words.
 */
const EXEMPT = {
  "timer ring": "the chip in its middle says the time left in words; the ring repeats it",
  "the recorded final's brass outline": "the centre's sentence names the final",
  "decorative lines": "--line and --card-edge only separate things that stand apart anyway",
};

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(tsx|css)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });

describe("contrast of every pair the UI draws (WCAG 2.2 AA)", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const pair of PAIRS) {
      for (const background of pair.on) {
        if (theme === "light" && pair.fg === "--brass" && background === "--table") continue;
        it(`${pair.fg} on ${background} reaches ${pair.min}:1 in the ${theme} theme (${pair.where})`, () => {
          const ratio = contrast(colour(pair.fg, theme), colour(background, theme));
          expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.min);
        });
      }
    }
  }

  it("keeps the focus ring visible on the felt in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const band = colour(FELT_RING.band, theme);
      const ring = colour(FELT_RING.ring, theme);
      const felt = colour(FELT_RING.felt, theme);
      // The ring against the band next to it, and either the band or the ring against the felt.
      expect(contrast(ring, band), theme).toBeGreaterThanOrEqual(3);
      expect(Math.max(contrast(band, felt), contrast(ring, felt)), theme).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives every exemption a reason", () => {
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(20);
  });

  it("names every text colour the components use in a pair", () => {
    const named = new Set(PAIRS.map((pair) => pair.fg));
    const used = new Map<string, string>();
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      // `text-ink-2`, `hover:text-card-ink`; not sizes (`text-sm`, `text-[12px]`).
      for (const m of text.matchAll(
        /(?<![\w-])(?:[\w-]+:)*text-([a-z][\w-]*?)(?:\/\d+)?(?![\w-])/g,
      )) {
        used.set(`--${m[1]}`, file);
      }
      for (const m of text.matchAll(/(?<![\w-])color:\s*var\((--[\w-]+)\)/g)) {
        used.set(m[1] ?? "", file);
      }
    }
    // Tailwind's text utilities that are not colours.
    const notColours =
      /^--(?:[2-9]?xl|xs|sm|base|lg|left|center|right|start|end|wrap|nowrap|balance|pretty|clip|ellipsis|shadow.*)$/;
    const unnamed: string[] = [];
    for (const [token, file] of used) {
      if (notColours.test(token)) continue;
      const resolved = resolveToken(token);
      // A decorative marker: list bullets in brass (room-not-found.tsx).
      if (resolved === "--brass" && /marker:text-brass/.test(readFileSync(file, "utf8"))) continue;
      if (resolved && !named.has(resolved)) unnamed.push(`${token} (${file})`);
    }
    expect(unnamed).toEqual([]);
    expect(used.size).toBeGreaterThan(5);
    expect(colour("--muted-foreground", "dark")).toBe(colour("--ink-2", "dark"));
  });
});

/** The design token behind a utility's colour name (`--primary-foreground` → `--on-spruce`). */
function resolveToken(token: string): Token | null {
  if (themes.light.has(token)) return token as Token;
  const value = aliases.get(token);
  const target = value && /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  return target ? resolveToken(target) : null;
}
