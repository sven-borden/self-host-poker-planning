import { afterEach, describe, expect, it, vi } from "vitest";
import { resetIdentityModule } from "../identity/identity.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import { createRoom, fetchRoomHeader, RoomApiError } from "./api.ts";

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stubs `fetch` with one handler per `METHOD path` and records every call. */
function serve(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${input}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const route = routes[key];
      if (!route) throw new TypeError("Failed to fetch");
      return route(init);
    }),
  );
  return calls;
}

const SESSION = { "GET /api/auth/get-session": () => json({ user: { id: "u1", name: "" } }) };

afterEach(() => {
  vi.unstubAllGlobals();
  resetIdentityModule();
  useIdentityStore.getState().reset();
});

describe("createRoom", () => {
  it("makes sure of the identity, then posts the name and the deck", async () => {
    const calls = serve({ ...SESSION, "POST /api/rooms": () => json({ code: "Abc1234567" }, 201) });
    expect(await createRoom({ name: " Sprint 42 ", deck: "tshirt" })).toBe("Abc1234567");
    expect(calls.map((call) => call.key)).toEqual(["GET /api/auth/get-session", "POST /api/rooms"]);
    expect(calls[1]?.body).toEqual({ name: " Sprint 42 ", deck: "tshirt" });
  });

  it("leaves out a name that is only whitespace", async () => {
    const calls = serve({ ...SESSION, "POST /api/rooms": () => json({ code: "Abc1234567" }, 201) });
    await createRoom({ name: "  \t", deck: "fib" });
    expect(calls[1]?.body).toEqual({ deck: "fib" });
  });

  it("renews a session that ended, once", async () => {
    let answers = [json({ code: "unauthenticated" }, 401), json({ code: "Abc1234567" }, 201)];
    const calls = serve({ ...SESSION, "POST /api/rooms": () => answers.shift() ?? json({}, 500) });
    expect(await createRoom({ name: "", deck: "fib" })).toBe("Abc1234567");
    expect(calls.filter((call) => call.key === "GET /api/auth/get-session")).toHaveLength(2);
    answers = [json({ code: "unauthenticated" }, 401), json({ code: "unauthenticated" }, 401)];
    await expect(createRoom({ name: "", deck: "fib" })).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("rejects with the server's code, internal without one, network when offline", async () => {
    serve({ ...SESSION, "POST /api/rooms": () => json({ code: "rate_limited" }, 429) });
    await expect(createRoom({ name: "", deck: "fib" })).rejects.toEqual(
      new RoomApiError("rate_limited"),
    );
    serve({ ...SESSION, "POST /api/rooms": () => new Response("oops", { status: 502 }) });
    await expect(createRoom({ name: "", deck: "fib" })).rejects.toMatchObject({ code: "internal" });
    serve({ ...SESSION, "POST /api/rooms": () => json({ nope: true }, 201) });
    await expect(createRoom({ name: "", deck: "fib" })).rejects.toMatchObject({ code: "internal" });
    serve(SESSION);
    await expect(createRoom({ name: "", deck: "fib" })).rejects.toMatchObject({ code: "network" });
  });
});

describe("fetchRoomHeader", () => {
  it("reads a room's code and name", async () => {
    serve({ "GET /api/rooms/Abc1234567": () => json({ code: "Abc1234567", name: "Sprint" }) });
    expect(await fetchRoomHeader("Abc1234567")).toEqual({ code: "Abc1234567", name: "Sprint" });
    serve({ "GET /api/rooms/Abc1234567": () => json({ code: "Abc1234567", name: null }) });
    expect(await fetchRoomHeader("Abc1234567")).toEqual({ code: "Abc1234567", name: null });
  });

  it("rejects with room_not_found, and escapes the code in the path", async () => {
    serve({ "GET /api/rooms/a%2Fb": () => json({ code: "room_not_found" }, 404) });
    await expect(fetchRoomHeader("a/b")).rejects.toMatchObject({ code: "room_not_found" });
    serve({ "GET /api/rooms/x": () => json({}, 200) });
    await expect(fetchRoomHeader("x")).rejects.toMatchObject({ code: "internal" });
  });
});
