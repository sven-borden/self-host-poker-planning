import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.ts";

describe("PROTOCOL_VERSION", () => {
  it("is 5: the queue (#52) tells a tab from before it to reload", () => {
    expect(PROTOCOL_VERSION).toBe(6);
  });
});
