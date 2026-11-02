import { createRoom, type RoomState } from "@pp/domain";
import { CONNECTOR_META, type ConnectorImportView, type RoundView, toSnapshot } from "@pp/protocol";
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
import { ConnectorSection, importReport } from "./connector-section.tsx";
import { HistoryWrite } from "./history-write.tsx";
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
      phase: final === undefined ? "voting" : "revealed",
      subject: { kind: "link", url: "https://a/browse/ABC-1", key: "ABC-1" },
      ...(final === undefined ? {} : { final }),
      ...(system ? { system } : {}),
    }) as unknown as RoundView;

  it("waits for a press on a final that was there when the page came up", async () => {
    api.writeBack.mockResolvedValue({ key: "ABC-1", value: 5 });
    render(<WriteBackLines code={CODE} round={round(1, "5")} />);
    expect(api.writeBack).not.toHaveBeenCalled();
    expect(
      screen.getByText(t("connector.write.waiting", { item: "ABC-1", card: "5" })),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Write to Jira" }));
    await screen.findByText(
      t("connector.write.written", { item: "ABC-1", card: "5", system: "Jira" }),
    );
    expect(api.writeBack).toHaveBeenCalledWith("jira", CODE, 1);
  });

  it("writes a recorded final by itself, once for each final, by the round's number", async () => {
    api.writeBack.mockResolvedValue({ key: "ABC-1", value: 5 });
    const view = render(<WriteBackLines code={CODE} round={round(1)} />);
    view.rerender(<WriteBackLines code={CODE} round={round(1, "5")} />);
    await screen.findByText(
      t("connector.write.written", { item: "ABC-1", card: "5", system: "Jira" }),
    );
    view.rerender(<WriteBackLines code={CODE} round={round(1, "5")} />);
    expect(api.writeBack).toHaveBeenCalledTimes(1);
    expect(api.writeBack).toHaveBeenCalledWith("jira", CODE, 1);
    view.rerender(<WriteBackLines code={CODE} round={round(1, "8")} />);
    await waitFor(() => expect(api.writeBack).toHaveBeenCalledTimes(2));
  });

  it("writes nothing for a round with no final, or from no tracker", () => {
    render(<WriteBackLines code={CODE} round={round(1)} />);
    render(<WriteBackLines code={CODE} round={null} />).rerender(
      <WriteBackLines code={CODE} round={round(2, "5", null)} />,
    );
    expect(api.writeBack).not.toHaveBeenCalled();
    render(
      <WriteBackLines
        code={CODE}
        round={{ ...round(2, "5"), system: undefined } as unknown as RoundView}
      />,
    );
    expect(api.writeBack).not.toHaveBeenCalled();
  });

  it("keeps a failure through the next round, and a retry clears it", async () => {
    api.writeBack.mockRejectedValueOnce(new RoomApiError("connector_timeout"));
    const view = render(<WriteBackLines code={CODE} round={round(1)} />);
    view.rerender(<WriteBackLines code={CODE} round={round(1, "5")} />);
    await screen.findByRole("button", { name: t("connector.write.retry") });
    view.rerender(<WriteBackLines code={CODE} round={round(2)} />);
    expect(screen.getByRole("alert").textContent).toContain("ABC-1");
    api.writeBack.mockResolvedValue({ key: "ABC-1", value: 5 });
    fireEvent.click(screen.getByRole("button", { name: t("connector.write.retry") }));
    await waitFor(() => expect(api.writeBack).toHaveBeenLastCalledWith("jira", CODE, 1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("says a final with no number stays, and offers no retry", async () => {
    api.writeBack.mockRejectedValue(new RoomApiError("connector_not_numeric"));
    render(<WriteBackLines code={CODE} round={round(1)} />).rerender(
      <WriteBackLines code={CODE} round={round(1, "M")} />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Only a number");
    expect(screen.queryByRole("button", { name: t("connector.write.retry") })).toBeNull();
  });

  it("can be dismissed", async () => {
    api.writeBack.mockRejectedValue(new RoomApiError("connector_unavailable"));
    render(<WriteBackLines code={CODE} round={round(1)} />).rerender(
      <WriteBackLines code={CODE} round={round(1, "5")} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: t("connector.write.dismiss") }));
    expect(screen.queryByRole("alert")).toBeNull();
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
