import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.ts";

describe("PROTOCOL_VERSION", () => {
  it("is 3 since the away and back causes (#17)", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});
