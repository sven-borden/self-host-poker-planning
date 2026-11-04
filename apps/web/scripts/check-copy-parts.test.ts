// @vitest-environment node
import { describe, expect, it } from "vitest";
import { COPY_PARTS } from "../src/i18n/copy-parts.ts";
import { LANDING_ROUTE, type Manifest, ROOM_ROUTE } from "./check-budget.ts";
import { findings, loadedWith, names, PART_ROOTS, partKeys } from "./check-copy-parts.ts";

const PANEL = "src/room/settings-panel.tsx";
const SEATED = "src/room/seated.tsx";
const EXPORTS = "src/room/exports.ts";

/** A build like the app's: two routes, a panel, the table, and a chunk the two share. */
function build(): Manifest {
  return {
    "index.html": {
      file: "assets/index.js",
      isEntry: true,
      imports: ["_vendor.js"],
      dynamicImports: [`${ROOM_ROUTE}?tsr-split=component`, `${LANDING_ROUTE}?tsr-split=component`],
    },
    "_vendor.js": { file: "assets/vendor.js" },
    [`${ROOM_ROUTE}?tsr-split=component`]: {
      file: "assets/code.js",
      imports: ["index.html"],
      dynamicImports: [PANEL, SEATED],
    },
    [`${LANDING_ROUTE}?tsr-split=component`]: { file: "assets/home.js", imports: ["index.html"] },
    [PANEL]: {
      file: "assets/settings-panel.js",
      imports: ["index.html", "_shared.js"],
      dynamicImports: [EXPORTS],
    },
    [SEATED]: { file: "assets/seated.js", imports: ["index.html", "_shared.js"] },
    "_shared.js": { file: "assets/shared.js" },
    [EXPORTS]: { file: "assets/exports.js", imports: ["index.html"] },
  };
}

const settings = { settings: { deck: "Deck", deckCount_one: "x", deckCount_other: "y" } };
const ROOTS = { settings: [PANEL, EXPORTS] };

/** The chunks' code: what the test does not give is empty. */
const chunks =
  (code: Record<string, string>) =>
  (file: string): string =>
    code[file] ?? "";

describe("loadedWith", () => {
  it("names the first screen, else each lazy chunk that loads a file", () => {
    const roots = loadedWith(build());
    expect([...(roots.get("assets/code.js") ?? [])]).toEqual(["the first screen"]);
    expect([...(roots.get("assets/settings-panel.js") ?? [])]).toEqual([PANEL]);
    expect([...(roots.get("assets/shared.js") ?? [])].sort()).toEqual([PANEL, SEATED].sort());
    expect([...(roots.get("assets/exports.js") ?? [])]).toEqual([EXPORTS]);
  });
});

describe("names", () => {
  it("finds a key quoted or built from its head, never inside a longer key", () => {
    expect(names('t("settings.deck")', "settings.deck")).toBe(true);
    expect(names("label:`settings.deck`", "settings.deck")).toBe(true);
    expect(names("t(`settings.${e}`)", "settings.deck")).toBe(true);
    expect(names('t("settings."+e)', "settings.deck")).toBe(true);
    expect(names('t("settings.deckHint")', "settings.deck")).toBe(false);
    expect(names('t("mysettings.deck")', "settings.deck")).toBe(false);
    expect(names("t(`settings.deck.${e}`)", "settings.deck")).toBe(false);
  });

  it("reads a part's keys without their plural suffixes", () => {
    expect(partKeys(settings).sort()).toEqual(["settings.deck", "settings.deckCount"]);
  });
});

describe("findings", () => {
  it("passes a key used only in its panel's chunks", () => {
    const code = chunks({
      "assets/settings-panel.js": 't("settings.deck");t("settings.deckCount",{count:n})',
      "assets/exports.js": "t(`settings.${column}`)",
    });
    expect(findings(build(), code, { settings }, ROOTS)).toEqual([]);
  });

  it("fails a key the first screen, the table or a chunk shared with it names", () => {
    const code = chunks({
      "assets/code.js": 't("settings.deck")',
      "assets/shared.js": "t(`settings.${e}`)",
    });
    expect(findings(build(), code, { settings }, ROOTS)).toEqual([
      "settings: settings.deck is in assets/code.js, which loads with the first screen.",
      `settings: settings.deck is in assets/shared.js, which loads with ${SEATED}.`,
      `settings: settings.deckCount is in assets/shared.js, which loads with ${SEATED}.`,
    ]);
  });

  it("fails a further chunk that something else loads, and a chunk gone from the build", () => {
    const manifest = build();
    manifest[SEATED] = { ...manifest[SEATED], file: "assets/seated.js", dynamicImports: [EXPORTS] };
    const gone = { settings: [PANEL, "src/room/nowhere.tsx"] };
    expect(findings(manifest, chunks({}), { settings }, ROOTS)).toEqual([
      `settings: ${EXPORTS} is loaded by ${SEATED}, which ${SEATED} loads.`,
    ]);
    expect(findings(build(), chunks({}), { settings }, gone)).toEqual([
      "settings: src/room/nowhere.tsx is not in the build any more.",
    ]);
    expect(findings(build(), chunks({}), { settings }, {})).toEqual([
      "settings: no chunk loads it.",
    ]);
  });

  it("knows a loading chunk for every part", () => {
    expect(Object.keys(PART_ROOTS).sort()).toEqual([...COPY_PARTS].sort());
  });
});
