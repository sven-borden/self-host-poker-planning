import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createT } from "../i18n/i18n.ts";
import { I18nProvider } from "../i18n/i18n-context.tsx";
import { Avatar, avatarColour, initials } from "./avatar.tsx";
import { cardLabel, HandCard, labelEms, labelScale, MiniCard, SlotCard } from "./cards.tsx";
import type { TablePerson } from "./seat.tsx";
import { TableStage } from "./table-stage.tsx";

afterEach(() => {
  cleanup();
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
  });

  it("is decorative and uses an avatar token", () => {
    const { container } = render(<Avatar id="user-1" name="Ana Lima" size={40} />);
    const avatar = container.firstElementChild;
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.className).toMatch(/\bbg-av[1-8]\b/);
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

  it("speaks French and German", () => {
    render(
      <I18nProvider language="fr">
        <TableStage people={voting} variant="desktop" />
      </I18nProvider>,
    );
    expect(screen.getByRole("list", { name: "Personnes à la table" })).toBeDefined();
    expect(screen.getByText("Ben, réfléchit")).toBeDefined();
    cleanup();
    render(
      <I18nProvider language="de">
        <TableStage people={voting} variant="desktop" />
      </I18nProvider>,
    );
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

  it("makes a seat whose name is cut off a button that shows the whole name", async () => {
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
      expect(screen.getAllByRole("button")).toHaveLength(1);
      const seat = screen.getByRole("button", { name: "Maximilian Oberhuber-Schwarz, thinking" });
      // Ana's name fits: no button, the list item speaks.
      expect(screen.getByText("Ana, voted").className).toContain("sr-only");
      await act(async () => {
        fireEvent.click(seat);
      });
      const popover = await screen.findByRole("dialog");
      expect(popover.textContent).toBe("Maximilian Oberhuber-SchwarzThinking");
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
    expect(screen.queryAllByRole("button")).toHaveLength(0);
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
  const t = createT("en");

  it("names special cards in words", () => {
    expect(cardLabel(t, "5")).toBe("5");
    expect(cardLabel(t, "?")).toBe("unsure");
    expect(cardLabel(t, "☕")).toBe("needs a break");
    expect(cardLabel(t, "∞")).toBe("too big to estimate");
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
    expect(value?.style.fontSize).toBe("0.423em");
  });

  it("sizes slot cards in whole pixels from the layout", () => {
    const { container } = render(<SlotCard face="up" value="8" size={{ width: 36, height: 50 }} />);
    const style = (container.firstElementChild as HTMLElement).style;
    expect([style.width, style.height]).toEqual(["36px", "50px"]);
  });
});
