import { expect, type Page, test } from "@playwright/test";
import {
  createRoom,
  type Guest,
  guestsJoin,
  hand,
  handCard,
  join,
  newGuest,
  phone,
  SHOTS,
  sameUser,
  seats,
} from "./support.ts";

// Phones (#22), against the real server and Postgres: a whole round on the iPhone 13 and
// Pixel 7 descriptors by touch (AC 1), no sideways scroll from 320 to 640 px in English,
// French and German in every phase (AC 2), 16 seats that stay apart at 360 px (AC 3), the
// hand docked within thumb reach while voting, the subject, table and hand on one screen
// at 390 × 844 with 8 people, a phone on its side, and the screenshots. The helpers for
// phones (`phone`, `guestsJoin`, `hand`, `handCard`) live in support.ts, for #23's
// four-person round: Playwright refuses a test file that imports another. Needs DATABASE_URL; skipped without it locally,
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

const handLive = (page: Page) => page.locator("[data-hand-live]");
const results = (page: Page) => page.getByRole("region", { name: "Results" });
const stat = (page: Page, key: string) => results(page).locator(`[data-stat='${key}'] dd`);

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
      // Docked at the bottom of the screen where the table leaves room for it, in the page
      // under the table where it does not; never over "Reveal cards" or the viewer's seat.
      expectClearOfDock(await dockAtTop(viewer.page), card);
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

/** What the phone shows at the top of the page while voting, and where the docked hand is. */
async function dockAtTop(page: Page) {
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    window.scrollTo(0, 0);
    const box = (element: Element | null) => {
      if (!element) return null;
      const { top, bottom } = element.getBoundingClientRect();
      return { top, bottom };
    };
    const dock = document.querySelector("[data-hand-dock]");
    const panel = document.querySelector("[data-room-hand]");
    return {
      dock: dock ? { ...box(dock), position: getComputedStyle(dock).position } : null,
      hand: panel ? getComputedStyle(panel).position : null,
      kept: {
        "Reveal cards": box(document.querySelector("[data-reveal]")),
        "the viewer's seat": box(document.querySelector("[data-room-table] [data-seat][data-you]")),
        "the viewer's slot": box(
          document.querySelector("[data-room-table] [data-slot-card][data-you]"),
        ),
      },
      height: document.documentElement.clientHeight,
    };
  });
}

type AtTop = Awaited<ReturnType<typeof dockAtTop>>;

/**
 * Nothing that matters lies under the docked hand: "Reveal cards" and the viewer's seat
 * and slot end above it, on screen. A hand that does not dock stays in the page.
 */
