import type { RoundView, Snapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerClock, sampleServerClock } from "../realtime/server-clock.ts";
import { useRoomStore } from "../stores/room-store.ts";
import {
  PING_AFTER_MS,
  ringSteps,
  TimerChip,
  TimerControls,
  useCountdown,
  useLastSecondsWarning,
  useTimeUpPing,
} from "./timer.tsx";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../realtime/room-connection.ts", () => ({
  commandSender: () => mocks.send,
}));

const NOW = 1_800_000_000_000;

const voting = (extra: Partial<RoundView> = {}) =>
  ({
    number: 1,
    subject: { kind: "none" },
    startedAt: NOW - 60_000,
    deck: { kind: "preset", id: "fib" },
    specials: [],
    voted: [],
    phase: "voting",
    anonymous: false,
    ...extra,
  }) as RoundView;

/** A round whose 60 s timer has `left` milliseconds to go, by the server's clock. */
const running = (left: number, total = 60_000) =>
  voting({ deadlineAt: NOW + left, timerStartedAt: NOW + left - total });

function Everyone({ round }: { round: RoundView }) {
  const countdown = useCountdown(round);
  useLastSecondsWarning(countdown);
  useTimeUpPing(countdown);
  return (
    <div data-variant="desktop">
      <TimerChip countdown={countdown} />
    </div>
  );
}

function Owner({ round, onFailure = () => {} }: { round: RoundView; onFailure?: () => void }) {
  const countdown = useCountdown(round);
  return (
    <div data-variant="desktop">
      <TimerControls countdown={countdown} onFailure={onFailure} />
    </div>
  );
}

/** The PO's centre: the timer's controls while the round votes, "Next round" once revealed. */
function Centre({ round }: { round: RoundView }) {
  const countdown = useCountdown(round);
  return round.phase === "voting" ? (
    <div data-variant="desktop">
      <TimerControls countdown={countdown} onFailure={() => {}} />
    </div>
  ) : (
    <button type="button" data-start-round>
      Next round
    </button>
  );
}

let reduced = false;
const animate = vi.fn((_frames: Keyframe[], _options?: KeyframeAnimationOptions) => ({
  cancel: vi.fn(),
}));
let observed: (() => void) | null = null;

