import { createRoom, type RoomState } from "@pp/domain";
import { CONNECTOR_META, type RoundView, toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, fixedT } from "../i18n/i18n.ts";
import { RoomApiError } from "../rooms/api.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { AzureSection } from "./azure-section.tsx";
import { connectorMessage, connectorOf, connectorOn } from "./connector.ts";
import { HistoryWrite } from "./history-write.tsx";
import { TrackerLines } from "./tracker-lines.tsx";
import { WriteBackLines } from "./write-back.tsx";

const api = vi.hoisted(() => ({
  fetchConnection: vi.fn(),
  connectAzure: vi.fn(),
  disconnect: vi.fn(),
  fetchSites: vi.fn(),
  chooseSite: vi.fn(),
  fetchTypes: vi.fn(),
  fetchTypeFields: vi.fn(),
  chooseTypedField: vi.fn(),
  clearField: vi.fn(),
  fetchSavedQueries: vi.fn(),
  importItems: vi.fn(),
  writeBack: vi.fn(),
}));
vi.mock("./connector-api.ts", () => api);

const CODE = "abcdefghij";
const PO = "po";
const TOKEN = "a-token-that-must-not-stay";
const PROJECT = { id: "fabrikam/guid", name: "Fabrikam Fiber" };
const CONNECTED = { connected: true, organization: "fabrikam", site: PROJECT };
const t = fixedT("en");

beforeAll(async () => {
  await changeLanguage("en");
});

function showRoom() {
  act(() => useRoomStore.getState().open(CODE));
  const state: RoomState = {
    ...createRoom({ ownerId: PO }),
    participants: { [PO]: { name: "Pia", role: "voter", joinedAt: 1, connected: true } },
  };
  act(() => {
    useRoomStore.getState().receive(toSnapshot(state, PO, { code: CODE, version: 1, now: 0 }));
  });
}

const signIn = (on: boolean) =>
  act(() => useIdentityStore.setState({ email: on ? "a@example.com" : null, provider: null }));

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  signIn(true);
  showRoom();
  api.fetchConnection.mockResolvedValue({ connected: false });
  api.connectAzure.mockResolvedValue(undefined);
  api.fetchSites.mockResolvedValue([PROJECT, { id: "fabrikam/two", name: "Second" }]);
  api.fetchTypes.mockResolvedValue(["User Story", "Task"]);
  api.fetchTypeFields.mockImplementation(async (_name: string, type: string) =>
    type === "Task"
      ? { fields: [] }
      : {
          fields: [
            { id: "Custom.Points", name: "Points" },
            { id: "Microsoft.VSTS.Scheduling.StoryPoints", name: "Story Points" },
          ],
          guess: "Microsoft.VSTS.Scheduling.StoryPoints",
        },
  );
  api.fetchSavedQueries.mockResolvedValue({
    queries: [
      { id: "q1", name: "My Queries/Mine" },
      { id: "q2", name: "Shared Queries/Backlog" },
    ],
    more: false,
  });
  api.importItems.mockResolvedValue({
    added: 2,
    duplicates: 0,
    shortened: 0,
    leftOut: 0,
    beyond: 0,
  });
});

afterEach(() => {
  cleanup();
  document.head.querySelector(`meta[name="${CONNECTOR_META}"]`)?.remove();
  act(() => useRoomStore.getState().reset());
});

const field = (name: string | RegExp) => screen.getByLabelText(name) as HTMLInputElement;

async function shownForm() {
  render(<AzureSection />);
  await screen.findByRole("button", { name: "Connect Azure DevOps" });
}

function fill(organization: string, token: string) {
  fireEvent.change(field("Organisation"), { target: { value: organization } });
  fireEvent.change(field("Personal access token"), { target: { value: token } });
}

const connect = () => fireEvent.click(screen.getByRole("button", { name: "Connect Azure DevOps" }));

