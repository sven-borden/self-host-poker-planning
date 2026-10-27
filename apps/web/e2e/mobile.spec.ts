import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  createRoom,
  type Guest,
  join,
  newGuest,
  ownAddress,
  SHOTS,
  sameUser,
  seats,
} from "./support.ts";

// Phones (#22), against the real server and Postgres: a whole round on the iPhone 13 and
// Pixel 7 descriptors by touch (AC 1), no sideways scroll from 320 to 640 px in English,
// French and German in every phase (AC 2), 16 seats that stay apart at 360 px (AC 3), the
// hand docked within thumb reach while voting, the subject, table and hand on one screen
// at 390 × 844 with 8 people, a phone on its side, and the screenshots. Exported helpers
// are meant for #23's four-person round. Needs DATABASE_URL; skipped without it locally,
// failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the phone tests: set DATABASE_URL");
  }
});

type Device = "iPhone 13" | "Pixel 7";

export interface Phone {
  context: BrowserContext;
  page: Page;
  /** Every `navigator.vibrate` pattern the page asked for. */
  vibrations: () => Promise<number[]>;
  /** Uncaught errors on the page. */
  errors: string[];
}

/**
 * A phone: a device descriptor (viewport, touch, mobile, user agent) in the configured
 * Chromium or Edge, or a bare phone-sized viewport. The iPhone has no `navigator.vibrate`,
 * as in Safari; elsewhere each call is recorded.
 */
export async function phone(
  browser: Browser,
  device: Device | { width: number; height: number },
): Promise<Phone> {
  const options =
    typeof device === "string"
      ? (({ defaultBrowserType: _, ...descriptor }) => descriptor)(devices[device])
      : { viewport: device, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const context = await browser.newContext({
    ...options,
    locale: "en-US",
    extraHTTPHeaders: ownAddress(),
  });
  const ios = device === "iPhone 13";
  await context.addInitScript((noVibrate: boolean) => {
    const calls: number[] = [];
    Object.assign(window, { __vibrations: calls });
    if (noVibrate) {
      Reflect.deleteProperty(Navigator.prototype, "vibrate");
      return;
    }
    Object.defineProperty(Navigator.prototype, "vibrate", {
      configurable: true,
      value: (pattern: number | Iterable<number>) => {
        calls.push(...(typeof pattern === "number" ? [pattern] : pattern));
        return true;
      },
    });
  }, ios);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return {
    context,
    page,
    errors,
    vibrations: () =>
      page.evaluate(() => (window as unknown as { __vibrations: number[] }).__vibrations),
  };
}

export const hand = (page: Page) => page.getByRole("toolbar", { name: "Your cards" });
export const handCard = (page: Page, label: string) =>
  hand(page).getByRole("button", { name: label, exact: true });
const handLive = (page: Page) => page.locator("[data-hand-live]");
const results = (page: Page) => page.getByRole("region", { name: "Results" });
const stat = (page: Page, key: string) => results(page).locator(`[data-stat='${key}'] dd`);

/** Guests who join as voters over the protocol, named in order. */
export async function guestsJoin(base: string, code: string, names: readonly string[]) {
  const guests: Guest[] = [];
  for (const name of names) {
    const guest = await newGuest(base);
    guests.push(guest);
    expect(await guest.enter(code)).toMatchObject({ ok: true });
    expect(await guest.cmd("join", { name, role: "voter" })).toMatchObject({ ok: true });
  }
  return guests;
}

async function vote(guests: readonly Guest[], cards: readonly string[], round = 1) {
  for (const [i, guest] of guests.entries()) {
    const card = cards[i];
    if (card === undefined) continue;
    expect(await guest.cmd("castVote", { card, round })).toMatchObject({ ok: true });
  }
}

/** How far the page scrolls sideways (0 when it does not), and what sticks out. */
async function sideScroll(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const over = root.scrollWidth - root.clientWidth;
    const out =
      over <= 0
        ? []
        : [...document.querySelectorAll("body *")]
            .filter((element) => element.getBoundingClientRect().right > root.clientWidth + 0.5)
            .slice(0, 4)
            .map((element) => element.outerHTML.slice(0, 120));
    return { over, out };
  });
}

/** Reloads the page in another language, as the language switcher would leave it. */
async function inLanguage(page: Page, language: "en" | "fr" | "de") {
  await page.evaluate((code) => localStorage.setItem("pp-language", code), language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  await expect(page.getByTestId("room-connection")).not.toBeEmpty();
}

const SIZES = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
] as const;

