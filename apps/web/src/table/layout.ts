// The table's geometry (docs/03-design-brief.md, "The table"): pure numbers, no DOM.
//
// Seats sit on an ellipse around a stadium-shaped table. Positions are percentages of
// the stage, so one formula serves every width:
//   left = 50 + rx·cos(θ), top = 50 + ry·sin(θ), θ = 90° + i·360°/n.
// Index 0 is the viewer, at the bottom; the others follow clockwise (on screen, with y
// pointing down, a growing angle turns clockwise). A seat's point is its avatar's centre;
// the name sits on the far side from the table (above the avatar in the top half, below
// it elsewhere), so the narrow avatar faces the table. Sizes are whole pixels so cards
// stay crisp. `layout.test.ts` proves that nothing overlaps for 1 to 16 people.

export type TableVariant = "desktop" | "phone";

/** Viewports this wide or narrower get the tall phone table. */
export const PHONE_MAX_WIDTH = 640;

/** A room holds at most 16 people (CLAUDE.md, product invariants). */
export const MAX_SEATS = 16;

export interface Radii {
  /** Horizontal radius, in percent of the stage width. */
  rx: number;
  /** Vertical radius, in percent of the stage height. */
  ry: number;
}

export interface Size {
  /** Whole pixels. */
  width: number;
  height: number;
}

export interface SeatGeometry {
  /** Avatar diameter, in pixels. */
  avatar: number;
  /** The name under (or over) the avatar; null shows initials only, name on tap. */
  label: { width: number; height: number; gap: number } | null;
  /** Side of the square tap target around an initials-only seat (44 px), else 0. */
  target: number;
}

/** Seat and card sizes, and the two ellipses, for one density. */
export interface DensityGeometry {
  seats: Radii;
  slots: Radii;
  seat: SeatGeometry;
  slot: Size;
}

export interface VariantGeometry {
  /** Stage width divided by stage height. */
  aspect: number;
  /** The stage never gets shorter than this, in pixels (narrow tablets). */
  minStageHeight: number;
  /** Table insets, in percent: x of the stage width (each side), y of its height. */
  table: { x: number; y: number };
  /** The status in the middle of the table (count, timer, result) fits in this, in px. */
  centre: Size;
  /** More people than this switches to the dense geometry. */
  denseAbove: number;
  normal: DensityGeometry;
  dense: DensityGeometry;
}

/** The brief's numbers, per variant. Change them in the design brief too. */
export const GEOMETRY: Record<TableVariant, VariantGeometry> = {
  desktop: {
    aspect: 16 / 9,
    minStageHeight: 500,
    table: { x: 17, y: 19 },
    centre: { width: 140, height: 96 },
    denseAbove: 12,
    normal: {
      seats: { rx: 42, ry: 42 },
      slots: { rx: 25, ry: 23 },
      seat: { avatar: 40, label: { width: 90, height: 16, gap: 4 }, target: 0 },
      slot: { width: 36, height: 50 },
    },
    dense: {
      seats: { rx: 42, ry: 42 },
      slots: { rx: 26, ry: 23 },
      seat: { avatar: 40, label: { width: 90, height: 16, gap: 4 }, target: 0 },
      slot: { width: 32, height: 44 },
    },
  },
  phone: {
    aspect: 4 / 5.4,
    minStageHeight: 0,
    table: { x: 24, y: 16 },
    centre: { width: 68, height: 60 },
    denseAbove: 10,
    normal: {
      seats: { rx: 40, ry: 42 },
      slots: { rx: 17, ry: 27 },
      seat: { avatar: 32, label: { width: 64, height: 14, gap: 3 }, target: 0 },
      slot: { width: 27, height: 38 },
    },
    dense: {
      seats: { rx: 42, ry: 42 },
      slots: { rx: 20, ry: 27 },
      seat: { avatar: 32, label: null, target: 44 },
      slot: { width: 21, height: 30 },
    },
  },
};

export interface Point {
  /** Percent of the stage width, from the left. */
  x: number;
  /** Percent of the stage height, from the top. */
  y: number;
}

export interface SeatPlace extends Point {
  /** Where the name goes: away from the table. */
  label: "above" | "below";
}

export interface TableLayout {
  variant: TableVariant;
  /** People at the table (observers excluded), 1 to 16. */
  count: number;
  /** More people than the variant's threshold: the dense geometry applies. */
  dense: boolean;
  aspect: number;
  minStageHeight: number;
  table: { x: number; y: number };
  centre: Size;
  /** Each seat's avatar centre, index 0 being the viewer at the bottom, then clockwise. */
  seats: SeatPlace[];
  /** Centre of each seat's card slot on the table, same order. */
  slots: Point[];
  seat: SeatGeometry;
  slot: Size;
}

export function variantFor(viewportWidth: number): TableVariant {
  return viewportWidth <= PHONE_MAX_WIDTH ? "phone" : "desktop";
}

/** Angle of seat `index` out of `count`, in radians: the viewer at 90° (bottom). */
export function seatAngle(index: number, count: number): number {
  return Math.PI / 2 + (index * 2 * Math.PI) / count;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function onEllipse(angle: number, radii: Radii): Point {
  return { x: round(50 + radii.rx * Math.cos(angle)), y: round(50 + radii.ry * Math.sin(angle)) };
}

/** Seat and slot positions for `count` people (clamped to 1–16). */
export function layoutTable(
  count: number,
  variant: TableVariant,
  geometries: Record<TableVariant, VariantGeometry> = GEOMETRY,
): TableLayout {
  const n = Math.min(MAX_SEATS, Math.max(1, Math.floor(count)));
  const geometry = geometries[variant];
  const dense = n > geometry.denseAbove;
  const density = dense ? geometry.dense : geometry.normal;
  const angles = Array.from({ length: n }, (_, i) => seatAngle(i, n));
  return {
    variant,
    count: n,
    dense,
    aspect: geometry.aspect,
    minStageHeight: geometry.minStageHeight,
    table: geometry.table,
    centre: geometry.centre,
    seats: angles.map((angle) => {
      const point = onEllipse(angle, density.seats);
      // Upper half: the name goes above the avatar. A small tolerance keeps side seats
      // (sin θ = 0, give or take rounding) labelled below.
      return { ...point, label: Math.sin(angle) < -1e-9 ? "above" : "below" };
    }),
    slots: angles.map((angle) => onEllipse(angle, density.slots)),
    seat: density.seat,
    slot: density.slot,
  };
}

/** Horizontal page gutter around the stage (the shell's `px-4`), in pixels. */
export const PAGE_GUTTER = 16;

/** Widest stage: the shell's `max-w-5xl` content column minus its gutters. */
export const MAX_STAGE_WIDTH = 1024 - 2 * PAGE_GUTTER;

/** Widest phone stage: past this the tall table would only grow taller than the screen. */
export const MAX_PHONE_STAGE_WIDTH = 480;

/** The stage's pixel size in a viewport `viewportWidth` wide, as the shell lays it out. */
export function stageSize(
  viewportWidth: number,
  geometries: Record<TableVariant, VariantGeometry> = GEOMETRY,
): Size & { variant: TableVariant } {
  const variant = variantFor(viewportWidth);
  const geometry = geometries[variant];
  const width = Math.min(
    viewportWidth - 2 * PAGE_GUTTER,
    variant === "phone" ? MAX_PHONE_STAGE_WIDTH : MAX_STAGE_WIDTH,
  );
  return {
    variant,
    width,
    height: Math.max(width / geometry.aspect, geometry.minStageHeight),
  };
}
