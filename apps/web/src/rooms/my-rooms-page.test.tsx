import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.tsx";
import { changeLanguage } from "../i18n/i18n.ts";
import type { Language } from "../i18n/language.ts";
import { resetIdentityModule } from "../identity/identity.ts";
import { createAppRouter } from "../router.ts";
import { settleToasts } from "../settle-toasts.ts";
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
  keeper: true,
  seated: false,
  rounds: 12,
  lastActiveAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
};
const ROOM_B = {
  ...ROOM_A,
  id: "22222222-2222-4222-8222-222222222222",
  code: "bbbbbbbbbb",
  name: null,
  owned: false,
  keeper: false,
  seated: true,
  rounds: 1,
};
const page = (rooms: unknown[], extra: object = {}) => ({ rooms, retentionDays: 90, ...extra });
const CLAIMED = { ...ROOM_B, owned: true };

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

// Sonner's removal timer must not outlive the file (settle-toasts.ts).
afterAll(settleToasts);

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

  it("takes a person whose session ended for what they are now, with a way back in", async () => {
    asAccount();
    let sessions = 0;
    serve({
      "GET /api/my-rooms": () => json({ code: "unauthenticated" }, 401),
      // No session, then the guest this page's bootstrap creates, as on any page.
      "GET /api/auth/get-session": () =>
        json(sessions++ === 0 ? null : { user: { id: "guest", isAnonymous: true } }),
      "POST /api/auth/sign-in/anonymous": () => json({ user: { id: "guest" } }),
    });
    await renderRooms();
    await screen.findByText(/Sign in to see the rooms you own/);
    expect(named("Sign in with Google")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(document.querySelector("[data-my-rooms-link]")).toBeNull();
    expect(useIdentityStore.getState().email).toBeNull();
  });

  it("says what it heard when the session cannot be read either, and asks once a load", async () => {
    asAccount();
    const calls = serve({
      "GET /api/my-rooms": () => json({ code: "unauthenticated" }, 401),
      "GET /api/auth/get-session": () => json({ code: "internal" }, 500),
    });
    await renderRooms();
    await screen.findByRole("alert");
    expect(named("Try again")).toBeTruthy();
    expect(calls.filter((call) => call === "GET /api/my-rooms")).toHaveLength(1);
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
    expect(screen.queryByRole("button", { name: "Leave this room: Sprint planning" })).toBeNull();
    expect(named("Leave this room: Room bbbbbbbbbb")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete Room bbbbbbbbbb" })).toBeNull();
  });

  it("says plainly who is on it, and how long a room stays", async () => {
    asAccount();
    serve({ "GET /api/my-rooms": () => json(page([])) });
    await renderRooms();
    await screen.findByText(/where you hold a seat now/);
    expect(screen.getByText(/goes from this list/)).toBeTruthy();
    expect(screen.getByText(/can go after 90 days without activity/)).toBeTruthy();
  });

  it("offers rename and leave for a role taken by claim, not delete, and says why", async () => {
    asAccount();
    serve({
      "GET /api/my-rooms": () => json(page([{ ...ROOM_A, keeper: false, seated: true }])),
    });
    await renderRooms();
    await screen.findByText("You are the product owner");
    expect(screen.getByText(/does not carry that right/)).toBeTruthy();
    expect(named("Rename Sprint planning")).toBeTruthy();
    expect(named("Leave this room: Sprint planning")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete Sprint planning" })).toBeNull();
  });

  it("tells a keeper who lost the role how to get it back, and offers no delete", async () => {
    asAccount();
    serve({
      "GET /api/my-rooms": () => json(page([{ ...ROOM_A, owned: false, seated: true }])),
    });
    await renderRooms();
    await screen.findByText("Your room, with another product owner");
    expect(screen.getByText(/Get the role back in the room/)).toBeTruthy();
    expect(named("Leave this room: Sprint planning")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete Sprint planning" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename Sprint planning" })).toBeNull();
  });

  it("keeps a keeper's room with no seat as a link alone", async () => {
    asAccount();
    serve({ "GET /api/my-rooms": () => json(page([{ ...ROOM_A, owned: false }])) });
    await renderRooms();
    await screen.findByRole("link", { name: "Sprint planning" });
    expect(document.querySelectorAll("[data-my-room] button")).toHaveLength(0);
  });

  it("announces a result in a region that was there before it, and that stays through a reload", async () => {
    asAccount();
    let reads = 0;
    serve({
      "GET /api/my-rooms": () => json(page(reads++ === 0 ? [ROOM_A] : [])),
      [`DELETE /api/my-rooms/${ROOM_A.id}`]: () => json({ code: "room_not_found" }, 404),
    });
    await renderRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Sprint planning" }));
    const region = document.querySelector("[data-my-rooms-notice]");
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toBe("");
    fireEvent.click(await screen.findByRole("button", { name: "Delete this room" }));
    await screen.findByText("No rooms yet");
    expect(document.querySelector("[data-my-rooms-notice]")).toBe(region);
    expect(region?.textContent).toBe("That room is no longer there.");
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
        return json(
          page([reads === 1 ? ROOM_A : { ...ROOM_A, owned: false, keeper: false, seated: true }]),
        );
      },
      [`PATCH /api/my-rooms/${ROOM_A.id}`]: () => json({ code: "not_owner" }, 403),
    });
    await renderRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Sprint planning" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Leave this room: Sprint planning" });
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

  it("reads the list again when the server says the right to delete is someone else's", async () => {
    asAccount();
    let reads = 0;
    serve({
      "GET /api/my-rooms": () =>
        json(page([reads++ === 0 ? ROOM_A : { ...ROOM_A, keeper: false, seated: true }])),
      [`DELETE /api/my-rooms/${ROOM_A.id}`]: () => json({ code: "not_keeper" }, 403),
    });
    await renderRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Sprint planning" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete this room" }));
    await screen.findByText("You are the product owner");
    expect(screen.getByText("You cannot delete this room: that right is not yours.")).toBeTruthy();
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Leave this room: Room bbbbbbbbbb" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Leave this room" }));
    await screen.findByText("You left the room.");
    expect(rowCount()).toBe(0);
    expect(calls).toContain(`POST /api/my-rooms/${ROOM_B.id}/leave`);
  });

  it("keeps a room that is still the person's, without the seat", async () => {
    asAccount();
    serve({
      "GET /api/my-rooms": () => json(page([{ ...ROOM_A, owned: false, seated: true }])),
      [`POST /api/my-rooms/${ROOM_A.id}/leave`]: noContent,
    });
    await renderRooms();
    fireEvent.click(
      await screen.findByRole("button", { name: "Leave this room: Sprint planning" }),
    );
    await screen.findByText(/stays on this list/);
    fireEvent.click(await screen.findByRole("button", { name: "Leave this room" }));
    await screen.findByText("You left the room.");
    expect(rowCount()).toBe(1);
    expect(screen.queryByRole("button", { name: "Leave this room: Sprint planning" })).toBeNull();
  });
});

