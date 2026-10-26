import { describe, expect, it } from "vitest";
import { generateRange, type RangeErrorCode } from "./range.ts";

type Spec = { start: number; end: number; step: number };

describe("generateRange", () => {
  it.each<[Spec, string[]]>([
    [{ start: 0, end: 4, step: 0.5 }, ["0", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4"]],
    [
      { start: 0, end: 1, step: 0.1 },
      ["0", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9", "1"],
    ],
    [
      { start: 0.2, end: 0.29, step: 0.01 },
      ["0.2", "0.21", "0.22", "0.23", "0.24", "0.25", "0.26", "0.27", "0.28", "0.29"],
    ],
    [{ start: 1, end: 10, step: 1 }, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]],
    [{ start: 0, end: 1, step: 0.3 }, ["0", "0.3", "0.6", "0.9"]],
    [{ start: 0.5, end: 2, step: 0.25 }, ["0.5", "0.75", "1", "1.25", "1.5", "1.75", "2"]],
    [{ start: -1, end: 1, step: 0.5 }, ["-1", "-0.5", "0", "0.5", "1"]],
    [{ start: 3, end: 3, step: 1 }, ["3"]],
    [{ start: 0, end: 19, step: 1 }, Array.from({ length: 20 }, (_, i) => String(i))],
  ])("%j gives %j", (spec, cards) => {
    expect(generateRange(spec)).toEqual({ ok: true, cards });
  });

  it.each<[RangeErrorCode, Spec]>([
    ["range_not_finite", { start: Number.NaN, end: 4, step: 1 }],
    ["range_not_finite", { start: 0, end: Number.POSITIVE_INFINITY, step: 1 }],
    ["range_not_finite", { start: 0, end: 4, step: Number.NaN }],
    ["range_step_not_positive", { start: 0, end: 4, step: 0 }],
    ["range_step_not_positive", { start: 0, end: 4, step: -1 }],
    ["range_end_before_start", { start: 4, end: 0, step: 1 }],
    ["range_too_many_cards", { start: 0, end: 20, step: 1 }],
    ["range_too_many_cards", { start: 0, end: 1e300, step: 0.5 }],
    ["range_label_too_long", { start: 9000, end: 10000, step: 1000 }],
    ["range_label_too_long", { start: 0, end: 0.01, step: 0.001 }],
    ["range_label_too_long", { start: 0, end: 1, step: 1 / 3 }],
    ["range_label_too_long", { start: 0.12345, end: 1, step: 0.5 }],
    ["range_label_too_long", { start: 1e30, end: 1e30, step: 1 }],
  ])("refuses with %s: %j", (code, spec) => {
    expect(generateRange(spec)).toEqual({ ok: false, code });
  });
});