beforeEach(() => {
  // The page counts on the monotonic clock (`performance`), which starts at NOW here.
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  reduced = false;
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: reduced && query.includes("reduce"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  // jsdom lays nothing out: the chip measures 64 by 36, and the ring and pulse are recorded.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(64);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(36);
  Object.assign(Element.prototype, { animate });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observed = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  useRoomStore.getState().reset();
  mocks.send.mockResolvedValue({ ok: true, version: 2 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "animate");
  animate.mockClear();
  mocks.send.mockReset();
  resetServerClock();
  observed = null;
});

const text = () => document.querySelector("[data-timer-text]")?.textContent;
const ring = () => document.querySelector<SVGPathElement>(".pp-timer-progress");
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("the countdown (#27)", () => {
  it("shows the time left as text, a timer for screen readers, and the ring's share", () => {
    render(<Everyone round={running(45_000)} />);
    expect(text()).toBe("0:45");
    expect(screen.getByRole("timer").textContent).toContain("Time left: 0:45");
    expect(ring()?.getAttribute("data-ring-left")).toBe("0.750");
    expect(ring()?.classList.contains("pp-timer-warn")).toBe(false);
    advance(1_005);
    expect(text()).toBe("0:44");
    expect(observed).not.toBeNull();
  });

  it("drains the ring linearly to the deadline, a device pixel at a time", () => {
    // The 64 by 36 chip's stadium is 161.2 px long: 162 steps of 370 ms for 60 s.
    const steps = ringSteps({ width: 64, height: 36 }, 60_000);
    expect(steps).toBe(162);
    const stepMs = 60_000 / steps;
    render(<Everyone round={running(45_000)} />);
    const offset = () => Number(ring()?.getAttribute("stroke-dashoffset"));
    // 45 s left is inside step 122 (rounded up): the ring never shows less than is left.
    expect(offset()).toBeCloseTo(100 * (1 - 122 / steps), 6);
    // No animation runs between steps: one style change per step, set by a timeout.
    const drains = animate.mock.calls.filter(
      ([frames]) => frames[0] && "strokeDashoffset" in frames[0],
    );
    expect(drains).toEqual([]);
    advance(45_000 - 121 * stepMs - 2);
    expect(offset()).toBeCloseTo(100 * (1 - 122 / steps), 6);
    advance(4);
    expect(offset()).toBeCloseTo(100 * (1 - 121 / steps), 6);
    advance(stepMs);
    expect(offset()).toBeCloseTo(100 * (1 - 120 / steps), 6);
    advance(45_000);
    expect(offset()).toBe(100);
  });

  it("steps one device pixel at a time, never more than 20 times a second", () => {
    const chip = { width: 64, height: 36 };
    expect(ringSteps(chip, 3_600_000)).toBe(162);
    expect(ringSteps(chip, 30_000, 2)).toBe(323);
    expect(ringSteps(chip, 5_000)).toBe(100);
    expect(ringSteps({ width: 24, height: 24 }, 30_000)).toBe(68);
  });

  it("counts on the monotonic clock: a step of the wall clock changes nothing", () => {
    render(<Everyone round={running(45_000)} />);
    // Someone sets the computer's clock 10 s forward.
    vi.setSystemTime(Date.now() + 10_000);
    advance(1_005);
    expect(text()).toBe("0:44");
  });

  it("counts from the server's clock, not this page's", () => {
    // This page's clock is 5 s behind the server's: the deadline is 45 s off by the server.
    sampleServerClock(NOW + 5_000, NOW);
    render(<Everyone round={voting({ deadlineAt: NOW + 50_000, timerStartedAt: NOW - 10_000 })} />);
    expect(text()).toBe("0:45");
    expect(document.querySelector("[data-timer]")?.getAttribute("data-ends-at")).toBe(
      String(NOW + 45_000),
    );
  });

  it("turns warn and pulses at 1 Hz in the last 10 s, and says it once", () => {
    render(<Everyone round={running(11_500)} />);
    expect(document.querySelector("[data-timer]")?.getAttribute("data-timer")).toBe("running");
    advance(2_000);
    expect(text()).toBe("0:10");
    expect(document.querySelector("[data-timer]")?.getAttribute("data-timer")).toBe("warn");
    expect(ring()?.classList.contains("pp-timer-warn")).toBe(true);
    const pulse = animate.mock.calls.find(([frames]) => frames[0] && "transform" in frames[0]);
    expect(pulse?.[1]).toMatchObject({ duration: 1_000, iterations: Number.POSITIVE_INFINITY });
    expect(useRoomStore.getState().said.text).toBe("10 seconds left.");
    const id = useRoomStore.getState().said.id;
    advance(3_000);
    expect(useRoomStore.getState().said.id).toBe(id);
  });

  it("never says the last seconds on a page that loads inside them", () => {
    render(<Everyone round={running(8_000)} />);
    advance(2_000);
    expect(useRoomStore.getState().said.id).toBe(0);
  });

  it("stops at 0:00 and waits for the server, never below", () => {
    render(<Everyone round={running(1_500)} />);
    advance(5_000);
    expect(text()).toBe("0:00");
    expect(document.querySelector("[data-timer]")?.getAttribute("data-timer")).toBe("zero");
  });

  it("under reduced motion: no drain, no pulse; the ring steps once a second", () => {
    reduced = true;
    render(<Everyone round={running(10_500)} />);
    expect(animate).not.toHaveBeenCalled();
    const before = ring()?.getAttribute("stroke-dashoffset");
    advance(1_000);
    expect(ring()?.getAttribute("stroke-dashoffset")).not.toBe(before);
    expect(text()).toBe("0:10");
    // The colour and the text still say it.
    expect(ring()?.classList.contains("pp-timer-warn")).toBe(true);
    expect(animate).not.toHaveBeenCalled();
  });

  it("says that time is up, with a full warn ring, and nothing without a timer", () => {
    const { rerender } = render(<Everyone round={voting({ timeUpAt: NOW - 1 })} />);
    expect(text()).toBe("Time is up");
    expect(ring()?.getAttribute("data-ring-left")).toBe("1.000");
    expect(ring()?.classList.contains("pp-timer-warn")).toBe(true);
    rerender(<Everyone round={voting()} />);
    expect(document.querySelector("[data-timer]")).toBeNull();
  });

  it("measures an older server's timer from the moment it was first seen", () => {
    render(<Everyone round={voting({ deadlineAt: NOW + 30_000 })} />);
    expect(ring()?.getAttribute("data-ring-left")).toBe("1.000");
    advance(15_000);
    expect(ring()?.getAttribute("data-ring-left")).toBe("0.500");
  });
});

describe("the PO's timer controls (#27)", () => {
  it("names the chip by its state only; the time is in a timer beside it", () => {
    const { rerender } = render(<Owner round={voting()} />);
    expect(screen.getByRole("button", { name: "Timer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add 30 seconds" })).toBeNull();
    expect(screen.queryByRole("timer")).toBeNull();
    rerender(<Owner round={running(45_000)} />);
    const chip = screen.getByRole("button", { name: "Timer, running" });
    expect(screen.getByRole("timer").textContent).toBe("Time left: 0:45");
    // A screen reader speaks a focused control's new name: the name must not tick.
    advance(1_005);
    expect(chip.getAttribute("aria-label")).toBe("Timer, running");
    expect(screen.getByRole("timer").textContent).toBe("Time left: 0:44");
    expect(screen.getByRole("timer").getAttribute("aria-live")).toBeNull();
    rerender(<Owner round={voting({ timeUpAt: NOW })} />);
    expect(screen.getByRole("button", { name: "Timer, time is up" })).toBeTruthy();
  });

  it("adds 30 s and stops the timer beside the chip", async () => {
    render(<Owner round={running(45_000)} />);
    const add = screen.getByRole("button", { name: "Add 30 seconds" });
    expect(add.textContent).toContain("+30\u{a0}s");
    await act(async () => fireEvent.click(add));
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "extendTimer", payload: { seconds: 30 } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop the timer" })));
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "stopTimer" });
  });

  it("sends one command at a time and shows a refusal", async () => {
    let answer: (value: unknown) => void = () => {};
    mocks.send.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const onFailure = vi.fn();
    render(<Owner round={running(45_000)} onFailure={onFailure} />);
    const add = screen.getByRole("button", { name: "Add 30 seconds" });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await act(async () => answer({ ok: false, code: "bad_seconds" }));
    expect(onFailure).toHaveBeenLastCalledWith("bad_seconds");
  });

  it("says nothing when +30 s loses the race with the end of the timer", async () => {
    const onFailure = vi.fn();
    render(<Owner round={running(400)} onFailure={onFailure} />);
    mocks.send.mockResolvedValueOnce({ ok: false, code: "no_timer" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add 30 seconds" })));
    expect(onFailure).not.toHaveBeenCalledWith("no_timer");
    // Stop has no race to lose: its refusal still shows.
    mocks.send.mockResolvedValueOnce({ ok: false, code: "not_owner" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop the timer" })));
    expect(onFailure).toHaveBeenLastCalledWith("not_owner");
  });

  it("starts a preset or a custom length from its menu, and says a bad length", async () => {
    vi.useRealTimers();
    render(<Owner round={voting()} />);
    fireEvent.click(screen.getByRole("button", { name: "Timer" }));
    const preset = await screen.findByRole("button", { name: "60\u{a0}s" });
    await act(async () => fireEvent.click(preset));
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "startTimer", payload: { seconds: 60 } });

    fireEvent.click(screen.getByRole("button", { name: "Timer" }));
    const field = await screen.findByRole("textbox", { name: "Length" });
    fireEvent.change(field, { target: { value: "2 min" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect((await screen.findByRole("alert")).textContent).toContain("5 seconds to 60 minutes");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(field, { target: { value: "1:30" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "startTimer", payload: { seconds: 90 } });
  });

  it("says a wrong length each time it is tried, also the same one again", async () => {
    vi.useRealTimers();
    render(<Owner round={voting()} />);
    fireEvent.click(screen.getByRole("button", { name: "Timer" }));
    const field = await screen.findByRole("textbox", { name: "Length" });
    fireEvent.change(field, { target: { value: "2 min" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const first = await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const second = await screen.findByRole("alert");
    // A new alert element, so a screen reader says it again.
    expect(second).not.toBe(first);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("gives the focus to the PO's decision when the menu leaves with the round", async () => {
    vi.useRealTimers();
    const { rerender } = render(<Centre round={running(6_000)} />);
    fireEvent.click(screen.getByRole("button", { name: "Timer, running" }));
    const field = await screen.findByRole("textbox", { name: "Length" });
    field.focus();
    expect(document.activeElement).toBe(field);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    // The timer reveals while the PO types a length.
    rerender(<Centre round={{ ...voting(), phase: "revealed" } as RoundView} />);
    const next = screen.getByRole("button", { name: "Next round" });
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });
});

describe("the timeUp ping (#27, architecture section 9)", () => {
  /** The store shows `round`, as the page's latest snapshot does. */
  const shows = (round: RoundView) =>
    useRoomStore.setState({ snapshot: { room: { round } } as unknown as Snapshot });

  it("asks the server once, a second or two after the deadline, while the round still votes", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const round = running(2_000);
    shows(round);
    render(<Everyone round={round} />);
    advance(2_000 + PING_AFTER_MS + 499);
    expect(mocks.send).not.toHaveBeenCalled();
    advance(2);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "timeUp" });
    advance(10_000);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the round it showed was revealed or got a new deadline meanwhile", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const round = running(1_000);
    shows({ ...round, phase: "revealed" } as RoundView);
    render(<Everyone round={round} />);
    advance(1_000 + PING_AFTER_MS + 10);
    shows(running(30_000));
    advance(5_000);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
