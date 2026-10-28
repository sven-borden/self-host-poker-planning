import { describe, expect, it } from "vitest";
import { nodeVersionError } from "./node-version.mjs";

/** @param {string} version */
const refusal = (version) => `Poker Planning needs Node 24.7 or a later Node 24, found ${version}`;

describe("nodeVersionError", () => {
  it("accepts Node 24.7 and every later Node 24", () => {
    expect(nodeVersionError("v24.7.0")).toBeNull();
    expect(nodeVersionError("v24.22.1")).toBeNull();
  });

  it.each(["v22.12.0", "v23.11.0", "v24.0.0", "v24.6.1", "v25.0.0", "v26.1.0", "v4.24.0"])(
    "refuses %s",
    (version) => {
      expect(nodeVersionError(version)).toBe(refusal(version));
    },
  );

  it("refuses a version it cannot parse", () => {
    expect(nodeVersionError("garbage")).toBe(refusal("garbage"));
  });
});
