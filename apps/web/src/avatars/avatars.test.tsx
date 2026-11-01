import { AVATAR_IDS, type AvatarId } from "@pp/domain";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n/i18n.ts";
import { Avatar, AvatarDrawing, avatarLooks } from "../table/avatar.tsx";
import { AVATAR_ART } from "./art.ts";
import { AvatarPicker } from "./avatar-picker.tsx";
import { holdIdle, IDLE_GAP } from "./idle.ts";
import { loadAvatarArt, resetAvatarArt } from "./use-art.ts";

beforeAll(() => changeLanguage("en"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const look = (art?: AvatarId) => ({ initials: "AL", colour: 3, art });

describe("the drawings", () => {
  it("cover every avatar the domain knows, each one different", () => {
    expect(Object.keys(AVATAR_ART).sort()).toEqual([...AVATAR_IDS].sort());
    const drawn = AVATAR_IDS.map((id) => JSON.stringify(AVATAR_ART[id]));
    expect(new Set(drawn).size).toBe(24);
  });

  it("weigh under 60 KB together, as the page gets them (#42)", () => {
    const bytes = AVATAR_IDS.reduce(
      (sum, id) =>
        sum +
        new Blob([renderToStaticMarkup(<AvatarDrawing drawing={AVATAR_ART[id]} idle />)]).size,
      0,
    );
    expect(bytes).toBeLessThan(60 * 1024);
  });

  it("have eyes to blink with, and draw every path in a known tone", () => {
    const tones = new Set(["face", "shade", "ink", "brass", "line", "pale"]);
    for (const id of AVATAR_IDS) {
      const { body, eyes } = AVATAR_ART[id];
      expect(eyes.length, id).toBeGreaterThan(0);
      for (const [tone, path] of [...body, ...eyes]) {
        expect(tones.has(tone), id).toBe(true);
        expect(path, id).toMatch(/^M[-\d.MmLlQqHhVvAaZz ]+$/);
      }
    }
  });
});

describe("looks", () => {
  const people = (count: number, avatar?: AvatarId) =>
    Array.from({ length: count }, (_, i) => ({ id: `user-${i}`, name: `Guest ${i}`, avatar }));

  it("give a person the drawing they picked, on their own colour", () => {
    const looks = avatarLooks([
      { id: "a", name: "Ana Lima", avatar: "fox" },
      { id: "b", name: "Ben Oka" },
    ]);
    expect(looks.get("a")).toMatchObject({ art: "fox", initials: "AL" });
    expect(looks.get("b")?.art).toBeUndefined();
  });

  it("wear one drawing in up to eight colours, then fall back to initials", () => {
    const looks = [...avatarLooks(people(16, "fox")).values()];
    const foxes = looks.filter((one) => one.art === "fox");
    expect(foxes).toHaveLength(8);
    expect(new Set(foxes.map((one) => one.colour)).size).toBe(8);
    const faces = looks.map((one) => `${one.colour}:${one.art ?? one.initials}`);
    expect(new Set(faces).size).toBe(16);
  });

  it("change nobody's colour for a pick", () => {
    const plain = avatarLooks(people(8));
    const picked = avatarLooks(people(8, "owl"));
    for (const [id, one] of plain) expect(picked.get(id)?.colour).toBe(one.colour);
  });
});

describe("an avatar", () => {
  beforeEach(() => resetAvatarArt());

  it("shows its initials until the drawing has loaded", async () => {
    const { container } = render(<Avatar id="a" name="Ana Lima" size={40} look={look("fox")} />);
    expect(container.textContent).toBe("AL");
    await act(() => loadAvatarArt());
    expect(container.textContent).toBe("");
    expect(container.querySelector('[data-avatar-art="idle"]')).not.toBeNull();
    expect(container.querySelector("[data-avatar-eyes]")).not.toBeNull();
  });

  it("keeps its initials for an id this page does not know", async () => {
    const unknown = { initials: "AL", colour: 3, art: "constructor" };
    const { container } = render(<Avatar id="a" name="Ana Lima" size={40} look={unknown} />);
    await act(() => loadAvatarArt());
    expect(container.textContent).toBe("AL");
  });

  it("rests and shuts its eyes while its person is away", async () => {
    const { container } = render(
      <Avatar id="a" name="Ana Lima" size={40} look={look("fox")} away />,
    );
    await act(() => loadAvatarArt());
    expect(container.querySelector('[data-avatar-art="still"]')).not.toBeNull();
    expect(container.querySelector("[data-avatar-away]")).not.toBeNull();
  });
});

describe("the picker", () => {
  beforeEach(() => resetAvatarArt());

  function renderPicker(value: AvatarId | null = null, focusOnMount = false) {
    const onChange = vi.fn();
    render(
      <AvatarPicker
        value={value}
        onChange={onChange}
        id="me"
        name="Ana Lima"
        colour={2}
        focusOnMount={focusOnMount}
      />,
    );
    return onChange;
  }

  it("is a group of native radios, the initials first, each with a name", async () => {
    renderPicker("fox");
    await act(() => loadAvatarArt());
    expect(screen.getByRole("group", { name: "Your avatar" })).toBeDefined();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(25);
    expect(radios[0]?.getAttribute("aria-label")).toBe("Initials");
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Fox" }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Owl" }).checked).toBe(false);
  });

  it("only moves the choice, back to the initials too", () => {
    const onChange = renderPicker("fox");
    fireEvent.click(screen.getByRole("radio", { name: "Owl" }));
    expect(onChange).toHaveBeenLastCalledWith("owl");
    fireEvent.click(screen.getByRole("radio", { name: "Initials" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("marks the pick with a shape, and gives idle life to the pick alone", async () => {
    const { container } = render(
      <AvatarPicker value="fox" onChange={() => {}} id="me" name="Ana" colour={2} />,
    );
    await act(() => loadAvatarArt());
    expect(container.querySelectorAll("[data-avatar-picked]")).toHaveLength(1);
    expect(container.querySelectorAll('[data-avatar-art="idle"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-avatar-art="still"]')).toHaveLength(23);
  });

  it("can take the focus on the current choice", () => {
    renderPicker("owl", true);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Owl" }));
  });
});

describe("idle life", () => {
  const animate = vi.fn();
  const reduced = vi.fn(() => false);
  /** The wait between two gestures, with `Math.random` held at 0.5. */
  const GAP = (IDLE_GAP.min + IDLE_GAP.max) / 2;

  beforeEach(() => {
    animate.mockClear();
    reduced.mockReturnValue(false);
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    Element.prototype.animate = animate;
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced(), media: query }));
    document.body.innerHTML = `<svg data-avatar-art="idle"><g data-avatar-eyes></g></svg>`;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("makes one gesture at a time, a blink or a bob, while something holds it", () => {
    const release = holdIdle();
    vi.advanceTimersByTime(GAP);
    expect(animate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(GAP * 4);
    expect(animate).toHaveBeenCalledTimes(5);
    release();
    vi.advanceTimersByTime(GAP * 4);
    expect(animate).toHaveBeenCalledTimes(5);
  });

  it("runs once for several holders, until the last lets go", () => {
    const first = holdIdle();
    const second = holdIdle();
    vi.advanceTimersByTime(GAP);
    expect(animate).toHaveBeenCalledTimes(1);
    first();
    vi.advanceTimersByTime(GAP);
    expect(animate).toHaveBeenCalledTimes(2);
    second();
    vi.advanceTimersByTime(GAP);
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it("does nothing under reduced motion", () => {
    reduced.mockReturnValue(true);
    const release = holdIdle();
    vi.advanceTimersByTime(GAP * 4);
    expect(animate).not.toHaveBeenCalled();
    release();
  });

  it("pauses while the tab is hidden, and goes on when it comes back", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const release = holdIdle();
    vi.advanceTimersByTime(GAP * 4);
    expect(animate).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    vi.advanceTimersByTime(GAP);
    expect(animate).toHaveBeenCalledTimes(1);
    release();
  });
});
