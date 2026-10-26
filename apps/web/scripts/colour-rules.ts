// Rules for "no literal colour in components" (ADR-007): every colour comes from a design
// token, so a theme or a brand can change it in one place. Pure functions, no I/O, so the
// rules are tested directly; check-colours.ts walks the files.

export interface ColourFinding {
  file: string;
  line: number;
  column: number;
  match: string;
  rule: string;
}

// Tailwind's colour palette names (v4), including the newer neutrals.
const PALETTE =
  "slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

const RULES: { rule: string; pattern: RegExp }[] = [
  {
    rule: "hex colour",
    // #abc, #abcd, #aabbcc, #aabbccdd; not an HTML entity like &#123;
    pattern: /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
  },
  {
    rule: "colour function",
    pattern: /(?<![\w-])(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(/g,
  },
  {
    rule: "Tailwind palette class",
    pattern: new RegExp(`(?<![\\w-])[a-z][a-z-]*-(?:${PALETTE})-(?:50|[1-9]00|950)(?![\\w-])`, "g"),
  },
  {
    rule: "Tailwind palette class",
    pattern: /(?<![\w-])[a-z][a-z-]*-(?:white|black)(?![\w-])/g,
  },
];

/** Every literal colour in one source file, with 1-based line and column. */
export function findLiteralColours(source: string, file: string): ColourFinding[] {
  const findings: ColourFinding[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((text, index) => {
    for (const { rule, pattern } of RULES) {
      for (const match of text.matchAll(pattern)) {
        findings.push({
          file,
          line: index + 1,
          column: (match.index ?? 0) + 1,
          match: match[0],
          rule,
        });
      }
    }
  });
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Files in scope: TypeScript sources, minus token files and generated code. */
export function isCheckedFile(path: string): boolean {
  const normalised = path.replaceAll("\\", "/");
  const name = normalised.slice(normalised.lastIndexOf("/") + 1);
  if (!/\.(?:ts|tsx)$/.test(name)) {
    return false;
  }
  // Token definitions may hold literals; so may generated files.
  return !/(?:^|\.)tokens\.tsx?$/.test(name) && !name.endsWith(".gen.ts");
}

export function formatFinding(finding: ColourFinding): string {
  return `${finding.file}:${finding.line}:${finding.column}  ${finding.rule}: ${finding.match}`;
}
