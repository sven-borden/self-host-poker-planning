// Fails when a component uses a literal colour instead of a design token.
// Usage: node apps/web/scripts/check-colours.ts [directory]  (default: apps/web/src)
// Scans .ts, .tsx and .css files; tokens.css, where the tokens are defined, is exempt.
// Runs under Node 24's built-in type stripping, so it needs no build step and works the
// same on Windows and Linux. Part of `pnpm lint`, hence of `pnpm gate`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ColourFinding,
  findLiteralColours,
  formatFinding,
  isCheckedFile,
} from "./colour-rules.ts";

export function checkDirectory(directory: string): ColourFinding[] {
  const findings: ColourFinding[] = [];
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    if (!isCheckedFile(path)) {
      continue;
    }
    const file = relative(process.cwd(), path).replaceAll("\\", "/");
    findings.push(...findLiteralColours(readFileSync(path, "utf8"), file));
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
      `\n${findings.length} literal colour(s). Use a design token instead (bg-surface, text-ink-2, …; see apps/web/src/tokens.css).`,
    );
    process.exitCode = 1;
  } else {
    console.log("Colours: no literal colour in components.");
  }
}
