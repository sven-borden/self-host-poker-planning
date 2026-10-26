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
    ["hsl()", "hsl(200 50% 50%)", "hsl("],
    ["oklch()", "oklch(0.7 0.1 200)", "oklch("],
    ["palette class", 'className="p-2 bg-red-500"', "bg-red-500"],
    ["palette class with variant", 'className="hover:text-slate-900/50"', "text-slate-900"],
    ["white", 'className="text-white"', "text-white"],
    ["black with opacity", 'className="bg-black/50"', "bg-black"],
    ["arbitrary hex", 'className="bg-[#123456]"', "#123456"],
  ])("flags %s", (_name, source, match) => {
    expect(findLiteralColours(source, "x.tsx").map((f) => f.match)).toContain(match);
  });

  it.each([
    ["a token class", 'className="bg-surface text-ink-2 border-line"'],
    ["a CSS variable", 'style={{ color: "var(--brass)" }}'],
    ["an anchor", '<a href="#main">'],
    ["an HTML entity", "&#123;"],
    ["a word that contains a colour name", 'className="whitespace-nowrap"'],
    ["a function whose name ends like a colour function", "label(x); getRgb(y)"],
  ])("accepts %s", (_name, source) => {
    expect(findLiteralColours(source, "x.tsx")).toEqual([]);
  });

  it("reports 1-based line and column", () => {
    const [finding] = findLiteralColours('const a = 1;\nconst b = "#abcdef";', "f.ts");
    expect(finding).toMatchObject({ file: "f.ts", line: 2, column: 12, rule: "hex colour" });
  });
});

describe("isCheckedFile", () => {
  it("checks TypeScript sources only and skips token files and generated code", () => {
    expect(isCheckedFile("src/routes/index.tsx")).toBe(true);
    expect(isCheckedFile("src\\lib\\utils.ts")).toBe(true);
    expect(isCheckedFile("src/styles.css")).toBe(false);
    expect(isCheckedFile("src/theme/tokens.ts")).toBe(false);
    expect(isCheckedFile("src/brand.tokens.ts")).toBe(false);
    expect(isCheckedFile("src/routeTree.gen.ts")).toBe(false);
  });
});

describe("check-colours", () => {
  it("finds every literal in the failing fixture", () => {
    const matches = checkDirectory(fixtures).map((f) => f.match);
    expect(matches).toEqual(["bg-red-500", "text-white", "#B0453B", "rgb("]);
  });

  it("exits with 1 on the failing fixture", () => {
    const run = spawnSync(process.execPath, [script, fixtures], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("literal-colours.tsx:5");
  });

  it("passes on the app sources", () => {
    expect(checkDirectory(src)).toEqual([]);
  });
});
