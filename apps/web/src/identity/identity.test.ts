import { afterEach, describe, expect, it, vi } from "vitest";
import { useIdentityStore } from "../stores/identity-store.ts";
import {
  COOKIES_BLOCKED,
  ensureIdentity,
  IdentityError,
  RETRY_CAP_MS,
  resetIdentityModule,
  retryDelay,
  setDisplayName,
} from "./identity.ts";

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

/**
 * A server whose session appears once a sign-in succeeded, as a browser that keeps the
 * cookie would see it. `user` is what the sign-in creates.
 */
function guestServer(signIn: Route = () => json({ user: { id: "g1", name: "" } })) {
  let signedIn = false;
  return serve({
    "/api/auth/get-session": () => json(signedIn ? { user: { id: "g1", name: "" } } : null),
    "/api/auth/sign-in/anonymous": async (init) => {
      const response = await signIn(init);
      if (response.ok) signedIn = true;
      return response;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetIdentityModule();
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

  it("signs in as a guest without a session and reads it back; an empty name is no name yet", async () => {
    const calls = guestServer();
    await expect(ensureIdentity()).resolves.toEqual({ userId: "g1", name: null });
    expect(calls.map((c) => c.path)).toEqual([
      "/api/auth/get-session",
      "/api/auth/sign-in/anonymous",
      "/api/auth/get-session",
    ]);
    expect(calls[1]?.init).toMatchObject({ method: "POST", body: "{}" });
  });

  it("reads the session another tab created when the server answers not_allowed", async () => {
    let otherTab = false;
    serve({
      "/api/auth/get-session": () => json(otherTab ? { user: { id: "t1", name: "" } } : null),
      "/api/auth/sign-in/anonymous": () => {
        otherTab = true;
        return json({ code: "not_allowed" }, 400);
      },
    });
    await expect(ensureIdentity()).resolves.toEqual({ userId: "t1", name: null });
    expect(useIdentityStore.getState()).toMatchObject({ status: "ready", userId: "t1" });
  });

  it("holds the identity lock while it bootstraps, when the browser has one", async () => {
    guestServer();
    const request = vi.fn((_name: string, task: () => Promise<unknown>) => task());
    vi.stubGlobal("navigator", { cookieEnabled: true, locks: { request } });
    await expect(ensureIdentity()).resolves.toMatchObject({ userId: "g1" });
    expect(request).toHaveBeenCalledWith("pp-identity", expect.any(Function));
  });

  it("reports cookies_blocked when the new guest's session does not stick, and stops creating guests", async () => {
    const calls = serve({
      "/api/auth/get-session": () => json(null),
      "/api/auth/sign-in/anonymous": () => json({ user: { id: "g1", name: "" } }),
    });
    await expect(ensureIdentity({ retry: true })).rejects.toMatchObject({ code: COOKIES_BLOCKED });
    expect(useIdentityStore.getState()).toMatchObject({ status: "error", error: COOKIES_BLOCKED });
    await expect(ensureIdentity({ force: true })).rejects.toMatchObject({ code: COOKIES_BLOCKED });
    expect(calls.filter((c) => c.path === "/api/auth/sign-in/anonymous")).toHaveLength(1);
  });

  it("creates no guest at all when the browser says cookies are off", async () => {
    const calls = guestServer();
    vi.stubGlobal("navigator", { cookieEnabled: false });
    await expect(ensureIdentity()).rejects.toMatchObject({ code: COOKIES_BLOCKED });
    expect(calls.map((c) => c.path)).toEqual(["/api/auth/get-session"]);
  });

  it("retries a temporary failure with backoff until the server is back", async () => {
    vi.useFakeTimers();
    let down = 2;
    const calls = serve({
      "/api/auth/get-session": () =>
        down-- > 0 ? new Response("Bad Gateway", { status: 502 }) : json({ user: { id: "u1" } }),
    });
    const identity = ensureIdentity({ retry: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(useIdentityStore.getState()).toMatchObject({ status: "retrying", error: "internal" });
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS);
    await expect(identity).resolves.toEqual({ userId: "u1", name: null });
    expect(calls).toHaveLength(3);
    expect(useIdentityStore.getState()).toMatchObject({ status: "ready", error: null });
  });

  it("waits at least the server's Retry-After", async () => {
    vi.useFakeTimers();
    let limited = true;
    const calls = guestServer(() => {
      if (!limited) return json({ user: { id: "g1", name: "" } });
      limited = false;
      return new Response(JSON.stringify({ code: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "40" },
      });
    });
    const identity = ensureIdentity({ retry: true });
    await vi.advanceTimersByTimeAsync(39_000);
    expect(calls.filter((c) => c.path.endsWith("/anonymous"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(identity).resolves.toMatchObject({ userId: "g1" });
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

  it("joins a running bootstrap and retries after it when asked to", async () => {
    vi.useFakeTimers();
    let down = 1;
    serve({
      "/api/auth/get-session": () =>
        down-- > 0 ? new Response("", { status: 503 }) : json({ user: { id: "u1" } }),
    });
    const plain = ensureIdentity();
    const retrying = ensureIdentity({ retry: true });
    await expect(plain).rejects.toMatchObject({ code: "internal" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(retrying).resolves.toMatchObject({ userId: "u1" });
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

describe("retryDelay", () => {
  it("doubles from 1 s up to 30 s, half fixed and half random, and honours Retry-After", () => {
    expect(retryDelay(0, undefined, () => 0)).toBe(500);
    expect(retryDelay(0, undefined, () => 1)).toBe(1000);
    expect(retryDelay(3, undefined, () => 0.5)).toBe(6000);
    expect(retryDelay(10, undefined, () => 1)).toBe(RETRY_CAP_MS);
    expect(retryDelay(1000, undefined, () => 0)).toBe(RETRY_CAP_MS / 2);
    expect(retryDelay(0, 40, () => 0)).toBe(40_000);
    expect(retryDelay(0, 86_400, () => 0)).toBe(300_000);
  });
});
