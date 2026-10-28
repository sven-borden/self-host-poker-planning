import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, fixedT, loadLanguage } from "../i18n/i18n.ts";
import { Avatar, avatarColour, avatarLooks, initials } from "./avatar.tsx";
import {
  cardLabel,
  HandCard,
  labelEms,
  labelFit,
  labelScale,
  MiniCard,
  SlotCard,
} from "./cards.tsx";
import type { TablePerson } from "./seat.tsx";
import { TableStage } from "./table-stage.tsx";

afterEach(async () => {
  cleanup();
  await act(() => changeLanguage("en"));
});

const person = (id: string, name: string, status: TablePerson["status"]): TablePerson => ({
  id,
  name,
  status,
});

describe("avatars", () => {
  it("picks one of the eight colours from the id, the same every time", () => {
    const colours = Array.from({ length: 64 }, (_, i) => avatarColour(`user-${i}`));
    expect(colours.every((colour) => colour >= 1 && colour <= 8)).toBe(true);
    expect(new Set(colours).size).toBe(8);
    expect(avatarColour("user-7")).toBe(avatarColour("user-7"));
  });

  it("derives initials from the name", () => {
    expect(initials("Ana Lima")).toBe("AL");
    expect(initials("Jérôme Lefebvre-Martin")).toBe("JL");
    expect(initials("noor")).toBe("No");
    expect(initials("  ")).toBe("?");
    expect(initials("Łukasz de Vries")).toBe("ŁV");
    expect(initials("Guest 1")).toBe("G1");
    expect(initials("guest 16")).toBe("G16");
    expect(initials("Room 2026")).toBe("R20");
  });

  it("is decorative and uses an avatar token", () => {
    const { container } = render(<Avatar id="user-1" name="Ana Lima" size={40} />);
    const avatar = container.firstElementChild;
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.className).toMatch(/\bbg-av[1-8]\b/);
  });

  it("greys an away avatar's disc at full opacity, so its initials stay readable", () => {
    const { container } = render(<Avatar id="user-1" name="Ana Lima" size={40} away />);
    const avatar = container.firstElementChild;
    expect(avatar?.className).toContain("bg-surface-2");
    expect(avatar?.className).toContain("text-ink-2");
    expect(avatar?.className).toContain("border-dashed");
    expect(avatar?.className).not.toMatch(/\bbg-av[1-8]\b|opacity|grayscale|text-on-avatar/);
    expect(avatar?.textContent).toBe("AL");
  });
});

