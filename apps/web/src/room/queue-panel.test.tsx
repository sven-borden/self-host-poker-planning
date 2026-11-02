import { createRoom, MAX_QUEUE_ITEMS, type RoomState } from "@pp/domain";
import { type QueueItemView, toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, fixedT } from "../i18n/i18n.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { RoomQueueButton } from "./queue-button.tsx";
import { movedItem, pasteReport } from "./queue-panel.tsx";

const mocks = vi.hoisted(() => ({ requestQueue: vi.fn(), send: vi.fn() }));
vi.mock("../realtime/room-connection.ts", () => ({
  requestQueue: mocks.requestQueue,
  commandSender: () => mocks.send,
}));

const CODE = "abcdefghij";
const PO = "po";

const ITEMS: QueueItemView[] = [
  { id: 1, key: "PAY-1", title: "First", url: "https://j.co/browse/PAY-1" },
  { id: 2, key: "12345", title: "Second" },
  { id: 3, title: "Third" },
];

function roomWith(rev: number, count: number): RoomState {
  const room = createRoom({ ownerId: PO });
  return {
    ...room,
    participants: { [PO]: { name: "Pia", role: "voter", joinedAt: 1, connected: true } },
    ...(count > 0
      ? {
          queue: {
            items: Array.from({ length: count }, (_, n) => ({ id: n + 1, title: `t${n}` })),
            lastId: count,
            rev,
          },
        }
      : {}),
  };
}

let version = 1;
function show(state: RoomState) {
  act(() => {
    version += 1;
    useRoomStore.getState().receive(toSnapshot(state, PO, { code: CODE, version, now: 0 }));
    useRoomStore.getState().setStatus("live");
  });
}

async function open(items = ITEMS) {
  mocks.requestQueue.mockResolvedValue({ ok: true, rev: 1, items });
  render(<RoomQueueButton count={items.length} />);
  fireEvent.click(screen.getByRole("button", { name: /Queue/ }));
  const dialog = await screen.findByRole("dialog", { name: "Queue" });
  if (items.length > 0) await within(dialog).findByRole("list", { name: "Items in the queue" });
  else await within(dialog).findByText("Nothing in the queue yet.");
  return dialog;
}

const titles = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll("[data-queue-item]")].map((row) =>
    row.getAttribute("data-queue-item"),
  );

const paste = async (dialog: HTMLElement, text: string) => {
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Paste your tickets" }), {
    target: { value: text },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add to the queue" }));
  await waitFor(() =>
    expect(dialog.querySelector("[data-queue-report]")?.textContent).not.toBe(""),
  );
};

beforeAll(() => changeLanguage("en"));

beforeEach(() => {
  mocks.requestQueue.mockReset();
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ ok: true, version: 9 });
  show(roomWith(1, 3));
});

afterEach(() => {
  cleanup();
  useRoomStore.getState().reset?.();
});

describe("the queue button", () => {
  it("names the queue and says how many wait", () => {
    render(<RoomQueueButton count={12} />);
    expect(screen.getByRole("button", { name: "Queue 12 items" })).toBeTruthy();
  });

  it("shows no count on an empty queue", () => {
    render(<RoomQueueButton count={0} />);
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
  });
});

