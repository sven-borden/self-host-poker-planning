import { describe, expect, it } from "vitest";
import { dockFits, inSight } from "./hand-dock.ts";

describe("the docked hand (#22)", () => {
  it("docks only when what must stay in sight ends above it at the top of the page", () => {
    // 390 × 844 with 8 people: the table ends at 700, the dock is 97 px high.
    expect(dockFits(700, 97, 844)).toBe(true);
    expect(dockFits(747, 97, 844)).toBe(true);
    expect(dockFits(748, 97, 844)).toBe(false);
    // An iPhone 13 in Safari shows 664 px: the same table does not leave room.
    expect(dockFits(700, 97, 664)).toBe(false);
  });

  it("lands a vote's flight only on a slot on screen and above the dock", () => {
    const slot = { top: 500, bottom: 528 };
    expect(inSight(slot, 844, null)).toBe(true);
    expect(inSight(slot, 844, { top: 747 })).toBe(true);
    expect(inSight(slot, 844, { top: 520 })).toBe(false);
    expect(inSight(slot, 520, null)).toBe(false);
    expect(inSight({ top: -4, bottom: 24 }, 844, null)).toBe(false);
  });
});
