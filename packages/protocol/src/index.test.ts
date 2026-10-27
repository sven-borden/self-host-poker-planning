import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.ts";

describe("PROTOCOL_VERSION", () => {
  it("starts at 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
