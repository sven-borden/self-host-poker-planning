import { describe, expect, it } from "vitest";
import { judgeAudit } from "./audit.mjs";

/** @param {Record<string, number>} counts @param {object[]} advisories */
const report = (counts, advisories = []) =>
  JSON.stringify({
    advisories: Object.fromEntries(advisories.map((advisory, i) => [String(i + 1), advisory])),
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts },
    },
  });

const advisory = (severity) => ({
  id: 1,
  module_name: "left-pad",
  vulnerable_versions: "<2.0.0",
  title: "Pads too much",
  severity,
  github_advisory_id: "GHSA-xxxx-yyyy-zzzz",
});

describe("judgeAudit", () => {
  it("passes a clean report and a moderate advisory", () => {
    expect(judgeAudit({ status: 0, stdout: report({}), stderr: "" })).toEqual({
      exit: 0,
      lines: ["Production dependencies: 0 info, 0 low, 0 moderate, 0 high, 0 critical."],
    });
    const moderate = report({ moderate: 1 }, [advisory("moderate")]);
    expect(judgeAudit({ status: 1, stdout: moderate, stderr: "" }).exit).toBe(0);
  });

  it.each(["high", "critical"])("fails on a %s advisory and names it", (severity) => {
    const verdict = judgeAudit({
      status: 1,
      stdout: report({ [severity]: 1 }, [advisory(severity)]),
      stderr: "",
    });
    expect(verdict.exit).toBe(1);
    expect(verdict.lines[0]).toBe(
      `::error title=${severity} advisory::left-pad <2.0.0: Pads too much (GHSA-xxxx-yyyy-zzzz)`,
    );
  });

  it("fails on a high count even when the advisory list is empty", () => {
    expect(judgeAudit({ status: 1, stdout: report({ high: 2 }), stderr: "" }).exit).toBe(1);
  });

  it("warns and passes when the endpoint cannot be reached", () => {
    const verdict = judgeAudit({
      status: 1,
      stdout: "",
      stderr: "\nError: ERR_PNPM_AUDIT_BAD_RESPONSE\n\n  × Failed to request the audit endpoint\n",
    });
    expect(verdict).toEqual({
      exit: 0,
      lines: [
        "::warning title=Dependency audit skipped::The audit endpoint could not be reached (Error: ERR_PNPM_AUDIT_BAD_RESPONSE); run pnpm audit --prod later.",
      ],
    });
  });

  it.each([
    ["an HTML error page", "<html>502 Bad Gateway</html>"],
    ["JSON without counts", JSON.stringify({ error: { code: "ECONNRESET" } })],
    ["JSON null", "null"],
  ])("warns and passes on %s", (_what, stdout) => {
    const verdict = judgeAudit({ status: 1, stdout, stderr: "" });
    expect(verdict.exit).toBe(0);
    expect(verdict.lines[0]).toContain("could not be reached (exit 1)");
  });
});
