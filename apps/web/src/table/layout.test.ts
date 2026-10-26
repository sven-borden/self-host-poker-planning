import { describe, expect, it } from "vitest";
import {
  AVATAR_HALO,
  geometryProblems,
  type PixelLayout,
  problemsAt,
  type Rect,
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
// (docs/03-design-brief.md, "The table"). These tests hold the numbers to it. The engine
// takes the room the stage gets; in the shell's `px-4` column that is the viewport less
// 32 px, so a 360 px phone gives the table 328 px.

const PEOPLE = Array.from({ length: MAX_SEATS }, (_, i) => i + 1);
const SHELL_GUTTERS = 32;

describe("table geometry", () => {
  it.each([360, 768, 1024, 1440])(
    "seats 1 to 16 people cleanly in a %i px viewport",
    (viewport) => {
      for (const count of PEOPLE) {
        expect(problemsAt(viewport - SHELL_GUTTERS, count), `${count} people`).toEqual([]);
      }
    },
  );

  it("seats 1 to 16 people cleanly in every room from 328 to 1600 px", () => {
    const failures: string[] = [];
    for (let room = 328; room <= 1600; room++) {
      for (const count of PEOPLE) {
        for (const problem of problemsAt(room, count)) {
          failures.push(`${room} px, ${count} people: ${problem.kind} ${problem.a}`);
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
        ...problemsAt(328, count, original),
        ...problemsAt(736, count, original),
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
  it("switches to the tall phone stage with 608 px of room or less (a 640 px viewport)", () => {
    expect(variantFor(608)).toBe("phone");
    expect(variantFor(609)).toBe("desktop");
    expect(stageSize(328)).toMatchObject({ variant: "phone", width: 328, height: 442.8 });
  });

  it("caps the phone stage at 480 px wide", () => {
    expect(stageSize(480)).toMatchObject({ variant: "phone", width: 480 });
    expect(stageSize(608)).toMatchObject({ variant: "phone", width: 480, height: 648 });
  });

  it("keeps the desktop stage at least 540 px tall and 992 px wide at most", () => {
    expect(stageSize(736)).toMatchObject({ width: 736, height: 540 });
    expect(stageSize(1408)).toMatchObject({ width: 992, height: 558 });
    expect(stageSize(2400)).toMatchObject({ width: 992, height: 558 });
  });
});

describe("clearance rules", () => {
  // A stadium 200 × 100 at (400, 400): spine from (450, 450) to (550, 450), radius 50.
  const empty = { left: 0, top: 0, right: 0, bottom: 0 };
  const base: PixelLayout = {
    stage: { width: 1000, height: 1000 },
    table: { left: 400, top: 400, right: 600, bottom: 500 },
    centre: empty,
    seats: [],
    named: true,
    slots: [],
  };
  const box = (left: number, top: number): Rect => ({
    left,
    top,
    right: left + 10,
    bottom: top + 10,
  });

  it("keeps named seats 4 px from each other", () => {
    expect(geometryProblems({ ...base, seats: [[box(0, 0)], [box(13, 0)]] })).toEqual([
      { kind: "seat-seat", a: 0, b: 1 },
    ]);
    expect(geometryProblems({ ...base, seats: [[box(0, 0)], [box(14, 0)]] })).toEqual([]);
  });

  it("keeps named seats 4 px from the table", () => {
    expect(geometryProblems({ ...base, seats: [[box(495, 387)]] })).toEqual([
      { kind: "seat-table", a: 0 },
    ]);
    expect(geometryProblems({ ...base, seats: [[box(495, 386)]] })).toEqual([]);
  });

  it("lets the tap targets of initials-only seats touch, but not overlap", () => {
    const initials = { ...base, named: false };
    expect(geometryProblems({ ...initials, seats: [[box(0, 0)], [box(10, 0)]] })).toEqual([]);
    expect(geometryProblems({ ...initials, seats: [[box(0, 0)], [box(9, 0)]] })).toEqual([
      { kind: "seat-seat", a: 0, b: 1 },
    ]);
  });

  it("keeps cards 2 px from each other", () => {
    expect(geometryProblems({ ...base, slots: [box(480, 440), box(491, 440)] })).toEqual([
      { kind: "slot-slot", a: 0, b: 1 },
    ]);
    expect(geometryProblems({ ...base, slots: [box(480, 440), box(492, 440)] })).toEqual([]);
  });

  it("forgives sub-pixel rounding only when asked to", () => {
    const close = { ...base, seats: [[box(0, 0)], [box(13.6, 0)]] };
    expect(geometryProblems(close)).toHaveLength(1);
    expect(geometryProblems(close, 0.5)).toEqual([]);
  });

  it("measures an avatar with 4 px around it for the ring and the voted badge", () => {
    expect(AVATAR_HALO).toBe(4);
    const [avatar] = seatParts({ x: 100, y: 100 }, GEOMETRY.desktop.normal.seat, "below");
    expect(avatar).toEqual({ left: 76, top: 76, right: 124, bottom: 124 });
    const [target] = seatParts({ x: 100, y: 100 }, GEOMETRY.phone.dense.seat, "below");
    expect(target).toEqual({ left: 78, top: 78, right: 122, bottom: 122 });
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
