import type { RoundView } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerClock, sampleServerClock } from "../realtime/server-clock.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { TimerChip, TimerControls, useCountdown, useLastSecondsWarning } from "./timer.tsx";

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

let reduced = false;
const animate = vi.fn((_frames: Keyframe[], _options?: KeyframeAnimationOptions) => ({
  cancel: vi.fn(),
}));
let observed: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
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

  it("drains the ring smoothly to the deadline, linearly", () => {
    render(<Everyone round={running(45_000)} />);
    const drain = animate.mock.calls.find(
      ([frames]) => frames[0] !== undefined && "strokeDashoffset" in frames[0],
    );
    expect(drain).toBeDefined();
    const [frames, options] = drain ?? [];
    expect(frames).toEqual([{ strokeDashoffset: 25 }, { strokeDashoffset: 100 }]);
    expect(options).toMatchObject({ duration: 45_000, easing: "linear", fill: "forwards" });
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
  it("names the chip by what it shows", () => {
    const { rerender } = render(<Owner round={voting()} />);
    expect(screen.getByRole("button", { name: "Timer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+30\u{a0}s" })).toBeNull();
    rerender(<Owner round={running(45_000)} />);
    expect(screen.getByRole("button", { name: "Timer, 0:45 left" })).toBeTruthy();
    rerender(<Owner round={voting({ timeUpAt: NOW })} />);
    expect(screen.getByRole("button", { name: "Timer, time is up" })).toBeTruthy();
  });

  it("adds 30 s and stops the timer beside the chip", async () => {
    render(<Owner round={running(45_000)} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "+30\u{a0}s" })));
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "extendTimer", payload: { seconds: 30 } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop the timer" })));
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "stopTimer" });
  });

  it("sends one command at a time and shows a refusal", async () => {
    let answer: (value: unknown) => void = () => {};
    mocks.send.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const onFailure = vi.fn();
    render(<Owner round={running(45_000)} onFailure={onFailure} />);
    const add = screen.getByRole("button", { name: "+30\u{a0}s" });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await act(async () => answer({ ok: false, code: "no_timer" }));
    expect(onFailure).toHaveBeenLastCalledWith("no_timer");
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
});