/** Screenshots at 360 × 780 and 390 × 844, light and dark; the viewport, or the page. */
async function shootPhone(page: Page, name: string, { fullPage = false } = {}) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const size of SIZES) {
      await page.setViewportSize(size);
      // The table measures its container; let it settle at the new width.
      await page.waitForTimeout(200);
      // What the phone shows first: the top of the page, the hand docked when voting.
      if (!fullPage) await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `${SHOTS}phone-${name}-${size.width}x${size.height}-${scheme}.png`,
        fullPage,
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("a round on an iPhone 13 and a Pixel 7, by touch (AC 1)", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const iphone = await phone(browser, "iPhone 13");
  const pixel = await phone(browser, "Pixel 7");
  let guests: Guest[] = [];
  try {
    const code = await createRoom(iphone.page);
    await join(iphone.page, "Ana");
    await pixel.page.goto(iphone.page.url());
    await join(pixel.page, "Ben");
    // A third voter who keeps the round open until the PO reveals it.
    guests = await guestsJoin(baseURL ?? "", code, ["Cleo"]);
    await expect(seats(iphone.page).locator("[data-seat]")).toHaveCount(3);

    await iphone.page.getByRole("button", { name: "Start voting" }).tap();
    for (const [viewer, card] of [
      [iphone, "5"],
      [pixel, "8"],
    ] as const) {
      // Within thumb reach without scrolling: docked at the bottom of the screen.
      const dock = viewer.page.locator("[data-hand-dock]");
      await expect(dock).toHaveCSS("position", "sticky");
      const box = await dock.boundingBox();
      const height = viewer.page.viewportSize()?.height ?? 0;
      expect(box && box.y >= 0 && box.y + box.height <= height, JSON.stringify(box)).toBe(true);
      await handCard(viewer.page, card).tap();
      await expect(handLive(viewer.page)).toHaveText(`Your vote: ${card}.`);
    }
    await expect(iphone.page.locator("[data-centre-status='voting']")).toHaveText(
      "2/3 voted so far",
    );
    // A tick on Android once the vote is confirmed; Safari has no vibrate, and nothing fails.
    expect(await pixel.vibrations()).toEqual([12]);
    expect(await iphone.vibrations()).toEqual([]);

    await iphone.page.getByRole("button", { name: "Reveal cards" }).tap();
    for (const viewer of [iphone, pixel]) {
      await expect(stat(viewer.page, "average")).toHaveText("6.5");
      await expect(stat(viewer.page, "agreement")).toHaveText("50%");
      // The results stack under the table and the hand no longer docks over them.
      await expect(viewer.page.locator("[data-hand-dock]")).toHaveCount(0);
      const table = await viewer.page.locator("[data-stage]").boundingBox();
      const panel = await results(viewer.page).boundingBox();
      expect(table && panel && panel.y >= table.y + table.height).toBe(true);
      expect((await sideScroll(viewer.page)).over).toBeLessThanOrEqual(0);
    }
    await iphone.page.getByRole("button", { name: "Next round" }).tap();
    await expect(iphone.page.locator("[data-round-subject]")).toHaveText("Round 2");
    expect(iphone.errors).toEqual([]);
    expect(pixel.errors).toEqual([]);
  } finally {
    for (const guest of guests) guest.close();
    await iphone.context.close();
    await pixel.context.close();
  }
});

