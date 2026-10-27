import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.tsx";
import { ErrorPage } from "./components/shell/error-page.tsx";
import { changeLanguage } from "./i18n/i18n.ts";
import type { Language } from "./i18n/language.ts";
import { resetIdentityModule } from "./identity/identity.ts";
import { createAppRouter } from "./router.ts";
import { useIdentityStore } from "./stores/identity-store.ts";
import { useRoomStore } from "./stores/room-store.ts";

// The pages of #24 in a real router: the landing page, "Join with a code", the missing
// room and the generic error page, each in English, French and German.

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

const NB = "\u{202F}";
const CODE = "Abc1234567";
const UNKNOWN = "Unknown123";
const NOT_FOUND = () => json({ code: "room_not_found", retentionDays: 90 }, 404);

beforeEach(() => {
  document.title = "Poker Planning";
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetIdentityModule();
  useIdentityStore.getState().reset();
  window.localStorage.clear();
  await act(() => changeLanguage("en"));
});

describe("the landing page", () => {
  const COPY = {
    en: {
      how: "How it works",
      join: "Join with a code",
      steps: ["Create a room", "Share the link", "Vote", "Reveal"],
    },
    fr: {
      how: "Comment ça marche",
      join: "Rejoindre avec un code",
      steps: ["Créez une salle", "Partagez le lien", "Votez", "Révélez"],
    },
    de: {
      how: "So funktioniert es",
      join: "Mit Code beitreten",
      steps: ["Raum erstellen", "Link teilen", "Abstimmen", "Aufdecken"],
    },
  } as const;

  for (const language of ["en", "fr", "de"] as const) {
    it(`explains a round in four steps, next to both ways in (${language})`, async () => {
      await renderAt("/", language);
      const how = await screen.findByRole("heading", { level: 2, name: COPY[language].how });
      const list = how.parentElement?.querySelector("ol");
      const items = [...(list?.querySelectorAll("li") ?? [])];
      expect(items.map((item) => item.querySelector("p")?.textContent)).toEqual(
        COPY[language].steps,
      );
      expect(screen.getByRole("heading", { level: 2, name: COPY[language].join })).toBeDefined();
      expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(3);
      expect(document.title).toBe("Poker Planning");
    });
  }
});

describe("join with a code", () => {
  async function join(typed: string) {
    const field = await screen.findByRole("textbox", { name: "Room code or link" });
    fireEvent.change(field, { target: { value: typed } });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    return field;
  }

  it("offers no history of earlier codes", async () => {
    await renderAt("/");
    const field = await screen.findByRole("textbox", { name: "Room code or link" });
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("name")).toBeNull();
    expect(field.getAttribute("list")).toBeNull();
  });

  it("asks for a code when the field is empty, and keeps the focus in it", async () => {
    const calls = serve({});
    const router = await renderAt("/");
    const field = await join("   ");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Enter a room code, or paste the room link.");
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toContain(alert.id);
    expect(router.state.location.pathname).toBe("/");
    expect(calls.filter((call) => call.includes("/api/rooms"))).toEqual([]);
  });

  it("refuses a malformed code in the browser, without leaving the page", async () => {
    const calls = serve({});
    const router = await renderAt("/");
    for (const bad of ["abc", "0OIl000000", "https://poker.example.com/r/abc"]) {
      await join(bad);
      expect((await screen.findByRole("alert")).textContent, bad).toBe(
        "This is not a room code. A code has 10 letters and digits, never 0, O, I or l. Check it, or paste the whole link.",
      );
      expect(router.state.location.pathname).toBe("/");
    }
    expect(calls.filter((call) => call.includes("/api/rooms"))).toEqual([]);
  });

  it("opens the room for a code with spaces or a pasted link", async () => {
    for (const typed of [
      "Abc12 34567",
      ` ${CODE} `,
      `https://poker.example.com/r/${CODE}`,
      `${window.location.origin}/r/${CODE}?from=chat`,
    ]) {
      serve({ [`GET /api/rooms/${CODE}`]: () => json({ code: CODE, name: "Sprint 42" }) });
      const router = await renderAt("/");
      await join(typed);
      expect(await screen.findByRole("heading", { level: 1, name: "Sprint 42" })).toBeDefined();
      expect(router.state.location.pathname, typed).toBe(`/r/${CODE}`);
      cleanup();
    }
  });
});

