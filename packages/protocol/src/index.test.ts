import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.ts";

describe("PROTOCOL_VERSION", () => {
  it("is 4 since votes carry their round and round_changed exists (#18)", () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });
});
