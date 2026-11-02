import { createRoom, type RoomState } from "@pp/domain";
import {
  CONNECTOR_META,
  type ConnectorImportView,
  type RoomView,
  type RoundView,
  type Snapshot,
  toSnapshot,
} from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, fixedT } from "../i18n/i18n.ts";
import { RoomApiError } from "../rooms/api.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import { useRoomStore } from "../stores/room-store.ts";
import {
  clearConnectorResult,
  connectorMessage,
  connectorOn,
  connectorResult,
  readConnectorResult,
} from "./connector.ts";
import { importReport } from "./connector-parts.tsx";
import { ConnectorSection } from "./connector-section.tsx";
import { forgetFinalPress, markFinalPress } from "./final-press.ts";
import { HistoryWrite } from "./history-write.tsx";
import { TrackerLines } from "./tracker-lines.tsx";
import { useConnectorChunk } from "./use-connector-chunk.ts";
import { WriteBackLines } from "./write-back.tsx";

const api = vi.hoisted(() => ({
  fetchConnection: vi.fn(),
  startConnection: vi.fn(),
  disconnect: vi.fn(),
  fetchSites: vi.fn(),
  chooseSite: vi.fn(),
  fetchFields: vi.fn(),
  chooseField: vi.fn(),
  fetchBoards: vi.fn(),
  fetchSprints: vi.fn(),
  importItems: vi.fn(),
  writeBack: vi.fn(),
}));
vi.mock("./connector-api.ts", () => api);
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const CODE = "abcdefghij";
const PO = "po";
const t = fixedT("en");

beforeAll(async () => {
  await changeLanguage("en");
});

function showRoom(you = PO) {
  act(() => useRoomStore.getState().open(CODE));
  const state: RoomState = {
    ...createRoom({ ownerId: PO }),
    participants: { [you]: { name: "Pia", role: "voter", joinedAt: 1, connected: true } },
  };
  act(() => {
    useRoomStore.getState().receive(toSnapshot(state, you, { code: CODE, version: 1, now: 0 }));
  });
}

const signIn = (on: boolean) =>
  act(() => useIdentityStore.setState({ email: on ? "a@example.com" : null, provider: null }));

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  signIn(true);
  api.fetchSites.mockResolvedValue([
    { id: "a", name: "Acme" },
    { id: "b", name: "Globex" },
  ]);
  api.fetchFields.mockResolvedValue({
    fields: [
      { id: "customfield_1", name: "Team size" },
      { id: "customfield_2", name: "Story Points" },
    ],
    guess: "customfield_2",
  });
  api.fetchBoards.mockResolvedValue({ boards: [{ id: 1, name: "Board" }], more: false });
  api.fetchSprints.mockResolvedValue([
    { id: 7, name: "Sprint 7", state: "active" },
    { id: 8, name: "Sprint 8", state: "future" },
  ]);
});

afterEach(() => {
  cleanup();
  document.head.querySelector(`meta[name="${CONNECTOR_META}"]`)?.remove();
  act(() => useRoomStore.getState().reset());
  window.history.replaceState(null, "", "/");
});

/** The lines as the page has them: the round comes from the store. */
function Lines() {
  const view = useRoomStore((state) => state.snapshot?.room.round ?? null);
  return <WriteBackLines code={CODE} round={view} />;
}

function Part({ load }: { load: () => Promise<{ text: string }> }) {
  const chunk = useConnectorChunk(true, load);
  return <p>{chunk?.text ?? "the room"}</p>;
}

describe("connectorOn", () => {
  it("reads the server's tag, and nothing without one", () => {
    expect(connectorOn("jira")).toBe(false);
    const tag = document.createElement("meta");
    tag.name = CONNECTOR_META;
    tag.content = "jira";
    document.head.append(tag);
    expect(connectorOn("jira")).toBe(true);
    tag.content = "gitlab";
    expect(connectorOn("jira")).toBe(false);
  });
});