function expectClearOfDock(at: AtTop, where: string) {
  if (at.dock === null) {
    expect(at.hand, `${where}: the hand in the page`).toBe("static");
    return;
  }
  const dock = at.dock as { top: number; bottom: number; position: string };
  expect(dock.position, where).toBe("sticky");
  expect(dock.bottom, `${where}: the dock on screen`).toBeLessThanOrEqual(at.height + 0.5);
  for (const [name, box] of Object.entries(at.kept)) {
    if (box === null) continue;
    expect(box.top, `${where}: ${name} on screen`).toBeGreaterThanOrEqual(0);
    expect(box.bottom, `${where}: ${name} above the dock`).toBeLessThanOrEqual(dock.top + 0.5);
  }
}

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
    // The second Ana Lima is numbered for sighted people too, in her seat's popover.
    await page.setViewportSize({ width: 360, height: 780 });
    await seats(page).getByRole("button", { name: "Ana Lima (2), thinking" }).tap();
    await expect(page.getByRole("dialog")).toContainText("Ana Lima (2)");
    await page.screenshot({ path: `${SHOTS}phone-fix-08-namesake-popover-360x780.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

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

    // The T-shirt deck's long labels narrow rather than shrink below 7 px, on the slots
    // and in the centre's tie chips ("XL", "XXL").
    expect(
      await owner.cmd("updateSettings", { patch: { deck: { kind: "preset", id: "tshirt" } } }),
    ).toMatchObject({ ok: true });
    await page.setViewportSize({ width: 360, height: 780 });
    await page.getByRole("button", { name: "Next round" }).tap();
    await vote(
      guests,
      ["XXL", "XXL", "XXL", "XXL", "XL", "XL", "XL", "XL", "XS", "XS", "S", "S", "M", "M", "L"],
      2,
    );
    await handCard(page, "L").tap();
    await expect(results(page)).toBeVisible();
    await expect(page.locator("[data-room-table] [data-face='up']")).toHaveCount(16);
    const shirts = await page
      .locator("[data-room-table] span[data-card-value]")
      .evaluateAll((values) =>
        values.map((value) => ({
          card: value.textContent,
          px: Number.parseFloat(getComputedStyle(value).fontSize),
          narrow: value.hasAttribute("data-narrow"),
        })),
      );
    expect(shirts.filter(({ px }) => px < 7)).toEqual([]);
    expect(shirts.some(({ card, narrow }) => card === "XXL" && narrow)).toBe(true);
    await page.waitForTimeout(2600);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${SHOTS}phone-fix-06-tshirt-16-360x780.png` });
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
      // At the top of the page the hand is docked at the bottom, within thumb reach, and
      // the table, "Reveal cards" and the viewer's seat end above it.
      const atTop = await dockAtTop(viewer);
      expect(atTop.dock, "docked at 390 × 844").not.toBeNull();
      expectClearOfDock(atTop, "390 × 844");
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

const LONG_TITLES = {
  en: "Payment retries for the second card when the first one is declined twice in a row",
  fr: "Nouvelles tentatives de paiement avec la deuxième carte quand la première est refusée",
  de: "Zahlungswiederholung mit der zweiten Karte, wenn die erste zweimal abgelehnt wird",
} as const;

