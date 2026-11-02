import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIdentityStore } from "../stores/identity-store.ts";
import { fetchSession, IdentityError, signOut, startSignIn } from "./identity.ts";
import { readSignInError, returnPath, signInProviders, takeSignInError } from "./sign-in.ts";
import { SignInRow } from "./sign-in-row.tsx";

function meta(content?: string) {
  document.head.querySelector('meta[name="pp-sign-in"]')?.remove();
  if (content === undefined) return;
  const tag = document.createElement("meta");
  tag.name = "pp-sign-in";
  tag.content = content;
  document.head.append(tag);
}

const answer = (body: unknown, status = 200) => Response.json(body, { status });
const asGuest = () => useIdentityStore.getState().setIdentity({ userId: "u1", name: "Ada" });
const asAccount = () =>
  useIdentityStore.getState().setIdentity({
    userId: "u1",
    name: "Ada",
    email: "ada@example.com",
    provider: "google",
  });

const assign = vi.fn();
const reload = vi.fn();

beforeEach(() => {
  useIdentityStore.getState().reset();
  vi.stubGlobal("location", {
    ...window.location,
    href: "http://localhost/r/AbCdEf2345",
    pathname: "/r/AbCdEf2345",
    assign,
    reload,
  });
});

afterEach(() => {
  cleanup();
  meta();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  assign.mockReset();
  reload.mockReset();
});

describe("signInProviders", () => {
  it("names nothing without the server's tag", () => {
    expect(signInProviders()).toEqual([]);
  });

  it("lists what the tag names, in its own order, and only what it knows", () => {
    meta("microsoft github google");
    expect(signInProviders()).toEqual(["google", "microsoft"]);
  });
});

describe("returnPath", () => {
  it("is the path, without a trailing slash", () => {
    expect(returnPath()).toBe("/r/AbCdEf2345");
    vi.stubGlobal("location", { pathname: "/" });
    expect(returnPath()).toBe("/");
    vi.stubGlobal("location", { pathname: "/r/AbCdEf2345/" });
    expect(returnPath()).toBe("/r/AbCdEf2345");
  });
});

describe("a failed sign-in's code", () => {
  function arrive(search: string) {
    vi.stubGlobal("location", { href: `http://localhost/r/AbCdEf2345${search}` });
    return vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
  }

  it("is taken out of the address and given once", () => {
    const replace = arrive("?sign_in_error=cancelled&keep=1");
    readSignInError();
    expect(String(replace.mock.calls[0]?.[2])).toBe("http://localhost/r/AbCdEf2345?keep=1");
    expect(takeSignInError()).toBe("cancelled");
    expect(takeSignInError()).toBeNull();
  });

  it("is a plain failure when this version does not know it", () => {
    arrive("?sign_in_error=%3Cscript%3E");
    readSignInError();
    expect(takeSignInError()).toBe("failed");
  });

  it("leaves an address without one alone", () => {
    const replace = arrive("");
    readSignInError();
    expect(replace).not.toHaveBeenCalled();
    expect(takeSignInError()).toBeNull();
  });
});

describe("the calls", () => {
  it("starts a sign-in with the path to return to, and answers the provider's address", async () => {
    const fetcher = vi.fn(async () => answer({ url: "https://accounts.google.com/x" }));
    vi.stubGlobal("fetch", fetcher);
    expect(await startSignIn("google")).toBe("https://accounts.google.com/x");
    expect(fetcher).toHaveBeenCalledWith("/api/auth/sign-in/social", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", returnTo: "/r/AbCdEf2345" }),
    });
  });

  it("rejects with the server's code", async () => {
    vi.stubGlobal("fetch", async () => answer({ code: "rate_limited" }, 429));
    await expect(startSignIn("google")).rejects.toThrow(IdentityError);
    await expect(signOut()).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("gives the address of an account, and never a guest's placeholder", async () => {
    vi.stubGlobal("fetch", async () =>
      answer({ user: { id: "u1", name: "Ada", email: "ada@example.com", isAnonymous: false } }),
    );
    expect((await fetchSession())?.email).toBe("ada@example.com");
    vi.stubGlobal("fetch", async () =>
      answer({ user: { id: "u1", name: "", email: "temp@anonymous.invalid", isAnonymous: true } }),
    );
    expect((await fetchSession())?.email).toBeUndefined();
  });

  it("gives an account's provider when this version knows it", async () => {
    const session = (provider: string) => async () =>
      answer({ user: { id: "u1", name: "Ada", email: "a@b.c", isAnonymous: false, provider } });
    vi.stubGlobal("fetch", session("microsoft"));
    expect((await fetchSession())?.provider).toBe("microsoft");
    vi.stubGlobal("fetch", session("github"));
    expect((await fetchSession())?.provider).toBeUndefined();
  });
});

describe("SignInRow", () => {
  it("shows nothing on an install without keys", () => {
    asGuest();
    const { container } = render(<SignInRow />);
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing until it is known who this is", () => {
    meta("google");
    const { container } = render(<SignInRow />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a button per provider of this install, and sends the person there", async () => {
    meta("google microsoft");
    asGuest();
    vi.stubGlobal("fetch", async () => answer({ url: "https://accounts.google.com/x" }));
    render(<SignInRow />);
    expect(screen.getByRole("button", { name: "Sign in with Microsoft" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/x"));
  });

  it("shows only the provider it has", () => {
    meta("microsoft");
    asGuest();
    render(<SignInRow />);
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in with Microsoft" })).toBeTruthy();
  });

  it("says what went wrong, stays where it is, and can try again", async () => {
    meta("google");
    asGuest();
    vi.stubGlobal("fetch", async () => answer({ code: "rate_limited" }, 429));
    render(<SignInRow />);
    const button = screen.getByRole("button", { name: "Sign in with Google" });
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("shows the account instead of the buttons, even if the keys have gone", () => {
    asAccount();
    render(<SignInRow />);
    expect(screen.getByText("Signed in with Google")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull();
  });

  it("never shows the address unless the page asks: a room may be on a shared screen", () => {
    asAccount();
    const { container } = render(<SignInRow />);
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(container.innerHTML).not.toContain("ada@example.com");
  });

  it("shows the address where the page asks for it", () => {
    asAccount();
    render(<SignInRow showAddress />);
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.queryByText("Ada")).toBeNull();
  });

  it("names the provider alone for someone with no name yet", () => {
    useIdentityStore.getState().setIdentity({
      userId: "u1",
      name: null,
      email: "ada@example.com",
      provider: "microsoft",
    });
    const { container } = render(<SignInRow />);
    expect(screen.getByText("Signed in with Microsoft")).toBeTruthy();
    expect(container.querySelector("[data-account]")).toBeNull();
    expect(container.innerHTML).not.toContain("ada@example.com");
  });

  it("falls back to the name when this version does not know the provider", () => {
    useIdentityStore.getState().setIdentity({ userId: "u1", name: "Ada", email: "a@b.c" });
    render(<SignInRow />);
    expect(screen.getByText("Signed in as")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("signs out, then reloads this page into a new guest", async () => {
    asAccount();
    const fetcher = vi.fn(async () => answer({ success: true }));
    vi.stubGlobal("fetch", fetcher);
    render(<SignInRow />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledWith("/api/auth/sign-out", expect.anything());
  });

  it("stays signed in and says so when signing out fails", async () => {
    asAccount();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    render(<SignInRow />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
