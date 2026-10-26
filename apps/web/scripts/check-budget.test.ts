// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatKb, initialChunks, type Manifest, ROOM_ROUTE } from "./check-budget.ts";

const manifest: Manifest = {
  "index.html": {
    file: "assets/index.js",
    isEntry: true,
    imports: ["_vendor.js"],
    dynamicImports: ["src/motion/features.ts", `${ROOM_ROUTE}?tsr-split=component`],
  },
  "_vendor.js": { file: "assets/vendor.js" },
  "src/motion/features.ts": { file: "assets/features.js", imports: ["index.html"] },
  [`${ROOM_ROUTE}?tsr-split=component`]: {
    file: "assets/code.js",
    imports: ["index.html", "_room-shared.js"],
  },
  "_room-shared.js": { file: "assets/room-shared.js", imports: ["_vendor.js"] },
  "src/routes/index.tsx?tsr-split=component": { file: "assets/home.js" },
};

describe("initialChunks", () => {
  it("counts the entry, the room route and their static imports, not lazy chunks", () => {
    expect(initialChunks(manifest, ROOM_ROUTE).sort()).toEqual(
      ["index.html", "_vendor.js", `${ROOM_ROUTE}?tsr-split=component`, "_room-shared.js"].sort(),
    );
  });

  it("fails loudly when the route is missing, rather than measuring the wrong thing", () => {
    expect(() => initialChunks(manifest, "src/routes/nowhere.tsx")).toThrow(
      "The manifest has no chunk for src/routes/nowhere.tsx.",
    );
  });
});

describe("formatKb", () => {
  it("prints kilobytes with one decimal", () => {
    expect(formatKb(195_712)).toBe("195.7 kB");
  });
});