describe("the missing room", () => {
  const COPY = {
    en: {
      title: "Room not found",
      expired:
        "The room was deleted: rooms on this server are removed after 90 days without activity.",
      tab: "Room not found · Poker Planning",
      another: "Try another code",
      create: "Create a new room",
    },
    fr: {
      title: "Salle introuvable",
      expired: `La salle a été supprimée${NB}: sur ce serveur, une salle est effacée après 90 jours sans activité.`,
      tab: "Salle introuvable · Poker Planning",
      another: "Essayer un autre code",
      create: "Créer une nouvelle salle",
    },
    de: {
      title: "Raum nicht gefunden",
      expired:
        "Der Raum wurde gelöscht: Auf diesem Server wird ein Raum nach 90 Tagen ohne Aktivität entfernt.",
      tab: "Raum nicht gefunden · Poker Planning",
      another: "Anderen Code versuchen",
      create: "Neuen Raum erstellen",
    },
  } as const;

  for (const language of ["en", "fr", "de"] as const) {
    it(`says what may have happened and offers a way back, never the code (${language})`, async () => {
      serve({ [`GET /api/rooms/${UNKNOWN}`]: NOT_FOUND });
      await renderAt(`/r/${UNKNOWN}`, language);
      const copy = COPY[language];
      expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(copy.title);
      // Keep French narrow no-break spaces as they are.
      expect(screen.getByText(copy.expired, { normalizer: (text) => text })).toBeDefined();
      expect(screen.getByRole("heading", { level: 2, name: copy.another })).toBeDefined();
      expect(screen.getByRole("link", { name: copy.create }).getAttribute("href")).toBe("/");
      expect(document.title).toBe(copy.tab);
      // The code is a bearer capability: not in the page, not in the tab.
      expect(document.body.textContent).not.toContain(UNKNOWN);
      expect(document.title).not.toContain(UNKNOWN);
      // No retry: nothing will make the room appear.
      expect(screen.queryByRole("button", { name: /Try again|Réessayer|Erneut/ })).toBeNull();
    });
  }

  it("speaks of a long time when the server does not state its retention", async () => {
    serve({ [`GET /api/rooms/${UNKNOWN}`]: () => json({ code: "room_not_found" }, 404) });
    await renderAt(`/r/${UNKNOWN}`);
    await screen.findByRole("heading", { level: 1, name: "Room not found" });
    expect(
      screen.getByText(
        "The room was deleted: rooms on this server are removed after a long time without activity.",
      ),
    ).toBeDefined();
  });

  it("says one day in the singular", async () => {
    serve({
      [`GET /api/rooms/${UNKNOWN}`]: () => json({ code: "room_not_found", retentionDays: 1 }, 404),
    });
    await renderAt(`/r/${UNKNOWN}`);
    expect(await screen.findByText(/after 1 day without activity\.$/)).toBeDefined();
  });

  it("tries another code from the page, and gives the tab its title back", async () => {
    serve({
      [`GET /api/rooms/${UNKNOWN}`]: NOT_FOUND,
      [`GET /api/rooms/${CODE}`]: () => json({ code: CODE, name: "Found it" }),
    });
    const router = await renderAt(`/r/${UNKNOWN}`);
    const field = await screen.findByRole("textbox", { name: "Room code or link" });
    fireEvent.change(field, { target: { value: CODE } });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Found it" })).toBeDefined();
    expect(router.state.location.pathname).toBe(`/r/${CODE}`);
    expect(document.title).toBe("Poker Planning");
  });
  it("replaces the room with the same page when the socket's enter finds no room", async () => {
    serve({ [`GET /api/rooms/${CODE}`]: () => json({ code: CODE, name: "Gone soon" }) });
    await renderAt(`/r/${CODE}`);
    await screen.findByRole("heading", { level: 1, name: "Gone soon" });
    // What openRoom does with a refused enter: the room was purged after the header loaded.
    act(() => useRoomStore.getState().fail("room_not_found"));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Room not found");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Try another code" })).toBeDefined();
    expect(document.body.textContent).not.toContain(CODE);
    expect(document.body.textContent).not.toContain("Gone soon");
    expect(document.title).toBe("Room not found · Poker Planning");
  });
});

describe("the generic error page", () => {
  const COPY = {
    en: { title: "Something went wrong", reload: "Reload the page", home: "Back to the home page" },
    fr: {
      title: "Une erreur s’est produite",
      reload: "Recharger la page",
      home: "Retour à l’accueil",
    },
    de: {
      title: "Etwas ist schiefgelaufen",
      reload: "Seite neu laden",
      home: "Zurück zur Startseite",
    },
  } as const;

  /** A router whose only page throws, with the app's default error component. */
  async function renderBroken(language: Language) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = createRootRoute();
    const broken = createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => {
        throw new Error(`secret detail for room ${CODE}`);
      },
    });
    const router = createRouter({
      routeTree: root.addChildren([broken]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      defaultErrorComponent: createAppRouter().options.defaultErrorComponent,
    });
    await act(async () => {
      await changeLanguage(language);
      render(<RouterProvider router={router} />);
      await router.load();
    });
  }

  for (const language of ["en", "fr", "de"] as const) {
    it(`replaces a failed page with a calm message, a reload and a link home (${language})`, async () => {
      await renderBroken(language);
      const copy = COPY[language];
      expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(copy.title);
      expect(screen.getByRole("button", { name: copy.reload })).toBeDefined();
      expect(screen.getByRole("link", { name: copy.home }).getAttribute("href")).toBe("/");
      expect(document.title).toBe(`${copy.title} · Poker Planning`);
      // No error details on screen: no message, no stack, no room code.
      expect(document.body.textContent).not.toMatch(/secret|Error|Abc1234567|\.tsx?:\d/);
    });
  }

  it("reloads the page from its button", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<ErrorPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reload the page" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("is the app router's default for every page", () => {
    expect(createAppRouter().options.defaultErrorComponent).toBe(ErrorPage);
  });
});

describe("the not-found page for an unknown address", () => {
  it("names the tab after the page", async () => {
    await renderAt("/nowhere/at/all");
    await waitFor(() => expect(document.title).toBe("Page not found · Poker Planning"));
  });
});
