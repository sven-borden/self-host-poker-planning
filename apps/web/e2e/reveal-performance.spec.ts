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
// phone, never more than 4x. `pnpm exec playwright test reveal-performance --no-deps` runs it alone; in the
// whole suite it runs after everything else (`performance` in playwright.config.ts).
//
// The sound is on (#44), the page's first tap starting it: the worst case has sixteen flicks
// and a chord to lay out as well.

/** DevTools' "Mid-tier mobile" CPU, on the desktop that `REFERENCE_MS` was measured on. */
const MID_RANGE_RATE = 4;
/** What `benchmark` took on that desktop (Sven's, November 2026). */
const REFERENCE_MS = 3.2;
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

const tasksSince = (page: Page, since: number) =>
  page.evaluate(
    (from) =>
      (window as unknown as { __longTasks: Task[] }).__longTasks.filter((t) => t.start >= from),
    since,
  );

const throttle = (cdp: CDPSession, rate: number) =>
  cdp.send("Emulation.setCPUThrottlingRate", { rate });

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
      const speed = await benchmark(page);
      const rate = Math.min(MID_RANGE_RATE, Math.max(1, (MID_RANGE_RATE * REFERENCE_MS) / speed));
      const cdp = await device.context.newCDPSession(page);
      await throttle(cdp, rate);
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
        `${kind} reveal, benchmark ${speed.toFixed(1)} ms, ${rate.toFixed(1)}x: ${said.join(", ") || "no long task"}`,
      );
      expect(tasks.filter((t) => t.duration >= LONG_TASK_MS)).toEqual([]);
    } finally {
      owner.close();
      for (const guest of guests) guest.close();
      await device.context.close();
    }
  });
}
