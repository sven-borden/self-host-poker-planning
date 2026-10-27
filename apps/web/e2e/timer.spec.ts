import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import {
  createRoom,
  type Guest,
  guestsJoin,
  handCard,
  join,
  newPerson,
  ownAddress,
  phone,
  recordFrames,
  SHOTS,
  sameUser,
  seats,
  shoot,
  snapshotsIn,
} from "./support.ts";

// The vote timer (#27) in real browsers, against the real server and Postgres: the PO
// starts, extends and stops a timer from the table's centre and everyone counts down and
// hears it; the room's timer from the settings panel starts with every round; at the
// deadline the server reveals once (AC 2) or everyone reads "Time is up"; three pages
// whose clocks are 5 s apart show the same time left (AC 1); the PO's flow works by
// keyboard alone on a desktop and a phone; the PO's controls stay clear of every card at
// 4, 8, 10 and 16 seats in English, French and German. Needs DATABASE_URL; skipped
// without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the timer tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const NB = "\u{a0}";
/** Everyone's timer in the centre: the chip, which is a button for the PO. */
const chip = (page: Page) => page.locator("[data-centre] [data-timer]");
const chipText = (page: Page) => chip(page).locator("[data-timer-text]");
const timerButton = (page: Page) => page.locator("[data-timer-button]");
const timerMenu = (page: Page) => page.locator("[data-timer-menu]");
const tableLive = (page: Page) => page.locator("[data-table-live]");
const centreStatus = (page: Page) => page.locator("[data-centre] [data-centre-status]");

/** A second person in their own browser, joined as a voter. */
async function secondBrowser(browser: Browser, url: string, name: string) {
  const person = await newPerson(browser);
  const frames = recordFrames(person.page);
  await person.page.goto(url);
  await join(person.page, name);
  return { ...person, frames };
}

/** Opens the PO's timer menu and waits for its lazy chunk. */
async function openTimerMenu(page: Page) {
  // By keyboard: in its last 10 s the chip pulses, and Playwright never clicks a moving target.
  await timerButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(timerMenu(page).locator("[data-timer-preset='30']")).toBeVisible();
  return timerMenu(page);
}

