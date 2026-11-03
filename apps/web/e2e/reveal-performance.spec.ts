import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { createRoom, type Guest, guestsJoin, handCard, join, phone, sameUser } from "./support.ts";

// The reveal on a mid-range phone (#43, ADR-019): sixteen seats, a phone's screen and touch,
// and the CPU slowed down as Chrome's DevTools do for a mid-tier phone. Every long task the
// browser reports from the last vote until the results have settled is read back: none may
// reach 50 ms. The worst case, since the card's flight and the flips start together.
//
// The speed is set from a benchmark, not a fixed rate: DevTools' 4x is meant for a fast
// desktop, and a CI runner is slower, so it gets less of a slowdown and tests the same
// phone, never more than 4x. The benchmark is taken under the throttle (`calibrate`): the
// nominal rate is not what a platform delivers. On Windows Chromium's 4x ran layout x7.5 to
// 8.3 slower, on Linux x3.4 to 4.7 (build log, 2026-11-02), so a fixed rate tested a slower
// phone on Windows than in CI. `pnpm exec playwright test reveal-performance --no-deps` runs it
// alone; in the whole suite it runs after everything else (`performance` in playwright.config.ts).
//
// The sound is on (#44), the page's first tap starting it: the worst case has sixteen flicks
// and a chord to lay out as well.

/** DevTools' "Mid-tier mobile" CPU, on the desktop that `REFERENCE_MS` was measured on. */
const MID_RANGE_RATE = 4;
/**
 * What `measure` takes on that desktop unthrottled: Sven's, in Edge 156, in this spec's page (a
 * Pixel 7 at a table of sixteen), as the spec logs it. The median of 33 readings in 17 runs on
 * 2026-11-03: 2.4 ms (2.4 to 2.9, and 3.9 to 5.1 while another worktree's tests ran). #43's
 * reading, 3.2 ms, was a single best of ten.
 */
const REFERENCE_MS = 2.4;
/** The mid-range phone: what `measure` takes there, which the throttle is set to match. */
const PHONE_MS = MID_RANGE_RATE * REFERENCE_MS;
/** Close enough to the phone to stop calibrating. */
const PHONE_TOLERANCE = 0.1;
const LONG_TASK_MS = 50;
/** Sixteen flips (2 s), then the columns rise (about 1 s). */
const SETTLED_MS = 3500;

// A trace snapshots the page on every action, itself a long task at this speed.
test.use({ trace: "off" });

interface Task {
  start: number;
  duration: number;
}

/** How fast this machine draws, in ms: the best of ten rounds of building and laying out. */
const benchmark = (page: Page) =>
  page.evaluate(() => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:-10000px;width:300px;visibility:hidden";
    document.body.append(box);
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 10; round += 1) {
      const start = performance.now();
      box.innerHTML = '<div class="flex gap-2"><span>5</span><b>voted</b></div>'.repeat(200);
      void box.offsetHeight;
      best = Math.min(best, performance.now() - start);
    }
    box.remove();
    return best;
  });

async function watchLongTasks(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("pp-sound", JSON.stringify({ on: true }));
    const tasks: { start: number; duration: number }[] = [];
    Object.assign(window, { __longTasks: tasks });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        tasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  });
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return Number.isInteger(middle)
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[Math.floor(middle)] ?? Number.NaN);
};

/** The median of five benchmarks: a throttled one varies with where the throttle's pauses fall. */
async function measure(page: Page) {
  const runs: number[] = [];
  for (let i = 0; i < 5; i += 1) runs.push(await benchmark(page));
  return median(runs);
}

const tasksSince = (page: Page, since: number) =>
  page.evaluate(
    (from) =>
      (window as unknown as { __longTasks: Task[] }).__longTasks.filter((t) => t.start >= from),
    since,
  );

const throttle = (cdp: CDPSession, rate: number) =>
  cdp.send("Emulation.setCPUThrottlingRate", { rate });

const between = (rate: number) => Math.min(MID_RANGE_RATE, Math.max(1, rate));

