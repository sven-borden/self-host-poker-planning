import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.tsx";
import { changeLanguage } from "../i18n/i18n.ts";
import type { Language } from "../i18n/language.ts";
import { resetIdentityModule } from "../identity/identity.ts";
import { createAppRouter } from "../router.ts";
import { useIdentityStore } from "../stores/identity-store.ts";

// "My rooms" (#49) in a real router: who sees what, the list's states, and what each press asks
// of the server. The server's own refusals are in `apps/server/src/my-rooms.db.test.ts`.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noContent = () => new Response(null, { status: 204 });

const ROOM_A = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "aaaaaaaaaa",
  name: "Sprint planning",
  owned: true,
  rounds: 12,
  lastActiveAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
};
const ROOM_B = {
  ...ROOM_A,
  id: "22222222-2222-4222-8222-222222222222",
  code: "bbbbbbbbbb",
  name: null,
  owned: false,
  rounds: 1,
};
const page = (rooms: unknown[], extra: object = {}) => ({ rooms, retentionDays: 90, ...extra });

type Route = (init?: RequestInit) => Response;

/** Stubs `fetch` with one answer per `METHOD path`; anything else fails like offline. */
function serve(routes: Record<string, Route>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${input}`;
      calls.push(key);
      const route = routes[key];
      if (!route) throw new TypeError("Failed to fetch");
      return route(init);
    }),
  );
  return calls;
}

function providers(content: string | null) {
  document.head.querySelector('meta[name="pp-sign-in"]')?.remove();
  if (content === null) return;
  const tag = document.createElement("meta");
  tag.name = "pp-sign-in";
  tag.content = content;
  document.head.append(tag);
}

const asGuest = () => useIdentityStore.getState().setIdentity({ userId: "guest", name: null });
const asAccount = () =>
  useIdentityStore.getState().setIdentity({
    userId: "account",
    name: "Ada",
    email: "ada@example.com",
    provider: "google",
  });

async function renderRooms(language: Language = "en") {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/rooms"] }));
  await act(async () => {
    await changeLanguage(language);
    render(<App router={router} />);
    await router.load();
  });
  return router;
}

const named = (name: string) => screen.getByRole("button", { name });
const rowCount = () => document.querySelectorAll("[data-my-room]").length;

beforeEach(() => {
  resetIdentityModule();
  useIdentityStore.getState().reset();
  providers("google");
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  providers(null);
  await changeLanguage("en");
});

describe("who sees what", () => {
  it("is an unknown page on an install without keys, and asks the server nothing", async () => {
    providers(null);
    asGuest();
    const calls = serve({});
    await renderRooms();
    await screen.findByRole("heading", { name: "Page not found" });
    expect(document.querySelector("[data-my-rooms]")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("offers a guest the sign-in, and asks the server nothing", async () => {
    asGuest();
    const calls = serve({});
    await renderRooms();
    await screen.findByRole("heading", { name: "My rooms" });
    expect(named("Sign in with Google")).toBeTruthy();
    expect(calls).toEqual([]);
    expect(document.title).toContain("My rooms");
  });

  it("says it is loading until it knows who this is", async () => {
    useIdentityStore.getState().setLoading();
    serve({});
    await renderRooms();
    await screen.findByRole("status");
    expect(screen.getByRole("status").textContent).toBe("Loading your rooms…");
  });

  it("shows a person whose session ended the sign-in, not an error", async () => {
    asAccount();
    serve({ "GET /api/my-rooms": () => json({ code: "unauthenticated" }, 401) });
    await renderRooms();
    await screen.findByText(/Sign in to see the rooms you own/);
  });
});

describe("the list", () => {
  it("shows each room's name, activity and rounds, with the owner's actions or a way to leave", async () => {
    asAccount();
    serve({ "GET /api/my-rooms": () => json(page([ROOM_A, ROOM_B])) });
    await renderRooms();

    const link = await screen.findByRole("link", { name: "Sprint planning" });
    expect(link.getAttribute("href")).toBe("/r/aaaaaaaaaa");
    expect(screen.getByRole("link", { name: "Room bbbbbbbbbb" })).toBeTruthy();
    expect(screen.getByText("You own this room")).toBeTruthy();
    expect(screen.getByText("You hold a seat")).toBeTruthy();
    expect(screen.getAllByText("Active 2 days ago")).toHaveLength(2);
    expect(screen.getByText("12 rounds")).toBeTruthy();
    expect(screen.getByText("1 round")).toBeTruthy();
    expect(named("Rename Sprint planning")).toBeTruthy();
    expect(named("Delete Sprint planning")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Leave Sprint planning" })).toBeNull();
    expect(named("Leave Room bbbbbbbbbb")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete Room bbbbbbbbbb" })).toBeNull();
  });

  it("says plainly who is on it, and how long a room stays", async () => {
    asAccount();
    serve({ "GET /api/my-rooms": () => json(page([])) });
    await renderRooms();
    await screen.findByText(/where you hold a seat now/);
    expect(screen.getByText(/goes from this list/)).toBeTruthy();
    expect(screen.getByText(/goes after 90 days without activity/)).toBeTruthy();
  });

  it("has words for no rooms at all", async () => {
    asAccount();
    serve({ "GET /api/my-rooms": () => json(page([])) });
    await renderRooms();
    await screen.findByText("No rooms yet");
    expect(screen.getByRole("link", { name: "Create a new room" })).toBeTruthy();
  });

  it("says when a load failed, and tries again", async () => {
    asAccount();
    let fail = true;
    serve({
      "GET /api/my-rooms": () => {
        if (fail) return json({ code: "internal" }, 500);
        return json(page([ROOM_A]));
      },
    });
    await renderRooms();
    await screen.findByRole("alert");
    fail = false;
    fireEvent.click(named("Try again"));
    await screen.findByRole("link", { name: "Sprint planning" });
  });

  it("says when rooms are still on their way, and looks again", async () => {
    asAccount();
    let moving = true;
    serve({ "GET /api/my-rooms": () => json(page([], moving ? { moving: true } : {})) });
    await renderRooms();
    await screen.findByText(/still on their way/);
    moving = false;
    fireEvent.click(named("Try again"));
    await waitFor(() => expect(screen.queryByText(/still on their way/)).toBeNull());
  });

  it("shows more rooms, after the page's last one", async () => {
    asAccount();
    const calls = serve({
      "GET /api/my-rooms": () => json(page([ROOM_A], { next: "1_x" })),
      "GET /api/my-rooms?after=1_x": () => json(page([ROOM_B])),
    });
    await renderRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Show more rooms" }));
    await waitFor(() => expect(rowCount()).toBe(2));
    expect(screen.queryByRole("button", { name: "Show more rooms" })).toBeNull();
    expect(calls).toContain("GET /api/my-rooms?after=1_x");
  });

  it("reads in French and German", async () => {
    asAccount();
    serve({ "GET /api/my-rooms": () => json(page([ROOM_A])) });
    await renderRooms("fr");
    await screen.findByRole("heading", { name: "Mes salles" });
    expect(screen.getByText("12 tours")).toBeTruthy();
    cleanup();
    await renderRooms("de");
    await screen.findByRole("heading", { name: "Meine Räume" });
    expect(screen.getByText("12 Runden")).toBeTruthy();
  });
});

describe("renaming", () => {
  it("sends the name, and shows what the server stored", async () => {
    asAccount();
    let sent: unknown;
    serve({
      "GET /api/my-rooms": () => json(page([ROOM_A])),
      [`PATCH /api/my-rooms/${ROOM_A.id}`]: (init) => {
        sent = JSON.parse(String(init?.body));
        return json({ name: "Retro" });
      },
    });
    await renderRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Sprint planning" }));
    const input = await screen.findByLabelText("Room name");
    expect((input as HTMLInputElement).value).toBe("Sprint planning");
    fireEvent.change(input, { target: { value: "  Retro " } });
    fireEvent.click(named("Save"));
    await screen.findByRole("link", { name: "Retro" });
    expect(sent).toEqual({ name: "  Retro " });
    expect(screen.getByText("Room renamed.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says what is wrong with a name, and stays open", async () => {
    asAccount();
    serve({
      "GET /api/my-rooms": () => json(page([ROOM_A])),
      [`PATCH /api/my-rooms/${ROOM_A.id}`]: () => json({ code: "bad_room_name" }, 400),
    });
    await renderRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Sprint planning" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("reads the list again for a person who lost the PO role", async () => {
    asAccount();
    let reads = 0;
    serve({
      "GET /api/my-rooms": () => {
        reads += 1;
        return json(page([reads === 1 ? ROOM_A : { ...ROOM_A, owned: false }]));
      },
      [`PATCH /api/my-rooms/${ROOM_A.id}`]: () => json({ code: "not_owner" }, 403),
    });
    await renderRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Sprint planning" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Leave Sprint planning" });
    expect(screen.getByText("Only the product owner can do that.")).toBeTruthy();
  });
});

describe("deleting", () => {
  it("asks first, with the room's name and what will go, and sends nothing until pressed", async () => {
    asAccount();
    const calls = serve({
      "GET /api/my-rooms": () => json(page([ROOM_A, ROOM_B])),
      [`DELETE /api/my-rooms/${ROOM_A.id}`]: noContent,
    });
    await renderRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Sprint planning" }));

    await screen.findByRole("heading", { name: "Delete Sprint planning?" });
    expect(screen.getByText(/its rounds, its history, its queue/)).toBeTruthy();
    expect(screen.getByText(/right now sees at once/)).toBeTruthy();
    fireEvent.click(named("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toEqual(["GET /api/my-rooms"]);

    fireEvent.click(named("Delete Sprint planning"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete this room" }));
    await waitFor(() => expect(rowCount()).toBe(1));
    expect(calls).toContain(`DELETE /api/my-rooms/${ROOM_A.id}`);
    expect(screen.getByText("Room deleted.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  });

  it("says when the room had gone already, and shows the list as it is", async () => {
    asAccount();
    let reads = 0;
    serve({
      "GET /api/my-rooms": () => json(page(reads++ === 0 ? [ROOM_A] : [])),
      [`DELETE /api/my-rooms/${ROOM_A.id}`]: () => json({ code: "room_not_found" }, 404),
    });
    await renderRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Sprint planning" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete this room" }));
    await screen.findByText("That room is no longer there.");
    await screen.findByText("No rooms yet");
  });

  it("keeps the dialog on a failure that can be tried again", async () => {
    asAccount();
    serve({
      "GET /api/my-rooms": () => json(page([ROOM_A])),
      [`DELETE /api/my-rooms/${ROOM_A.id}`]: () => json({ code: "rate_limited" }, 429),
    });
    await renderRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Sprint planning" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete this room" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(rowCount()).toBe(1);
  });
});

describe("leaving", () => {
  it("asks first, gives up the seat, and the room goes from the list", async () => {
    asAccount();
    const calls = serve({
      "GET /api/my-rooms": () => json(page([ROOM_B])),
      [`POST /api/my-rooms/${ROOM_B.id}/leave`]: noContent,
    });
    await renderRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Leave Room bbbbbbbbbb" }));
    fireEvent.click(await screen.findByRole("button", { name: "Leave this room" }));
    await screen.findByText("You left the room.");
    expect(rowCount()).toBe(0);
    expect(calls).toContain(`POST /api/my-rooms/${ROOM_B.id}/leave`);
  });
});
