// @vitest-environment node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDirectory } from "./check-colours.ts";
import { findLiteralColours, isCheckedFile } from "./colour-rules.ts";

const script = fileURLToPath(new URL("./check-colours.ts", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const src = fileURLToPath(new URL("../src", import.meta.url));

describe("findLiteralColours", () => {
  it.each([
    ["hex", 'const c = "#1E5A53";', "#1E5A53"],
    ["short hex", "color: '#fff'", "#fff"],
    ["hex with alpha", "fill: #13201ECC", "#13201ECC"],
    ["rgb()", "rgb(0 0 0 / 0.5)", "rgb("],
    ["rgba()", "rgba(0,0,0,.5)", "rgba("],
    ["upper-case RGB()", "RGB(0 0 0)", "RGB("],
    ["hsl()", "hsl(200 50% 50%)", "hsl("],
    ["oklch()", "oklch(0.7 0.1 200)", "oklch("],
    ["color()", "color(display-p3 1 0 0)", "color("],
    ["color-mix()", "color-mix(in srgb, var(--ink) 50%, var(--bg))", "color-mix("],
    ["palette class", 'className="p-2 bg-red-500"', "bg-red-500"],
    ["palette class with variant", 'className="hover:text-slate-900/50"', "text-slate-900"],
    ["white", 'className="text-white"', "text-white"],
    ["black with opacity", 'className="bg-black/50"', "bg-black"],
    ["arbitrary hex", 'className="bg-[#123456]"', "#123456"],
    ["named colour in an arbitrary value", 'className="bg-[red]"', "red"],
    ["named colour in an arbitrary property", 'className="[color:crimson]"', "crimson"],
    ["named colour in an SVG fill", 'className="fill-[navy]"', "navy"],
    ["named colour inside a shadow", 'className="shadow-[0_0_0_2px_tomato]"', "tomato"],
    ["upper-case named colour", 'className="hover:bg-[Red]"', "Red"],
    ["named colour in a style object", 'style={{color:"red"}}', "red"],
    ["named colour in a border shorthand", "style={{ border: '1px solid Navy' }}", "Navy"],
  ])("flags %s", (_name, source, match) => {
    expect(findLiteralColours(source, "x.tsx").map((f) => f.match)).toContain(match);
  });

  it.each([
    ["a token class", 'className="bg-surface text-ink-2 border-line"'],
    ["a CSS variable", 'style={{ color: "var(--brass)" }}'],
    ["a token in an arbitrary value", 'className="shadow-[3px_-2px_0_-0.5px_var(--brass)]"'],
    ["an arbitrary variant", "className=\"[&_svg:not([class*='size-'])]:size-4\""],
    ["an index in code", "const Icon = ICONS[mode]; items[tan]"],
    ["a word that is a colour outside a colour property", 'const label = { title: "Gold" }'],
    ["transparent and currentColor", 'style={{ fill: "currentColor", color: "transparent" }}'],
    ["an anchor", '<a href="#main">'],
    ["an HTML entity", "&#123;"],
    ["a word that contains a colour name", 'className="whitespace-nowrap"'],
    ["a function whose name ends like a colour function", "label(x); getRgb(y); setColor(z)"],
  ])("accepts %s", (_name, source) => {
    expect(findLiteralColours(source, "x.tsx")).toEqual([]);
  });

  it("reports 1-based line and column", () => {
    const [finding] = findLiteralColours('const a = 1;\nconst b = "#abcdef";', "f.ts");
    expect(finding).toMatchObject({ file: "f.ts", line: 2, column: 12, rule: "hex colour" });
  });

  it("reports the column of the colour word inside a value", () => {
    const [finding] = findLiteralColours('<p style={{ color: "red" }} />', "f.tsx");
    expect(finding).toMatchObject({ column: 21, match: "red" });
  });
});

describe("findLiteralColours in stylesheets", () => {
  it("flags named colours, hex and colour functions in declarations", () => {
    const css = ".a {\n  color: Tomato;\n  border: 1px solid #fff;\n  fill: rgb(0 0 0);\n}";
    expect(findLiteralColours(css, "a.css").map((f) => [f.line, f.match])).toEqual([
      [2, "Tomato"],
      [3, "#fff"],
      [4, "rgb("],
    ]);
  });

  it("ignores comments, selectors and token references", () => {
    const css =
      "/* bg-red-500, #fff and red are fine here */\n:root:not([data-theme='light']) {\n  color: var(--ink);\n  --background: var(--bg);\n}";
    expect(findLiteralColours(css, "a.css")).toEqual([]);
  });
});

describe("isCheckedFile", () => {
  it("checks TypeScript sources and stylesheets, and skips token files and generated code", () => {
    expect(isCheckedFile("src/routes/index.tsx")).toBe(true);
    expect(isCheckedFile("src\\lib\\utils.ts")).toBe(true);
    expect(isCheckedFile("src/styles.css")).toBe(true);
    expect(isCheckedFile("src/tokens.css")).toBe(false);
    expect(isCheckedFile("src/theme/tokens.ts")).toBe(false);
    expect(isCheckedFile("src/brand.tokens.ts")).toBe(false);
    expect(isCheckedFile("src/routeTree.gen.ts")).toBe(false);
    expect(isCheckedFile("src/logo.svg")).toBe(false);
  });
});

describe("check-colours", () => {
  it("finds every literal in the failing fixtures", () => {
    const matches = checkDirectory(fixtures).map((f) => `${f.file.split("/").pop()} ${f.match}`);
    expect(matches).toEqual([
      "literal-colours.css tomato",
      "literal-colours.css #b0453b",
      "literal-colours.css rgb(",
      "literal-colours.tsx bg-red-500",
      "literal-colours.tsx text-white",
      "literal-colours.tsx #B0453B",
      "literal-colours.tsx rgb(",
      "literal-colours.tsx red",
      "literal-colours.tsx crimson",
      "literal-colours.tsx navy",
      "literal-colours.tsx tomato",
      "literal-colours.tsx red",
      "literal-colours.tsx RGB(",
      "literal-colours.tsx color-mix(",
    ]);
  });

  it("exits with 1 on the failing fixtures", () => {
    const run = spawnSync(process.execPath, [script, fixtures], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("literal-colours.tsx:5");
    expect(run.stderr).toContain("literal-colours.css:3");
  });

  it("passes on the app sources, stylesheets included", () => {
    expect(checkDirectory(src)).toEqual([]);
  });
});