describe("TableStage", () => {
  const voting = [
    person("a", "Ana", { kind: "voted" }),
    person("b", "Ben", { kind: "thinking" }),
    person("c", "Cleo", { kind: "voted" }),
  ];

  it("lists the seats with each person's state", () => {
    render(<TableStage people={voting} variant="desktop" />);
    const list = screen.getByRole("list", { name: "People at the table" });
    const items = within(list).getAllByRole("listitem");
    // The visible avatar and name are hidden from screen readers; the label speaks.
    expect(items.map((item) => item.querySelector(".sr-only")?.textContent)).toEqual([
      "Ana, voted",
      "Ben, thinking",
      "Cleo, voted",
    ]);
    // Two face-down cards on the table, one empty slot.
    expect(document.querySelectorAll('[data-face="down"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-face="empty"]')).toHaveLength(1);
    // The voted state is a check mark, not a colour alone.
    expect(document.querySelectorAll('[data-badge="voted"] svg')).toHaveLength(2);
  });

  it("says the card after reveal, in words for the specials", () => {
    render(
      <TableStage
        variant="desktop"
        people={[
          person("a", "Ana", { kind: "revealed", card: "5" }),
          person("b", "Ben", { kind: "revealed", card: null }),
          person("c", "Cleo", { kind: "revealed", card: "?" }),
        ]}
      />,
    );
    expect(screen.getByText("Ana, card 5")).toBeDefined();
    expect(screen.getByText("Ben, no vote")).toBeDefined();
    expect(screen.getByText("Cleo, unsure")).toBeDefined();
    expect(document.querySelectorAll('[data-face="up"]')).toHaveLength(2);
  });

  it("speaks French and German", async () => {
    await act(() => changeLanguage("fr"));
    render(<TableStage people={voting} variant="desktop" />);
    expect(screen.getByRole("list", { name: "Personnes à la table" })).toBeDefined();
    expect(screen.getByText("Ben, réfléchit")).toBeDefined();
    cleanup();
    await act(() => changeLanguage("de"));
    render(<TableStage people={voting} variant="desktop" />);
    expect(screen.getByText("Ana, hat abgestimmt")).toBeDefined();
  });

  it("shows initials only with more than 10 people on a phone, the name on tap", async () => {
    const crowd = Array.from({ length: 11 }, (_, i) =>
      person(`p${i}`, `Person ${i}`, { kind: i === 3 ? "voted" : "thinking" }),
    );
    render(<TableStage people={crowd} variant="phone" />);
    expect(document.querySelectorAll('[data-seat-part="name"]')).toHaveLength(0);
    const seat = screen.getByRole("button", { name: "Person 3, voted" });
    expect(seat.closest("[data-seat]")?.getAttribute("style")).toContain("width: 44px");
    await act(async () => {
      fireEvent.click(seat);
    });
    const popover = await screen.findByRole("dialog");
    expect(popover.textContent).toBe("Person 3Voted");
  });

  it("makes every seat a button that shows the whole name and the state", async () => {
    // jsdom does no layout: names longer than 12 characters overflow their 90 px.
    const sizes = {
      scrollWidth: function (this: HTMLElement) {
        return (this.textContent?.length ?? 0) > 12 ? 140 : 60;
      },
      clientWidth: () => 90,
    };
    for (const [key, get] of Object.entries(sizes)) {
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get });
    }
    try {
      render(
        <TableStage
          variant="desktop"
          people={[
            person("a", "Ana", { kind: "voted" }),
            person("m", "Maximilian Oberhuber-Schwarz", { kind: "thinking" }),
          ]}
        />,
      );
      expect(screen.getAllByRole("button")).toHaveLength(2);
      const seat = screen.getByRole("button", { name: "Maximilian Oberhuber-Schwarz, thinking" });
      await act(async () => {
        fireEvent.click(seat);
      });
      const popover = await screen.findByRole("dialog");
      expect(popover.textContent).toBe("Maximilian Oberhuber-SchwarzThinking");
      // Ana's name fits; her seat is a button too, for what its check mark means.
      expect(screen.getByRole("button", { name: "Ana, voted" })).toBeDefined();
    } finally {
      for (const key of Object.keys(sizes)) {
        Reflect.deleteProperty(HTMLElement.prototype, key);
      }
    }
  });

  it("keeps names with up to 10 people on a phone", () => {
    const ten = Array.from({ length: 10 }, (_, i) => person(`p${i}`, `P${i}`, { kind: "present" }));
    render(<TableStage people={ten} variant="phone" />);
    expect(document.querySelectorAll('[data-seat-part="name"]')).toHaveLength(10);
    expect(document.querySelectorAll("[data-seat-trigger]")).toHaveLength(10);
  });

  it("seats observers in a row under the table, not at it", () => {
    render(
      <TableStage variant="desktop" people={voting} observers={[{ id: "o", name: "Olivia" }]} />,
    );
    expect(
      within(screen.getByRole("list", { name: "People at the table" })).queryByText("Olivia"),
    ).toBeNull();
    const observers = screen.getByRole("list", { name: "Observers" });
    expect(within(observers).getByText("Olivia")).toBeDefined();
  });

  it("renders the centre status it is given", () => {
    render(
      <TableStage people={voting} variant="desktop">
        <p>2/3 voted so far</p>
      </TableStage>,
    );
    expect(document.querySelector("[data-centre]")?.textContent).toBe("2/3 voted so far");
  });
});