/** The room's timer in the PO's settings panel: a length (a preset or typed), and its end. */
async function setRoomTimer(
  page: Page,
  { length, custom, revealAtEnd }: { length?: string; custom?: string; revealAtEnd?: boolean },
) {
  await page.getByRole("button", { name: "Room settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Room settings" });
  const row = dialog.locator("[data-setting='timer']");
  const settled = () => expect(row.locator("[data-setting-saving]")).toHaveCount(0);
  if (length !== undefined) {
    await row.getByRole("radio", { name: length, exact: true }).click();
    await expect(row.getByRole("radio", { name: length, exact: true })).toBeChecked();
    await settled();
  }
  if (custom !== undefined) {
    await row.getByRole("radio", { name: "Custom" }).click();
    await row.getByRole("textbox", { name: "Custom length" }).fill(custom);
    await row.getByRole("button", { name: "Set" }).click();
    await settled();
  }
  if (revealAtEnd !== undefined) {
    const atEnd = row.getByRole("switch", { name: "Reveal when the timer ends" });
    if ((await atEnd.getAttribute("aria-checked")) !== String(revealAtEnd)) await atEnd.click();
    await expect(atEnd).toHaveAttribute("aria-checked", String(revealAtEnd));
    await settled();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

/** The `revealed` causes in a page's frames, from frame `from` on. */
function reveals(frames: readonly string[], from = 0) {
  return snapshotsIn(frames.slice(from)).flatMap((snapshot) =>
    snapshot.causes.filter((cause) => cause.type === "revealed"),
  );
}

test("the PO starts, extends and stops a timer; everyone counts down and hears it", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await createRoom(page);
  await join(page, "Ana");
  const ben = await secondBrowser(browser, page.url(), "Ben");
  try {
    await page.getByRole("button", { name: "Start voting" }).click();
    // No timer yet: the PO's chip says "Timer", and nobody else sees one.
    await expect(timerButton(page)).toHaveAttribute("data-timer", "idle");
    await expect(timerButton(page)).toHaveAccessibleName("Timer");
    await expect(chip(ben.page)).toHaveCount(0);

    const menu = await openTimerMenu(page);
    await expect(menu.locator("[data-timer-preset]")).toHaveText([
      `30${NB}s`,
      `60${NB}s`,
      `2${NB}min`,
    ]);
    // On a desktop "+30 s" and "Stop" sit beside the chip, not in the menu.
    await expect(menu.locator("[data-menu-extend], [data-menu-stop]")).toHaveCount(0);
    await menu.locator("[data-timer-preset='60']").click();
    await expect(timerMenu(page)).toHaveCount(0);
    await expect(timerButton(page)).toBeFocused();
    for (const viewer of [page, ben.page]) {
      await expect(chip(viewer)).toHaveAttribute("data-timer", "running");
      await expect(chipText(viewer)).toHaveText(/^(1:00|0:5\d)$/);
      await expect(tableLive(viewer)).toContainText("Timer started: 1 minute.");
    }
    await expect(ben.page.getByRole("timer")).toContainText(/Time left: (1:00|0:5\d)/);
    // The PO's chip is named by its state; the time is in the timer beside it.
    await expect(timerButton(page)).toHaveAccessibleName("Timer, running");
    await expect(page.getByRole("timer")).toContainText(/Time left: (1:00|0:5\d)/);
    // The ring drains linearly in small steps, about a device pixel each, with no
    // animation running between them (the page restyles only when a step comes).
    const drain = await ben.page.evaluate(async () => {
      const ring = document.querySelector(".pp-timer-progress");
      const seen: number[] = [];
      for (let i = 0; i < 80; i += 1) {
        const value = Number(ring?.getAttribute("stroke-dashoffset"));
        if (seen.at(-1) !== value) seen.push(value);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { animations: ring?.getAnimations().length, seen };
    });
    expect(drain.animations).toBe(0);
    expect(drain.seen.length).toBeGreaterThanOrEqual(3);
    for (const [i, value] of drain.seen.entries()) {
      if (i === 0) continue;
      const step = value - (drain.seen[i - 1] ?? 0);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(1);
    }

    await page.getByRole("button", { name: "Add 30 seconds" }).click();
    for (const viewer of [page, ben.page]) {
      await expect(chipText(viewer)).toHaveText(/^1:[23]\d$/);
      await expect(tableLive(viewer)).toContainText("30 seconds added.");
    }
    const stop = page.getByRole("button", { name: "Stop the timer" });
    await stop.focus();
    await page.keyboard.press("Enter");
    await expect(chip(ben.page)).toHaveCount(0);
    await expect(timerButton(page)).toHaveAttribute("data-timer", "idle");
    for (const viewer of [page, ben.page]) {
      await expect(tableLive(viewer)).toContainText("Timer stopped.");
    }
    // "Stop" left with the timer; the focus went to the chip.
    await expect(timerButton(page)).toBeFocused();
  } finally {
    await ben.context.close();
  }
});

test("the room's timer starts every round, and the server reveals at the deadline exactly once (AC 2)", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const frames = recordFrames(page);
  await createRoom(page);
  await join(page, "Ana");
  const ben = await secondBrowser(browser, page.url(), "Ben");
  try {
    await setRoomTimer(page, { custom: "5" });
    await expect(page.getByRole("button", { name: "Room settings" })).toBeVisible();
    const fromPo = frames.length;
    const fromBen = ben.frames.length;
    await page.getByRole("button", { name: "Start voting" }).click();
    await expect(tableLive(ben.page)).toContainText(
      "Voting started: Round 1. Timer started: 5 seconds.",
    );
    for (const viewer of [page, ben.page]) {
      // Five seconds: the last stretch from the start.
      await expect(chip(viewer)).toHaveAttribute("data-timer", /^(warn|zero)$/);
      await expect(chipText(viewer)).toHaveText(/^0:0[0-5]$/);
    }
    await handCard(ben.page, "8").click();
    // Nobody acts: the server's own timeout reveals the round.
    for (const viewer of [page, ben.page]) {
      await expect(centreStatus(viewer)).toHaveAttribute("data-centre-status", "revealed", {
        timeout: 10_000,
      });
      await expect(tableLive(viewer)).toContainText("Time is up. Cards revealed.");
    }
    await page.waitForTimeout(1_500);
    for (const [name, list, from] of [
      ["Ana", frames, fromPo],
      ["Ben", ben.frames, fromBen],
    ] as const) {
      expect(reveals(list, from), `${name}'s reveals`).toEqual([{ type: "revealed", by: "timer" }]);
      // Stamped with the deadline itself.
      const shown = snapshotsIn(list.slice(from)).map(
        (s) => s.room.round as { deadlineAt?: number; revealedAt?: number } | null,
      );
      const deadline = shown.find((round) => round?.deadlineAt !== undefined)?.deadlineAt;
      expect(shown.at(-1)?.revealedAt, `${name}'s reveal time`).toBe(deadline);
    }

    // The next round starts with the timer again; the PO reveals before it ends.
    await page.getByRole("button", { name: "Next round" }).click();
    for (const viewer of [page, ben.page]) {
      await expect(chipText(viewer)).toHaveText(/^0:0[1-5]$/);
    }
    await page.getByRole("button", { name: "Reveal cards" }).click();
    for (const viewer of [page, ben.page]) {
      await expect(centreStatus(viewer)).toHaveAttribute("data-centre-status", "revealed");
      await expect(chip(viewer)).toHaveCount(0);
    }
    expect(reveals(frames, fromPo)).toEqual([
      { type: "revealed", by: "timer" },
      { type: "revealed", by: "manual" },
    ]);
  } finally {
    await ben.context.close();
  }
});

test("without the reveal at the end, everyone reads that time is up and the PO reveals", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await createRoom(page);
  await join(page, "Ana");
  const ben = await secondBrowser(browser, page.url(), "Ben");
  try {
    await setRoomTimer(page, { custom: "5", revealAtEnd: false });
    await page.getByRole("button", { name: "Start voting" }).click();
    for (const viewer of [page, ben.page]) {
      await expect(chip(viewer)).toHaveAttribute("data-timer", "up", { timeout: 10_000 });
      await expect(chipText(viewer)).toHaveText("Time is up");
      await expect(tableLive(viewer)).toContainText("Time is up.");
    }
    await expect(timerButton(page)).toHaveAccessibleName("Timer, time is up");
    // The round waits for the PO, also after a reload.
    await page.waitForTimeout(1_000);
    await expect(centreStatus(ben.page)).toHaveAttribute("data-centre-status", "voting");
    await ben.page.reload();
    await expect(chip(ben.page)).toHaveAttribute("data-timer", "up");
    await shoot(ben.page, "timer-time-up");
    await shoot(page, "timer-time-up-po");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Reveal cards" }).click();
    for (const viewer of [page, ben.page]) {
      await expect(centreStatus(viewer)).toHaveAttribute("data-centre-status", "revealed");
    }
  } finally {
    await ben.context.close();
  }
});

