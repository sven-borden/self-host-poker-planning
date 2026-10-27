import { type Browser, expect, type Page, test } from "@playwright/test";
import { computeResults } from "../../../packages/domain/src/results.ts";
import { cardLeaks } from "../../../packages/protocol/src/leak-scan.ts";
import {
  animated,
  createRoom,
  type Guest,
  join,
  newGuest,
  newPerson,
  ownAddress,
  recordAnimations,
  recordFrames,
  SHOTS,
  sameUser,
  seats,
  shoot,
  snapshotsIn,
} from "./support.ts";

// The results (#20) in real browsers, against the real server and Postgres: the numbers
// the panel shows equal the domain's `computeResults` for the same votes (AC 1), a T-shirt
// round shows no average (AC 2), the panel, the centre and the live region read as text
// (AC 3), the lowest and highest voters are marked in a named round only, the columns
// rise once the last card has turned, and the PO's phone centre fits between the cards
// in English, French and German ("Next round" sits under the table since #32). Needs DATABASE_URL; skipped without it locally, failing
// without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the results tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const hand = (page: Page) => page.getByRole("toolbar", { name: "Your cards" });
const handCard = (page: Page, label: string) =>
  hand(page).getByRole("button", { name: label, exact: true });
const tableLive = (page: Page) => page.locator("[data-table-live]");
const centreSentence = (page: Page) => page.locator("[data-centre-result] .sr-only");
const results = (page: Page) => page.getByRole("region", { name: "Results" });
const stat = (page: Page, key: string) => results(page).locator(`[data-stat='${key}'] dd`);
const spoken = (page: Page, list: string) =>
  results(page).getByRole("list", { name: list }).locator(":scope > li > .sr-only");

const one = (value: number | null) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value ?? Number.NaN);
const percent = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 }).format(value);

