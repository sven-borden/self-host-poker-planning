import { apply, createRoom, type Participant, type RoomState } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, fixedT, loadLanguage } from "../i18n/i18n.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import { isRestrictionRefusal, useRoomStore } from "../stores/room-store.ts";
import { describeEvents, liveEvents } from "./announcements.ts";
import { RoomView } from "./room-view.tsx";
import { RoomSettingsButton } from "./settings-button.tsx";
import { GROUPS, withPatch } from "./settings-panel.tsx";

// A room limited to accounts in the page (#50): what someone refused reads, the PO's row in
// "Room settings", and what everyone else reads of the rule.

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  commandSender: vi.fn(),
  enterRoomAgain: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock("../realtime/room-connection.ts", () => ({
  sendCommand: mocks.sendCommand,
  commandSender: mocks.commandSender,
  enterRoomAgain: mocks.enterRoomAgain,
  announceRoomAccess: vi.fn(),
}));

const CODE = "abcdefghij";
const PO = "po";
const ANA = "ana";
const TENANT = "11111111-2222-3333-4444-555555555555";
let version = 1;
let state: RoomState;

function meta(content?: string) {
  document.head.querySelector('meta[name="pp-sign-in"]')?.remove();
  if (content === undefined) return;
  const tag = document.createElement("meta");
  tag.name = "pp-sign-in";
  tag.content = content;
  document.head.append(tag);
}

function room(restriction?: RoomState["settings"]["restriction"]): RoomState {
  const created = createRoom({ ownerId: PO });
  const participants: Record<string, Participant> = {
    [PO]: { name: "Pia", role: "voter", joinedAt: 1, connected: true },
    [ANA]: { name: "Ana", role: "voter", joinedAt: 2, connected: true },
  };
  const settings = restriction ? { ...created.settings, restriction } : created.settings;
  return { ...created, settings, participants };
}

function show(next: RoomState, viewer: string) {
  state = next;
  act(() => {
    version += 1;
    useRoomStore.getState().receive(toSnapshot(next, viewer, { code: CODE, version, now: 0 }));
    useRoomStore.getState().setStatus("live");
  });
}

const asAccount = (provider: "google" | "microsoft") =>
  useIdentityStore
    .getState()
    .setIdentity({ userId: PO, name: "Pia", email: "pia@example.com", provider });

function refuse(code: Parameters<typeof isRestrictionRefusal>[0], domains: string[], org: boolean) {
  if (!isRestrictionRefusal(code)) throw new Error("not a rule's code");
  act(() => useRoomStore.getState().restrict({ code, domains, organisation: org }));
}

async function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: "Room settings" }));
  return screen.findByRole("dialog", { name: "Room settings" });
}

/** The server takes the rule, as `updateSettings` does, and shows the PO the result. */
function acceptChanges() {
  const send = vi.fn(async ({ payload }: { payload: { patch: { restriction: unknown } } }) => {
    const result = apply(
      state,
      { type: "updateSettings", patch: payload.patch as never },
      { actor: PO, now: 1 },
    );
    show(result.state, PO);
    return { ok: true, version };
  });
  mocks.commandSender.mockReturnValue(send);
  return send;
}

const field = (dialog: HTMLElement, name: string) =>
  within(dialog).getByRole("textbox", { name }) as HTMLTextAreaElement;

function serverAnswers(body: object) {
  mocks.fetch.mockImplementation(async () => Response.json(body));
}

beforeAll(async () => {
  await changeLanguage("en");
  await loadLanguage("fr");
  await loadLanguage("de");
});

beforeEach(() => {
  useRoomStore.getState().reset();
  useRoomStore.getState().open(CODE);
  useIdentityStore.getState().reset();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockReset();
  mocks.commandSender.mockReset();
  mocks.enterRoomAgain.mockReset();
  serverAnswers({ outsiders: 0, own: { domain: "example.com", tenant: null } });
  meta("google microsoft");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  meta();
});