test("the ring at 0:45 and in its last 10 s, for everyone and for the PO (screenshots)", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await createRoom(page);
  await join(page, "Ana");
  const ben = await secondBrowser(browser, page.url(), "Ben");
  try {
    await page.getByRole("button", { name: "Start voting" }).click();
    const menu = await openTimerMenu(page);
    await menu.getByRole("textbox", { name: "Length" }).fill("0:47");
    await menu.getByRole("button", { name: "Start" }).click();
    await expect(chipText(ben.page)).toHaveText("0:45", { timeout: 5_000 });
    await shoot(ben.page, "timer-045");
    await shoot(page, "timer-controls-045");
    await expect(chip(ben.page)).toHaveAttribute("data-timer", "warn", { timeout: 45_000 });
    await expect(chipText(ben.page)).toHaveText(/^0:(09|10)$/);
    await shoot(ben.page, "timer-last-10");
    await shoot(page, "timer-controls-last-10");
    await expect(tableLive(ben.page)).toContainText("10 seconds left.");
    // The menu while a timer runs, on a desktop and a phone.
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTimerMenu(page);
    // Once the menu has faded in.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}timer-menu-running-1440.png` });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 360, height: 900 });
    await openTimerMenu(page);
    await expect(timerMenu(page).locator("[data-menu-extend]")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}timer-menu-running-360.png`, fullPage: true });
    await page.keyboard.press("Escape");
  } finally {
    await ben.context.close();
  }
});

test("three pages whose clocks are 5 s apart show the same time left, within 0.5 s (AC 1)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const skews = [-5_000, 0, 5_000];
  const people = await Promise.all(
    skews.map(async (skew) => {
      const person = await newPerson(browser);
      await person.context.addInitScript((shift: number) => {
        const real = Date.now.bind(Date);
        Date.now = () => real() + shift;
      }, skew);
      return person;
    }),
  );
  const [po, ...others] = people;
  if (!po) throw new Error("no PO");
  try {
    await createRoom(po.page);
    await join(po.page, "Ana");
    for (const [i, person] of others.entries()) {
      await person.page.goto(po.page.url());
      await join(person.page, ["Ben", "Cleo"][i] ?? "Guest");
    }
    // Each page's clock really is off by its skew.
    for (const [i, { page }] of people.entries()) {
      const off = await page.evaluate(
        () => Date.now() - (performance.timeOrigin + performance.now()),
      );
      expect(Math.abs(off - (skews[i] ?? 0))).toBeLessThan(50);
    }
    await po.page.getByRole("button", { name: "Start voting" }).click();
    const menu = await openTimerMenu(po.page);
    await menu.locator("[data-timer-preset='120']").click();
    for (const { page } of people)
      await expect(chip(page)).toHaveAttribute("data-timer", "running");

    const results: number[] = [];
    for (let sample = 0; sample < 3; sample += 1) {
      await po.page.waitForTimeout(700);
      const readings = await Promise.all(
        people.map(({ page }) =>
          page.evaluate(() => {
            const element = document.querySelector<HTMLElement>("[data-centre] [data-timer]");
            return {
              left: Number(element?.dataset.endsAt) - Date.now(),
              // The real time of the reading, which no page's Date.now shift touches.
              at: performance.timeOrigin + performance.now(),
              text: element?.querySelector("[data-timer-text]")?.textContent ?? "",
            };
          }),
        ),
      );
      const at = Math.max(...readings.map((r) => r.at));
      const left = readings.map((r) => r.left - (at - r.at));
      const spread = Math.max(...left) - Math.min(...left);
      console.log(
        `skewed clocks: left ${left.map(Math.round).join(", ")} ms, spread ${Math.round(spread)} ms`,
      );
      results.push(spread);
      for (const r of readings) expect(r.text).toMatch(/^(2:00|1:[0-5]\d)$/);
    }
    for (const spread of results) expect(spread).toBeLessThan(500);
  } finally {
    for (const person of people) await person.context.close();
  }
});

/** Presses Tab (or Shift+Tab) until `target` has the focus, at most `limit` times. */
async function tabTo(page: Page, target: Locator, back = false, limit = 40) {
  for (let i = 0; i < limit; i += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
  }
  await expect(target).toBeFocused();
}

test("the PO's timer by keyboard alone, on a desktop", async ({ page }) => {
  test.setTimeout(120_000);
  await createRoom(page);
  await join(page, "Ana");
  await page.getByRole("button", { name: "Start voting" }).focus();
  await page.keyboard.press("Enter");
  await expect(centreStatus(page)).toHaveAttribute("data-centre-status", "voting");
  // From the hand back to the centre's chip.
  await tabTo(page, timerButton(page), true);
  await page.keyboard.press("Enter");
  await expect(timerMenu(page).locator("[data-timer-preset='30']")).toBeVisible();
  await tabTo(page, timerMenu(page).locator("[data-timer-preset='30']"));
  await page.keyboard.press("Enter");
  await expect(timerButton(page)).toBeFocused();
  await expect(chipText(page)).toHaveText(/^0:(30|2\d)$/);

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Add 30 seconds" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chipText(page)).toHaveText(/^0:5\d|1:00$/);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Stop the timer" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(timerButton(page)).toHaveAttribute("data-timer", "idle");
  await expect(timerButton(page)).toBeFocused();

  // A custom length; R in the field is a letter, not the reveal.
  await page.keyboard.press("Enter");
  const field = timerMenu(page).getByRole("textbox", { name: "Length" });
  await tabTo(page, field);
  await page.keyboard.type("r");
  await expect(centreStatus(page)).toHaveAttribute("data-centre-status", "voting");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("1:30");
  await page.keyboard.press("Enter");
  await expect(timerButton(page)).toBeFocused();
  await expect(chipText(page)).toHaveText(/^1:(30|2\d)$/);
  // R on the chip reveals, as anywhere on the table.
  await page.keyboard.press("r");
  await expect(centreStatus(page)).toHaveAttribute("data-centre-status", "revealed");
  await expect(chip(page)).toHaveCount(0);
  // The chip left with the round: the focus went to the PO's decision under the table.
  await expect(page.locator("[data-decision] :focus")).toHaveCount(1);
});

test("the PO's timer by keyboard alone, on a phone, with the hand docked under the table", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const pixel = await phone(browser, "Pixel 7");
  const { page } = pixel;
  try {
    await createRoom(page);
    await join(page, "Ana");
    await page.getByRole("button", { name: "Start voting" }).focus();
    await page.keyboard.press("Enter");
    await expect(centreStatus(page)).toHaveAttribute("data-centre-status", "voting");
    // On a phone the chip stands alone: "+30 s" and "Stop" live in its menu.
    await expect(page.getByRole("button", { name: "Add 30 seconds" })).toHaveCount(0);
    await tabTo(page, timerButton(page), true);
    await page.keyboard.press("Enter");
    await tabTo(page, timerMenu(page).locator("[data-timer-preset='60']"));
    await page.keyboard.press("Enter");
    await expect(timerButton(page)).toBeFocused();
    await expect(chipText(page)).toHaveText(/^(1:00|0:5\d)$/);
    await expect(page.locator("[data-centre] [data-timer-stop]")).toBeHidden();

    await page.keyboard.press("Enter");
    const add = timerMenu(page).locator("[data-menu-extend]");
    await tabTo(page, add);
    await page.keyboard.press("Enter");
    await expect(chipText(page)).toHaveText(/^1:[23]\d$/);
    await expect(timerButton(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await tabTo(page, timerMenu(page).locator("[data-menu-stop]"));
    await page.keyboard.press("Enter");
    await expect(timerButton(page)).toHaveAttribute("data-timer", "idle");

    // #22's rule: where the hand docks, "Reveal cards", the timer and the PO's seat end
    // above it.
    await page.evaluate(() => window.scrollTo(0, 0));
    const dock = page.locator("[data-hand-dock]");
    if ((await dock.count()) > 0) {
      const top = (await dock.boundingBox())?.y ?? 0;
      for (const part of [
        page.getByRole("button", { name: "Reveal cards" }),
        timerButton(page),
        seats(page).locator("[data-you]").first(),
      ]) {
        const box = await part.boundingBox();
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(top);
      }
    }
    expect(pixel.errors).toEqual([]);
  } finally {
    await pixel.context.close();
  }
});

/** The PO's centre, part by part, and the slot cards it must not touch. */
async function clearance(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element) => element.getBoundingClientRect();
    const parts = [
      ...document.querySelectorAll(
        "[data-centre] [data-timer-controls] > *, [data-centre] [data-centre-status], [data-centre] [data-reveal]",
      ),
    ]
      .map(box)
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const cards = [...document.querySelectorAll("[data-slot-card] > [data-face]")].map(box);
    let touching = 0;
    for (const part of parts) {
      for (const card of cards) {
        if (
          part.left < card.right &&
          card.left < part.right &&
          part.top < card.bottom &&
          card.top < part.bottom
        ) {
          touching += 1;
        }
      }
    }
    const left = Math.min(...parts.map((p) => p.left));
    const right = Math.max(...parts.map((p) => p.right));
    const top = Math.min(...parts.map((p) => p.top));
    const bottom = Math.max(...parts.map((p) => p.bottom));
    return {
      width: Math.round(right - left),
      height: Math.round(bottom - top),
      touching,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

const LANGUAGES = [
  ["Français", /^Language: English$/, "fr"],
  ["Deutsch", /^Langue/, "de"],
  ["English", /^Sprache/, "en"],
] as const;

test("the PO's timer controls stay clear of every card at 4, 8, 10 and 16 seats, in every language, on a desktop and a phone", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(600_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const guests: Guest[] = [];
  const po = await sameUser(base, context);
  try {
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(
      await po.cmd("updateSettings", { patch: { timer: { revealAtEnd: false } } }),
    ).toMatchObject({ ok: true });
    await page.getByRole("button", { name: "Start voting" }).click();
    const sizes: {
      label: string;
      language: string;
      width: number;
      viewport: number;
      height: number;
      touching: number;
      sideways: boolean;
    }[] = [];
    const measure = async (label: string) => {
      for (const viewport of [1440, 360]) {
        await page.setViewportSize({ width: viewport, height: 900 });
        await page.waitForTimeout(200);
        for (const [language, current, lang] of LANGUAGES) {
          await page.getByRole("button", { name: current }).click();
          await page.getByRole("menuitemradio", { name: language }).click();
          await expect(page.locator("html")).toHaveAttribute("lang", lang);
          await page.waitForTimeout(100);
          sizes.push({ label, language: lang, viewport, ...(await clearance(page)) });
        }
      }
    };
    for (const count of [4, 8, 10, 16]) {
      const names = Array.from(
        { length: count - 1 - guests.length },
        (_, i) => `Guest ${guests.length + i + 1}`,
      );
      guests.push(...(await guestsJoin(base, code, names)));
      await expect(seats(page).locator("[data-seat]")).toHaveCount(count);
      // No timer: the PO's "Timer" chip.
      expect(await po.cmd("startTimer", { seconds: 600 })).toMatchObject({ ok: true });
      expect(await po.cmd("stopTimer", {})).toMatchObject({ ok: true });
      await expect(timerButton(page)).toHaveAttribute("data-timer", "idle");
      await measure(`idle-${count}`);
      // Running: on a desktop "Stop" and "+30 s" beside it.
      expect(await po.cmd("startTimer", { seconds: 600 })).toMatchObject({ ok: true });
      await expect(timerButton(page)).toHaveAttribute("data-timer", "running");
      await measure(`running-${count}`);
      // Time is up: the longest words.
      expect(await po.cmd("startTimer", { seconds: 5 })).toMatchObject({ ok: true });
      await expect(timerButton(page)).toHaveAttribute("data-timer", "up", { timeout: 10_000 });
      await measure(`up-${count}`);
      if (count === 8 || count === 16) {
        for (const lang of ["fr", "de"] as const) {
          await page.getByRole("button", { name: /^Language: English$/ }).click();
          await page
            .getByRole("menuitemradio", { name: lang === "fr" ? "Français" : "Deutsch" })
            .click();
          await page.setViewportSize({ width: 360, height: 900 });
          await page.waitForTimeout(200);
          await page.screenshot({ path: `${SHOTS}timer-centre-up-${count}-${lang}-360.png` });
          await page.getByRole("button", { name: lang === "fr" ? /^Langue/ : /^Sprache/ }).click();
          await page.getByRole("menuitemradio", { name: "English" }).click();
        }
      }
    }
    console.log(`timer centre sizes: ${JSON.stringify(sizes)}`);
    for (const size of sizes) {
      const at = `${size.label} in ${size.language} at ${size.viewport} px`;
      expect(size.touching, `${at}: against a card`).toBe(0);
      expect(size.sideways, `${at}: sideways scroll`).toBe(false);
    }
  } finally {
    po.close();
    for (const guest of guests) guest.close();
  }
});
