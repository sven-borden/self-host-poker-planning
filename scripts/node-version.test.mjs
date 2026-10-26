import { describe, expect, it } from "vitest";
import { nodeVersionError, REQUIRED_NODE_MAJOR } from "./node-version.mjs";

describe("nodeVersionError", () => {
  it("accepts any Node 24 release", () => {
    expect(nodeVersionError("v24.0.0")).toBeNull();
    expect(nodeVersionError("v24.22.1")).toBeNull();
  });

  it.each(["v22.12.0", "v23.11.0", "v25.0.0", "v26.1.0", "v4.24.0"])("refuses %s", (version) => {
    expect(nodeVersionError(version)).toBe(
      `Poker Planning needs Node ${REQUIRED_NODE_MAJOR}, found ${version}`,
    );
  });

  it("refuses a version it cannot parse", () => {
    expect(nodeVersionError("garbage")).toBe("Poker Planning needs Node 24, found garbage");
  });
});
