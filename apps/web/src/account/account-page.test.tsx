import { ACCOUNT_DELETE_WORDS } from "@pp/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.tsx";
import { changeLanguage } from "../i18n/i18n.ts";
import type { Language } from "../i18n/language.ts";
import { resetIdentityModule } from "../identity/identity.ts";
import { createAppRouter } from "../router.ts";
import { useIdentityStore } from "../stores/identity-store.ts";

// The account page (#51) in a real router: who sees what, what each press asks of the server, and
// above all what the page says after a deletion, which may be only what the server's answer
// allows. The server's own refusals are in `apps/server/src/account.db.test.ts`.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SHARED = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Sprint planning",
  lastActiveAt: new Date(Date.now() - 86_400_000).toISOString(),
  seats: [
    { id: "ann", name: "Ann" },
    { id: "ben", name: "Ben" },
  ],
};

const OVERVIEW = { recent: true, retentionDays: 90, alone: 2, seats: 1, shared: [SHARED] };

const SESSION = {
  user: { id: "account", name: "Ada", email: "ada@example.com", provider: "google" },
  session: {},
};

const GUEST_SESSION = { user: { id: "guest-2", name: "", isAnonymous: true }, session: {} };

type Route = (init?: RequestInit) => Response;

/** Stubs `fetch` with one answer per `METHOD path`; anything else fails like offline. */
function serve(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${input}`;
      const sent = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ key, body: sent });
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

const asAccount = () =>
  useIdentityStore.getState().setIdentity({
    userId: "account",
    name: "Ada",
    email: "ada@example.com",
    provider: "google",
  });

async function renderAccount(language: Language = "en") {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/account"] }));
  await act(async () => {
    await changeLanguage(language);
    render(<App router={router} />);
    await router.load();
  });
}

const typeWord = (word: string) =>
  fireEvent.change(screen.getByLabelText(new RegExp(word)), { target: { value: word } });

/** Opens the dialog and confirms it with the word. */
async function confirmDeletion(language: Language = "en") {
  const dialogButton = await screen.findByRole("button", { name: /delete my account/i });
  fireEvent.click(dialogButton);
  const word = ACCOUNT_DELETE_WORDS[language];
  await screen.findByRole("dialog");
  typeWord(word);
  const dialog = screen.getByRole("dialog");
  const press = [...dialog.querySelectorAll("button")].find(
    (button) => button.getAttribute("type") === "submit",
  );
  if (!press) throw new Error("no submit button");
  await act(async () => {
    fireEvent.click(press);
  });
}

beforeEach(() => {
  providers("google");
  useIdentityStore.getState().reset?.();
  resetIdentityModule();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  providers(null);
});

describe("who sees the page", () => {
  it("shows an install without a provider the page of an unknown address", async () => {
    providers(null);
    serve({
      "GET /api/auth/get-session": () => json(GUEST_SESSION),
    });
    useIdentityStore.getState().setIdentity({ userId: "guest", name: null });
    await renderAccount();
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });

  it("offers someone signed out the sign-in, and asks the server for nothing", async () => {
    const calls = serve({});
    useIdentityStore.getState().setIdentity({ userId: "guest", name: null });
    await renderAccount();
    expect(await screen.findByRole("heading", { name: "Your account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Google/ })).toBeTruthy();
    expect(calls.map(({ key }) => key)).not.toContain("GET /api/account");
  });
});

describe("what the page says", () => {
  it("lists what goes, what stays, and says the file holds no code", async () => {
    serve({ "GET /api/account": () => json(OVERVIEW) });
    asAccount();
    await renderAccount();
    expect(await screen.findByText(/2 rooms with nobody else/)).toBeTruthy();
    expect(screen.getByText(/Your seat in 1 room/)).toBeTruthy();
    expect(screen.getByText(/never by their code/)).toBeTruthy();
    expect(screen.getByText(/Backups of this server keep your data/)).toBeTruthy();
    expect(screen.getByText(/Server logs hold ids/)).toBeTruthy();
    expect(screen.getByText(/What other people already hold/)).toBeTruthy();
  });

  it("speaks French and German, down to the word to type", async () => {
    for (const [language, button] of [
      ["fr", "Supprimer mon compte"],
      ["de", "Mein Konto löschen"],
    ] as const) {
      serve({ "GET /api/account": () => json(OVERVIEW) });
      asAccount();
      await renderAccount(language);
      fireEvent.click(await screen.findByRole("button", { name: button }));
      expect(await screen.findByLabelText(new RegExp(ACCOUNT_DELETE_WORDS[language]))).toBeTruthy();
      cleanup();
    }
  });

  it("names the longest seated as the default, and sends only what the person changed", async () => {
    const calls = serve({
      "GET /api/account": () => json(OVERVIEW),
      "POST /api/account/delete": () => json({ finished: true }),
      "GET /api/auth/get-session": () => json(GUEST_SESSION),
    });
    asAccount();
    await renderAccount();
    const select = await screen.findByLabelText("Who takes Sprint planning");
    expect((select as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      "Ann (seated longest)",
    );
    await confirmDeletion();
    expect(calls.find(({ key }) => key === "POST /api/account/delete")?.body).toEqual({
      confirm: "DELETE",
      rooms: [],
    });
  });

  it("sends a chosen person and a chosen delete, and warns of the second", async () => {
    const calls = serve({
      "GET /api/account": () => json({ ...OVERVIEW, shared: [SHARED, { ...SHARED, id: "other" }] }),
      "POST /api/account/delete": () => json({ finished: true }),
      "GET /api/auth/get-session": () => json(GUEST_SESSION),
    });
    asAccount();
    await renderAccount();
    const [first, second] = await screen.findAllByLabelText("Who takes Sprint planning");
    fireEvent.change(first as HTMLElement, { target: { value: "ben" } });
    fireEvent.change(second as HTMLElement, { target: { value: "delete" } });
    expect(screen.getByText(/This room goes for everyone in it/)).toBeTruthy();
    await confirmDeletion();
    expect(calls.find(({ key }) => key === "POST /api/account/delete")?.body).toEqual({
      confirm: "DELETE",
      rooms: [
        { id: SHARED.id, to: "ben" },
        { id: "other", delete: true },
      ],
    });
  });
});

describe("a recent sign-in", () => {
  it("sends an old session through the sign-in, coming back here", async () => {
    const calls = serve({
      "GET /api/account": () => json({ ...OVERVIEW, recent: false }),
      "POST /api/auth/sign-in/social": () => json({ url: "https://accounts.example/x" }),
    });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, pathname: "/account" });
    asAccount();
    await renderAccount();
    expect(screen.queryByRole("button", { name: "Delete my account" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.example/x"));
    expect(calls.find(({ key }) => key.includes("sign-in/social"))?.body).toEqual({
      provider: "google",
      returnTo: "/account",
    });
  });

  it("takes the server's word that the session has grown old in the meantime", async () => {
    let reads = 0;
    serve({
      "GET /api/account": () => json({ ...OVERVIEW, recent: ++reads === 1 }),
      "POST /api/account/delete": () => json({ code: "sign_in_again" }, 403),
    });
    asAccount();
    await renderAccount();
    await confirmDeletion();
    expect(await screen.findByText(/That sign-in is too old/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the confirmation", () => {
  it("sends nothing until the word is typed", async () => {
    const calls = serve({ "GET /api/account": () => json(OVERVIEW) });
    asAccount();
    await renderAccount();
    fireEvent.click(await screen.findByRole("button", { name: "Delete my account" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText(/Type DELETE/), { target: { value: "dele" } });
    const form = dialog.querySelector("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    expect(calls.map(({ key }) => key)).not.toContain("POST /api/account/delete");
  });

  it("says a refusal where it happened, with the dialog still open", async () => {
    serve({
      "GET /api/account": () => json(OVERVIEW),
      "POST /api/account/delete": () => json({ code: "rate_limited" }, 429),
    });
    asAccount();
    await renderAccount();
    await confirmDeletion();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("after the request", () => {
  it("says it is done only when the server said so, and the browser is a new guest", async () => {
    const calls = serve({
      "GET /api/account": () => json(OVERVIEW),
      "POST /api/account/delete": () => json({ finished: true }),
      "GET /api/auth/get-session": () => json(GUEST_SESSION),
    });
    asAccount();
    await renderAccount();
    await confirmDeletion();
    expect(await screen.findByRole("heading", { name: "Your account is deleted" })).toBeTruthy();
    expect(screen.getByText(/backups until they expire/)).toBeTruthy();
    await waitFor(() => expect(useIdentityStore.getState().userId).toBe("guest-2"));
    expect(calls.map(({ key }) => key)).toContain("GET /api/auth/get-session");
    expect(document.title).toContain("Your account is deleted");
  });

  it("says it will finish when the server said it has not", async () => {
    serve({
      "GET /api/account": () => json(OVERVIEW),
      "POST /api/account/delete": () => json({ finished: false }),
      "GET /api/auth/get-session": () => json(GUEST_SESSION),
    });
    asAccount();
    await renderAccount();
    await confirmDeletion();
    expect(await screen.findByRole("heading", { name: /is being deleted/ })).toBeTruthy();
    expect(screen.getByText(/finishes by itself, within a day/)).toBeTruthy();
    expect(screen.queryByText("Your account is deleted")).toBeNull();
  });

  it("says nothing went when the request failed and the person is still signed in", async () => {
    serve({
      "GET /api/account": () => json(OVERVIEW),
      "POST /api/account/delete": () => json({ code: "internal" }, 500),
      "GET /api/auth/get-session": () => json(SESSION),
    });
    asAccount();
    await renderAccount();
    await confirmDeletion();
    expect(await screen.findByText(/Nothing was deleted/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("says what it cannot know when the answer was lost and the session is gone", async () => {
    serve({
      "GET /api/account": () => json(OVERVIEW),
      "GET /api/auth/get-session": () => json(GUEST_SESSION),
    });
    asAccount();
    await renderAccount();
    await confirmDeletion();
    expect(await screen.findByRole("heading", { name: "You are signed out" })).toBeTruthy();
    expect(screen.getByText(/most likely went through/)).toBeTruthy();
    expect(screen.queryByText("Your account is deleted")).toBeNull();
  });

  it("says so when the server cannot be reached at all", async () => {
    serve({ "GET /api/account": () => json(OVERVIEW) });
    asAccount();
    await renderAccount();
    await confirmDeletion();
    expect(await screen.findByText(/may or may not have reached it/)).toBeTruthy();
  });
});

describe("the download", () => {
  it("saves the file, and says when a guest's rooms have not arrived", async () => {
    let incomplete = false;
    serve({
      "GET /api/account": () => json(OVERVIEW),
      "GET /api/account/export": () => json({ version: 1, ...(incomplete && { incomplete }) }),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL() {} }),
    );
    asAccount();
    await renderAccount();
    fireEvent.click(await screen.findByRole("button", { name: "Download my data" }));
    expect(await screen.findByText("Your file is on its way.")).toBeTruthy();
    expect(click).toHaveBeenCalledTimes(1);
    incomplete = true;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Download my data" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Download my data" }));
    expect(await screen.findByText(/had not reached your account/)).toBeTruthy();
    click.mockRestore();
  });

  it("says why when the server refuses", async () => {
    serve({
      "GET /api/account": () => json(OVERVIEW),
      "GET /api/account/export": () => json({ code: "rate_limited" }, 429),
    });
    asAccount();
    await renderAccount();
    fireEvent.click(await screen.findByRole("button", { name: "Download my data" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