describe("cards", () => {
  const t = fixedT("en");

  it("names special cards in words", () => {
    expect(cardLabel(t, "5")).toBe("5");
    expect(cardLabel(t, "?")).toBe("unsure");
    expect(cardLabel(t, "☕")).toBe("needs a break");
    expect(cardLabel(t, "∞")).toBe("too big to estimate");
  });

  it("keeps a label as the deck holds it, in every language", async () => {
    await loadLanguage("fr");
    await loadLanguage("de");
    for (const language of ["fr", "de"] as const) {
      expect(cardLabel(fixedT(language), "0.5")).toBe("0.5");
      expect(cardLabel(fixedT(language), "½")).toBe("½");
    }
    expect(cardLabel(fixedT("fr"), "?")).toBe("incertain");
  });

  it("makes a hand card a 44 px-wide-or-more toggle button with corner indices", () => {
    render(<HandCard value="13" label="13" selected />);
    const card = screen.getByRole("button", { name: "13" });
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(card.className).toContain("w-[50px]");
    expect(card.className).toContain("phone:w-11");
    expect(card.textContent).toBe("131313");
  });

  it("draws ☕ and ∞ as icons, not as emoji or a fallback glyph", () => {
    render(
      <>
        <HandCard value="☕" label={cardLabel(t, "☕")} />
        <MiniCard value="∞" />
      </>,
    );
    expect(
      screen.getByRole("button", { name: "needs a break" }).querySelectorAll("svg"),
    ).toHaveLength(3);
    expect(document.body.textContent).not.toMatch(/[☕∞]/);
  });

  it("shrinks a label by its graphemes so that it fits on one line", () => {
    expect(labelEms("8")).toBe(0.72);
    expect(labelEms("100")).toBeCloseTo(2.16);
    expect(labelEms("XXL")).toBe(3);
    expect(labelEms("WWWW")).toBe(4);
    // Lowercase letters but m and w take 0.8 em (#26).
    expect(labelEms("Huge")).toBeCloseTo(3.4);
    expect(labelEms("mmmm")).toBe(4);
    expect(labelEms("a")).toBe(0.8);
    // Only ASCII lowercase counts as narrow; ½, ¼ and ¾ are 1 em, not a digit's 0.72 (#26).
    expect(labelEms("œœœœ")).toBe(4);
    expect(labelEms("щщщщ")).toBe(4);
    expect(labelEms("½½½½")).toBe(4);
    expect(labelEms("1½")).toBeCloseTo(1.72);
    // A skin-toned thumb is one grapheme of two code points.
    expect(labelEms("👍🏽👍")).toBeCloseTo(2.6);
    expect(labelScale("13", 1.88)).toBe(1);
    expect(labelScale("WWWW", 1.88)).toBe(0.47);
    for (const value of ["1", "13", "100", "1000", "XXL", "WWWW", "MMMM", "👍🏽👍", "½"]) {
      for (const room of [1.69, 1.88, 1.4]) {
        expect(labelScale(value, room) * labelEms(value)).toBeLessThanOrEqual(room);
      }
    }
    render(<MiniCard value="XXXL" />);
    const value = document.querySelector<HTMLElement>("[data-card-value]");
    expect(value?.className).toContain("whitespace-nowrap");
    // At 42 % it would be 5 px on a phone's chip: it narrows to 70 % width and grows.
    // Never under 7 px, whatever the parent's size.
    expect(value?.style.fontSize).toBe("max(7px, 0.579em)");
    expect(value?.style.fontStretch).toBe("70%");
  });

  it("narrows a long label rather than shrinking it below 80 % (#22)", () => {
    expect(labelFit("13", 1.4545)).toMatchObject({ scale: 1, narrow: false });
    expect(labelFit("100", 1.88)).toMatchObject({ scale: 0.87, narrow: false });
    // An emoji's font has no width axis.
    expect(labelFit("👍🏽👍", 1.4).narrow).toBe(false);
    // The dense phone slot: 16 px of room in an 11 px font.
    const dense = 16 / 11;
    expect(labelFit("XXL", dense)).toMatchObject({ scale: 0.664, narrow: true });
    expect(labelFit("100", dense).scale * 11).toBeGreaterThan(10);
    expect(labelFit("XL", dense).scale * 11).toBeGreaterThan(10);
    for (const value of ["XS", "XL", "XXL", "100", "½"]) {
      expect(labelFit(value, dense).scale * 11, value).toBeGreaterThanOrEqual(7);
    }
  });

  it("clips a label that does not fit its card as drawn, centred, with the whole label in its title", () => {
    // jsdom has no layout: the drawn label is as wide as its text in 5 px a character,
    // the card 18 px inside its border.
    const offset = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-card-value") ? (this.textContent?.length ?? 0) * 5 : 0;
      });
    const client = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-face") ? 18 : 0;
      });
    try {
      const { container } = render(
        <>
          <SlotCard face="up" value="WWWW" size={{ width: 20, height: 28 }} />
          <SlotCard face="up" value="XL" size={{ width: 20, height: 28 }} />
        </>,
      );
      const [wide, fits] = [...container.querySelectorAll("[data-face='up']")];
      expect(wide?.querySelector("[data-clipped]")?.textContent).toBe("WWWW");
      const clip = wide?.querySelector<HTMLElement>("[data-label-clip]");
      expect(clip?.className).toContain("overflow-hidden");
      expect(clip?.title).toBe("WWWW");
      expect(fits?.querySelector("[data-clipped]")).toBeNull();
    } finally {
      offset.mockRestore();
      client.mockRestore();
    }
  });

  it("sizes slot cards in whole pixels from the layout", () => {
    const { container } = render(<SlotCard face="up" value="8" size={{ width: 36, height: 50 }} />);
    const style = (container.firstElementChild as HTMLElement).style;
    expect([style.width, style.height]).toEqual(["36px", "50px"]);
  });
});

