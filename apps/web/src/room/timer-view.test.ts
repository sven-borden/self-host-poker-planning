import type { RoundView } from "@pp/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { fixedT, loadLanguage } from "../i18n/i18n.ts";
import {
  clockText,
  durationWords,
  inWarnPhase,
  parseDuration,
  remainingMs,
  ringLeft,
  shortDuration,
  shownSeconds,
  timerState,
  typedDuration,
} from "./timer-view.ts";

const voting = (extra: Partial<RoundView> = {}) =>
  ({
    number: 1,
    subject: { kind: "none" },
    startedAt: 0,
    deck: { kind: "preset", id: "fib" },
    specials: [],
    voted: [],
    phase: "voting",
    anonymous: false,
    ...extra,
  }) as RoundView;

beforeAll(async () => {
  await loadLanguage("fr");
  await loadLanguage("de");
});

describe("the timer's view (#27)", () => {
  it("reads the round: none, running from its start, or time up", () => {
    expect(timerState(null)).toEqual({ kind: "none" });
    expect(timerState(voting())).toEqual({ kind: "none" });
    expect(timerState(voting({ deadlineAt: 9_000, timerStartedAt: 3_000 }))).toEqual({
      kind: "running",
      deadlineAt: 9_000,
      startedAt: 3_000,
    });
    // An older server sends no start: the ring then measures from the first sight.
    expect(timerState(voting({ deadlineAt: 9_000 }))).toEqual({
      kind: "running",
      deadlineAt: 9_000,
      startedAt: null,
    });
    expect(timerState(voting({ timeUpAt: 9_000 }))).toEqual({ kind: "up" });
    const revealed = { ...voting(), phase: "revealed", deadlineAt: 9_000 } as unknown as RoundView;
    expect(timerState(revealed)).toEqual({ kind: "none" });
  });

  it("never shows a negative time, and 0:00 only once the deadline passed", () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
    expect(remainingMs(10_000, 12_000)).toBe(0);
    expect(clockText(45_000)).toBe("0:45");
    expect(clockText(44_001)).toBe("0:45");
    expect(clockText(200)).toBe("0:01");
    expect(clockText(0)).toBe("0:00");
    expect(clockText(-3_000)).toBe("0:00");
    expect(clockText(120_000)).toBe("2:00");
    expect(clockText(3_600_000)).toBe("60:00");
    expect(shownSeconds(9_999)).toBe(10);
  });

  it("turns to the warn phase for the last 10 s, never at 0", () => {
    expect(inWarnPhase(10_001)).toBe(false);
    expect(inWarnPhase(10_000)).toBe(true);
    expect(inWarnPhase(1)).toBe(true);
    expect(inWarnPhase(0)).toBe(false);
  });

  it("drains the ring from the time left out of the whole length", () => {
    expect(ringLeft(45_000, 60_000)).toBe(0.75);
    expect(ringLeft(90_000, 60_000)).toBe(1);
    expect(ringLeft(-1, 60_000)).toBe(0);
    expect(ringLeft(5, 0)).toBe(1);
    expect(ringLeft(0, 0)).toBe(0);
  });

  it("says a length in words and on a button, in each language", () => {
    const en = fixedT("en");
    expect(durationWords(en, 60)).toBe("1 minute");
    expect(durationWords(en, 30)).toBe("30 seconds");
    expect(durationWords(en, 1)).toBe("1 second");
    expect(durationWords(en, 90)).toBe("1 minute 30 seconds");
    expect(durationWords(en, 120)).toBe("2 minutes");
    expect(durationWords(fixedT("fr"), 90)).toBe("1 minute 30 secondes");
    expect(durationWords(fixedT("de"), 120)).toBe("2 Minuten");
    expect(shortDuration(en, 30)).toBe("30\u{a0}s");
    expect(shortDuration(en, 60)).toBe("60\u{a0}s");
    expect(shortDuration(en, 120)).toBe("2\u{a0}min");
    expect(shortDuration(fixedT("de"), 120)).toBe("2\u{a0}min");
    expect(shortDuration(en, 150)).toBe("2:30");
  });

  it("reads a typed length as seconds or minutes and seconds, 5 s to 60 min", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration(" 1:30 ")).toBe(90);
    expect(parseDuration("01:05")).toBe(65);
    expect(parseDuration("60:00")).toBe(3_600);
    expect(parseDuration("5")).toBe(5);
    expect(parseDuration("4")).toBeNull();
    expect(parseDuration("60:01")).toBeNull();
    expect(parseDuration("3601")).toBeNull();
    expect(parseDuration("1:60")).toBeNull();
    expect(parseDuration("1.5")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(typedDuration(90)).toBe("90");
    expect(typedDuration(150)).toBe("2:30");
  });
});
