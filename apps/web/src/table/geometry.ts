// Pixel geometry for checking a table layout: rectangles, the stadium-shaped table, the
// parts a seat paints, and the rules the layout must pass. Pure, no DOM; used by
// layout.test.ts and by the Playwright spec (e2e/table.spec.ts).

import {
  GEOMETRY,
  layoutTable,
  type Point,
  type SeatGeometry,
  type SeatPlace,
  type Size,
  stageSize,
  type TableLayout,
  type TableVariant,
  type VariantGeometry,
} from "./layout.ts";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A rounded rectangle whose short side is fully round: radius = half the short side. */
export type Stadium = Rect;

export function rectAround(centre: { x: number; y: number }, size: Size): Rect {
  return {
    left: centre.x - size.width / 2,
    top: centre.y - size.height / 2,
    right: centre.x + size.width / 2,
    bottom: centre.y + size.height / 2,
  };
}

/** True when the rectangles come closer than `gap` pixels (0: share area; edges may touch). */
export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.left < b.right + gap &&
    b.left < a.right + gap &&
    a.top < b.bottom + gap &&
    b.top < a.bottom + gap
  );
}

/** The stadium as a segment (its spine) plus a radius: every point within it is inside. */
export function stadiumSpine(stadium: Stadium): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  radius: number;
} {
  const width = stadium.right - stadium.left;
  const height = stadium.bottom - stadium.top;
  const radius = Math.min(width, height) / 2;
  return {
    x1: stadium.left + radius,
    y1: stadium.top + radius,
    x2: stadium.right - radius,
    y2: stadium.bottom - radius,
    radius,
  };
}

/** Distance between two closed intervals, 0 when they meet. */
const gap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, b1 - a2, a1 - b2);

/** Shortest distance from the rectangle to the stadium's spine (an axis-aligned segment). */
function distanceToSpine(rect: Rect, stadium: Stadium): number {
  const spine = stadiumSpine(stadium);
  const dx = gap(spine.x1, spine.x2, rect.left, rect.right);
  const dy = gap(spine.y1, spine.y2, rect.top, rect.bottom);
  return Math.hypot(dx, dy);
}

/** True when the rectangle comes within `gap` pixels of the stadium, rounded ends included. */
export function rectTouchesStadium(rect: Rect, stadium: Stadium, gap = 0): boolean {
  return distanceToSpine(rect, stadium) < stadiumSpine(stadium).radius + gap;
}

/** True when the whole rectangle lies on the stadium, at least `margin` from its edge. */
export function rectInsideStadium(rect: Rect, stadium: Stadium, margin = 0): boolean {
  const spine = stadiumSpine(stadium);
  const corners: Point[] = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.left, y: rect.bottom },
    { x: rect.right, y: rect.bottom },
  ];
  // The stadium is convex, so the rectangle is inside when its four corners are.
  return corners.every(
    (corner) =>
      Math.hypot(
        gap(spine.x1, spine.x2, corner.x, corner.x),
        gap(spine.y1, spine.y2, corner.y, corner.y),
      ) <=
      spine.radius - margin,
  );
}

/** Room kept around an avatar for its ring and the "voted" badge, in pixels. */
export const AVATAR_HALO = 4;

/**
 * The parts a seat paints, in pixels: the avatar (with its halo) and the name, or the
 * square tap target of an initials-only seat. Overlap is checked part by part, so the
 * empty corners beside an avatar may tuck in next to the table.
 */
export function seatParts(
  centre: { x: number; y: number },
  seat: SeatGeometry,
  side: SeatPlace["label"],
): Rect[] {
  if (!seat.label) {
    const size = Math.max(seat.target, seat.avatar + 2 * AVATAR_HALO);
    return [rectAround(centre, { width: size, height: size })];
  }
  const ring = seat.avatar + 2 * AVATAR_HALO;
  const avatar = rectAround(centre, { width: ring, height: ring });
  const offset = seat.avatar / 2 + seat.label.gap + seat.label.height / 2;
  const label = rectAround(
    { x: centre.x, y: centre.y + (side === "above" ? -offset : offset) },
    { width: seat.label.width, height: seat.label.height },
  );
  return [avatar, label];
}

