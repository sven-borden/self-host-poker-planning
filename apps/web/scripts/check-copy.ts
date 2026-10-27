// Fails when a component holds literal copy: JSX text, or an aria-label, title,
// placeholder or alt written as a string, instead of `t("…")`.
// Usage: node apps/web/scripts/check-copy.ts [directory]  (default: apps/web/src)
// Scans .tsx files except tests. Runs under Node 24's built-in type stripping, like the
// colour check. Part of `pnpm lint`, hence of `pnpm gate`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CopyFinding, findLiteralCopy, formatFinding, isCheckedFile } from "./copy-rules.ts";

export function checkDirectory(directory: string): CopyFinding[] {
  const findings: CopyFinding[] = [];
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (!entry.isFile() || !isCheckedFile(path)) {
      continue;
    }
    const file = relative(process.cwd(), path).replaceAll("\\", "/");
    findings.push(...findLiteralCopy(readFileSync(path, "utf8"), file));
  }
  // readdir order differs between file systems: sort for a stable report.
  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const directory = resolve(process.argv[2] ?? fileURLToPath(new URL("../src", import.meta.url)));
  const findings = checkDirectory(directory);
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(formatFinding(finding));
    }
    console.error(
      `\n${findings.length} literal string(s). Add the copy to src/i18n/en.ts, fr.ts and de.ts and use t("…") (apps/web/README.md, "i18n").`,
    );
    process.exitCode = 1;
  } else {
    console.log("Copy: no literal copy in components.");
  }
}