test("the docked hand never covers Reveal cards or the viewer's seat: 320 to 390 px, three languages, two-line titles, 150 % text", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const po = await phone(browser, "iPhone SE");
  const ben = await phone(browser, { width: 390, height: 844 });
  const { page } = po;
  let guests: Guest[] = [];
  let owner: Guest | undefined;
  /** Where the hand docked, for the report. */
  const docked: string[] = [];
  const sizes = [
    { width: 390, height: 844 },
    { width: 390, height: 664 }, // an iPhone 13 in Safari, its bars showing
    { width: 360, height: 780 },
    { width: 320, height: 568 }, // an iPhone SE
  ];
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
    owner = await sameUser(baseURL ?? "", po.context);
    expect(await owner.enter(code)).toMatchObject({ ok: true });

    for (const subject of ["link", "title"] as const) {
      for (const language of ["en", "fr", "de"] as const) {
        if (subject === "title" || language === "en") {
          const ack = await owner.cmd("startRound", {
            subject:
              subject === "link"
                ? { kind: "link", url: "https://example.atlassian.net/browse/PAY-482" }
                : { kind: "title", text: LONG_TITLES[language] },
          });
          expect(ack).toMatchObject({ ok: true });
        }
        for (const [who, viewer] of [
          ["PO", page],
          ["guest", ben.page],
        ] as const) {
          await inLanguage(viewer, language);
          await expect(viewer.locator("[data-room-hand]")).toBeVisible();
          if (who === "PO") await expect(viewer.locator("[data-reveal]")).toBeVisible();
          for (const size of sizes) {
            await viewer.setViewportSize(size);
            const where = `${who}, ${language}, ${subject}, ${size.width} × ${size.height}`;
            const at = await dockAtTop(viewer);
            if (who === "PO") expect(at.kept["Reveal cards"], where).not.toBeNull();
            expectClearOfDock(at, where);
            if (at.dock) docked.push(where);
          }
          // 150 % text: the dock grows with it, and still covers nothing.
          if (language !== "fr") {
            const larger = await viewer.addStyleTag({ content: "html { font-size: 150% }" });
            for (const size of [sizes[0], sizes[2]]) {
              if (!size) continue;
              await viewer.setViewportSize(size);
              const where = `${who}, ${language}, ${subject}, 150 % text, ${size.width} × ${size.height}`;
              const at = await dockAtTop(viewer);
              expectClearOfDock(at, where);
              if (at.dock) docked.push(where);
              if (who === "PO" && language === "en" && subject === "link" && size.width === 390) {
                await viewer.screenshot({ path: `${SHOTS}phone-fix-04-text150-390x844.png` });
              }
            }
            await larger.evaluate((element) => (element as Element).remove());
          }
        }
        // The reviewer's situations, after the fix.
        if (language === "en" && subject === "link") {
          await page.setViewportSize({ width: 320, height: 568 });
          await dockAtTop(page);
          await page.screenshot({ path: `${SHOTS}phone-fix-01-iphone-se-po-320x568.png` });
          await ben.page.setViewportSize({ width: 390, height: 664 });
          await dockAtTop(ben.page);
          await ben.page.screenshot({ path: `${SHOTS}phone-fix-02-iphone13-guest-390x664.png` });
        }
        if (language === "de" && subject === "title") {
          await page.setViewportSize({ width: 360, height: 780 });
          await dockAtTop(page);
          await page.screenshot({ path: `${SHOTS}phone-fix-03-de-two-line-title-360x780.png` });
        }
        if (subject === "title" || language === "de") {
          expect(await owner.cmd("reveal")).toMatchObject({ ok: true });
        }
      }
    }
    // The one-screen promise holds where it was made: 390 × 844, English, a short subject.
    expect(docked).toContain("PO, en, link, 390 × 844");
    expect(docked).toContain("guest, en, link, 390 × 844");
    test.info().annotations.push({ type: "docked", description: docked.join("; ") });
    console.log(`docked: ${docked.join("; ")}`);

    // Arrow keys keep the focused card in sight, and the page where it was.
    expect(await owner.cmd("startRound", { subject: { kind: "none" } })).toMatchObject({
      ok: true,
    });
    await inLanguage(ben.page, "en");
    await ben.page.setViewportSize({ width: 360, height: 780 });
    await dockAtTop(ben.page);
    await handCard(ben.page, "0").focus();
    const scrolled = await ben.page.evaluate(() => window.scrollY);
    for (let i = 0; i < 6; i++) await ben.page.keyboard.press("ArrowRight");
    await expect(handCard(ben.page, "13")).toBeFocused();
    const bar = await hand(ben.page).boundingBox();
    const thirteen = await handCard(ben.page, "13").boundingBox();
    expect(
      bar &&
        thirteen &&
        thirteen.x >= bar.x + 31 &&
        thirteen.x + thirteen.width <= bar.x + bar.width - 31,
      JSON.stringify({ bar, thirteen }),
    ).toBe(true);
    expect(await ben.page.evaluate(() => window.scrollY)).toBe(scrolled);
  } finally {
    owner?.close();
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
    // A smaller phone on its side (750 × 342): the PO's field is compact, so the first
    // screen reaches the table.
    await page.getByRole("button", { name: "Next round" }).tap();
    await page.setViewportSize({ width: 750, height: 342 });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.scrollTo(0, 0));
    const field = await page.locator("[data-next-subject]").boundingBox();
    expect(field?.height ?? 99, "the subject field").toBeLessThanOrEqual(48);
    const stage = await page.locator("[data-stage]").boundingBox();
    expect(stage?.y ?? 999, "the table starts on the first screen").toBeLessThan(342);
    await page.screenshot({ path: `${SHOTS}phone-fix-05-landscape-750x342.png` });
    expect(po.errors).toEqual([]);
  } finally {
    for (const guest of guests) guest.close();
    await po.context.close();
  }
});