/**
 * Sets the throttle so that `measure` takes `PHONE_MS`, never above 4x, and leaves it on. The
 * first guess takes the throttle at its word, from the unthrottled `speed`. Then each benchmark
 * under it gives the time one step of rate adds (`speed + slope × (rate − 1)`: on Windows the
 * slope held at about twice `speed` from 2x to 4x, where an exact throttle has `speed`), and the
 * median slope sets the next rate, three times at most. Returns the rate and each step, for the log.
 */
async function calibrate(page: Page, cdp: CDPSession, speed: number) {
  let rate = between((MID_RANGE_RATE * REFERENCE_MS) / speed);
  const steps: string[] = [];
  const slopes: number[] = [];
  // A machine as slow as the phone gets no throttle, and has nothing to calibrate.
  for (let step = 0; step < 3 && rate > 1; step += 1) {
    await throttle(cdp, rate);
    const took = await measure(page);
    steps.push(`${rate.toFixed(1)}x ${took.toFixed(1)} ms`);
    slopes.push(Math.max(0.01, (took - speed) / (rate - 1)));
    const next = between(1 + (PHONE_MS - speed) / median(slopes));
    if (Math.abs(took - PHONE_MS) <= PHONE_MS * PHONE_TOLERANCE && step > 0) break;
    rate = next;
  }
  await throttle(cdp, rate);
  return { rate, steps };
}

const NAMES = "Ben Cleo Dan Eve Finn Gia Hugo Iris Jon Kim Leo Mia Noa Omar Pia".split(" ");
const CARDS = ["1", "2", "3", "5", "8", "13", "21", "5", "8", "3", "2", "13", "5", "8", "3"];

for (const anonymous of [false, true]) {
  const kind = anonymous ? "anonymous" : "named";
  test(`no long task in a ${kind} reveal of sixteen seats on a mid-range phone`, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const base = baseURL ?? "";
    const device = await phone(browser, "Pixel 7");
    const { page } = device;
    await watchLongTasks(page);
    const code = await createRoom(page);
    await join(page, "Ana");
    const owner = await sameUser(base, device.context);
    let guests: Guest[] = [];
    try {
      expect(await owner.enter(code)).toMatchObject({ ok: true });
      guests = await guestsJoin(base, code, NAMES);
      if (anonymous) {
        expect(await owner.cmd("updateSettings", { patch: { revealNames: false } })).toMatchObject({
          ok: true,
        });
      }
      await page.getByRole("button", { name: "Start voting" }).click();
      for (const [i, guest] of guests.entries()) {
        expect(await guest.cmd("castVote", { card: CARDS[i], round: 1, restart: 0 })).toMatchObject(
          { ok: true },
        );
      }
      await expect(page.getByText("15/16", { exact: false })).toBeVisible();
      await page.waitForTimeout(1000);

      // Nothing of Playwright's may run in the page while it is measured: its locators
      // walk the accessibility tree, itself a long task at this speed.
      const card = await handCard(page, "5").boundingBox();
      if (!card) throw new Error("no card to play");
      const speed = await measure(page);
      const cdp = await device.context.newCDPSession(page);
      const { rate, steps } = await calibrate(page, cdp, speed);
      const from = await page.evaluate(() => performance.now());
      await page.touchscreen.tap(card.x + card.width / 2, card.y + card.height / 2);
      await page.waitForTimeout(SETTLED_MS);
      const tasks = await tasksSince(page, from);
      await throttle(cdp, 1);
      await expect(page.getByRole("region", { name: "Results" })).toBeVisible();

      const said = tasks.map(
        (t) => `${Math.round(t.duration)} ms at ${Math.round(t.start - from)}`,
      );
      console.log(
        `${kind} reveal, benchmark ${speed.toFixed(1)} ms, ${rate.toFixed(1)}x (${steps.join(", ")}; phone ${PHONE_MS.toFixed(1)} ms): ${said.join(", ") || "no long task"}`,
      );
      expect(tasks.filter((t) => t.duration >= LONG_TASK_MS)).toEqual([]);
    } finally {
      owner.close();
      for (const guest of guests) guest.close();
      await device.context.close();
    }
  });
}
