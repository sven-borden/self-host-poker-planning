import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.ts";

describe("PROTOCOL_VERSION", () => {
  it("is 2 since the busy ack code (#15)", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });
});
