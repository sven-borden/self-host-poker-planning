import type { AvatarId } from "@pp/domain";

// The 24 avatars (#42): original drawings, MIT like the rest of the repo. Each is a head
// on a 48 × 48 box, printed like a playing card: warm card face over the person's colour,
// with card ink and a touch of brass. Those tones read on all eight `--av` colours in both
// themes, so nobody's disc has to change for their avatar. A head keeps 3 units from the
// top and the bottom, so the small bob never cuts it off. This module is a lazy chunk
// (`use-art.ts`).

/** A layer's paint; `avatar.css` gives each its token. */
export type Tone = "face" | "shade" | "ink" | "brass" | "line" | "pale";

export type Layer = readonly [tone: Tone, path: string];

export interface Drawing {
  /** Back to front. */
  body: readonly Layer[];
  /** Over the body, in a group of their own: they close to blink. */
  eyes: readonly Layer[];
}

/** An ellipse as a path. */
const oval = (x: number, y: number, rx: number, ry = rx): string =>
  `M${x - rx} ${y}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;

/** Two ellipses, `dx` either side of the face's axis. */
const pair = (dx: number, y: number, rx: number, ry = rx): string =>
  oval(24 - dx, y, rx, ry) + oval(24 + dx, y, rx, ry);

/** A path and its mirror image: every coordinate absolute, written `x y`. */
const both = (path: string): string =>
  path +
  path.replace(/(\d*\.?\d+) (\d*\.?\d+)/g, (_, x: string, y: string) => `${48 - Number(x)} ${y}`);

const round = (value: number): number => Math.round(value * 10) / 10;

/** A disc with `count` bumps around its edge: wool, a mane. */
function tufts(y: number, reach: number, bump: number, count: number): string {
  let path = oval(24, y, reach);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * 2 * Math.PI;
    path += oval(round(24 + reach * Math.cos(angle)), round(y + reach * Math.sin(angle)), bump);
  }
  return path;
}

/** A star of `count` points between two radii: spines. */
function spines(y: number, outer: number, inner: number, count: number): string {
  let path = "";
  for (let i = 0; i < count * 2; i++) {
    const reach = i % 2 === 0 ? outer : inner;
    const angle = (i / (count * 2)) * 2 * Math.PI - Math.PI / 2;
    path += `${i === 0 ? "M" : "L"}${round(24 + reach * Math.cos(angle))} ${round(y + reach * Math.sin(angle))}`;
  }
  return `${path}Z`;
}

/** Two round eyes. */
const eyes = (dx: number, y: number, r = 2.4, tone: Tone = "ink"): readonly Layer[] => [
  [tone, pair(dx, y, r)],
];

export const AVATAR_ART: Record<AvatarId, Drawing> = {
  bat: {
    body: [
      ["face", both("M12 22L7 3L22 13Z")],
      ["face", oval(24, 27, 15.5, 14.5)],
      ["brass", both("M13.5 17L10.8 7.5L18.5 13Z")],
      ["ink", pair(1.4, 28.5, 0.9) + both("M19.5 33.8L20.9 37.6L22.3 34.8Z")],
      ["line", "M17.5 32.5Q24 36.5 30.5 32.5"],
    ],
    eyes: eyes(6.5, 24.5),
  },
  bear: {
    body: [
      ["face", pair(12.5, 13.5, 6.5) + oval(24, 27, 16.5, 15.5)],
      ["shade", pair(12.5, 13.5, 3.2) + oval(24, 33, 8, 6.5)],
      ["ink", "M20.8 30.2Q24 28.8 27.2 30.2Q27.2 33 24 34Q20.8 33 20.8 30.2Z"],
      ["line", "M24 34V37"],
    ],
    eyes: eyes(7.5, 24),
  },
  cat: {
    body: [
      ["face", "M8 7L19 14.5Q24 13.5 29 14.5L40 7L41 27Q41 41 24 41Q7 41 7 27Z"],
      ["brass", both("M11 12L17.5 16.5L11.5 20.5Z")],
      ["ink", "M21.8 29H26.2L24 31.4Z"],
      [
        "line",
        `M24 31.4Q24 34.4 20.5 34.4M24 31.4Q24 34.4 27.5 34.4${both("M12.5 30.5L8.5 29.8")}`,
      ],
    ],
    eyes: [["ink", pair(8, 24, 2.2, 3)]],
  },
  chick: {
    body: [
      [
        "face",
        `${oval(24, 27, 16)}M24 12Q20 4.5 16.5 8Q21 8 22 12ZM24 12Q26 4 30.5 7Q26.5 8 26 12Z`,
      ],
      ["shade", pair(11, 31.5, 3.6, 2.6)],
      ["brass", "M19.5 27Q24 24.5 28.5 27L24 33Z"],
    ],
    eyes: eyes(7, 23),
  },
  cow: {
    body: [
      ["shade", both("M15 12Q8.5 11 7.5 4Q13 6 18 10Z")],
      ["face", both("M10.5 21Q3.5 20 3 14.5Q9 13 13 16.5Z")],
      ["face", "M11 18Q12 10 24 10Q36 10 37 18L35 36Q34 44 24 44Q14 44 13 36Z"],
      ["ink", "M24 10Q32 10 36.8 17L36 27Q30 29.5 27 25.5Q25 20 24 10Z"],
      ["shade", oval(24, 37, 10.5, 6.5)],
      ["ink", pair(4, 36.5, 1.4, 1.7)],
    ],
    eyes: [
      ["ink", oval(17, 24, 2.4)],
      ["face", oval(31, 23.5, 2)],
    ],
  },
  deer: {
    body: [
      ["pale", both("M18 14Q16 9 11 7M16.2 10.2Q17 7 15.5 3.8M13.5 8.2Q9.5 9 7.5 6")],
      ["face", both("M14 20Q6 20 4 15Q11 13 16 17Z")],
      ["face", "M14 18Q15 12 24 12Q33 12 34 18Q34 27 29 37Q27 42 24 42Q21 42 19 37Q14 27 14 18Z"],
      ["brass", both("M12.8 18Q9 18 7.2 16Q11 15.2 14 16.8Z")],
      ["shade", oval(24, 16.5, 1.5) + pair(5.5, 15.5, 1.1)],
      ["ink", oval(24, 38, 3, 2.4)],
    ],
    eyes: eyes(6, 24),
  },
  dog: {
    body: [
      ["face", oval(24, 26, 15, 16.5)],
      ["shade", `${both("M11 11Q3 13 4 28Q5 35 10.5 33Q15 24 16.5 12.5Z")}${oval(31, 22, 6)}`],
      ["brass", "M21 37Q21 42.5 24 42.5Q27 42.5 27 37Q24 38.5 21 37Z"],
      ["ink", oval(24, 30, 4.2, 3.2)],
      ["line", "M24 33V36M24 36Q20 38.5 17.5 36M24 36Q28 38.5 30.5 36"],
    ],
    eyes: eyes(7, 22),
  },
  fox: {
    body: [
      ["face", "M5 8L17.5 15.5Q24 14 30.5 15.5L43 8L41.5 27Q36 38 24 44Q12 38 6.5 27Z"],
      ["brass", "M8 12L17 17.5Q24 15.8 31 17.5L40 12L39.5 25Q31 25 24 36Q17 25 8.5 25Z"],
      ["ink", `${both("M5 8L11.5 11.9L6 15.5Z")}M21.5 39.5Q24 38.5 26.5 39.5L24 43Z`],
    ],
    eyes: eyes(8, 24.5),
  },
  frog: {
    body: [
      ["face", pair(10, 14, 7.5) + oval(24, 29, 19, 13.5)],
      ["ink", pair(2.5, 25, 0.9)],
      ["line", "M11 31Q24 41 37 31"],
    ],
    eyes: eyes(10, 14, 3.4),
  },
  hedgehog: {
    body: [
      ["face", spines(25, 21.5, 16.5, 16)],
      ["brass", spines(25, 19.5, 15, 16)],
      ["face", oval(24, 31, 11.5, 10.5)],
      ["ink", oval(24, 33, 2.4)],
    ],
    eyes: eyes(5, 28, 2.1),
  },
  koala: {
    body: [
      ["face", pair(14.5, 18.5, 8.5) + oval(24, 27, 14, 15)],
      ["shade", pair(14.5, 18.5, 4.8)],
      ["ink", oval(24, 29, 4, 6)],
    ],
    eyes: eyes(8, 23),
  },
  lion: {
    body: [
      ["face", tufts(25, 16.5, 4.6, 12)],
      ["brass", tufts(25, 16, 3.8, 12)],
      ["face", oval(24, 26, 12.5)],
      ["shade", oval(24, 31, 6.5, 5)],
      ["ink", "M21.5 28.5H26.5L24 31.5Z"],
      ["line", "M24 31.5V33.5M24 33.5Q21.5 35.5 20 34M24 33.5Q26.5 35.5 28 34"],
    ],
    eyes: eyes(5.5, 24, 2.1),
  },
  monkey: {
    body: [
      ["face", pair(17.5, 25, 5.5) + oval(24, 23, 15.5)],
      ["brass", pair(17.5, 25, 2.8)],
      [
        "shade",
        "M24 19Q21 13.5 16 15Q11 17.5 13 23Q13 26 15 27Q12.5 36 24 37.5Q35.5 36 33 27Q35 26 35 23Q37 17.5 32 15Q27 13.5 24 19Z",
      ],
      ["ink", pair(1.6, 28, 0.8)],
      ["line", "M18 31.5Q24 36 30 31.5"],
    ],
    eyes: eyes(5.5, 22.5),
  },
  mouse: {
    body: [
      ["face", pair(12.5, 16.5, 9)],
      ["shade", pair(12.5, 16.5, 5.4)],
      ["face", "M10 24Q10 14 24 14Q38 14 38 24Q38 33 24 43Q10 33 10 24Z"],
      ["ink", oval(24, 39.5, 2.4)],
      ["line", both("M19 33L13.5 31M19.5 36.5L15.5 37")],
    ],
    eyes: eyes(6.5, 26),
  },
  otter: {
    body: [
      ["face", pair(15.5, 16.5, 3.4) + oval(24, 26, 18.5, 14.5)],
      ["brass", "M7.5 24Q9 13 24 13Q39 13 40.5 24Q33 18.5 24 19Q15 18.5 7.5 24Z"],
      [
        "ink",
        `M21 26.5Q24 25.2 27 26.5Q26.6 29.2 24 29.8Q21.4 29.2 21 26.5Z${pair(7.5, 31, 0.8) + pair(10.5, 28.5, 0.8) + pair(11, 33, 0.8)}`,
      ],
      ["line", "M24 29.8V32.2M24 32.2Q21.5 34.4 19.5 33M24 32.2Q26.5 34.4 28.5 33"],
    ],
    eyes: eyes(9, 23.5),
  },
  owl: {
    body: [
      ["face", both("M8 6Q15 7 18 11.5L10 16Z")],
      ["face", oval(24, 27, 17)],
      ["shade", pair(7.5, 24, 7.5)],
      ["brass", "M21 28H27L24 33.5Z"],
    ],
    eyes: eyes(7.5, 24, 3.6),
  },
  panda: {
    body: [
      ["face", pair(13, 12.5, 7.5)],
      ["ink", pair(13, 12.5, 6)],
      ["face", oval(24, 26, 17.5, 16)],
      [
        "ink",
        `${both("M11.5 27Q11 20.5 16 19.5Q21 19 20.5 24.5Q19.5 30 15 31Q12 31 11.5 27Z")}M21.5 31.5H26.5L24 34Z`,
      ],
      ["line", "M24 34V36.5"],
    ],
    eyes: eyes(8, 25, 1.7, "face"),
  },
  penguin: {
    body: [
      ["face", oval(24, 25, 18, 19.5)],
      [
        "ink",
        "M24 7.5Q9.5 8 8 24Q8 30 11 34Q15 28 16 24Q19 17 24 20Q29 17 32 24Q33 28 37 34Q40 30 40 24Q38.5 8 24 7.5Z",
      ],
      ["brass", "M20.5 27H27.5L24 33Z"],
    ],
    eyes: eyes(6.5, 24),
  },
  pig: {
    body: [
      ["face", both("M10 15L7 4.5L19 11Z")],
      ["face", oval(24, 26, 17.5, 16)],
      ["shade", `${both("M11 13L9.5 8L15 11Z")}${oval(24, 30, 8.5, 6.5)}`],
      ["ink", pair(3, 30, 1.5, 2)],
      ["line", "M18 38.2Q24 40.5 30 38.2"],
    ],
    eyes: eyes(8, 22),
  },
  rabbit: {
    body: [
      ["face", pair(7.5, 14.5, 4.6, 11.5) + oval(24, 31, 13.5, 12.5)],
      ["brass", pair(7.5, 15, 2.2, 8)],
      ["ink", "M22 30H26L24 32.5Z"],
      ["line", "M24 32.5V34.5M24 34.5Q21 37 19 35M24 34.5Q27 37 29 35"],
    ],
    eyes: eyes(6.5, 27),
  },
  raccoon: {
    body: [
      ["face", both("M9 15Q8 6 15 7Q19 8 19 13Z")],
      ["face", "M24 12Q36 12 40 22Q43 27 38 30Q33 41 24 42Q15 41 10 30Q5 27 8 22Q12 12 24 12Z"],
      ["shade", "M21.5 12V22L24 24.5L26.5 22V12Z"],
      [
        "ink",
        `${both("M11.5 13Q11.5 9.5 14.5 9.8Q16 10.5 16.5 12.5ZM24 24.5Q20 18 13 20Q8 22 7.5 26Q12 31 18 29.5Q22 28 24 24.5Z")}M21.5 32.5H26.5L24 35Z`,
      ],
    ],
    eyes: eyes(8, 24.5, 1.9, "face"),
  },
  seal: {
    body: [
      ["face", oval(24, 25.5, 16, 16.5)],
      ["shade", pair(5, 32, 6, 4.5)],
      ["ink", oval(24, 29, 2.6, 2)],
      ["line", both("M13 31L18.5 32M13.5 35L18.5 34.5")],
    ],
    eyes: eyes(7.5, 22, 3.4),
  },
  sheep: {
    body: [
      ["shade", both("M13 26Q5 25 4 30Q9 33.5 14 30Z")],
      ["face", tufts(23, 13.5, 6.2, 10)],
      ["ink", oval(24, 28, 9.5, 11.5)],
      ["pale", "M21 34Q24 36.5 27 34"],
    ],
    eyes: eyes(4.5, 26, 2, "face"),
  },
  tiger: {
    body: [
      ["face", pair(13, 12, 5.5) + oval(24, 26, 17, 16)],
      [
        "brass",
        "M9.5 20Q14 11 24 10.5Q34 11 38.5 20Q37 25 31 22Q27 20 24 28Q21 20 17 22Q11 25 9.5 20Z",
      ],
      [
        "ink",
        `M22 10.6L24 17L26 10.6Z${both("M14.5 12.5L18 18L17.5 11.4ZM8 23L14 24.5L7.6 26.5ZM8.5 29L14 28.8L9.5 32Z")}M21.5 29.5H26.5L24 32Z`,
      ],
      ["line", "M24 32V34M24 34Q21.5 36 20 34.5M24 34Q26.5 36 28 34.5"],
    ],
    eyes: eyes(7, 23.5),
  },
};
