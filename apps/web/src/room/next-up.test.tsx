import type { RoomView } from "@pp/protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n/i18n.ts";
import { useNextRound } from "./next-round.tsx";
import { NextUp } from "./next-up.tsx";

const mocks = vi.hoisted(() => ({ send: vi.fn(), now: vi.fn() }));
vi.mock("../realtime/room-connection.ts", () => ({
  commandSender: () => mocks.send,
  requestQueue: vi.fn(),
}));
vi.mock("../realtime/server-clock.ts", () => ({
  serverTime: mocks.now,
  localNow: mocks.now,
  useClockOffset: () => 0,
}));

const T0 = 1_000_000;
const queue = { count: 2, rev: 1, next: { id: 7, key: "AB-1" } };

function roomOf(fields: { advanceAt?: number; you?: string; queue?: RoomView["queue"] }): RoomView {
  const { advanceAt, you = "po", queue: held = queue } = fields;
  return {
    you,
    ownerId: "po",
    queue: held,
    round: { phase: "revealed", ...(advanceAt === undefined ? {} : { advanceAt }) },
  } as unknown as RoomView;
}

function Table({ room }: { room: RoomView }) {
  return (
    <>
      <div data-hand>
        <button type="button" tabIndex={0}>
          A card
        </button>
      </div>
      <button type="button" data-record-final>
        Record
      </button>
      <NextUp room={room} onFailure={() => {}} />
    </>
  );
}

beforeAll(() => changeLanguage("en"));

beforeEach(() => {
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ ok: true, version: 2 });
  mocks.now.mockReset();
  mocks.now.mockReturnValue(T0);
});

afterEach(cleanup);

describe("NextUp", () => {
  const line = () => document.querySelector("[data-next-up]");

  it("says what is next after a reveal", () => {
    render(<NextUp room={roomOf({})} onFailure={() => {}} />);
    expect(line()?.textContent).toBe("Next: AB-1");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows nothing without a queue, and nothing while voting", () => {
    const empty = { ...roomOf({}), queue: undefined } as unknown as RoomView;
    render(<NextUp room={empty} onFailure={() => {}} />);
    expect(line()).toBeNull();
    const voting = { ...roomOf({}), round: { phase: "voting" } } as unknown as RoomView;
    render(<NextUp room={voting} onFailure={() => {}} />);
    expect(line()).toBeNull();
  });

  it("counts down in plain text, and only the PO can stay", () => {
    const { rerender } = render(
      <NextUp room={roomOf({ advanceAt: T0 + 7500, you: "ana" })} onFailure={() => {}} />,
    );
    expect(line()?.textContent).toBe("Next: AB-1, in 8\u{A0}s");
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<NextUp room={roomOf({ advanceAt: T0 + 7500 })} onFailure={() => {}} />);
    expect(screen.getByRole("button", { name: "Stay on this round" })).toBeTruthy();
  });

  it("sends the PO's stay, and shows a refusal", async () => {
    const onFailure = vi.fn();
    render(<NextUp room={roomOf({ advanceAt: T0 + 5000 })} onFailure={onFailure} />);
    fireEvent.click(screen.getByRole("button", { name: "Stay on this round" }));
    expect(mocks.send).toHaveBeenCalledWith({ type: "holdAdvance" });
    mocks.send.mockResolvedValue({ ok: false, code: "not_owner" });
    await waitFor(() => expect(onFailure).toHaveBeenCalledWith(null));
    fireEvent.click(screen.getByRole("button", { name: "Stay on this round" }));
    await waitFor(() => expect(onFailure).toHaveBeenCalledWith("not_owner"));
  });
});

describe("the focus on Stay, when the button leaves", () => {
  const focusOnStay = () => screen.getByRole("button", { name: "Stay on this round" }).focus();

  it("goes to the hand when the countdown started the next item", async () => {
    const { rerender } = render(<Table room={roomOf({ advanceAt: T0 + 5000 })} />);
    focusOnStay();
    const voting = { ...roomOf({}), round: { phase: "voting" } } as unknown as RoomView;
    rerender(<Table room={voting} />);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("A card"));
  });

  it("goes back to the decision when the room stays", async () => {
    const { rerender } = render(<Table room={roomOf({ advanceAt: T0 + 5000 })} />);
    focusOnStay();
    rerender(<Table room={roomOf({})} />);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Record"));
  });

  it("stays out of the way of a focus that is elsewhere", async () => {
    const { rerender } = render(<Table room={roomOf({ advanceAt: T0 + 5000 })} />);
    screen.getByRole("button", { name: "A card" }).focus();
    rerender(<Table room={roomOf({})} />);
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement?.textContent).toBe("A card");
  });
});

describe("useNextRound with a queue", () => {
  const nothing = () => {};

  it("takes the next item while the field is empty", async () => {
    const { result } = renderHook(() => useNextRound(nothing, 7));
    expect(result.current.fromQueue).toBe(true);
    await act(() => result.current.start());
    expect(mocks.send).toHaveBeenCalledWith({ type: "startNext", payload: { id: 7 } });
  });

  it("takes a typed subject first: the queue never locks the PO out of the field", async () => {
    const { result } = renderHook(() => useNextRound(nothing, 7));
    act(() => result.current.setDraft("By hand"));
    expect(result.current.fromQueue).toBe(false);
    await act(() => result.current.start());
    expect(mocks.send).toHaveBeenCalledWith({
      type: "startRound",
      payload: { subject: { kind: "title", text: "By hand" }, round: 0 },
    });
  });

  it("sends the round on the table, so a press never replaces a round it did not see", async () => {
    const { result } = renderHook(() => useNextRound(nothing, null, 4));
    await act(() => result.current.start());
    expect(mocks.send).toHaveBeenCalledWith({
      type: "startRound",
      payload: { subject: { kind: "none" }, round: 4 },
    });
  });

  it("stays quiet when a countdown started the next item under the press", async () => {
    const onFailure = vi.fn();
    const { result } = renderHook(() => useNextRound(onFailure, 7));
    mocks.send.mockResolvedValue({ ok: false, code: "not_revealed" });
    await act(() => result.current.start());
    act(() => result.current.setDraft("By hand"));
    mocks.send.mockResolvedValue({ ok: false, code: "round_changed" });
    await act(() => result.current.start());
    expect(onFailure.mock.calls.flat()).toEqual([null, null]);
    expect(result.current.draft).toBe("By hand");
    mocks.send.mockResolvedValue({ ok: false, code: "unknown_item" });
    act(() => result.current.setDraft(""));
    await act(() => result.current.start());
    expect(onFailure).toHaveBeenLastCalledWith("unknown_item");
  });

  it("counts blanks as an empty field", () => {
    const { result } = renderHook(() => useNextRound(nothing, 7));
    act(() => result.current.setDraft("   "));
    expect(result.current.fromQueue).toBe(true);
  });

  it("starts a round with no subject without a queue, as always", async () => {
    const { result } = renderHook(() => useNextRound(nothing));
    expect(result.current.fromQueue).toBe(false);
    await act(() => result.current.start());
    expect(mocks.send).toHaveBeenCalledWith({
      type: "startRound",
      payload: { subject: { kind: "none" }, round: 0 },
    });
  });
});