describe("a room nobody holds (#51)", () => {
  it("says what a room with no keeper comes to, and that one with a keeper has one", async () => {
    asAccount();
    serve({
      "GET /api/my-rooms": () => json(page([{ ...CLAIMED, noKeeper: true }], { retentionDays: 1 })),
    });
    await renderRooms();
    expect(await screen.findByText(/Nobody can delete it/)).toBeTruthy();
    expect(screen.getByText(/goes after 1 day without activity/)).toBeTruthy();
    expect(screen.queryByText(/the person it belongs to/)).toBeNull();
    cleanup();
    serve({ "GET /api/my-rooms": () => json(page([{ ...CLAIMED, noKeeper: false }])) });
    await renderRooms();
    expect(await screen.findByText(/the person it belongs to/)).toBeTruthy();
    expect(screen.queryByText(/Nobody can delete it/)).toBeNull();
  });
});

describe("rooms a rule hides (#50)", () => {
  it("says that a recent sign-in brings the others back", async () => {
    asAccount();
    serve({ "GET /api/my-rooms": () => json(page([ROOM_A], { signInAgain: true })) });
    await renderRooms();
    await waitFor(() =>
      expect(document.querySelector("[data-my-rooms-sign-in-again]")?.textContent).toContain(
        "ask for a recent sign-in",
      ),
    );
  });
});