test("no page scrolls sideways from 320 to 640 px, in English, French and German, in every phase (AC 2)", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const po = await phone(browser, { width: 360, height: 780 });
  const visitor = await phone(browser, { width: 360, height: 780 });
  const { page } = po;
  let guests: Guest[] = [];
  let owner: Guest | undefined;
  const widths = [320, 360, 390, 640];
  /** Ends in English, which the locators here speak. */
  const check = async (viewer: Page, phase: string, prepare?: () => Promise<void>) => {
    for (const language of ["fr", "de", "en"] as const) {
      await inLanguage(viewer, language);
      await prepare?.();
      for (const width of widths) {
        await viewer.setViewportSize({ width, height: 780 });
        await viewer.waitForTimeout(120);
        const { over, out } = await sideScroll(viewer);
        expect(over, `${phase}, ${language}, ${width} px: ${out.join(" | ")}`).toBeLessThanOrEqual(
          0,
        );
      }
    }
  };
  try {
    const code = await createRoom(page);
    await join(page, "Maximiliane Schwarzenberger");
    guests = await guestsJoin(baseURL ?? "", code, [
      "Bartholomäus Wichtelhausen",
      "Cleo",
      "Dan Wu",
      "Eve Novak",
      "Finn Berg",
      "Gus Moreau",
      "Hana Sato",
      "Ivo Petrov",
    ]);
    const watcher = await newGuest(baseURL ?? "");
    guests.push(watcher);
    expect(await watcher.enter(code)).toMatchObject({ ok: true });
    expect(
      await watcher.cmd("join", { name: "Konstantinopolitanerin Observer", role: "observer" }),
    ).toMatchObject({ ok: true });
    owner = await sameUser(baseURL ?? "", po.context);
    expect(await owner.enter(code)).toMatchObject({ ok: true });

    // Not in the room yet: the join form.
    await visitor.page.goto(page.url());
    await expect(visitor.page.getByRole("button", { name: "Join the room" })).toBeVisible();
    await check(visitor.page, "join");

    await check(page, "lobby");

    const title =
      "Kundenkontoverwaltungsoberflächenüberarbeitung: Zahlungsabwicklung für wiederkehrende Abonnements mit Teilrückerstattungen und Gutschriften";
    expect(
      await owner.cmd("startRound", { subject: { kind: "title", text: title } }),
    ).toMatchObject({ ok: true });
    await vote(guests.slice(0, 4), ["3", "5", "8", "13"]);
    await expect(hand(page)).toBeVisible();
    await check(page, "voting");
    // The PO's field with its hint, which shows on a phone while the field has the focus.
    await check(page, "voting, the subject field focused", async () => {
      await page.locator("[data-next-subject] input").fill(title);
      await expect(page.locator("[data-next-subject] p")).toBeVisible();
    });

    expect(await owner.cmd("reveal")).toMatchObject({ ok: true });
    await check(page, "revealed");
    expect(
      await owner.cmd("startRound", {
        subject: {
          kind: "link",
          url: "https://example.atlassian.net/browse/PAYMENTS-48213?focusedCommentId=1234567",
        },
      }),
    ).toMatchObject({ ok: true });
    await vote(guests.slice(0, 8), ["1", "2", "3", "5", "8", "13", "21", "?"], 2);
    expect(await owner.cmd("reveal")).toMatchObject({ ok: true });
    await expect(results(page)).toBeVisible();
    await check(page, "revealed, a link");
  } finally {
    owner?.close();
    for (const guest of guests) guest.close();
    await po.context.close();
    await visitor.context.close();
  }
});

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const overlap = (a: Box, b: Box) =>
  a.left < b.right - 0.5 &&
  b.left < a.right - 0.5 &&
  a.top < b.bottom - 0.5 &&
  b.top < a.bottom - 0.5;

