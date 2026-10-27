import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.ts";

describe("PROTOCOL_VERSION", () => {
  it("is 5 since votes carry their round's restarts too (#26)", () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });
});