/** Guests who join as voters over the protocol, named in order. */
async function guestsJoin(base: string, code: string, names: readonly string[]) {
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

async function secondBrowser(browser: Browser, url: string, name: string) {
  const person = await newPerson(browser);
  const frames = recordFrames(person.page);
  await person.page.goto(url);
  await join(person.page, name);
  return { ...person, frames };
}

test("a named round: the centre, the panel, the seats and the live region say the results (AC 1, AC 3)", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const code = await createRoom(page);
  await join(page, "Ana");
  const ben = await secondBrowser(browser, page.url(), "Ben");
  const names = ["Cleo", "Dan", "Eve", "Finn", "Gus", "Hana"];
  const guests = await guestsJoin(baseURL ?? "", code, names);
  // Ana 5, Ben 8, then the guests; Hana's 2 is the last vote, which reveals the round.
  const plays = ["3", "5", "8", "13", "?", "2"];
  try {
    await expect(seats(page).locator("[data-seat]")).toHaveCount(8);
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "5").click();
    await handCard(ben.page, "8").click();
    await vote(guests.slice(0, 5), plays);
    await expect(ben.page.locator("[data-card-flight]")).toHaveCount(0);
    await expect(page.locator("[data-card-flight]")).toHaveCount(0);
    await recordAnimations(ben.page);
    await vote(guests.slice(5), plays.slice(5));

    const expected = computeResults(["5", "8", ...plays], { kind: "preset", id: "fib" });
    // 2, 3, 5, 5, 8, 8 and 13: the average 6.3 is nearest 5, two votes in seven.
    const sentence = `Suggested ${expected.suggested}. Agreement ${percent(expected.agreement)}.`;
    expect(sentence).toBe("Suggested 5. Agreement 29%.");
    for (const viewer of [page, ben.page]) {
      await expect(centreSentence(viewer)).toHaveText(sentence);
      await expect(tableLive(viewer)).toContainText(`Cards revealed. ${sentence}`);
      await expect(stat(viewer, "average")).toHaveText(one(expected.average));
      await expect(stat(viewer, "median")).toHaveText(one(expected.median));
      await expect(stat(viewer, "agreement")).toHaveText(percent(expected.agreement));
      await expect(stat(viewer, "spread").locator("[aria-hidden]")).toHaveText("2–13");
      await expect(stat(viewer, "spread").locator(".sr-only")).toHaveText("2 to 13");
    }
    await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
    // A labelled region with real text: a description list, the columns as a list.
    await expect(results(ben.page).locator("dt")).toHaveText([
      "Average",
      "Median",
      "Agreement",
      "Spread",
    ]);
    await expect(spoken(ben.page, "Votes per card")).toHaveText([
      "2: 1 vote, lowest card",
      "3: 1 vote",
      "5: 2 votes",
      "8: 2 votes",
      "13: 1 vote, highest card",
    ]);
    await expect(spoken(ben.page, "Not counted")).toHaveText(["unsure: 1 vote"]);
    await expect(spoken(ben.page, "Lowest and highest cards")).toHaveText([
      "Lowest card 2: Hana",
      "Highest card 13: Finn",
    ]);
    // The seats say it, and wear the arrow.
    const benSeats = seats(ben.page);
    for (const [label, badge] of [
      ["Hana, card 2, lowest card", "lowest"],
      ["Finn, card 13, highest card", "highest"],
    ] as const) {
      const seat = benSeats.getByRole("button", { name: label });
      await expect(seat).toHaveCount(1);
      await expect(seat.locator(`[data-badge='${badge}']`)).toHaveCount(1);
    }
    await expect(benSeats.getByRole("button", { name: "Dan, card 5" })).toHaveCount(1);

    // The columns rose 60 ms apart once the eighth card had turned (650 + 7 × 90 ms), and
    // the seats' marks popped in then.
    const motion = await animated(ben.page);
    const bars = motion.filter((a) => a.target === "bar");
    expect(bars.map((a) => a.delay)).toEqual([1280, 1340, 1400, 1460, 1520]);
    expect(bars.every((a) => a.duration === 500)).toBe(true);
    const marks = motion.filter((a) => a.target === "lowest" || a.target === "highest");
    expect(marks.map((a) => a.delay)).toEqual([1280, 1280]);

    // Before the reveal Ben's frames held no card but his own.
    for (const snapshot of snapshotsIn(ben.frames)) {
      const round = snapshot.room.round as { phase?: string } | null;
      if (round?.phase === "revealed") continue;
      expect(cardLeaks(snapshot, ["3", "5", "13", "?", "2"])).toEqual([]);
    }
    await ben.page.waitForTimeout(1_800);
    await shoot(ben.page, "results-named");
    await shoot(page, "results-named-po");

    // A reload shows the results at rest.
    await recordAnimations(ben.page, { reload: true });
    await expect(stat(ben.page, "average")).toHaveText(one(expected.average));
    await ben.page.waitForTimeout(300);
    expect(await animated(ben.page)).toEqual([]);
  } finally {
    for (const guest of guests) guest.close();
    await ben.context.close();
  }
});

test("a consensus, then a T-shirt round with no average and a tie for most voted (AC 2)", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const guests = await guestsJoin(base, code, ["Cleo", "Dan", "Eve"]);
  const po = await sameUser(base, context);
  try {
    await expect(seats(page).locator("[data-seat]")).toHaveCount(4);
    await page.getByRole("button", { name: "Start voting" }).click();
    await vote(guests, ["8", "8", "8"]);
    await handCard(page, "8").click();
    await expect(centreSentence(page)).toHaveText("Consensus on 8.");
    await expect(page.locator("[data-centre-result] [data-pop]")).toHaveText("Consensus");
    await expect(tableLive(page)).toContainText("Cards revealed. Consensus on 8.");
    await expect(stat(page, "agreement")).toHaveText("100%");
    await expect(stat(page, "spread")).toHaveText("8");
    // Everyone agrees: nobody is lowest or highest.
    await expect(page.locator("[data-badge='lowest'], [data-badge='highest']")).toHaveCount(0);
    await page.waitForTimeout(1_200);
    await shoot(page, "results-consensus");

    // The PO's settings panel comes in W2: the deck changes over the protocol.
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(
      await po.cmd("updateSettings", { patch: { deck: { kind: "preset", id: "tshirt" } } }),
    ).toMatchObject({ ok: true });
    await page.getByRole("button", { name: "Next round" }).click();
    await expect(handCard(page, "M")).toBeVisible();
    await vote(guests, ["M", "L", "L"], 2);
    await handCard(page, "M").click();

    // M and L, twice each: the centre names the tie the panel shows, never one card of it.
    const expected = computeResults(["M", "M", "L", "L"], { kind: "preset", id: "tshirt" });
    const sentence = `Tie between M and L. Agreement ${percent(expected.agreement)}.`;
    await expect(centreSentence(page)).toHaveText(sentence);
    await expect(tableLive(page)).toContainText(`Cards revealed. ${sentence}`);
    await expect(page.locator("[data-centre-result='tie'] [data-mini-card]")).toHaveText([
      "M",
      "L",
    ]);
    await expect(page.locator("[data-centre-caption]")).toHaveText("Tie");
    await expect(results(page).locator("dt")).toHaveText(["Most voted", "Agreement", "Spread"]);
    await expect(stat(page, "mostVoted").locator("[aria-hidden]")).toHaveText("M · L");
    await expect(stat(page, "agreement")).toHaveText(percent(expected.agreement));
    await expect(stat(page, "spread").locator("[aria-hidden]")).toHaveText("M–L");
    // No average, no median, on screen or for a screen reader (AC 2).
    await expect(results(page)).not.toContainText("Average");
    await expect(results(page)).not.toContainText("Median");
    await page.waitForTimeout(1_200);
    await shoot(page, "results-tshirt-tie");
  } finally {
    po.close();
    for (const guest of guests) guest.close();
  }
});