describe("the refused screen", () => {
  it("asks a guest to sign in, says what passes, and offers the provider that can", async () => {
    useIdentityStore.getState().setIdentity({ userId: "g", name: null });
    render(<RoomView />);
    refuse("sign_in_required", ["example.com"], false);
    const screenRoot = document.querySelector("[data-room-restricted]") as HTMLElement;
    expect(screenRoot.getAttribute("data-room-restricted")).toBe("sign_in_required");
    expect(screenRoot.textContent).toContain("Google account on example.com");
    expect(screenRoot.textContent).toContain("Guests cannot join this room.");
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with Microsoft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Join the room" })).toBeNull();
    expect(document.activeElement).toBe(screenRoot);
  });

  it("says your organisation, and offers Microsoft, for a tenant", () => {
    useIdentityStore.getState().setIdentity({ userId: "g", name: null });
    render(<RoomView />);
    refuse("sign_in_required", [], true);
    const root = document.querySelector("[data-room-restricted]") as HTMLElement;
    expect(root.textContent).toContain("Microsoft account from your organisation");
    expect(screen.getByRole("button", { name: "Sign in with Microsoft" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
  });

  it("offers both, when either passes", () => {
    useIdentityStore.getState().setIdentity({ userId: "g", name: null });
    render(<RoomView />);
    refuse("sign_in_required", ["example.com"], true);
    expect(screen.getByRole("button", { name: "Sign in with Microsoft" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
    expect(document.querySelector("[data-room-restricted]")?.textContent).toContain(
      "or a Microsoft account",
    );
  });

  it.each([
    ["microsoft", ["contoso.com"], false, "never counts for an email domain"],
    ["microsoft", [], true, "belongs to another organisation"],
    ["google", ["example.com"], false, "not on one of these domains"],
    ["google", [], true, "takes Microsoft accounts"],
  ] as const)("tells a %s account which rule failed (%j, %s)", (provider, domains, org, words) => {
    asAccount(provider);
    render(<RoomView />);
    refuse("account_not_allowed", [...domains], org);
    expect(document.querySelector("[data-room-refusal]")?.textContent).toContain(words);
    // The way to another account: sign out, which reloads this room as a guest.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("has a plain word for an account it cannot read", () => {
    useIdentityStore.getState().setIdentity({ userId: "g", name: null });
    render(<RoomView />);
    refuse("account_not_allowed", ["example.com"], false);
    expect(document.querySelector("[data-room-refusal]")?.textContent).toBe(
      "This account cannot join this room. Sign out to use another one.",
    );
  });

  it("fails closed in words, with nothing to press", () => {
    asAccount("google");
    render(<RoomView />);
    refuse("restriction_unavailable", [], false);
    const root = document.querySelector("[data-room-restricted]") as HTMLElement;
    expect(root.textContent).toContain("no longer offers the sign-in");
    expect(root.querySelector("[data-sign-in]")).toBeNull();
  });
});

describe("the join form when a rule arrives", () => {
  it("enters again and lets the room say what it asks", async () => {
    const send = vi.fn(async () => ({ ok: false, code: "account_not_allowed" }));
    mocks.commandSender.mockReturnValue(send);
    mocks.enterRoomAgain.mockResolvedValue("account_not_allowed");
    mocks.fetch.mockImplementation(async () => Response.json({ name: "Ana" }));
    render(<RoomView />);
    show(room(), ANA);
    act(() => {
      const held = useRoomStore.getState().snapshot;
      if (!held) throw new Error("no snapshot");
      useRoomStore.getState().receive({
        ...held,
        version: held.version + 1,
        room: { ...held.room, you: null, participants: [] },
      });
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Ana" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join the room" }));
    await waitFor(() => expect(mocks.enterRoomAgain).toHaveBeenCalledTimes(1));
  });
});

describe("the PO's row", () => {
  it("does not appear without a provider", async () => {
    meta();
    render(<RoomSettingsButton />);
    show(room(), PO);
    const dialog = await openPanel();
    expect(dialog.querySelector('[data-setting="restriction"]')).toBeNull();
  });

  it("shows without a provider while a rule stands, says why it fails, and takes it off", async () => {
    meta();
    asAccount("google");
    const send = acceptChanges();
    render(<RoomSettingsButton />);
    show(room({ domains: ["example.com"], tenants: [TENANT] }), PO);
    const dialog = await openPanel();
    expect(dialog.querySelectorAll("[data-restriction-gone]")).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove the rule" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toEqual({
      type: "updateSettings",
      payload: { patch: { restriction: null } },
    });
  });

  it("asks a guest PO to sign in first", async () => {
    useIdentityStore.getState().setIdentity({ userId: PO, name: "Pia" });
    render(<RoomSettingsButton />);
    show(room(), PO);
    const dialog = await openPanel();
    expect(dialog.querySelector("[data-restriction-sign-in]")).not.toBeNull();
    expect(dialog.querySelector("[data-restriction-setting]")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("offers only what the install has", async () => {
    meta("google");
    asAccount("google");
    render(<RoomSettingsButton />);
    show(room(), PO);
    const dialog = await openPanel();
    expect(dialog.querySelector("[data-restriction-domains]")).not.toBeNull();
    expect(dialog.querySelector("[data-restriction-tenants]")).toBeNull();
  });

  it("labels the one list there is, with Microsoft alone", async () => {
    meta("microsoft");
    asAccount("microsoft");
    render(<RoomSettingsButton />);
    show(room(), PO);
    const dialog = await openPanel();
    expect(dialog.querySelector("[data-restriction-domains]")).toBeNull();
    expect(field(dialog, "Microsoft tenant ids")).toBeTruthy();
  });

  it("saves a rule the PO meets at once, its domain in ASCII", async () => {
    asAccount("google");
    serverAnswers({ outsiders: 0, own: { domain: "xn--bcher-kva.example", tenant: null } });
    const send = acceptChanges();
    render(<RoomSettingsButton />);
    show(room(), PO);
    const dialog = await openPanel();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.change(field(dialog, "Email domains"), { target: { value: "bücher.example\n" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save the rule" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toEqual({
      type: "updateSettings",
      payload: { patch: { restriction: { domains: ["xn--bcher-kva.example"], tenants: [] } } },
    });
    await waitFor(() => expect(field(dialog, "Email domains").value).toBe("xn--bcher-kva.example"));
  });

  it("asks first before a rule the PO does not meet, and can be cancelled", async () => {
    asAccount("microsoft");
    serverAnswers({ outsiders: 0, own: { domain: null, tenant: TENANT } });
    const send = acceptChanges();
    render(<RoomSettingsButton />);
    show(room(), PO);
    const dialog = await openPanel();
    await act(async () => {});
    fireEvent.change(field(dialog, "Email domains"), { target: { value: "contoso.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save the rule" }));
    expect(dialog.querySelector("[data-restriction-ask]")?.textContent).toContain(
      "You do not meet this rule yourself.",
    );
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(dialog.querySelector("[data-restriction-ask]")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save the rule" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save it anyway" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it("asks first when it could not read the PO's own account", async () => {
    asAccount("google");
    mocks.fetch.mockImplementation(async () =>
      Response.json({ code: "internal" }, { status: 500 }),
    );
    const send = acceptChanges();
    render(<RoomSettingsButton />);
    show(room(), PO);
    const dialog = await openPanel();
    await act(async () => {});
    fireEvent.change(field(dialog, "Email domains"), { target: { value: "example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save the rule" }));
    expect(dialog.querySelector("[data-restriction-ask]")).not.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("names a malformed entry and sends nothing", async () => {
    asAccount("google");
    const send = acceptChanges();
    render(<RoomSettingsButton />);
    show(room(), PO);
    const dialog = await openPanel();
    const save = within(dialog).getByRole("button", { name: "Save the rule" });
    const problem = () => dialog.querySelector("[data-restriction-problem]")?.textContent;
    fireEvent.change(field(dialog, "Email domains"), { target: { value: "*.example.com" } });
    fireEvent.click(save);
    expect(problem()).toBe("This is not a domain: *.example.com");
    fireEvent.change(field(dialog, "Email domains"), { target: { value: "http://[bücher" } });
    fireEvent.click(save);
    expect(problem()).toBe("This is not a domain: http://[bücher");
    fireEvent.change(field(dialog, "Email domains"), { target: { value: "" } });
    fireEvent.change(field(dialog, "Microsoft tenant ids"), { target: { value: "contoso.com" } });
    fireEvent.click(save);
    expect(problem()).toBe("This is not an organisation’s tenant id: contoso.com");
    fireEvent.change(field(dialog, "Microsoft tenant ids"), { target: { value: "" } });
    const many = Array.from({ length: 21 }, (_, i) => `d${i}.example.com`).join(" ");
    fireEvent.change(field(dialog, "Email domains"), { target: { value: many } });
    fireEvent.click(save);
    expect(problem()).toBe("Each list holds 20 entries at most.");
    expect(send).not.toHaveBeenCalled();
  });

  it("saving empty lists removes the rule", async () => {
    asAccount("google");
    const send = acceptChanges();
    render(<RoomSettingsButton />);
    show(room({ domains: ["example.com"], tenants: [] }), PO);
    const dialog = await openPanel();
    fireEvent.change(field(dialog, "Email domains"), { target: { value: "  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save the rule" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(state.settings.restriction).toBeUndefined();
  });

  it("shows how many people here would not pass, and never who", async () => {
    asAccount("google");
    serverAnswers({ outsiders: 2, own: { domain: "example.com", tenant: null } });
    render(<RoomSettingsButton />);
    show(room({ domains: ["example.com"], tenants: [] }), PO);
    const dialog = await openPanel();
    await waitFor(() =>
      expect(dialog.querySelector("[data-restriction-outsiders]")?.textContent).toBe(
        "2 people here would not pass. They stay until they reload the page or leave.",
      ),
    );
    expect(dialog.querySelector("[data-restriction-outsiders]")?.textContent).not.toContain("Ana");
  });

  it("is a change like any other: refused, it rolls back and says why", async () => {
    asAccount("google");
    const send = vi.fn(async () => ({ ok: false, code: "bad_restriction" }));
    mocks.commandSender.mockReturnValue(send);
    render(<RoomSettingsButton />);
    show(room(), PO);
    const dialog = await openPanel();
    await act(async () => {});
    fireEvent.change(field(dialog, "Email domains"), { target: { value: "example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save the rule" }));
    const alert = await within(dialog).findByText(/not a domain or a tenant id/);
    expect(alert).toBeTruthy();
    expect(state.settings.restriction).toBeUndefined();
  });
});

describe("everyone else", () => {
  it("reads the rule in words, a tenant as your organisation", async () => {
    render(<RoomSettingsButton />);
    show(room({ domains: ["example.com"], tenants: [TENANT] }), ANA);
    fireEvent.click(screen.getByRole("button", { name: "Room rules" }));
    const dialog = await screen.findByRole("dialog", { name: "Room rules" });
    const row = dialog.querySelector('[data-setting="restriction"]') as HTMLElement;
    expect(row.querySelector("[data-setting-value]")?.textContent).toBe("Limited");
    expect(row.querySelector("[data-setting-detail]")?.textContent).toBe(
      "example.com, your organisation",
    );
    expect(dialog.textContent).not.toContain(TENANT);
  });

  it("reads Anyone with the link, while a provider exists and no rule stands", async () => {
    render(<RoomSettingsButton />);
    show(room(), ANA);
    fireEvent.click(screen.getByRole("button", { name: "Room rules" }));
    const dialog = await screen.findByRole("dialog", { name: "Room rules" });
    expect(
      dialog.querySelector('[data-setting="restriction"] [data-setting-value]')?.textContent,
    ).toBe("Anyone with the link");
  });

  it("hears that it changed, and nothing of what it says", () => {
    const before = toSnapshot(room(), ANA, { code: CODE, version: 1, now: 0 });
    const after = toSnapshot(room({ domains: ["example.com"], tenants: [] }), ANA, {
      code: CODE,
      version: 2,
      now: 0,
    });
    const events = liveEvents(after.room, [], before.room);
    expect(describeEvents(fixedT("en"), events)).toBe(
      "The product owner changed who can join this room.",
    );
    expect(describeEvents(fixedT("fr"), events)).toContain("qui peut rejoindre");
    expect(describeEvents(fixedT("de"), events)).toContain("wer diesem Raum beitreten kann");
  });
});

describe("the panel's plumbing", () => {
  const settings = () =>
    toSnapshot(room({ domains: ["example.com"], tenants: [TENANT] }), PO, {
      code: CODE,
      version: 1,
      now: 0,
    }).room.settings;

  it("shows a pending rule as the server will, and its removal", () => {
    expect(withPatch(settings(), { restriction: null }).restriction).toBeUndefined();
    expect(
      withPatch(settings(), { restriction: { domains: ["a.example"], tenants: [] } }).restriction,
    ).toEqual({ domains: ["a.example"], tenants: [], organisation: false });
    expect(withPatch(settings(), { poVotes: false }).restriction?.tenants).toEqual([TENANT]);
  });

  it("orders the rule before the password: the room asks for it first", () => {
    const keys = GROUPS.flatMap((group) => group.fields.map((f) => f.key));
    expect(keys.indexOf("restriction")).toBe(keys.indexOf("hasPassword") - 1);
  });
});
