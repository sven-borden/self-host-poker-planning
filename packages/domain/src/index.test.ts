import { describe, expect, it } from "vitest";
import { MAX_PARTICIPANTS } from "./index.ts";

describe("MAX_PARTICIPANTS", () => {
  it("caps a room at 16 people", () => {
    expect(MAX_PARTICIPANTS).toBe(16);
  });
});
