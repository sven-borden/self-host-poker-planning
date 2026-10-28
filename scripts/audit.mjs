// The dependency audit of the CI `check` job (#36): `pnpm audit --prod --json`, judged
// here. A high or critical advisory in a production dependency fails the job. When the
// audit endpoint cannot be reached (npm's registry down, a network error, no answer we
// can read), the job warns and passes: an outage of npm's must not block every pull
// request. Run: `node scripts/audit.mjs`.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The severities that fail the job. */
export const FAILING = ["high", "critical"];

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} AuditRun
 * @typedef {{ exit: 0 | 1, lines: string[] }} Verdict
 */

/**
 * Judges one run of `pnpm audit --prod --json`. Lines starting with `::` are GitHub
 * Actions annotations.
 * @param {AuditRun} run
 * @returns {Verdict}
 */
export function judgeAudit({ status, stdout, stderr }) {
  /** @type {any} */
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    report = undefined;
  }
  const counts = report?.metadata?.vulnerabilities;
  if (typeof counts !== "object" || counts === null) {
    const reason =
      stderr
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? `exit ${status}`;
    return {
      exit: 0,
      lines: [
        `::warning title=Dependency audit skipped::The audit endpoint could not be reached (${reason}); run pnpm audit --prod later.`,
      ],
    };
  }
  const advisories = Object.values(report.advisories ?? {});
  const failing = advisories.filter((advisory) => FAILING.includes(advisory?.severity));
  const total = FAILING.reduce((sum, severity) => sum + (Number(counts[severity]) || 0), 0);
  const summary = Object.entries(counts)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(", ");
  if (failing.length === 0 && total === 0) {
    return { exit: 0, lines: [`Production dependencies: ${summary}.`] };
  }
  return {
    exit: 1,
    lines: [
      ...failing.map(
        (advisory) =>
          `::error title=${advisory.severity} advisory::${advisory.module_name} ${advisory.vulnerable_versions ?? ""}: ${advisory.title} (${advisory.github_advisory_id ?? advisory.url ?? advisory.id})`,
      ),
      `Production dependencies: ${summary}. A high or critical advisory fails the job.`,
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = { encoding: /** @type {const} */ ("utf8"), maxBuffer: 64 * 1024 * 1024 };
  // On Windows pnpm is a .cmd, which only a shell runs.
  const run =
    process.platform === "win32"
      ? spawnSync("pnpm audit --prod --json", { ...options, shell: true })
      : spawnSync("pnpm", ["audit", "--prod", "--json"], options);
  const verdict = judgeAudit({
    status: run.status,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? String(run.error ?? ""),
  });
  for (const line of verdict.lines) console.log(line);
  process.exitCode = verdict.exit;
}
