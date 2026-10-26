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

interface Hit {
  index: number;
  match: string;
}

interface Rule {
  rule: string;
  find: (text: string) => Hit[];
}

// Tailwind's colour palette names (v4), including the newer neutrals.
const PALETTE =
  "slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

// The CSS named colours (CSS Color 4), matched case-insensitively. `transparent` and
// `currentColor` are keywords, not colours, and stay allowed.
const NAMED_COLOURS =
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  );

// A named colour as a whole word. `_` separates words in Tailwind arbitrary values
// (`shadow-[0_0_0_2px_tomato]`), so it counts as a boundary; `-` does not (`--red-x`).
const NAMED_COLOUR = new RegExp(`(?<![a-z0-9-])(?:${NAMED_COLOURS.join("|")})(?![a-z0-9-])`, "gi");

// A Tailwind arbitrary value or property: `bg-[red]`, `[color:crimson]`. It starts a
// class or follows a utility prefix or variant, which rules out `items[i]` in code.
const ARBITRARY = /(?<=^|[\s"'`:!-])\[[^\]\s]+\]/g;

// A property that takes a colour, in a style object or a CSS declaration.
const COLOUR_PROPERTY =
  /colou?r|background|bg|border|outline|fill|stroke|shadow|caret|accent|decoration|stop/i;

// `color: "red"` or `"--x-bg": 'navy'` in a style object (one property per match).
const STYLE_VALUE = /(["']?)([\w-]+)\1\s*:\s*(["'`])([^"'`]*)\3/g;

// `color: tomato;` in a stylesheet.
const CSS_DECLARATION = /(?<![\w-])(-{0,2}[a-z][\w-]*)\s*:\s*([^;{}]+);/gi;

const regexRule = (rule: string, pattern: RegExp): Rule => ({
  rule,
  find: (text) => [...text.matchAll(pattern)].map((m) => ({ index: m.index, match: m[0] })),
});

/** Named colours inside `segment`, which starts at `offset` in the line. */
function namedColoursIn(segment: string, offset: number): Hit[] {
  return [...segment.matchAll(NAMED_COLOUR)].map((m) => ({
    index: offset + m.index,
    match: m[0],
  }));
}

const COMMON_RULES: Rule[] = [
  // #abc, #abcd, #aabbcc, #aabbccdd; not an HTML entity like &#123;
  regexRule(
    "hex colour",
    /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
  ),
  regexRule(
    "colour function",
    /(?<![\w-])(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix|color)\(/gi,
  ),
  regexRule(
    "Tailwind palette class",
    new RegExp(String.raw`(?<![\w-])[a-z][a-z-]*-(?:${PALETTE})-(?:50|[1-9]00|950)(?![\w-])`, "g"),
  ),
  regexRule("Tailwind palette class", /(?<![\w-])[a-z][a-z-]*-(?:white|black)(?![\w-])/g),
];

const SCRIPT_RULES: Rule[] = [
  ...COMMON_RULES,
  {
    rule: "named colour in an arbitrary value",
    find: (text) => [...text.matchAll(ARBITRARY)].flatMap((m) => namedColoursIn(m[0], m.index)),
  },
  {
    rule: "named colour in a style value",
    find: (text) =>
      [...text.matchAll(STYLE_VALUE)].flatMap((m) => {
        const [whole, , property = "", , value = ""] = m;
        if (!COLOUR_PROPERTY.test(property)) {
          return [];
        }
        return namedColoursIn(value, m.index + whole.length - value.length - 1);
      }),
  },
];

const STYLESHEET_RULES: Rule[] = [
  ...COMMON_RULES,
  {
    rule: "named colour in a declaration",
    find: (text) =>
      [...text.matchAll(CSS_DECLARATION)].flatMap((m) => {
        const [whole, property = "", value = ""] = m;
        if (!COLOUR_PROPERTY.test(property)) {
          return [];
        }
        return namedColoursIn(value, m.index + whole.length - value.length - 1);
      }),
  },
];

/** Blanks out CSS comments, keeping line and column positions intact. */
function withoutCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** Every literal colour in one source file, with 1-based line and column. */
export function findLiteralColours(source: string, file: string): ColourFinding[] {
  const stylesheet = file.endsWith(".css");
  const rules = stylesheet ? STYLESHEET_RULES : SCRIPT_RULES;
  const lines = (stylesheet ? withoutCssComments(source) : source).split(/\r?\n/);
  const findings: ColourFinding[] = [];
  lines.forEach((text, index) => {
    for (const { rule, find } of rules) {
      for (const hit of find(text)) {
        findings.push({ file, line: index + 1, column: hit.index + 1, match: hit.match, rule });
      }
    }
  });
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Files in scope: TypeScript sources and stylesheets, minus token files and generated code. */
export function isCheckedFile(path: string): boolean {
  const normalised = path.replaceAll("\\", "/");
  const name = normalised.slice(normalised.lastIndexOf("/") + 1);
  if (!/\.(?:ts|tsx|css)$/.test(name)) {
    return false;
  }
  // Token definitions may hold literals; so may generated files.
  return !/(?:^|\.)tokens\.(?:tsx?|css)$/.test(name) && !name.endsWith(".gen.ts");
}

export function formatFinding(finding: ColourFinding): string {
  return `${finding.file}:${finding.line}:${finding.column}  ${finding.rule}: ${finding.match}`;
}