/** The PO's centre (the result; "Next round" is under the table since #32) and the slot cards. */
async function centreClearance(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element) => element.getBoundingClientRect();
    const stack = document.querySelector("[data-centre] > div");
    if (!stack) throw new Error("no PO centre");
    const centre = box(stack);
    const touching = [...document.querySelectorAll("[data-slot-card] > [data-face]")].filter(
      (card) => {
        const r = box(card);
        return !(
          r.right <= centre.left ||
          r.left >= centre.right ||
          r.bottom <= centre.top ||
          r.top >= centre.bottom
        );
      },
    ).length;
    return { height: Math.round(centre.height), width: Math.round(centre.width), touching };
  });
}

/** Light and dark at the current size (a phone), not the full set `shoot` takes. */
async function shootPhone(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${SHOTS}${name}-360-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** How many rows the distribution's columns take. */
const columnRows = (page: Page) =>
  page.evaluate(
    () =>
      new Set(
        [...document.querySelectorAll("[data-column]")].map((column) =>
          Math.round(column.getBoundingClientRect().bottom),
        ),
      ).size,
  );

test("the PO's phone centre holds the result, clear of every card at 4, 8, 10 and 16 seats, in every language", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(420_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const guests: Guest[] = [];
  const po = await sameUser(base, context);
  try {
    expect(await po.enter(code)).toMatchObject({ ok: true });
    await page.setViewportSize({ width: 360, height: 900 });
    const languages = [
      ["Français", /^Language: English$/],
      ["Deutsch", /^Langue/],
      ["English", /^Sprache/],
    ] as const;
    const measure = async (label: string) => {
      // English first, then French and German, back to English.
      const sizes = [{ label, language: "English", ...(await centreClearance(page)) }];
      for (const [language, current] of languages) {
        await page.getByRole("button", { name: current }).click();
        await page.getByRole("menuitemradio", { name: language }).click();
        await expect(page.getByRole("menu")).toHaveCount(0);
        await expect(page.locator("html")).toHaveAttribute(
          "lang",
          language === "Français" ? "fr" : language === "Deutsch" ? "de" : "en",
        );
        if (language !== "English") {
          sizes.push({ label, language, ...(await centreClearance(page)) });
          await page.screenshot({
            path: `${SHOTS}results-centre-${label}-${language === "Français" ? "fr" : "de"}-360.png`,
          });
        }
      }
      return sizes;
    };

    const sizes: Awaited<ReturnType<typeof measure>> = [];
    let round = 0;
    const play = async (cards: readonly string[], mine: string) => {
      round += 1;
      await page.getByRole("button", { name: round === 1 ? "Start voting" : "Next round" }).click();
      await expect(handCard(page, mine)).toBeVisible();
      await vote(guests, cards, round);
      await handCard(page, mine).click();
    };
    const mixed = ["1", "2", "3", "5", "8", "13", "21", "3", "5", "8", "13", "2", "3", "5", "?"];
    for (const count of [4, 8, 10, 16]) {
      const names = Array.from(
        { length: count - 1 - guests.length },
        (_, i) => `Guest ${guests.length + i + 1}`,
      );
      guests.push(...(await guestsJoin(base, code, names)));
      await expect(seats(page).locator("[data-seat]")).toHaveCount(count);

      // Everyone plays 8: the chip, and the Consensus pill under it.
      await play(Array(guests.length).fill("8"), "8");
      await expect(centreSentence(page)).toHaveText("Consensus on 8.");
      await page.waitForTimeout(2_800);
      if (count !== 16) await shootPhone(page, `results-centre-consensus-${count}`);
      sizes.push(...(await measure(`consensus-${count}`)));

      // Mixed cards: the chip, and the agreement under it.
      await play(mixed.slice(0, guests.length), "21");
      await expect(centreSentence(page)).toContainText("Suggested");
      await page.waitForTimeout(2_800);
      if (count !== 16) await shootPhone(page, `results-centre-suggested-${count}`);
      sizes.push(...(await measure(`suggested-${count}`)));
    }
    // Sixteen people on seven Fibonacci cards: one row of columns at 360 px.
    expect(await columnRows(page)).toBe(1);
    await shootPhone(page, "results-columns-fib-16");

    // The modified Fibonacci deck's eleven cards, all played: still one row.
    expect(
      await po.cmd("updateSettings", { patch: { deck: { kind: "preset", id: "mfib" } } }),
    ).toMatchObject({ ok: true });
    const eleven = ["0", "½", "1", "2", "3", "5", "8", "13", "20", "40", "3", "5", "8", "13", "?"];
    await play(eleven, "100");
    await expect(results(page).locator("[data-column]")).toHaveCount(11);
    await page.waitForTimeout(2_800);
    expect(await columnRows(page)).toBe(1);
    await shootPhone(page, "results-columns-mfib-16");

    // Logged for the build log and the design brief: the sizes in each language.
    console.log(`centre sizes: ${JSON.stringify(sizes)}`);
    for (const size of sizes) {
      const at = `${size.label} in ${size.language}`;
      expect(size.width, `${at}: centre width`).toBeLessThanOrEqual(76);
      expect(size.touching, `${at}: centre against a card`).toBe(0);
    }
  } finally {
    po.close();
    for (const guest of guests) guest.close();
  }
});

test("a results chunk that cannot load still shows an anonymous round, and the next reveal tries again", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  // The chunk is gone, as after a redeploy that removed an old build.
  let gone = true;
  await page.route(/\/assets\/results-[^/]+\.js$/, (route) =>
    gone ? route.fulfill({ status: 404, body: "" }) : route.continue(),
  );
  const code = await createRoom(page);
  await join(page, "Ana");
  const guests = await guestsJoin(base, code, ["Cleo", "Dan", "Eve"]);
  const po = await sameUser(base, context);
  try {
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(await po.cmd("updateSettings", { patch: { revealNames: false } })).toMatchObject({
      ok: true,
    });
    await expect(seats(page).locator("[data-seat]")).toHaveCount(4);
    await page.getByRole("button", { name: "Start voting" }).click();
    await vote(guests, ["5", "3", "5"]);
    await handCard(page, "8").click();

    // 3, 5, 5 and 8: the centre says the result in a sentence, and the cards show in the
    // deck's order under the table, tied to nobody.
    const sentence = "Suggested 5. Agreement 50%.";
    await expect(page.locator("[data-centre-fallback]")).toHaveText(sentence);
    await expect(tableLive(page)).toContainText(`Cards revealed. ${sentence}`);
    await expect(results(page)).toHaveCount(0);
    const played = page.getByRole("list", { name: "Cards played" });
    await expect(played.locator("li .sr-only")).toHaveText(["3", "5", "5", "8"]);
    await page.waitForTimeout(1_200);
    await shoot(page, "results-chunk-failed-anonymous");

    // The chunk is back: the next reveal loads it, without a reload.
    gone = false;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Next round" }).click();
    await expect(handCard(page, "8")).toBeVisible();
    await vote(guests, ["5", "3", "5"], 2);
    await handCard(page, "8").click();
    await expect(centreSentence(page)).toHaveText(sentence);
    await expect(stat(page, "agreement")).toHaveText("50%");
    await expect(page.locator("[data-results='anonymous']")).toHaveCount(0);
  } finally {
    po.close();
    for (const guest of guests) guest.close();
  }
});