export interface PixelLayout {
  stage: Size;
  table: Stadium;
  /** The status box in the middle of the table. */
  centre: Rect;
  /** Each seat's painted parts. */
  seats: Rect[][];
  /** False for initials-only seats, measured by their tap targets. */
  named: boolean;
  slots: Rect[];
}

/** The layout in pixels on a stage of the given size. */
export function toPixels(layout: TableLayout, stage: Size): PixelLayout {
  const px = (point: Point) => ({
    x: (point.x / 100) * stage.width,
    y: (point.y / 100) * stage.height,
  });
  return {
    stage,
    centre: rectAround({ x: stage.width / 2, y: stage.height / 2 }, layout.centre),
    table: {
      left: (layout.table.x / 100) * stage.width,
      right: stage.width - (layout.table.x / 100) * stage.width,
      top: (layout.table.y / 100) * stage.height,
      bottom: stage.height - (layout.table.y / 100) * stage.height,
    },
    seats: layout.seats.map((place) => seatParts(px(place), layout.seat, place.label)),
    named: layout.seat.label !== null,
    slots: layout.slots.map((point) => rectAround(px(point), layout.slot)),
  };
}

/** Width of the table's rim, in pixels: slots stay inside it. */
export const RIM_WIDTH = 7;

/** Clear space kept between a slot and the status box, in pixels. */
export const CENTRE_GAP = 4;

/**
 * Clear space kept between two cards, two named seats, or a named seat and the table, in
 * pixels. Initials-only seats are measured by their 44 px tap targets, which may touch:
 * the 32 px avatars inside them are then 12 px apart.
 */
export const CLEARANCE = 4;

/** Clear space kept between two cards on the table, in pixels. */
export const SLOT_CLEARANCE = 2;

export interface GeometryProblem {
  kind:
    | "seat-seat"
    | "seat-table"
    | "seat-off-stage"
    | "slot-slot"
    | "slot-off-table"
    | "slot-centre";
  a: number;
  b?: number;
}

/** Every rule the layout breaks on this stage; empty when the table reads cleanly. */
export function geometryProblems(pixels: PixelLayout): GeometryProblem[] {
  const problems: GeometryProblem[] = [];
  const { seats, slots, table, stage } = pixels;
  const seatGap = pixels.named ? CLEARANCE : 0;
  seats.forEach((parts, a) => {
    for (let b = a + 1; b < seats.length; b++) {
      const other = seats[b] ?? [];
      if (parts.some((part) => other.some((rect) => rectsOverlap(part, rect, seatGap)))) {
        problems.push({ kind: "seat-seat", a, b });
      }
    }
    if (parts.some((part) => rectTouchesStadium(part, table, seatGap))) {
      problems.push({ kind: "seat-table", a });
    }
    const off = (part: Rect) =>
      part.left < 0 || part.top < 0 || part.right > stage.width || part.bottom > stage.height;
    if (parts.some(off)) {
      problems.push({ kind: "seat-off-stage", a });
    }
  });
  slots.forEach((slot, a) => {
    for (let b = a + 1; b < slots.length; b++) {
      const other = slots[b];
      if (other && rectsOverlap(slot, other, SLOT_CLEARANCE)) {
        problems.push({ kind: "slot-slot", a, b });
      }
    }
    if (!rectInsideStadium(slot, table, RIM_WIDTH)) {
      problems.push({ kind: "slot-off-table", a });
    }
    const centre = pixels.centre;
    const padded = {
      left: centre.left - CENTRE_GAP,
      top: centre.top - CENTRE_GAP,
      right: centre.right + CENTRE_GAP,
      bottom: centre.bottom + CENTRE_GAP,
    };
    if (centre.right > centre.left && rectsOverlap(slot, padded)) {
      problems.push({ kind: "slot-centre", a });
    }
  });
  return problems;
}

/** Problems for `count` people on the stage of a viewport `viewportWidth` pixels wide. */
export function problemsAt(
  viewportWidth: number,
  count: number,
  geometries: Record<TableVariant, VariantGeometry> = GEOMETRY,
): GeometryProblem[] {
  const stage = stageSize(viewportWidth, geometries);
  const layout: TableLayout = layoutTable(count, stage.variant, geometries);
  return geometryProblems(toPixels(layout, stage));
}
