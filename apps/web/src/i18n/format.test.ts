import { describe, expect, it } from "vitest";
import { formatDate, formatNumber, formatRelativeTime, formatTime } from "./format.ts";

const NNBSP = "\u202f";

describe("formatNumber", () => {
  it("uses the language's decimal mark", () => {
    expect(formatNumber(5.5, "en")).toBe("5.5");
    expect(formatNumber(5.5, "fr")).toBe("5,5");
    expect(formatNumber(5.5, "de")).toBe("5,5");
  });

  it("groups thousands the language's way", () => {
    expect(formatNumber(1234.5, "en")).toBe("1,234.5");
    expect(formatNumber(1234.5, "fr")).toBe(`1${NNBSP}234,5`);
    expect(formatNumber(1234.5, "de")).toBe("1.234,5");
  });

  it("passes options through, and reuses formatters", () => {
    expect(formatNumber(8.666, "fr", { maximumFractionDigits: 1 })).toBe("8,7");
    expect(formatNumber(0.25, "de", { style: "percent" })).toBe(`25${"\u00a0"}%`);
    expect(formatNumber(8.666, "fr", { maximumFractionDigits: 1 })).toBe("8,7");
    expect(formatNumber(3, "en")).toBe("3");
  });
});

describe("dates and times", () => {
  const moment = Date.UTC(2026, 9, 27, 14, 5);
  const utc = { timeZone: "UTC" } as const;

  it("formats a date in each language", () => {
    expect(formatDate(moment, "en", { dateStyle: "long", ...utc })).toBe("October 27, 2026");
    expect(formatDate(moment, "fr", { dateStyle: "long", ...utc })).toBe("27 octobre 2026");
    expect(formatDate(moment, "de", { dateStyle: "long", ...utc })).toBe("27. Oktober 2026");
  });

  it("formats a time of day in each language", () => {
    expect(formatTime(moment, "en", { timeStyle: "short", ...utc })).toMatch(/^2:05\sPM$/u);
    expect(formatTime(moment, "fr", { timeStyle: "short", ...utc })).toBe("14:05");
    expect(formatTime(moment, "de", { timeStyle: "short", ...utc })).toBe("14:05");
  });

  it("has defaults: a medium date and a short time", () => {
    expect(formatDate(new Date(moment), "en")).toMatch(/2026/);
    expect(formatTime(new Date(moment), "de")).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 9, 27, 12, 0);
  const ago = (seconds: number) => now - seconds * 1000;

  it("says now for the present moment", () => {
    expect(formatRelativeTime(now, "en", now)).toBe("now");
    expect(formatRelativeTime(ago(0.2), "fr", now)).toBe("maintenant");
    expect(formatRelativeTime(ago(-0.2), "de", now)).toBe("jetzt");
  });

  it("picks the largest unit that keeps the number small", () => {
    expect(formatRelativeTime(ago(30), "en", now)).toBe("30 seconds ago");
    expect(formatRelativeTime(ago(5 * 60), "en", now)).toBe("5 minutes ago");
    expect(formatRelativeTime(ago(2 * 3600), "fr", now)).toBe("il y a 2 heures");
    expect(formatRelativeTime(ago(3 * 86_400), "de", now)).toBe("vor 3 Tagen");
    expect(formatRelativeTime(ago(14 * 86_400), "en", now)).toBe("2 weeks ago");
    expect(formatRelativeTime(ago(400 * 86_400), "en", now)).toBe("last year");
  });

  it("says yesterday and tomorrow in words, and handles the future", () => {
    expect(formatRelativeTime(ago(86_400), "en", now)).toBe("yesterday");
    expect(formatRelativeTime(ago(86_400), "fr", now)).toBe("hier");
    expect(formatRelativeTime(ago(86_400), "de", now)).toBe("gestern");
    expect(formatRelativeTime(ago(-86_400), "en", now)).toBe("tomorrow");
    expect(formatRelativeTime(ago(-10 * 60), "de", now)).toBe("in 10 Minuten");
  });

  it("rounds before it picks the unit, so no amount reads as a full next unit", () => {
    expect(formatRelativeTime(ago(59.4), "en", now)).toBe("59 seconds ago");
    expect(formatRelativeTime(ago(59.6), "en", now)).toBe("1 minute ago");
    expect(formatRelativeTime(ago(59.6 * 60), "en", now)).toBe("1 hour ago");
    expect(formatRelativeTime(ago(23.6 * 3600), "en", now)).toBe("yesterday");
    expect(formatRelativeTime(ago(-59.6), "de", now)).toBe("in 1 Minute");
    expect(formatRelativeTime(ago(6.6 * 86_400), "en", now)).toBe("last week");
  });

  it("uses the region's clock: 24 hours for en-GB", () => {
    const moment = Date.UTC(2026, 9, 27, 14, 5);
    expect(formatTime(moment, "en-GB", { timeStyle: "short", timeZone: "UTC" })).toBe("14:05");
  });

  it("defaults to the current time", () => {
    expect(formatRelativeTime(Date.now() - 60_000, "en")).toBe("1 minute ago");
  });
});