describe("presence, the PO and the viewer (#17)", () => {
  const people: TablePerson[] = [
    { ...person("me", "Mia", { kind: "voted" }), you: true },
    { ...person("po", "Pia", { kind: "thinking" }), owner: true },
    { ...person("aw", "Ana", { kind: "voted" }), away: true },
  ];

  it("says who is the viewer, the PO and away, and badges each with a shape", () => {
    render(<TableStage variant="desktop" people={people} />);
    expect(screen.getByText("Mia, you, voted")).toBeDefined();
    expect(screen.getByText("Pia, product owner, thinking")).toBeDefined();
    expect(screen.getByText("Ana, away, voted")).toBeDefined();
    const seat = (id: number) => document.querySelectorAll("[data-seat]")[id];
    expect(seat(0)?.hasAttribute("data-you")).toBe(true);
    expect(seat(1)?.querySelector('[data-badge="owner"] svg')).not.toBeNull();
    expect(seat(2)?.hasAttribute("data-away")).toBe(true);
    expect(seat(2)?.querySelector('[data-badge="away"] svg')).not.toBeNull();
    expect(seat(2)?.querySelector('[data-badge="voted"] svg')).not.toBeNull();
    expect(seat(2)?.querySelector("[data-avatar]")?.className).toContain("bg-surface-2");
    expect(seat(0)?.querySelector("[data-avatar]")?.className).toContain("outline-spruce");
    // An away voter's card stays face down: away says nothing about the vote.
    expect(document.querySelectorAll('[data-face="down"]')).toHaveLength(2);
  });

  it("explains the badges of a seat with a name, by keyboard too", async () => {
    render(<TableStage variant="desktop" people={people} />);
    const seat = screen.getByRole("button", { name: "Ana, away, voted" });
    seat.focus();
    await act(async () => {
      fireEvent.keyDown(seat, { key: "Enter" });
      fireEvent.click(seat);
    });
    expect((await screen.findByRole("dialog")).textContent).toBe("AnaAway · Voted");
  });

  it("marks a card changed after the reveal: a chip on the table, words on the seat and in its popover (#29)", async () => {
    render(
      <TableStage
        variant="desktop"
        people={[
          person("ana", "Ana", { kind: "revealed", card: "8", extreme: "high", changed: true }),
          person("ben", "Ben", { kind: "revealed", card: "3", extreme: "low" }),
        ]}
      />,
    );
    const chips = document.querySelectorAll("[data-slot-card] [data-changed-chip]");
    expect([...chips].map((chip) => chip.textContent)).toEqual(["changed"]);
    expect(chips[0]?.closest("[data-slot-card]")?.getAttribute("aria-hidden")).toBe("true");
    const seat = screen.getByRole("button", {
      name: "Ana, card 8, highest card, changed after the reveal",
    });
    screen.getByRole("button", { name: "Ben, card 3, lowest card" });
    await act(async () => {
      fireEvent.click(seat);
    });
    expect((await screen.findByRole("dialog")).textContent).toBe(
      "Ana8 · Highest card · Changed after the reveal",
    );
  });

  it("marks a changed card with a corner dot on a dense phone table, the word elsewhere (#29)", () => {
    const crowd = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        person(`p${i}`, `P${i}`, { kind: "revealed", card: "5", changed: true }),
      );
    const marks = () =>
      [...document.querySelectorAll("[data-slot-card] [data-changed-chip]")].map((mark) => [
        mark.getAttribute("data-changed-chip"),
        mark.textContent,
      ]);
    // 10 on a phone is not dense yet: the word.
    const { unmount } = render(<TableStage people={crowd(10)} variant="phone" />);
    expect(new Set(marks().map(String))).toEqual(new Set(["word,changed"]));
    unmount();
    render(<TableStage people={crowd(11)} variant="phone" />);
    expect(marks()).toHaveLength(11);
    expect(new Set(marks().map(String))).toEqual(new Set(["mark,"]));
    // The seat still says it in words.
    screen.getByRole("button", { name: /^P3, card 5, changed after the reveal$/ });
  });

  it("puts the PO and away in the popover of a seat that shows initials only", async () => {
    const crowd = Array.from({ length: 11 }, (_, i) => ({
      ...person(`p${i}`, `Person ${i}`, { kind: "thinking" as const }),
      owner: i === 2,
      away: i === 2,
    }));
    render(<TableStage people={crowd} variant="phone" />);
    const seat = screen.getByRole("button", { name: "Person 2, product owner, away, thinking" });
    await act(async () => {
      fireEvent.click(seat);
    });
    expect((await screen.findByRole("dialog")).textContent).toBe(
      "Person 2Product owner · Away · Thinking",
    );
  });

  it("writes out away and the PO in the observers' row", () => {
    render(
      <TableStage
        variant="desktop"
        people={people}
        observers={[
          { id: "o1", name: "Olivia", away: true, owner: true },
          { id: "o2", name: "Oskar", you: true },
        ]}
      />,
    );
    const row = screen.getByRole("list", { name: "Observers" });
    const [olivia, oskar] = within(row).getAllByRole("listitem");
    expect(olivia?.textContent).toBe("OlOlivia, product owner, awayProduct owner · Away");
    expect(olivia?.hasAttribute("data-away")).toBe(true);
    expect(oskar?.textContent).toBe("OsOskar, you");
  });

  it("shows the second of a name numbered, on the seat, in its popover and in the observers' row (#22)", async () => {
    render(
      <TableStage
        variant="desktop"
        people={[
          person("a1", "Ana Lima", { kind: "thinking" }),
          { ...person("a2", "Ana Lima", { kind: "thinking" }), namesake: 2 },
        ]}
        observers={[{ id: "o3", name: "Ana Lima", namesake: 3 }]}
      />,
    );
    const names = [...document.querySelectorAll("[data-seat-part=name] bdi")].map(
      (name) => name.textContent,
    );
    expect(names).toEqual(["Ana Lima", "Ana Lima (2)"]);
    const row = screen.getByRole("list", { name: "Observers" });
    expect(within(row).getByRole("listitem").textContent).toContain("Ana Lima (3)");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ana Lima (2), thinking" }));
    });
    expect((await screen.findByRole("dialog")).textContent).toBe("Ana Lima (2)Thinking");
  });
});