/** Each seat as the page draws it: its name for screen readers, its look, its boxes. */
function seatLayout(page: Page) {
  return seats(page)
    .locator("[data-seat]")
    .evaluateAll((items) =>
      items.map((item) => {
        const box = (rect: DOMRect) => ({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        });
        const button = item.querySelector("button");
        const avatar = item.querySelector("[data-avatar]");
        // The avatar with its badges, as one box.
        const drawn = [...item.querySelectorAll("[data-avatar], [data-badge]")]
          .map((part) => part.getBoundingClientRect())
          .reduce(
            (all, rect) => ({
              left: Math.min(all.left, rect.left),
              top: Math.min(all.top, rect.top),
              right: Math.max(all.right, rect.right),
              bottom: Math.max(all.bottom, rect.bottom),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
          );
        const name = item.querySelector("[data-seat-part=name]");
        return {
          label:
            button?.getAttribute("aria-label") ??
            button?.querySelector(".sr-only")?.textContent ??
            "",
          initials: avatar?.textContent ?? "",
          colour: avatar ? getComputedStyle(avatar).backgroundColor : "",
          drawn,
          target: button ? box(button.getBoundingClientRect()) : drawn,
          name: name ? box(name.getBoundingClientRect()) : null,
        };
      }),
    );
}

const FIFTEEN = [
  "Ana Lima",
  "Ben Okafor",
  "Cleo Martin",
  "Dan Wu",
  "Eve Novak",
  "Finn Berg",
  "Gus Moreau",
  "Hana Sato",
  "Ivo Petrov",
  "Jana Kraus",
  "Kai Jensen",
  "Lea Rossi",
  "Mo Haddad",
  "Nora Lind",
  // A second Ana Lima: the same initials in another colour, and "(2)" in her seat's name.
  "Ana Lima",
];

test("16 seats stay apart at 360 px: names, initials and colours of their own, nothing overlapping (AC 3)", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const po = await phone(browser, { width: 360, height: 780 });
  const { page } = po;
  let guests: Guest[] = [];
  let owner: Guest | undefined;
  try {
    const code = await createRoom(page);
    await join(page, "Sven Muster");
    guests = await guestsJoin(baseURL ?? "", code, FIFTEEN);
    owner = await sameUser(baseURL ?? "", po.context);
    expect(await owner.enter(code)).toMatchObject({ ok: true });
    // The modified Fibonacci deck: "100" and "½" are the widest labels a preset holds.
    expect(
      await owner.cmd("updateSettings", { patch: { deck: { kind: "preset", id: "mfib" } } }),
    ).toMatchObject({ ok: true });
    await expect(seats(page).locator("[data-seat]")).toHaveCount(16);
    await expect(page.locator("[data-stage]")).toHaveAttribute("data-variant", "phone");

    await page.getByRole("button", { name: "Start voting" }).tap();
    await vote(guests.slice(0, 9), ["0", "½", "1", "2", "3", "5", "8", "13", "20"]);
    await expect(page.locator("[data-centre-status='voting']")).toHaveText("9/16 voted so far");

    const layout = await seatLayout(page);
    expect(layout).toHaveLength(16);
    expect(new Set(layout.map((seat) => seat.label)).size, "seat names").toBe(16);
    expect(layout.map((seat) => seat.label)).toContain("Ana Lima (2), thinking");
    expect(
      new Set(layout.map((seat) => `${seat.initials} ${seat.colour}`)).size,
      "initials and colours",
    ).toBe(16);
    // Only the two Ana Limas share initials, in two colours.
    expect(new Set(layout.map((seat) => seat.initials)).size).toBe(15);
    for (const [i, seat] of layout.entries()) {
      expect(seat.name, "initials only above 10 people").toBeNull();
      expect(seat.drawn.left >= 0 && seat.drawn.right <= 360, `${seat.label} on screen`).toBe(true);
      expect(seat.target.right - seat.target.left).toBeGreaterThanOrEqual(44);
      for (const other of layout.slice(i + 1)) {
        expect(overlap(seat.drawn, other.drawn), `${seat.label} / ${other.label}`).toBe(false);
        expect(overlap(seat.target, other.target), `${seat.label} / ${other.label} targets`).toBe(
          false,
        );
      }
    }
    await shootPhone(page, "voting-16");

    // Everyone else votes, the PO last: the round reveals itself.
    await vote(guests.slice(9), ["40", "100", "?", "5", "8", "13"]);
    await page.setViewportSize({ width: 360, height: 780 });
    await handCard(page, "100").tap();
    await expect(results(page)).toBeVisible();
    await expect(page.locator("[data-room-table] [data-face='up']")).toHaveCount(16);
    // Every card on the table stays legible: no label below 7 px.
    const sizes = await page
      .locator("[data-room-table] [data-face='up'] span[data-card-value]")
      .evaluateAll((values) =>
        values.map((value) => ({
          card: value.textContent,
          px: Number.parseFloat(getComputedStyle(value).fontSize),
        })),
      );
    expect(sizes.filter(({ px }) => px < 7)).toEqual([]);
    expect(sizes.find(({ card }) => card === "13")?.px).toBeGreaterThanOrEqual(10.5);
    const revealed = await seatLayout(page);
    for (const [i, seat] of revealed.entries()) {
      for (const other of revealed.slice(i + 1)) {
        expect(overlap(seat.drawn, other.drawn), `${seat.label} / ${other.label}`).toBe(false);
      }
    }
    expect((await sideScroll(page)).over).toBeLessThanOrEqual(0);
    await page.waitForTimeout(2600);
    await shootPhone(page, "reveal-16");
  } finally {
    owner?.close();
    for (const guest of guests) guest.close();
    await po.context.close();
  }
});

test("at 390 × 844 with 8 people the subject, the table and the hand fit on one screen while voting", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const po = await phone(browser, { width: 390, height: 844 });
  const ben = await phone(browser, { width: 390, height: 844 });
  const { page } = po;
  let guests: Guest[] = [];
  try {
    const code = await createRoom(page);
    await join(page, "Ana");
    await ben.page.goto(page.url());
    await join(ben.page, "Ben");
    guests = await guestsJoin(baseURL ?? "", code, [
      "Cleo",
      "Dan",
      "Eve Novak",
      "Finn",
      "Gus",
      "Hana",
    ]);
    await expect(seats(page).locator("[data-seat]")).toHaveCount(8);
    await shootPhone(page, "lobby-8");

    await page
      .locator("[data-next-subject] input")
      .fill("https://example.atlassian.net/browse/PAY-482");
    await page.getByRole("button", { name: "Start voting" }).tap();
    await expect(page.locator("[data-subject-key]")).toHaveText("PAY-482");
    await vote(guests.slice(0, 4), ["3", "5", "8", "13"]);
    for (const viewer of [page, ben.page]) {
      await viewer.setViewportSize({ width: 390, height: 844 });
      await viewer.waitForTimeout(200);
      const fit = await viewer.evaluate(() => {
        const rect = (selector: string) =>
          document.querySelector(selector)?.getBoundingClientRect();
        // The PO's field above the subject line, or the subject line, at the top.
        const first = () => rect("[data-next-subject]") ?? rect("[data-round-subject]");
        window.scrollTo(0, window.scrollY + (first()?.top ?? 0) - 8);
        return {
          first: first()?.top ?? -1,
          table: rect("[data-stage]")?.bottom ?? Number.POSITIVE_INFINITY,
          handTop: rect("[data-room-hand]")?.top ?? -1,
          handBottom: rect("[data-room-hand]")?.bottom ?? Number.POSITIVE_INFINITY,
          height: window.innerHeight,
        };
      });
      expect(fit.first, "the subject on screen").toBeGreaterThanOrEqual(0);
      expect(fit.table, "the table above the hand").toBeLessThanOrEqual(fit.handTop);
      expect(fit.handBottom, "the hand on screen").toBeLessThanOrEqual(fit.height);
      // At the top of the page the hand is docked at the bottom, within thumb reach.
      await viewer.evaluate(() => window.scrollTo(0, 0));
      const dock = await viewer.locator("[data-hand-dock]").boundingBox();
      expect(dock && dock.y + dock.height <= 844).toBe(true);
    }
    // The PO, field and all, and a guest see it all at the top of the page, unscrolled.
    for (const viewer of [page, ben.page]) {
      await viewer.evaluate(() => window.scrollTo(0, 0));
      const atTop = await viewer.evaluate(() => ({
        table: document.querySelector("[data-stage]")?.getBoundingClientRect().bottom ?? -1,
        hand: document.querySelector("[data-room-hand]")?.getBoundingClientRect().top ?? -1,
      }));
      expect(atTop.table, "the table above the hand, unscrolled").toBeLessThanOrEqual(atTop.hand);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await shootPhone(page, "voting-8");
    await ben.page.evaluate(() => window.scrollTo(0, 0));
    await shootPhone(ben.page, "voting-8-guest");

    // The PO's controls stay clear of the docked hand: "Reveal cards" takes a tap.
    await handCard(ben.page, "5").tap();
    await page.getByRole("button", { name: "Reveal cards" }).tap();
    await expect(results(page)).toBeVisible();
    await page.waitForTimeout(2600);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shootPhone(page, "reveal-8");
    await shootPhone(page, "results-8", { fullPage: true });
    // Nothing covers the results or the "You" panel once the round is revealed.
    await expect(page.locator("[data-hand-dock]")).toHaveCount(0);
    await page.getByRole("heading", { name: "You", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("heading", { name: "You", exact: true })).toBeInViewport();
  } finally {
    for (const guest of guests) guest.close();
    await po.context.close();
    await ben.context.close();
  }
});

test("a phone on its side (844 × 390) keeps the table, the hand and the controls apart", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const po = await phone(browser, { width: 844, height: 390 });
  const { page } = po;
  let guests: Guest[] = [];
  try {
    const code = await createRoom(page);
    await join(page, "Ana");
    guests = await guestsJoin(baseURL ?? "", code, ["Ben", "Cleo", "Dan"]);
    await page.getByRole("button", { name: "Start voting" }).tap();
    // Too short to dock: the hand stays in the page, under the table.
    await expect(page.locator("[data-room-hand]")).toHaveCSS("position", "static");
    await expect
      .poll(async () => {
        const table = await page.locator("[data-stage]").boundingBox();
        const cards = await hand(page).boundingBox();
        return table && cards && cards.y - (table.y + table.height);
      })
      .toBeGreaterThanOrEqual(0);
    expect((await sideScroll(page)).over).toBeLessThanOrEqual(0);
    await handCard(page, "8").tap();
    await expect(handLive(page)).toHaveText("Your vote: 8.");
    await vote(guests.slice(0, 2), ["5", "8"]);
    await page.getByRole("button", { name: "Reveal cards" }).tap();
    await expect(stat(page, "average")).toHaveText("7");
    expect((await sideScroll(page)).over).toBeLessThanOrEqual(0);
    await page.waitForTimeout(2600);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${SHOTS}phone-landscape-844x390-${scheme}.png` });
      await page.screenshot({
        path: `${SHOTS}phone-landscape-844x390-${scheme}-page.png`,
        fullPage: true,
      });
    }
    expect(po.errors).toEqual([]);
  } finally {
    for (const guest of guests) guest.close();
    await po.context.close();
  }
});