describe("the sheet", () => {
  it("asks for the list on open and shows each item with its name", async () => {
    const dialog = await open();
    expect(mocks.requestQueue).toHaveBeenCalledTimes(1);
    expect(titles(dialog)).toEqual(["1", "2", "3"]);
    expect(within(dialog).getByRole("link", { name: "PAY-1" }).getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
    expect(within(dialog).getByText("#12345")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Move Third up" })).toBeTruthy();
  });

  it("makes no link of a key without a url, or of an odd url", async () => {
    const dialog = await open([
      { id: 1, key: "PAY-1" },
      { id: 2, key: "PAY-2", url: "ftp://x" },
    ]);
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("says when the list failed, and tries again", async () => {
    mocks.requestQueue.mockResolvedValue({ ok: false, code: "offline" });
    render(<RoomQueueButton count={1} />);
    fireEvent.click(screen.getByRole("button", { name: /Queue/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("The queue could not be loaded.");
    mocks.requestQueue.mockResolvedValue({ ok: true, rev: 1, items: ITEMS });
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await within(dialog).findByRole("list", { name: "Items in the queue" });
  });

  it("asks again when the snapshot's rev moves", async () => {
    await open();
    show(roomWith(2, 3));
    await waitFor(() => expect(mocks.requestQueue).toHaveBeenCalledTimes(2));
  });
});

describe("moving", () => {
  it("moves an item at once, sends it, says it, and keeps the focus on the button", async () => {
    const dialog = await open();
    const down = within(dialog).getByRole("button", { name: "Move PAY-1 down" });
    down.focus();
    fireEvent.click(down);
    expect(titles(dialog)).toEqual(["2", "1", "3"]);
    expect(mocks.send).toHaveBeenCalledWith({ type: "queueMove", payload: { id: 1, to: 1 } });
    await waitFor(() =>
      expect(dialog.querySelector("[data-queue-live]")?.textContent).toBe(
        "PAY-1 is now number 2 of 3.",
      ),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Move PAY-1 down");
  });

  it("marks the ends: the first cannot go up, the last cannot go down", async () => {
    const dialog = await open();
    const up = within(dialog).getByRole("button", { name: "Move PAY-1 up" });
    expect(up.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(up);
    const down = within(dialog).getByRole("button", { name: "Move Third down" });
    expect(down.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(down);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("drags by the grip to another row", async () => {
    const dialog = await open();
    const rows = [...dialog.querySelectorAll<HTMLElement>("[data-queue-item]")];
    rows.forEach((row, n) => {
      row.getBoundingClientRect = () => ({ top: n * 50, bottom: (n + 1) * 50 }) as DOMRect;
    });
    const grip = rows[0]?.querySelector<HTMLElement>("[data-queue-grip]");
    if (!grip) throw new Error("no grip");
    grip.setPointerCapture = () => {};
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 10 });
    const move = new Event("pointermove", { bubbles: true });
    Object.assign(move, { clientY: 120 });
    act(() => {
      grip.dispatchEvent(move);
    });
    await waitFor(() => expect(rows[2]?.getAttribute("data-drop")).toBe("after"));
    const up = new Event("pointerup", { bubbles: true });
    Object.assign(up, { clientY: 120 });
    act(() => {
      grip.dispatchEvent(up);
    });
    expect(mocks.send).toHaveBeenCalledWith({ type: "queueMove", payload: { id: 1, to: 2 } });
  });
});

describe("removing", () => {
  it("removes an item and moves the focus to its neighbour", async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove PAY-1" }));
    expect(titles(dialog)).toEqual(["2", "3"]);
    expect(mocks.send).toHaveBeenCalledWith({ type: "queueRemove", payload: { id: 1 } });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Remove #12345");
    await waitFor(() =>
      expect(dialog.querySelector("[data-queue-live]")?.textContent).toBe("PAY-1 removed."),
    );
  });

  it("clears the queue only after asking", async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear the queue" }));
    await within(dialog).findByText("Remove all 3 items?");
    expect(mocks.send).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Keep them"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep them" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear the queue" }));
    // The next read finds it empty, or it would bring the rows back under this test.
    mocks.requestQueue.mockResolvedValue({ ok: true, rev: 2, items: [] });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Remove all" }));
    expect(mocks.send).toHaveBeenCalledWith({ type: "queueClear" });
    await within(dialog).findByText("Nothing in the queue yet.");
  });

  it("shows a refusal", async () => {
    mocks.send.mockResolvedValue({ ok: false, code: "unknown_item" });
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove PAY-1" }));
    await within(dialog).findByText("That item is no longer in the queue.");
  });
});

describe("pasting", () => {
  it("never reaches the subject field's form, which the sheet sits in", async () => {
    mocks.requestQueue.mockResolvedValue({ ok: true, rev: 1, items: ITEMS });
    const outer = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    render(
      <form onSubmit={outer}>
        <RoomQueueButton count={3} />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Queue/ }));
    const dialog = await screen.findByRole("dialog", { name: "Queue" });
    await within(dialog).findByRole("list", { name: "Items in the queue" });
    await paste(dialog, "PAY-9");
    expect(outer).not.toHaveBeenCalled();
  });

  it("sends one command for the whole list, and says what happened", async () => {
    const dialog = await open();
    await paste(dialog, "PAY-1\nPAY-9 New one\nPlain line");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({
      type: "queueAdd",
      payload: { items: [{ key: "PAY-9", title: "New one" }, { title: "Plain line" }] },
    });
    expect(dialog.querySelector("[data-queue-report]")?.textContent).toBe(
      "2 items added. 1 duplicate dropped.",
    );
    const box = within(dialog).getByRole("textbox", { name: "Paste your tickets" });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("sends nothing for a list with nothing new", async () => {
    const dialog = await open();
    await paste(dialog, "PAY-1");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(dialog.querySelector("[data-queue-report]")?.textContent).toBe(
      "Nothing new to add. 1 duplicate dropped.",
    );
  });

  it("asks for a list on an empty press", async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to the queue" }));
    expect(dialog.querySelector("[data-queue-report]")?.textContent).toBe("Paste a list first.");
  });

  it("keeps the text when the send is refused", async () => {
    mocks.send.mockResolvedValue({ ok: false, code: "queue_full" });
    const dialog = await open();
    const box = within(dialog).getByRole("textbox", { name: "Paste your tickets" });
    fireEvent.change(box, { target: { value: "PAY-9" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to the queue" }));
    await within(dialog).findByText(/The queue is full/);
    expect((box as HTMLTextAreaElement).value).toBe("PAY-9");
  });
});

describe("pasteReport", () => {
  const t = fixedT("en");
  it("says every count that is not zero", () => {
    const report = pasteReport(t, {
      items: [{ key: "A-1" }],
      duplicates: 2,
      refused: 1,
      shortened: 1,
      overflow: 3,
    });
    expect(report).toBe(
      `1 item added. 2 duplicates dropped. 1 title was cut to fit. 1 line could not be read. 3 items did not fit: a queue holds ${MAX_QUEUE_ITEMS}.`,
    );
  });
});

describe("movedItem", () => {
  it("moves one item and keeps the others, and ignores an unknown one", () => {
    expect(movedItem(ITEMS, 3, 0).map((item) => item.id)).toEqual([3, 1, 2]);
    expect(movedItem(ITEMS, 9, 0)).toEqual(ITEMS);
  });
});