describe("avatarLooks", () => {
  it("keeps each person's own colour when free, and tells twins apart", () => {
    const looks = avatarLooks([
      { id: "user-1", name: "Ana Lima" },
      { id: "user-2", name: "Ana Lima" },
    ]);
    expect(looks.get("user-1")).toEqual({ initials: "AL", colour: avatarColour("user-1") });
    expect(looks.get("user-2")?.initials).toBe("AL");
    expect(looks.get("user-2")?.colour).not.toBe(looks.get("user-1")?.colour);
  });

  it("gives 8 people 8 colours, and never two people the same look", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: `same-${i}`, name: `N${i}` }));
    expect(new Set([...avatarLooks(eight).values()].map((l) => l.colour)).size).toBe(8);
    const twins = Array.from({ length: 32 }, (_, i) => ({ id: `t${i}`, name: "Ana" }));
    const looks = [...avatarLooks([...twins, twins[0] as { id: string; name: string }]).values()];
    expect(looks).toHaveLength(32);
    expect(new Set(looks.map((l) => `${l.colour}${l.initials}`)).size).toBe(32);
    expect(looks.filter((l) => l.initials === "An")).toHaveLength(8);
    expect(looks.at(-1)?.initials).toBe("A4");
  });

  it("gives Guest 1 to Guest 16 sixteen different initials", () => {
    const guests = Array.from({ length: 16 }, (_, i) => ({ id: `g${i}`, name: `Guest ${i + 1}` }));
    const shown = [...avatarLooks(guests).values()].map((look) => look.initials);
    expect(new Set(shown).size).toBe(16);
    expect(shown).toEqual(guests.map((_, i) => `G${i + 1}`));
  });

  it("bases colours on ids: a rename changes none, a leave only those who gave way", () => {
    // Seven people, and an eighth whose id gives the first one's colour.
    const ids = Array.from({ length: 7 }, (_, i) => `user-${i}`);
    for (let j = 7; ids.length < 8; j++) {
      if (avatarColour(`user-${j}`) === avatarColour("user-0")) ids.push(`user-${j}`);
    }
    const people = ids.map((id, i) => ({ id, name: `Name ${i}` }));
    const before = avatarLooks(people);
    // In this set someone had to give way, so the checks below mean something.
    const gaveWay = people.filter((p) => before.get(p.id)?.colour !== avatarColour(p.id));
    expect(gaveWay.length).toBeGreaterThan(0);
    for (let i = 0; i < people.length; i++) {
      const renamed = avatarLooks(people.map((p, j) => (j === i ? { ...p, name: "Zed Ward" } : p)));
      for (const p of people) {
        expect(renamed.get(p.id)?.colour).toBe(before.get(p.id)?.colour);
      }
      const gone = people[i]?.id;
      const after = avatarLooks(people.filter((p) => p.id !== gone));
      for (const p of people) {
        if (p.id === gone || gaveWay.includes(p)) continue;
        expect(after.get(p.id)?.colour).toBe(avatarColour(p.id));
      }
    }
  });

  it("is what the avatar draws when given", () => {
    render(<Avatar id="x" name="Ana" size={40} look={{ initials: "A2", colour: 3 }} />);
    const avatar = document.querySelector("[data-avatar]");
    expect(avatar?.textContent).toBe("A2");
    expect(avatar?.className).toContain("bg-av3");
  });
});