describe("how a connection came back", () => {
  it("leaves the address at once, and is said once", () => {
    window.history.replaceState(null, "", "/r/abc?connector=connected&x=1");
    readConnectorResult();
    expect(window.location.search).toBe("?x=1");
    expect(connectorResult()).toBe("connected");
    expect(connectorResult()).toBe("connected");
    clearConnectorResult();
    expect(connectorResult()).toBeNull();
  });

  it("keeps a state that ran out apart from a failure", () => {
    window.history.replaceState(null, "", "/r/abc?connector=expired");
    readConnectorResult();
    expect(connectorResult()).toBe("expired");
    clearConnectorResult();
  });

  it("takes a word it does not know for a failure, and nothing for nothing", () => {
    window.history.replaceState(null, "", "/r/abc?connector=whatever");
    readConnectorResult();
    expect(connectorResult()).toBe("failed");
    clearConnectorResult();
    window.history.replaceState(null, "", "/r/abc");
    readConnectorResult();
    expect(connectorResult()).toBeNull();
  });
});

describe("connectorMessage", () => {
  it("names the tracker, gives the wait, and leaves other codes to the app's words", () => {
    expect(connectorMessage(t, "connector_forbidden", "jira")).toContain("Jira");
    expect(connectorMessage(t, "connector_rate_limited", "jira", 30)).toContain("30");
    expect(connectorMessage(t, "connector_rate_limited", "jira")).not.toContain("undefined");
    expect(connectorMessage(t, "room_not_found", "jira")).toBe(t("errors.room_not_found"));
  });
});

describe("importReport", () => {
  const view: ConnectorImportView = {
    added: 3,
    duplicates: 0,
    shortened: 0,
    leftOut: 0,
    beyond: 0,
  };

  it("says what happened and leaves out every zero", () => {
    expect(importReport(t, view)).toBe(t("queue.added", { count: 3 }));
    expect(importReport(t, { ...view, added: 0 })).toBe(t("queue.addedNone"));
  });

  it("says how many were left out and how many lie beyond", () => {
    const text = importReport(t, { ...view, duplicates: 1, shortened: 2, leftOut: 4, beyond: 9 });
    expect(text).toContain(t("connector.leftOut", { count: 4 }));
    expect(text).toContain(t("connector.beyond", { count: 9, max: 500 }));
    expect(importReport(t, { ...view, beyond: null })).toContain(
      t("connector.beyondUnknown", { max: 500 }),
    );
  });
});