describe("the section before a connection", () => {
  it("asks a guest to sign in, and offers no field", async () => {
    signIn(false);
    render(<AzureSection />);
    expect(screen.getByText("Sign in with an account to connect Azure DevOps.")).toBeTruthy();
    expect(screen.queryByLabelText("Personal access token")).toBeNull();
    expect(api.fetchConnection).not.toHaveBeenCalled();
  });

  it("hides the token: a password field with nothing to remember", async () => {
    await shownForm();
    const input = field("Personal access token");
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    expect(field("Organisation").autocomplete).toBe("off");
  });

  it("says what a token is used for, its one scope and its life", async () => {
    await shownForm();
    const text = document.body.textContent ?? "";
    expect(text).toContain("a single scope ticked: Work Items, Read & write");
    expect(text).toContain("only to read what you import and to write your estimates");
    expect(text).toContain("until it expires or you disconnect");
    expect(text).toContain("the shortest life that suits you");
  });

  it("links to where tokens are made, in the organisation typed", async () => {
    await shownForm();
    const link = () => screen.getByRole("link", { name: "Make a token" }).getAttribute("href");
    expect(link()).toContain("learn.microsoft.com");
    fireEvent.change(field("Organisation"), { target: { value: "fabrikam" } });
    expect(link()).toBe("https://dev.azure.com/fabrikam/_usersSettings/tokens");
    fireEvent.change(field("Organisation"), { target: { value: "evil.example/x" } });
    expect(link()).toContain("learn.microsoft.com");
  });

  it("sends the name and the token once, and clears the field at that moment", async () => {
    let finish = () => {};
    api.connectAzure.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await shownForm();
    fill(" fabrikam ", ` ${TOKEN} `);
    connect();
    expect(api.connectAzure).toHaveBeenCalledWith("fabrikam", TOKEN);
    expect(field("Personal access token").value).toBe("");
    connect();
    expect(api.connectAzure).toHaveBeenCalledTimes(1);
    api.fetchConnection.mockResolvedValue(CONNECTED);
    await act(async () => finish());
    await screen.findByText("Connected to fabrikam");
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("clears the token after a refusal too, and says why by the code", async () => {
    api.connectAzure.mockRejectedValue(new RoomApiError("connector_bad_token"));
    await shownForm();
    fill("fabrikam", TOKEN);
    connect();
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe(
      "Azure DevOps did not take this token. It may be mistyped, expired, or made for another organisation.",
    );
    expect(field("Personal access token").value).toBe("");
    expect(field("Organisation").value).toBe("fabrikam");
  });

  it("does not send a name that cannot be one, or no token", async () => {
    await shownForm();
    fill("https://dev.azure.com/fabrikam", TOKEN);
    connect();
    await waitFor(() =>
      expect(
        document.querySelector("[data-connector-problem]")?.getAttribute("data-connector-problem"),
      ).toBe("connector_bad_organization"),
    );
    fill("fabrikam", "   ");
    connect();
    await waitFor(() =>
      expect(
        document.querySelector("[data-connector-problem]")?.getAttribute("data-connector-problem"),
      ).toBe("connector_bad_token"),
    );
    expect(api.connectAzure).not.toHaveBeenCalled();
  });

  it("does not submit the room's form around it", async () => {
    const outer = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    render(
      <form onSubmit={outer}>
        <AzureSection />
      </form>,
    );
    await screen.findByRole("button", { name: "Connect Azure DevOps" });
    fill("fabrikam", TOKEN);
    connect();
    await waitFor(() => expect(api.connectAzure).toHaveBeenCalled());
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("the section when connected", () => {
  beforeEach(() => {
    api.fetchConnection.mockResolvedValue(CONNECTED);
  });

  it("picks a project from the person's own list", async () => {
    api.fetchConnection.mockResolvedValue({ connected: true, organization: "fabrikam" });
    render(<AzureSection />);
    const select = await screen.findByRole("combobox", { name: "Project" });
    fireEvent.change(select, { target: { value: "fabrikam/two" } });
    api.chooseSite.mockResolvedValue(undefined);
    api.fetchConnection.mockResolvedValue({
      ...CONNECTED,
      site: { id: "fabrikam/two", name: "Second" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this project" }));
    await screen.findByText("Project: Second");
    expect(api.chooseSite).toHaveBeenCalledWith("azure-devops", "fabrikam/two");
  });

  it("says when the token reaches no project", async () => {
    api.fetchConnection.mockResolvedValue({ connected: true, organization: "fabrikam" });
    api.fetchSites.mockResolvedValue([]);
    render(<AzureSection />);
    await screen.findByText("This token reaches no project in that organisation.");
  });

  it("changes project, and offers no import while it does", async () => {
    render(<AzureSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Change project" }));
    await screen.findByRole("combobox", { name: "Project" });
    expect(document.querySelector("[data-connector-import]")).toBeNull();
  });

  it("says estimates go to the type's own field until a person chooses", async () => {
    render(<AzureSection />);
    await screen.findByText(
      "Estimates go to the field each item’s type carries: Story Points, Effort or Size.",
    );
    expect(screen.queryByRole("button", { name: "Use each type’s own field" })).toBeNull();
  });

  it("chooses a field from a type's own number fields", async () => {
    api.chooseTypedField.mockResolvedValue(undefined);
    render(<AzureSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose a field" }));
    const type = await screen.findByRole("combobox", { name: "Work item type" });
    const chosen = (await screen.findByRole("combobox", {
      name: "Estimates go to",
    })) as HTMLSelectElement;
    expect(chosen.value).toBe("Microsoft.VSTS.Scheduling.StoryPoints");
    fireEvent.change(chosen, { target: { value: "Custom.Points" } });
    api.fetchConnection.mockResolvedValue({
      ...CONNECTED,
      field: { id: "Custom.Points", name: "Points" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save the field" }));
    await screen.findByText("Estimates go to Points");
    expect(api.chooseTypedField).toHaveBeenCalledWith(
      "azure-devops",
      "Custom.Points",
      "User Story",
    );
    expect(type).toBeTruthy();
  });

  it("says a type has no number field, with nothing to save", async () => {
    render(<AzureSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose a field" }));
    const type = await screen.findByRole("combobox", { name: "Work item type" });
    fireEvent.change(type, { target: { value: "Task" } });
    await screen.findByText("This type has no number field.");
    expect(screen.queryByRole("button", { name: "Save the field" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Choose a field" });
  });

  it("goes back to each type's own field", async () => {
    api.fetchConnection.mockResolvedValue({
      ...CONNECTED,
      field: { id: "Custom.Points", name: "Points" },
    });
    api.clearField.mockResolvedValue(undefined);
    render(<AzureSection />);
    const reset = await screen.findByRole("button", { name: "Use each type’s own field" });
    api.fetchConnection.mockResolvedValue(CONNECTED);
    fireEvent.click(reset);
    await waitFor(() => expect(api.clearField).toHaveBeenCalledWith("azure-devops"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Use each type’s own field" })).toBeNull(),
    );
  });

  it("imports a saved query", async () => {
    render(<AzureSection />);
    const select = await screen.findByRole("combobox", { name: "Saved query" });
    expect(select.textContent).toContain("Shared Queries/Backlog");
    fireEvent.change(select, { target: { value: "q2" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(document.querySelector("[data-connector-report]")?.textContent).toBe("2 items added."),
    );
    expect(api.importItems).toHaveBeenCalledWith("azure-devops", CODE, { saved: "q2" });
  });

  it("imports by WIQL, and an empty query does not leave", async () => {
    render(<AzureSection />);
    fireEvent.click(await screen.findByRole("radio", { name: "A WIQL query" }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("Pick a saved query or type a query first.");
    expect(api.importItems).not.toHaveBeenCalled();
    const query = screen.getByRole("textbox", { name: "WIQL query" });
    fireEvent.change(query, { target: { value: " Select 1 " } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(api.importItems).toHaveBeenCalledWith("azure-devops", CODE, { wiql: "Select 1" }),
    );
  });

  it("says when there is no saved query, and when the list stopped short", async () => {
    api.fetchSavedQueries.mockResolvedValue({ queries: [], more: false });
    const { unmount } = render(<AzureSection />);
    await screen.findByText("This project has no saved query you can see.");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("Pick a saved query or type a query first.");
    unmount();
    api.fetchSavedQueries.mockResolvedValue({ queries: [{ id: "q", name: "Q" }], more: true });
    render(<AzureSection />);
    await screen.findByText("Some folders were not read, so this list is not complete.");
  });

  it("shows a refused import, and a token found dead goes back to the form", async () => {
    render(<AzureSection />);
    await screen.findByRole("combobox", { name: "Saved query" });
    await waitFor(() => expect(api.fetchSavedQueries).toHaveBeenCalled());
    api.importItems.mockRejectedValue(new RoomApiError("connector_reconnect"));
    api.fetchConnection.mockResolvedValue({ connected: false });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByLabelText("Personal access token");
    expect(screen.getByRole("alert").textContent).toBe(
      "Azure DevOps no longer accepts this connection. Connect again.",
    );
  });

  it("disconnects, says the token lives on at Microsoft, and where to revoke it", async () => {
    api.disconnect.mockResolvedValue(undefined);
    render(<AzureSection />);
    const button = await screen.findByRole("button", { name: "Disconnect" });
    expect(document.body.textContent).toContain(
      "It still exists at Microsoft until it expires or you revoke it:",
    );
    expect(
      screen.getByRole("link", { name: "revoke it in Azure DevOps" }).getAttribute("href"),
    ).toBe("https://dev.azure.com/fabrikam/_usersSettings/tokens");
    api.fetchConnection.mockResolvedValue({ connected: false });
    fireEvent.click(button);
    await screen.findByLabelText("Personal access token");
    expect(api.disconnect).toHaveBeenCalledWith("azure-devops");
  });
});

describe("words", () => {
  it.each([
    ["connector_no_site", "Pick an Azure DevOps project in the queue first."],
    ["connector_bad_site", "That project is not on your list any more."],
    ["connector_bad_field", "That field is not a number field of this work item type."],
    [
      "connector_other_site",
      "This item belongs to another Azure DevOps organisation than the one you are connected to.",
    ],
    ["connector_no_source", "This item did not come from Azure DevOps."],
    [
      "connector_field_refused",
      "Azure DevOps refused this number on this item: a rule of its type may forbid it.",
    ],
  ])("says %s in Azure DevOps' own terms", (code, words) => {
    expect(connectorMessage(t, code, "azure-devops")).toBe(words);
  });

  it("leaves Jira's words alone", () => {
    expect(connectorMessage(t, "connector_other_site", "jira")).toBe(
      "This item belongs to another Jira site than the one you are connected to.",
    );
  });

  it("names a round's connector", () => {
    expect(connectorOf("ado")).toBe("azure-devops");
    expect(connectorOf("jira")).toBe("jira");
  });

  it("uses a French elision a template cannot", async () => {
    await changeLanguage("fr");
    expect(connectorMessage(fixedT("fr"), "connector_no_source", "azure-devops")).toBe(
      "Cet élément ne vient pas d’Azure DevOps.",
    );
    await changeLanguage("en");
  });
});

describe("the lines of a round from Azure DevOps", () => {
  const round = {
    number: 1,
    phase: "revealed",
    startedAt: 5,
    system: "ado",
    final: "5",
    subject: { kind: "link", url: "https://dev.azure.com/fabrikam/_workitems/edit/1", key: "1" },
  } as unknown as RoundView;

  it("waits for a press, and writes with this connector's name", async () => {
    api.writeBack.mockResolvedValue({ key: "1", value: 5 });
    render(<WriteBackLines code={CODE} round={round} name="azure-devops" />);
    const press = await screen.findByRole("button", { name: "Write to Azure DevOps" });
    expect(api.writeBack).not.toHaveBeenCalled();
    fireEvent.click(press);
    await screen.findByText("#1: 5 is in Azure DevOps.");
    expect(api.writeBack).toHaveBeenCalledWith("azure-devops", CODE, 1);
  });

  it("takes no round of another tracker's", () => {
    render(<WriteBackLines code={CODE} round={round} name="jira" />);
    expect(document.querySelector("[data-write-line]")).toBeNull();
  });

  it("reads an item with no estimate as nothing to try again", async () => {
    api.writeBack.mockRejectedValue(new RoomApiError("connector_no_estimate_field"));
    render(<WriteBackLines code={CODE} round={round} name="azure-devops" />);
    fireEvent.click(await screen.findByRole("button", { name: "Write to Azure DevOps" }));
    await screen.findByText(/This item has no estimate field/);
    expect(document.querySelector("[data-write-line=kept]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("loads the lines in the room for this tracker alone", async () => {
    const tag = document.createElement("meta");
    tag.name = CONNECTOR_META;
    tag.content = "azure-devops";
    document.head.append(tag);
    expect(connectorOn("azure-devops")).toBe(true);
    const room = useRoomStore.getState().snapshot?.room;
    if (!room) throw new Error("no room");
    render(<TrackerLines room={{ ...room, round }} />);
    await screen.findByRole("button", { name: "Write to Azure DevOps" });
    expect(document.querySelectorAll("[data-write-line]")).toHaveLength(1);
  });

  it("has a press on a past round, for the PO", async () => {
    const tag = document.createElement("meta");
    tag.name = CONNECTOR_META;
    tag.content = "azure-devops";
    document.head.append(tag);
    api.writeBack.mockResolvedValue({ key: "1", value: 5 });
    const past = { number: 2, final: "8", system: "ado" } as never;
    render(<HistoryWrite round={past} />);
    fireEvent.click(screen.getByRole("button", { name: "Write to Azure DevOps" }));
    await screen.findByText("Written to Azure DevOps.");
    expect(api.writeBack).toHaveBeenCalledWith("azure-devops", CODE, 2);
  });
});
