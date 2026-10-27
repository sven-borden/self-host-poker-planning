// @vitest-environment node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDirectory } from "./check-copy.ts";
import { findLiteralCopy, isCheckedFile } from "./copy-rules.ts";

const script = fileURLToPath(new URL("./check-copy.ts", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/copy", import.meta.url));
const src = fileURLToPath(new URL("../src", import.meta.url));

describe("findLiteralCopy", () => {
  it.each([
    ["JSX text", "const a = <p>Hello</p>;", "Hello"],
    ["JSX text around an expression", "const a = <p>Hi {name}</p>;", "Hi"],
    ["accented text", "const a = <p>Réglages</p>;", "Réglages"],
    ["aria-label", 'const a = <b aria-label="Close" />;', 'aria-label="Close"'],
    ["title in braces", 'const a = <b title={"Close"} />;', 'title="Close"'],
    ["placeholder template", "const a = <input placeholder={`Name`} />;", 'placeholder="Name"'],
    ["alt", 'const a = <img alt="Logo" />;', 'alt="Logo"'],
  ])("flags %s", (_, source, match) => {
    expect(findLiteralCopy(source, "f.tsx").map((finding) => finding.match)).toEqual([match]);
  });

  it.each([
    ["t calls", 'const a = <p title={t("x.y")}>{t("x.z")}</p>;'],
    ["symbols and numbers", "const a = <p>· / 3 — ½</p>;"],
    ["an empty alt", 'const a = <img alt="" />;'],
    ["other attributes", 'const a = <p className="flex" lang="fr" data-x="Hi" />;'],
    ["generics and comparisons", "const r = useRef<HTMLDivElement>(null); const b = a > c;"],
    ["comments", "const a = <p>{/* Hello */}</p>;"],
  ])("ignores %s", (_, source) => {
    expect(findLiteralCopy(source, "f.tsx")).toEqual([]);
  });

  it("reports the line and column", () => {
    const [finding] = findLiteralCopy("const a = (\n  <p>\n    Hello\n  </p>\n);", "f.tsx");
    expect(finding).toMatchObject({ line: 3, column: 5, match: "Hello" });
  });
});

describe("isCheckedFile", () => {
  it("checks components, not tests or plain modules", () => {
    expect(isCheckedFile("src/routes/index.tsx")).toBe(true);
    expect(isCheckedFile("src\\table\\seat.tsx")).toBe(true);
    expect(isCheckedFile("src/app.test.tsx")).toBe(false);
    expect(isCheckedFile("src/i18n/en.ts")).toBe(false);
  });
});

describe("check-copy", () => {
  it("finds every literal in the failing fixture", () => {
    expect(checkDirectory(fixtures).map((finding) => `${finding.line} ${finding.match}`)).toEqual([
      '5 aria-label="Settings"',
      "6 Room settings",
      "7 Hello",
      "7 , welcome",
      '8 placeholder="Your name"',
      '8 title="Name"',
    ]);
  });

  it("exits with 1 on the failing fixture", () => {
    const run = spawnSync(process.execPath, [script, fixtures], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("literal-copy.tsx:6");
  });

  it("passes on the app sources", () => {
    expect(checkDirectory(src)).toEqual([]);
  });
});