describe("the section", () => {
  it("asks a guest to sign in, and asks nothing of the server", () => {
    signIn(false);
    showRoom();
    render(<ConnectorSection />);
    expect(screen.getByText(t("connector.signIn", { system: "Jira" }))).toBeTruthy();
    expect(api.fetchConnection).not.toHaveBeenCalled();
  });

  it("offers to connect, and leaves for the address the server gave", async () => {
    showRoom();
    api.fetchConnection.mockResolvedValue({ connected: false });
    api.startConnection.mockRejectedValue(new RoomApiError("rate_limited"));
    render(<ConnectorSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Jira" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(api.startConnection).toHaveBeenCalledWith("jira", CODE);
  });

  it("asks which site when there are several, and saves the one picked", async () => {
    showRoom();
    api.fetchConnection.mockResolvedValueOnce({ connected: true });
    api.fetchConnection.mockResolvedValue({
      connected: true,
      site: { id: "b", name: "Globex" },
      field: { id: "customfield_2", name: "Story Points" },
    });
    render(<ConnectorSection />);
    const picker = await screen.findByLabelText(t("connector.site"));
    fireEvent.change(picker, { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: t("connector.siteSave") }));
    expect(await screen.findByText(t("connector.connectedTo", { site: "Globex" }))).toBeTruthy();
    expect(api.chooseSite).toHaveBeenCalledWith("jira", "b");
  });

  it("shows the guess in the field's list, and saves only on a press", async () => {
    showRoom();
    api.fetchConnection.mockResolvedValue({
      connected: true,
      site: { id: "a", name: "Acme" },
    });
    render(<ConnectorSection />);
    const select = (await screen.findByLabelText(t("connector.field"))) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("customfield_2"));
    expect(api.chooseField).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("connector.fieldSave") }));
    await waitFor(() => expect(api.chooseField).toHaveBeenCalledWith("jira", "customfield_2"));
  });

  async function connected() {
    showRoom();
    api.fetchConnection.mockResolvedValue({
      connected: true,
      site: { id: "a", name: "Acme" },
      field: { id: "customfield_2", name: "Story Points" },
    });
    render(<ConnectorSection />);
    await screen.findByText(t("connector.connectedTo", { site: "Acme" }));
  }

  it("imports a sprint, the first one picked by itself", async () => {
    await connected();
    api.importItems.mockResolvedValue({
      added: 2,
      duplicates: 0,
      shortened: 0,
      leftOut: 0,
      beyond: 0,
    });
    await screen.findByLabelText(t("connector.sprint"));
    fireEvent.click(screen.getByRole("button", { name: t("connector.import") }));
    await screen.findByText(t("queue.added", { count: 2 }));
    expect(api.importItems).toHaveBeenCalledWith("jira", CODE, { sprint: 7 });
  });

  it("imports by JQL, trimmed, and says nothing was asked for an empty box", async () => {
    await connected();
    fireEvent.click(screen.getByLabelText(t("connector.byJql")));
    fireEvent.click(screen.getByRole("button", { name: t("connector.import") }));
    await screen.findByText(t("connector.nothingAsked"));
    expect(api.importItems).not.toHaveBeenCalled();
    api.importItems.mockResolvedValue({
      added: 1,
      duplicates: 0,
      shortened: 0,
      leftOut: 0,
      beyond: 0,
    });
    fireEvent.change(screen.getByLabelText(t("connector.jql")), {
      target: { value: "  project = X " },
    });
    fireEvent.click(screen.getByRole("button", { name: t("connector.import") }));
    await waitFor(() =>
      expect(api.importItems).toHaveBeenCalledWith("jira", CODE, { jql: "project = X" }),
    );
  });

  it("goes back to Connect when the grant turns out dead", async () => {
    await connected();
    fireEvent.click(screen.getByLabelText(t("connector.byJql")));
    fireEvent.change(screen.getByLabelText(t("connector.jql")), { target: { value: "x" } });
    api.importItems.mockRejectedValue(new RoomApiError("connector_reconnect"));
    api.fetchConnection.mockResolvedValue({ connected: false });
    fireEvent.click(screen.getByRole("button", { name: t("connector.import") }));
    expect(await screen.findByRole("button", { name: "Connect Jira" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Connect again");
  });

  describe("a dead grant found by any call", () => {
    const dead = () => {
      api.fetchConnection.mockResolvedValue({ connected: false });
      return new RoomApiError("connector_reconnect");
    };
    const lands = async () => {
      expect(await screen.findByRole("button", { name: "Connect Jira" })).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toContain("Connect again");
      expect(screen.queryByRole("button", { name: t("connector.disconnect") })).toBeNull();
    };

    it("goes back to Connect from the list of sites", async () => {
      showRoom();
      api.fetchConnection.mockResolvedValueOnce({ connected: true });
      api.fetchSites.mockImplementation(() => Promise.reject(dead()));
      render(<ConnectorSection />);
      await lands();
    });

    it("goes back to Connect from the list of fields", async () => {
      showRoom();
      api.fetchConnection.mockResolvedValueOnce({ connected: true, site: { id: "a", name: "A" } });
      api.fetchFields.mockImplementation(() => Promise.reject(dead()));
      render(<ConnectorSection />);
      await lands();
    });

    it("goes back to Connect from the list of boards", async () => {
      showRoom();
      api.fetchConnection.mockResolvedValueOnce({
        connected: true,
        site: { id: "a", name: "A" },
        field: { id: "f", name: "F" },
      });
      api.fetchBoards.mockImplementation(() => Promise.reject(dead()));
      render(<ConnectorSection />);
      await lands();
    });

    it("goes back to Connect from a board's sprints", async () => {
      showRoom();
      api.fetchConnection.mockResolvedValueOnce({
        connected: true,
        site: { id: "a", name: "A" },
        field: { id: "f", name: "F" },
      });
      api.fetchSprints.mockImplementation(() => Promise.reject(dead()));
      render(<ConnectorSection />);
      await lands();
    });
  });

  it("keeps the connection when the app's setup is what is wrong, and says so", async () => {
    await connected();
    api.importItems.mockRejectedValue(new RoomApiError("connector_setup"));
    const calls = api.fetchConnection.mock.calls.length;
    fireEvent.click(screen.getByLabelText(t("connector.byJql")));
    fireEvent.change(screen.getByLabelText(t("connector.jql")), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: t("connector.import") }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("scopes");
    expect(alert.textContent).not.toContain("Connect again");
    expect(alert.querySelector("svg")).not.toBeNull();
    expect(api.fetchConnection).toHaveBeenCalledTimes(calls);
    expect(screen.getByRole("button", { name: t("connector.disconnect") })).toBeTruthy();
  });

  it("lets a refused board's alert go when another board is picked", async () => {
    api.fetchSprints.mockRejectedValueOnce(new RoomApiError("connector_unavailable"));
    api.fetchBoards.mockResolvedValue({
      boards: [
        { id: 1, name: "Broken" },
        { id: 2, name: "Fine" },
      ],
      more: false,
    });
    await connected();
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText(t("connector.board")), { target: { value: "2" } });
    await screen.findByLabelText(t("connector.sprint"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a board has no sprint to pick when the answer is empty", async () => {
    api.fetchSprints.mockResolvedValue([]);
    await connected();
    await screen.findByText(t("connector.noSprints"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("the focus after a change", () => {
    const focused = (name: string) =>
      waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name })));

    it("goes to the control that changes a saved site", async () => {
      showRoom();
      api.fetchConnection.mockResolvedValueOnce({ connected: true });
      api.fetchConnection.mockResolvedValue({
        connected: true,
        site: { id: "a", name: "Acme" },
        field: { id: "f", name: "F" },
      });
      render(<ConnectorSection />);
      const save = await screen.findByRole("button", { name: t("connector.siteSave") });
      save.focus();
      fireEvent.click(save);
      await focused(t("connector.siteChange"));
    });

    it("goes to the control that changes a saved field", async () => {
      showRoom();
      api.fetchConnection.mockResolvedValue({ connected: true, site: { id: "a", name: "Acme" } });
      render(<ConnectorSection />);
      const save = await screen.findByRole("button", { name: t("connector.fieldSave") });
      save.focus();
      fireEvent.click(save);
      await focused(t("connector.fieldChange"));
    });

    it("keeps the field's list open when saving it failed", async () => {
      showRoom();
      api.fetchConnection.mockResolvedValue({ connected: true, site: { id: "a", name: "Acme" } });
      api.chooseField.mockRejectedValue(new RoomApiError("connector_unavailable"));
      render(<ConnectorSection />);
      fireEvent.click(await screen.findByRole("button", { name: t("connector.fieldSave") }));
      await screen.findByRole("alert");
      expect(screen.getByLabelText(t("connector.field"))).toBeTruthy();
    });

    it("goes to Connect after a disconnect", async () => {
      await connected();
      api.fetchConnection.mockResolvedValue({ connected: false });
      const press = screen.getByRole("button", { name: t("connector.disconnect") });
      press.focus();
      fireEvent.click(press);
      await focused("Connect Jira");
    });

    it("stays where the person moved it", async () => {
      await connected();
      const outside = document.createElement("button");
      document.body.append(outside);
      api.fetchConnection.mockResolvedValue({ connected: false });
      fireEvent.click(screen.getByRole("button", { name: t("connector.disconnect") }));
      outside.focus();
      await screen.findByRole("button", { name: "Connect Jira" });
      await new Promise((done) => requestAnimationFrame(done));
      expect(document.activeElement).toBe(outside);
      outside.remove();
    });
  });

  it("disconnects, and says where Atlassian keeps its own grant", async () => {
    await connected();
    const link = screen.getByRole("link", { name: t("connector.grantsLink") });
    expect(link.getAttribute("href")).toBe("https://id.atlassian.com/manage-profile/apps");
    api.fetchConnection.mockResolvedValue({ connected: false });
    fireEvent.click(screen.getByRole("button", { name: t("connector.disconnect") }));
    await screen.findByRole("button", { name: "Connect Jira" });
    expect(api.disconnect).toHaveBeenCalledWith("jira");
  });
});

describe("the lines under the table", () => {
  const round = (number: number, final?: string, system: "jira" | null = "jira") =>
    ({
      number,
      startedAt: number * 1000,
      phase: final === undefined ? "voting" : "revealed",
      subject: { kind: "link", url: "https://a/browse/ABC-1", key: "ABC-1" },
      ...(final === undefined ? {} : { final }),
      ...(system ? { system } : {}),
    }) as unknown as RoundView;

  const finalSet = (card: string): Snapshot["causes"] => [{ type: "finalSet", card }];

  /** A frame of the room, through the store, as the socket delivers it. */
  function frame(view: RoundView | null, causes: Snapshot["causes"] = [], version = held() + 1) {
    const base = toSnapshot(createRoom({ ownerId: PO }), PO, { code: CODE, version, now: 0 });
    const snapshot = { ...base, room: { ...base.room, round: view }, causes } as Snapshot;
    act(() => {
      useRoomStore.getState().receive(snapshot);
    });
  }
  const held = () => useRoomStore.getState().snapshot?.version ?? 0;

  /** The PO's own press of a final here, its frame and its answer, in the server's order. */
  function recordHere(number: number, card: string) {
    const settle = markFinalPress(CODE, round(number), card);
    frame(round(number, card), finalSet(card));
    settle({ ok: true, version: held() });
  }

  const waiting = (card: string) =>
    screen.findByText(t("connector.write.waiting", { item: "ABC-1", card, system: "Jira" }));
  const written = (card: string) =>
    screen.findByText(t("connector.write.written", { item: "ABC-1", card, system: "Jira" }));

  beforeEach(() => {
    forgetFinalPress();
    act(() => useRoomStore.getState().open(CODE));
    api.writeBack.mockResolvedValue({ key: "ABC-1", value: 5 });
  });

  it("writes a final this tab recorded, on its frame, once, by the round's number", async () => {
    frame(round(1));
    render(<Lines />);
    recordHere(1, "5");
    await written("5");
    frame(round(1, "5"));
    expect(api.writeBack).toHaveBeenCalledTimes(1);
    expect(api.writeBack).toHaveBeenCalledWith("jira", CODE, 1);
    recordHere(1, "8");
    await waitFor(() => expect(api.writeBack).toHaveBeenCalledTimes(2));
  });

  it("writes a press whose frame beat the lines' chunk, when the lines arrive", async () => {
    frame(round(1));
    recordHere(1, "5");
    render(<Lines />);
    await written("5");
    expect(api.writeBack).toHaveBeenCalledTimes(1);
  });

  it("writes a press whose frame comes after its answer", async () => {
    frame(round(1));
    render(<Lines />);
    const settle = markFinalPress(CODE, round(1), "5");
    const next = held() + 1;
    settle({ ok: true, version: next });
    frame(round(1, "5"), finalSet("5"), next);
    await written("5");
  });

  it("waits for a press on a final found at re-entry, and a press writes it", async () => {
    frame(round(1, "5"));
    render(<Lines />);
    await waiting("5");
    expect(api.writeBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Write to Jira" }));
    await written("5");
    expect(api.writeBack).toHaveBeenCalledWith("jira", CODE, 1);
  });

  it("waits on a final that came in a snapshot, even if this tab pressed that card", async () => {
    frame(round(1));
    render(<Lines />);
    markFinalPress(CODE, round(1), "5");
    frame(round(1, "5"));
    await waiting("5");
    expect(api.writeBack).not.toHaveBeenCalled();
  });

  it("waits on a final recorded in another tab or on another device", async () => {
    frame(round(1));
    render(<Lines />);
    frame(round(1, "5"), finalSet("5"));
    await waiting("5");
    expect(api.writeBack).not.toHaveBeenCalled();
  });

  it("waits on a final someone else recorded before handing the role back", async () => {
    // The lines stay up throughout: the PO's seat in the page never changed.
    frame(round(1));
    render(<Lines />);
    frame(round(1), [{ type: "ownerChanged", by: "claim", to: "stranger" }]);
    frame(round(1, "13"), finalSet("13"));
    frame(round(1, "13"), [{ type: "ownerChanged", by: "transfer", to: PO }]);
    await waiting("13");
    expect(api.writeBack).not.toHaveBeenCalled();
  });

  it("waits when a sleeping tab wakes to a final set while it slept", async () => {
    frame(round(1));
    render(<Lines />);
    recordHere(1, "5");
    await written("5");
    frame(round(2));
    // Asleep: frames are missed. The socket comes back with `enter`, whose snapshot has no causes.
    frame(round(2, "13"), [], held() + 40);
    await waiting("13");
    expect(api.writeBack).toHaveBeenCalledTimes(1);
  });

  it("waits when a tab slept on an unanswered press and someone recorded that card", async () => {
    frame(round(1));
    render(<Lines />);
    const settle = markFinalPress(CODE, round(1), "13");
    settle({ ok: false });
    frame(round(1, "13"), finalSet("13"));
    await waiting("13");
    expect(api.writeBack).not.toHaveBeenCalled();
  });

  it("does not take another card, round or item for the press", async () => {
    frame(round(1));
    render(<Lines />);
    markFinalPress(CODE, round(1), "5");
    frame(round(1, "8"), finalSet("8"));
    await waiting("8");
    markFinalPress(CODE, round(1), "5");
    frame(round(2, "5"), finalSet("5"));
    await waiting("5");
    const restarted = { ...round(2, "3"), startedAt: 9 } as RoundView;
    markFinalPress(CODE, round(2), "3");
    frame(restarted, finalSet("3"));
    await waiting("3");
    const other = {
      ...round(3, "2"),
      subject: { kind: "link", url: "https://a/browse/ABC-2", key: "ABC-2" },
    } as RoundView;
    markFinalPress(CODE, round(3), "2");
    frame(other, finalSet("2"));
    await screen.findByText(
      t("connector.write.waiting", { item: "ABC-2", card: "2", system: "Jira" }),
    );
    expect(api.writeBack).not.toHaveBeenCalled();
  });

  it("does not count another card's frame as the press, for a final set later", async () => {
    frame(round(1));
    render(<Lines />);
    const settle = markFinalPress(CODE, round(1), "5");
    frame(round(1, "8"), finalSet("8"));
    settle({ ok: true, version: held() });
    frame(round(1, "5"), finalSet("5"));
    await waiting("5");
    expect(api.writeBack).not.toHaveBeenCalled();
  });

  it("does not take a frame past the press's answer, or one for a press that changed nothing", async () => {
    frame(round(1));
    render(<Lines />);
    const settle = markFinalPress(CODE, round(1), "5");
    const answered = held() + 1;
    settle({ ok: true, version: answered });
    frame(round(1, "5"), finalSet("5"), answered + 1);
    await waiting("5");
    frame(round(2));
    const nothing = markFinalPress(CODE, round(2), "8");
    nothing({ ok: true, version: held() });
    frame(round(2, "8"), finalSet("8"));
    await waiting("8");
    expect(api.writeBack).not.toHaveBeenCalled();
  });

  it("writes nothing for a round with no final, or from no tracker", () => {
    frame(round(1));
    render(<Lines />);
    recordHere(1, "5");
    cleanup();
    forgetFinalPress();
    act(() => useRoomStore.getState().reset());
    act(() => useRoomStore.getState().open(CODE));
    api.writeBack.mockClear();
    frame(round(1));
    render(<Lines />);
    const settle = markFinalPress(CODE, round(1, undefined, null), "5");
    frame(round(1, "5", null), finalSet("5"));
    settle({ ok: true, version: held() });
    expect(api.writeBack).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a failure through the next round, and a retry clears it", async () => {
    api.writeBack.mockRejectedValueOnce(new RoomApiError("connector_timeout"));
    frame(round(1));
    render(<Lines />);
    recordHere(1, "5");
    await screen.findByRole("button", { name: t("connector.write.retry") });
    frame(round(2));
    expect(screen.getByRole("alert").textContent).toContain("ABC-1");
    fireEvent.click(screen.getByRole("button", { name: t("connector.write.retry") }));
    await waitFor(() => expect(api.writeBack).toHaveBeenLastCalledWith("jira", CODE, 1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("says a final with no number stays, and offers no retry", async () => {
    api.writeBack.mockRejectedValue(new RoomApiError("connector_not_numeric"));
    frame(round(1));
    render(<Lines />);
    recordHere(1, "M");
    expect((await screen.findByRole("alert")).textContent).toContain("Only a number");
    expect(screen.queryByRole("button", { name: t("connector.write.retry") })).toBeNull();
  });

  it("can be dismissed, and draws a failure as the room's own", async () => {
    api.writeBack.mockRejectedValue(new RoomApiError("connector_unavailable"));
    frame(round(1));
    render(<Lines />);
    recordHere(1, "5");
    const alert = await screen.findByRole("alert");
    expect(alert.querySelector("svg")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("connector.write.dismiss") }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the lines in the room", () => {
  const room = {
    code: CODE,
    round: {
      number: 1,
      startedAt: 1000,
      phase: "revealed",
      final: "5",
      subject: { kind: "link", url: "https://a/browse/ABC-1", key: "ABC-1" },
      system: "jira",
    },
  } as unknown as RoomView;

  function on() {
    const tag = document.createElement("meta");
    tag.name = CONNECTOR_META;
    tag.content = "jira";
    document.head.append(tag);
  }

  it("load nothing where the install has no tracker, whatever a round says", async () => {
    const { container } = render(<TrackerLines room={room} />);
    await act(async () => {
      await import("./write-back.tsx");
    });
    expect(container.textContent).toBe("");
  });

  it("come up where it has one", async () => {
    on();
    render(<TrackerLines room={room} />);
    await screen.findByRole("button", { name: "Write to Jira" });
  });
});

describe("a tracker's chunk that cannot load", () => {
  it("says so in a toast with a reload, and leaves the page alone", async () => {
    toast.mockClear();
    const load = () => Promise.reject(new Error("Failed to fetch dynamically imported module"));
    render(<Part load={load} />);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(screen.getByText("the room")).toBeTruthy();
    const [message, options] = toast.mock.calls[0] ?? [];
    expect(message).toBe(t("connector.loadFailed", { system: "Jira" }));
    expect((options as { action: { label: string } }).action.label).toBe(t("room.reload"));
  });

  it("gives the part once it arrives", async () => {
    const load = async () => ({ text: "the part" });
    render(<Part load={load} />);
    await screen.findByText("the part");
  });
});

describe("a past round's press", () => {
  const past = {
    number: 3,
    final: "5",
    system: "jira",
  } as unknown as Parameters<typeof HistoryWrite>[0]["round"];

  function on() {
    const tag = document.createElement("meta");
    tag.name = CONNECTOR_META;
    tag.content = "jira";
    document.head.append(tag);
  }

  it("is for the PO of a round from a tracker that has a final", () => {
    on();
    showRoom("ana");
    const { container } = render(<HistoryWrite round={past} />);
    expect(container.textContent).toBe("");
    cleanup();
    showRoom();
    render(<HistoryWrite round={{ ...past, final: null }} />);
    render(<HistoryWrite round={{ ...past, system: undefined } as typeof past} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is not there while the connector is dark", () => {
    showRoom();
    render(<HistoryWrite round={past} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("writes that round, and says how it went", async () => {
    on();
    showRoom();
    api.writeBack.mockRejectedValueOnce(new RoomApiError("connector_other_site"));
    render(<HistoryWrite round={past} />);
    const press = screen.getByRole("button", { name: "Write to Jira" });
    fireEvent.click(press);
    expect((await screen.findByRole("alert")).textContent).toContain("another Jira site");
    api.writeBack.mockResolvedValue({ key: null, value: 5 });
    fireEvent.click(press);
    await screen.findByText(t("connector.write.done", { system: "Jira" }));
    expect(api.writeBack).toHaveBeenCalledWith("jira", CODE, 3);
  });
});
