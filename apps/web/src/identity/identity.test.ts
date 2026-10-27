import { afterEach, describe, expect, it, vi } from "vitest";
import { useIdentityStore } from "../stores/identity-store.ts";
import { ensureIdentity, IdentityError, setDisplayName } from "./identity.ts";

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stubs `fetch` with one handler per path and records every call. */
function serve(routes: Record<string, Route>) {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ path: input, init });
      const route = routes[input];
      if (!route) throw new TypeError("Failed to fetch");
      return route(init);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  useIdentityStore.getState().reset();
});

describe("ensureIdentity", () => {
  it("keeps the session's user when there is one, without signing in", async () => {
    const calls = serve({
      "/api/auth/get-session": () => json({ session: {}, user: { id: "u1", name: "Ada" } }),
    });
    await expect(ensureIdentity()).resolves.toEqual({ userId: "u1", name: "Ada" });
    expect(calls.map((c) => c.path)).toEqual(["/api/auth/get-session"]);
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    expect(useIdentityStore.getState()).toMatchObject({
      status: "ready",
      userId: "u1",
      name: "Ada",
      error: null,
    });
  });

  it("signs in as a guest without a session; an empty name is no name yet", async () => {
    const calls = serve({
      "/api/auth/get-session": () => json(null),
      "/api/auth/sign-in/anonymous": () => json({ token: "t", user: { id: "g1", name: "" } }),
    });
    await expect(ensureIdentity()).resolves.toEqual({ userId: "g1", name: null });
    expect(calls.map((c) => c.path)).toEqual([
      "/api/auth/get-session",
      "/api/auth/sign-in/anonymous",
    ]);
    expect(calls[1]?.init).toMatchObject({ method: "POST", body: "{}" });
  });

  it("shares one request between concurrent calls and reuses the store's identity", async () => {
    const calls = serve({
      "/api/auth/get-session": () => json({ user: { id: "u1", name: "" } }),
    });
    const [a, b] = await Promise.all([ensureIdentity(), ensureIdentity()]);
    expect(a).toEqual(b);
    await ensureIdentity();
    expect(calls).toHaveLength(1);
    await ensureIdentity({ force: true });
    expect(calls).toHaveLength(2);
  });

  it("keeps the server's code when it fails, and network when the request never landed", async () => {
    serve({
      "/api/auth/get-session": () => json(null),
      "/api/auth/sign-in/anonymous": () => json({ code: "rate_limited" }, 429),
    });
    await expect(ensureIdentity()).rejects.toMatchObject({ code: "rate_limited" });
    expect(useIdentityStore.getState()).toMatchObject({ status: "error", error: "rate_limited" });

    serve({ "/api/auth/get-session": () => new Response("oops", { status: 502 }) });
    await expect(ensureIdentity()).rejects.toMatchObject({ code: "internal" });

    serve({});
    await expect(ensureIdentity()).rejects.toBeInstanceOf(IdentityError);
    expect(useIdentityStore.getState().error).toBe("network");
  });

  it("refuses a session answer without a user id", async () => {
    serve({ "/api/auth/get-session": () => json({ user: { id: "" } }) });
    await expect(ensureIdentity()).rejects.toMatchObject({ code: "internal" });
  });
});

describe("setDisplayName", () => {
  it("posts the name and keeps what the server stored", async () => {
    const calls = serve({
      "/api/auth/get-session": () => json({ user: { id: "u1", name: "" } }),
      "/api/me/name": () => json({ name: "Ada Lovelace" }),
    });
    await expect(setDisplayName("  Ada   Lovelace ")).resolves.toBe("Ada Lovelace");
    expect(calls[1]?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ name: "  Ada   Lovelace " }),
    });
    expect(useIdentityStore.getState().name).toBe("Ada Lovelace");
  });

  it("rejects with the server's code", async () => {
    serve({
      "/api/auth/get-session": () => json({ user: { id: "u1", name: "" } }),
      "/api/me/name": () => json({ code: "bad_name" }, 400),
    });
    await expect(setDisplayName("x".repeat(40))).rejects.toMatchObject({ code: "bad_name" });
    expect(useIdentityStore.getState().name).toBeNull();
  });

  it("rejects with network or internal when the answer is missing or malformed", async () => {
    serve({ "/api/auth/get-session": () => json({ user: { id: "u1", name: "" } }) });
    await expect(setDisplayName("Ada")).rejects.toMatchObject({ code: "network" });
    serve({
      "/api/auth/get-session": () => json({ user: { id: "u1", name: "" } }),
      "/api/me/name": () => json({}),
    });
    await expect(setDisplayName("Ada")).rejects.toMatchObject({ code: "internal" });
  });
});
