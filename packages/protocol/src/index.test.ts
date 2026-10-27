import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.ts";

describe("PROTOCOL_VERSION", () => {
  it("stays 4: the restart a vote carries (#26) is optional, so older tabs keep their room", () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });
});
