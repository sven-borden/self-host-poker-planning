import { describe, expect, it } from "vitest";
import {
  geometryProblems,
  problemsAt,
  rectInsideStadium,
  rectTouchesStadium,
  seatParts,
  toPixels,
} from "./geometry.ts";
import {
  GEOMETRY,
  layoutTable,
  MAX_SEATS,
  stageSize,
  type TableVariant,
  variantFor,
} from "./layout.ts";

// The brief promises a clean table for 1 to 16 people from 360 px to 1440 px
// (docs/03-design-brief.md, "The table"). These tests hold the numbers to it.

const PEOPLE = Array.from({ length: MAX_SEATS }, (_, i) => i + 1);

describe("table geometry", () => {
  it.each([360, 768, 1024, 1440])(
    "seats 1 to 16 people cleanly in a %i px viewport",
    (viewport) => {
      for (const count of PEOPLE) {
        expect(problemsAt(viewport, count), `${count} people`).toEqual([]);
      }
    },
  );

  it("seats 1 to 16 people cleanly at every viewport width from 360 to 1440 px", () => {
    const failures: string[] = [];
    for (let viewport = 360; viewport <= 1440; viewport++) {
      for (const count of PEOPLE) {
        for (const problem of problemsAt(viewport, count)) {
          failures.push(`${viewport} px, ${count} people: ${problem.kind} ${problem.a}`);
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  it("would catch the brief's first numbers, which overlap", () => {
    // The numbers before #13 tuned them (design brief, "The table").
    const original = structuredClone(GEOMETRY);
    original.desktop.minStageHeight = 0;
    original.desktop.table = { x: 17, y: 18 };
    original.desktop.normal.seats = { rx: 44, ry: 42 };
    original.desktop.dense = original.desktop.normal;
    original.phone.table = { x: 24, y: 14 };
    original.phone.normal.seats = { rx: 40, ry: 43 };
    original.phone.normal.slots = { rx: 17, ry: 28 };
    original.phone.normal.seat = {
      avatar: 32,
      label: { width: 66, height: 14, gap: 3 },
      target: 0,
    };
    original.phone.dense = {
      ...original.phone.normal,
      seat: { avatar: 32, label: null, target: 44 },
    };
    const kinds = new Set(
      PEOPLE.flatMap((count) => [
        ...problemsAt(360, count, original),
        ...problemsAt(768, count, original),
      ]).map((problem) => problem.kind),
    );
    expect([...kinds].sort()).toEqual(
      expect.arrayContaining(["seat-seat", "seat-table", "slot-slot"]),
    );
  });
});

describe("layoutTable", () => {
  it("puts the viewer at the bottom centre and the others clockwise", () => {
    const { seats, slots } = layoutTable(4, "desktop");
    expect(seats[0]).toMatchObject({ x: 50, y: 92 });
    expect(slots[0]).toMatchObject({ x: 50, y: 73 });
    // Clockwise on screen from the bottom: left, top, right.
    expect(seats[1]?.x).toBeLessThan(50);
    expect(seats[2]?.y).toBeLessThan(50);
    expect(seats[3]?.x).toBeGreaterThan(50);
  });

  it("writes names away from the table: above in the top half, below elsewhere", () => {
    const { seats } = layoutTable(4, "phone");
    expect(seats.map((seat) => seat.label)).toEqual(["below", "below", "above", "below"]);
  });

  it("clamps the count to 1–16", () => {
    expect(layoutTable(0, "desktop").seats).toHaveLength(1);
    expect(layoutTable(40, "desktop").seats).toHaveLength(16);
  });

  it.each([
    ["phone", 10, false],
    ["phone", 11, true],
    ["desktop", 12, false],
    ["desktop", 13, true],
  ] as const)("on a %s with %i people, dense is %s", (variant, count, dense) => {
    expect(layoutTable(count, variant).dense).toBe(dense);
  });

  it("shows initials only, in a 44 px target, with more than 10 people on a phone", () => {
    const { seat } = layoutTable(11, "phone");
    expect(seat.label).toBeNull();
    expect(seat.target).toBe(44);
  });

  it("uses whole-pixel sizes, so cards stay crisp", () => {
    for (const variant of ["desktop", "phone"] as TableVariant[]) {
      for (const density of [GEOMETRY[variant].normal, GEOMETRY[variant].dense]) {
        const sizes = [density.slot.width, density.slot.height, density.seat.avatar];
        expect(sizes.every(Number.isInteger), variant).toBe(true);
      }
    }
  });
});

describe("stageSize", () => {
  it("switches to the tall phone stage at 640 px and below", () => {
    expect(variantFor(640)).toBe("phone");
    expect(variantFor(641)).toBe("desktop");
    expect(stageSize(360)).toMatchObject({ variant: "phone", width: 328, height: 442.8 });
  });

  it("keeps the desktop stage at least 540 px tall and 992 px wide at most", () => {
    expect(stageSize(768)).toMatchObject({ width: 736, height: 540 });
    expect(stageSize(1440)).toMatchObject({ width: 992, height: 558 });
  });
});

describe("stadium checks", () => {
  // A wide stadium 200 × 100: spine from (50, 50) to (150, 50), radius 50.
  const table = { left: 0, top: 0, right: 200, bottom: 100 };

  it("tests the rounded ends, not the bounding box", () => {
    const inCorner = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(rectTouchesStadium(inCorner, table)).toBe(false);
    expect(rectTouchesStadium({ left: 90, top: -20, right: 110, bottom: 5 }, table)).toBe(true);
    expect(rectTouchesStadium({ left: 90, top: -20, right: 110, bottom: 0 }, table)).toBe(false);
  });

  it("requires every corner of a slot on the table, clear of the rim", () => {
    expect(rectInsideStadium({ left: 90, top: 40, right: 110, bottom: 60 }, table, 7)).toBe(true);
    expect(rectInsideStadium({ left: 2, top: 40, right: 20, bottom: 60 }, table, 7)).toBe(false);
    expect(rectInsideStadium({ left: 90, top: 2, right: 110, bottom: 20 }, table, 7)).toBe(false);
  });

  it("reports overlapping seats", () => {
    const layout = layoutTable(2, "desktop");
    const pixels = toPixels(layout, { width: 992, height: 558 });
    const twin = pixels.seats[0] ?? [];
    expect(geometryProblems({ ...pixels, seats: [twin, twin] })).toContainEqual({
      kind: "seat-seat",
      a: 0,
      b: 1,
    });
  });

  it("splits a named seat into its avatar and its name", () => {
    const parts = seatParts({ x: 100, y: 100 }, GEOMETRY.desktop.normal.seat, "above");
    expect(parts).toHaveLength(2);
    expect(parts[1]?.bottom).toBeLessThanOrEqual(parts[0]?.top ?? 0);
  });
});
