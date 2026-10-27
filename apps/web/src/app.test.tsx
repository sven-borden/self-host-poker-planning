import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.tsx";
import { changeLanguage } from "./i18n/i18n.ts";
import type { Language } from "./i18n/language.ts";
import { resetIdentityModule } from "./identity/identity.ts";
import { createAppRouter } from "./router.ts";
import { useIdentityStore } from "./stores/identity-store.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stubs `fetch` with one answer per `METHOD path`; anything else fails like offline. */
function serve(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${input}`;
      calls.push(key);
      const route = routes[key];
      if (!route) throw new TypeError("Failed to fetch");
      return route();
    }),
  );
  return calls;
}

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
  vi.unstubAllGlobals();
  resetIdentityModule();
  useIdentityStore.getState().reset();
  window.localStorage.clear();
  await act(() => changeLanguage("en"));
});

describe("app shell", () => {
  it("renders the home page with the room creation card, Fibonacci picked", async () => {
    await renderAt("/");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveProperty(
      "textContent",
      "Estimate together, around one table",
    );
    expect(screen.getByRole("heading", { level: 2, name: "Create a room" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: /^Room name/ })).toHaveProperty("value", "");
    expect(screen.getByRole("radio", { name: /^Fibonacci/ })).toHaveProperty("checked", true);
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    const create = screen.getByRole("button", { name: "Create the room" });
    expect(create).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Theme: System" })).toBeDefined();
  });

  it("creates a room and opens it, its name inside bdi", async () => {
    const calls = serve({
      "GET /api/auth/get-session": () => json({ user: { id: "u1", name: "" } }),
      "POST /api/rooms": () => json({ code: "Abc1234567" }, 201),
      "GET /api/rooms/Abc1234567": () => json({ code: "Abc1234567", name: "Sprint 42" }),
    });
    const router = await renderAt("/");
    fireEvent.change(await screen.findByRole("textbox", { name: /^Room name/ }), {
      target: { value: "Sprint 42" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /^T-shirt sizes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create the room" }));
    const heading = await screen.findByRole("heading", { level: 1, name: "Sprint 42" });
    expect(router.state.location.pathname).toBe("/r/Abc1234567");
    expect(heading.querySelector("bdi")?.textContent).toBe("Sprint 42");
    expect(document.querySelector("[data-room-code]")?.textContent).toBe("Abc1234567");
    expect(document.querySelector("[data-room-slot]")).not.toBeNull();
    expect(calls).toContain("POST /api/rooms");
  });

  const NAME_REFUSED =
    "A room name needs 1 to 60 visible characters. Shorten it, or leave the field empty.";

  it("refuses a bad name in the browser, without a request, and focuses the field", async () => {
    const calls = serve({
      "GET /api/auth/get-session": () => json({ user: { id: "u1", name: "" } }),
    });
    await renderAt("/");
    const input = await screen.findByRole("textbox", { name: /^Room name/ });
    fireEvent.change(input, { target: { value: "x".repeat(61) } });
    fireEvent.click(screen.getByRole("button", { name: "Create the room" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(NAME_REFUSED);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);
    expect(document.activeElement).toBe(input);
    expect(calls).not.toContain("POST /api/rooms");
    expect(input.getAttribute("maxlength")).toBe("240");
  });

  it("says why a room could not be created, keeps the form and the focus", async () => {
    serve({
      "GET /api/auth/get-session": () => json({ user: { id: "u1", name: "" } }),
      "POST /api/rooms": () => json({ code: "bad_room_name" }, 400),
    });
    await renderAt("/");
    const input = await screen.findByRole("textbox", { name: /^Room name/ });
    fireEvent.change(input, { target: { value: "Sprint" } });
    const create = screen.getByRole("button", { name: "Create the room" });
    fireEvent.click(create);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(NAME_REFUSED);
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);
    expect(document.activeElement).toBe(input);
    expect(create).toHaveProperty("disabled", false);
    expect(create.getAttribute("aria-disabled")).toBeNull();
  });

  it("explains a refused origin as a setup problem, not as a room setting", async () => {
    serve({
      "GET /api/auth/get-session": () => json({ user: { id: "u1", name: "" } }),
      "POST /api/rooms": () => json({ code: "not_allowed" }, 403),
    });
    await renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "Create the room" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/check BASE_URL/);
  });

  it("shows a room without a name by its code, and copy falls back to the link", async () => {
    serve({ "GET /api/rooms/Abc1234567": () => json({ code: "Abc1234567", name: null }) });
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    await renderAt("/r/Abc1234567");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Room Abc1234567");
    fireEvent.click(screen.getByRole("button", { name: "Copy the link" }));
    const link = await screen.findByRole("textbox", { name: "Room link" });
    expect(link).toHaveProperty("value", `${window.location.origin}/r/Abc1234567`);
    expect(link).toHaveProperty("readOnly", true);
  });

  it("shows a not-found state for an unknown room, and a retry for other failures", async () => {
    serve({ "GET /api/rooms/Unknown123": () => json({ code: "room_not_found" }, 404) });
    await renderAt("/r/Unknown123");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Room not found");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    cleanup();
    const answers = [json({ code: "internal" }, 500), json({ code: "Abc1234567", name: "Back" })];
    serve({ "GET /api/rooms/Abc1234567": () => answers.shift() ?? json({}, 500) });
    await renderAt("/r/Abc1234567");
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Back" })).toBeDefined();
  });

  it("shows the rate-limit message for a limited header read, and Try again recovers", async () => {
    const answers = [
      json({ code: "rate_limited" }, 429),
      json({ code: "Abc1234567", name: "Back" }),
    ];
    serve({ "GET /api/rooms/Abc1234567": () => answers.shift() ?? json({}, 500) });
    await renderAt("/r/Abc1234567");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many attempts. Wait a moment, then try again.",
    );
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Room Abc1234567");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Back" })).toBeDefined();
  });

  it("speaks French and German", async () => {
    serve({ "GET /api/rooms/Abc1234567": () => json({ code: "Abc1234567", name: null }) });
    await renderAt("/r/Abc1234567", "fr");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Salle Abc1234567");
    cleanup();
    await renderAt("/", "de");
    expect(await screen.findByRole("heading", { name: "Raum erstellen" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Raum erstellen" })).toBeDefined();
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
