import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./app.tsx";
import { changeLanguage } from "./i18n/i18n.ts";
import type { Language } from "./i18n/language.ts";
import { createAppRouter } from "./router.ts";

async function renderAt(path: string, language: Language = "en") {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  await act(async () => {
    await changeLanguage(language);
    render(<App router={router} />);
    await router.load();
  });
  return router;
}

afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  await act(() => changeLanguage("en"));
});

describe("app shell", () => {
  it("renders the home page with room creation disabled until W1", async () => {
    await renderAt("/");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveProperty(
      "textContent",
      "Estimate together, around one table",
    );
    const create = screen.getByRole("button", { name: "Create a room" });
    expect(create).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Theme: System" })).toBeDefined();
  });

  it("shows the room code on the room placeholder", async () => {
    await renderAt("/r/abc");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Room abc");
  });

  it("speaks French and German", async () => {
    await renderAt("/r/abc", "fr");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Salle abc");
    cleanup();
    await renderAt("/", "de");
    expect(await screen.findByRole("button", { name: "Raum erstellen" })).toBeDefined();
  });

  it("renders a not-found page for an unknown address", async () => {
    await renderAt("/nowhere");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Page not found");
  });

  it("switches the language from the header without remounting the page", async () => {
    await renderAt("/");
    const heading = await screen.findByRole("heading", { level: 1 });
    const trigger = screen.getByRole("button", { name: "Language: English" });
    expect(trigger.className).toContain("phone:w-11");
    fireEvent.keyDown(trigger, { key: "Enter" });
    const french = await screen.findByRole("menuitemradio", { name: "Français" });
    expect(french.getAttribute("lang")).toBe("fr");
    expect(screen.getByRole("menuitemradio", { name: "Deutsch" }).getAttribute("lang")).toBe("de");
    fireEvent.click(french);
    await waitFor(() =>
      expect(heading.textContent).toBe("Estimez ensemble, autour d’une même table"),
    );
    expect(screen.getByRole("heading", { level: 1 })).toBe(heading);
    expect(document.documentElement.lang).toBe("fr");
    expect(window.localStorage.getItem("pp-language")).toBe("fr");
    expect(screen.getByRole("button", { name: "Langue\u202f: Français" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Thème\u202f: Système" })).toBeDefined();
  });
});
