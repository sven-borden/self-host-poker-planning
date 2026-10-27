import { type Browser, expect, type Page, test } from "@playwright/test";
import { cardLeaks } from "../../../packages/protocol/src/leak-scan.ts";
import {
  createRoom,
  type Guest,
  guestsJoin,
  hand,
  handCard,
  historyOf,
  join,
  newPerson,
  ownAddress,
  packetsIn,
  phone,
  recordFrames,
  SHOTS,
  sameUser,
  seats,
  shoot,
  subjectField,
  subjectLine,
} from "./support.ts";

// The final estimate and "Vote again" (#32) in real browsers, against the real server and
// Postgres: the PO records the preselected suggestion with one press and changes it, by
// keyboard on a desktop and on a phone; picks on a tie; everyone (a voter, an observer, a
// phone) sees the final in the centre and hears it once; the history row holds it at once;
// "Vote again" keeps the subject, clears the votes and raises the number; the frames of an
// anonymous round with a final and a re-vote leak nothing; and the PO's picker and the
// centre stay clear of every card at 4, 8, 10 and 16 seats, in English, French and German,
// on desktop and on a phone. Needs DATABASE_URL; skipped without it locally, failing
// without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the final estimate tests: set DATABASE_URL");
  }
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

const JIRA = "https://acme.atlassian.net/browse/PAY-482";

const tableLive = (page: Page) => page.locator("[data-table-live]");
const centreFinal = (page: Page) => page.locator("[data-centre-final]");
const centreStatus = (page: Page) => page.locator("[data-centre] [data-centre-status]");
const centreSentence = (page: Page) => page.locator("[data-centre-result] .sr-only");
const picker = (page: Page) => page.getByRole("group", { name: "Final estimate" });
const pick = (page: Page, name: string) => picker(page).getByRole("radio", { name, exact: true });
const recordButton = (page: Page) => page.locator("[data-record-final]");

async function vote(guests: readonly Guest[], cards: readonly string[], round: number) {
  for (const [i, guest] of guests.entries()) {
    const card = cards[i];
    if (card === undefined) continue;
    expect(await guest.cmd("castVote", { card, round })).toMatchObject({ ok: true });
  }
}

async function person(browser: Browser, url: string, name: string, role?: "Observer") {
  const { context, page } = await newPerson(browser);
  const frames = recordFrames(page);
  await page.goto(url);
  await join(page, name, role);
  return { context, page, frames };
}

/** The live region says `sentence` once: it is there, and not twice. */
async function saidOnce(page: Page, sentence: string) {
  await expect(tableLive(page)).toContainText(sentence);
  const text = (await tableLive(page).textContent()) ?? "";
  expect(text.split(sentence).length - 1, `"${sentence}" in "${text}"`).toBe(1);
}

/** The history row of round `number`, polled until it holds `final`. */
async function rowWithFinal(code: string, number: number, final: string) {
  const finalOf = async () => {
    const row = (await historyOf(code)).find((r) => r.number === number);
    return row ? JSON.parse(row.text).final : undefined;
  };
  await expect.poll(finalOf).toBe(final);
  return (await historyOf(code)).find((row) => row.number === number);
}

/**
 * The PO's flow by keyboard only, from "Reveal cards" with the focus: Enter reveals and the
 * focus lands on "Record <suggested>"; Enter records it; Shift+Tab goes back to the picker,
 * an arrow key picks the next card, Tab and Enter record it; Tab reaches "Next round", then
 * "Vote again".
 */
async function poByKeyboard(page: Page, suggested: string, next: string) {
  await page.getByRole("button", { name: "Reveal cards" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: `Record ${suggested}` })).toBeFocused();
  await expect(pick(page, `${suggested}, suggested`)).toBeChecked();
  await page.keyboard.press("Enter");
  await expect(recordButton(page)).toHaveText("Recorded");
  await expect(recordButton(page)).toBeFocused();
  await expect(centreFinal(page)).toHaveAttribute("data-centre-final", suggested);

  await page.keyboard.press("Shift+Tab");
  await expect(pick(page, `${suggested}, suggested`)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(pick(page, next)).toBeChecked();
  await expect(pick(page, next)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: `Record ${next}` })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(centreFinal(page)).toHaveAttribute("data-centre-final", next);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Next round" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Vote again" })).toBeFocused();
}

test("the PO records the suggestion with one press and changes it by keyboard; a voter, an observer and a phone see it, and hear it once", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const po = await sameUser(base, context);
  const ben = await person(browser, page.url(), "Ben");
  const olga = await person(browser, page.url(), "Olga", "Observer");
  const cleo = await phone(browser, "Pixel 7");
  try {
    await cleo.page.goto(page.url());
    await join(cleo.page, "Cleo");
    expect(await po.enter(code)).toMatchObject({ ok: true });
    // The PO reveals, by keyboard: the round must wait for them.
    expect(await po.cmd("updateSettings", { patch: { revealWhenAllVoted: false } })).toMatchObject({
      ok: true,
    });
    await expect(seats(page).locator("[data-seat]")).toHaveCount(3);
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "3").click();
    await handCard(ben.page, "8").click();
    await handCard(cleo.page, "5").tap();
    await expect(centreStatus(page)).toContainText("3/3 voted so far");

    // 3, 5 and 8: the average 5.3 suggests 5. Nothing is recorded by itself.
    await page.getByRole("button", { name: "Reveal cards" }).focus();
    await page.keyboard.press("Enter");
    const record5 = page.getByRole("button", { name: "Record 5" });
    await expect(record5).toBeFocused();
    await expect(centreSentence(ben.page)).toHaveText("Suggested 5. Agreement 33%.");
    await expect(pick(page, "5, suggested")).toBeChecked();
    expect((await historyOf(code)).length).toBe(0);
    await expect(centreFinal(ben.page)).toHaveCount(0);
    // Only the PO decides.
    for (const viewer of [ben.page, olga.page, cleo.page]) {
      await expect(picker(viewer)).toHaveCount(0);
      await expect(viewer.getByRole("button", { name: "Vote again" })).toHaveCount(0);
    }
    await page.waitForTimeout(1_500);
    await shoot(page, "final-po-suggested");
    await shoot(ben.page, "final-voter-suggested");

    // One press records the suggestion; the row holds it at once, before any next round.
    await record5.focus();
    await page.keyboard.press("Enter");
    await expect(recordButton(page)).toHaveText("Recorded");
    for (const viewer of [page, ben.page, olga.page, cleo.page]) {
      await expect(centreFinal(viewer)).toHaveAttribute("data-centre-final", "5");
      await expect(centreFinal(viewer).locator(".sr-only")).toHaveText("Final estimate: 5.");
      await saidOnce(viewer, "The PO recorded 5 as the final estimate.");
    }
    const decided = await rowWithFinal(code, 1, "5");
    expect(decided?.votes).toMatchObject({ kind: "named" });
    await page.waitForTimeout(600);
    await shoot(page, "final-po-recorded");
    await shoot(ben.page, "final-voter-recorded");
    await cleo.page.screenshot({ path: `${SHOTS}final-phone-voter-recorded.png`, fullPage: true });

    // The PO changes it: the picker, an arrow key, then "Record 8".
    await page.setViewportSize({ width: 1280, height: 900 });
    await recordButton(page).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(pick(page, "5, suggested")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(pick(page, "8")).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Record 8" })).toBeFocused();
    await page.keyboard.press("Enter");
    for (const viewer of [page, ben.page, olga.page, cleo.page]) {
      await expect(centreFinal(viewer)).toHaveAttribute("data-centre-final", "8");
      await saidOnce(viewer, "The PO changed the final estimate to 8.");
    }
    await rowWithFinal(code, 1, "8");
    // Then the next steps, in order.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Next round" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Vote again" })).toBeFocused();

    // The next round writes the row again and keeps the final.
    await page.getByRole("button", { name: "Next round" }).click();
    await expect(centreStatus(page)).toHaveText("0/3 voted so far");
    const rows = await historyOf(code);
    expect(rows.map((row) => [row.number, JSON.parse(row.text).final])).toEqual([[1, "8"]]);
    expect(cleo.errors).toEqual([]);
  } finally {
    po.close();
    await Promise.all([ben.context.close(), olga.context.close(), cleo.context.close()]);
  }
});

test("with a tie the PO picks: nothing preselected, the tied cards marked", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const po = await sameUser(base, context);
  const ben = await person(browser, page.url(), "Ben");
  const guests = await guestsJoin(base, code, ["Cleo"]);
  try {
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(
      await po.cmd("updateSettings", { patch: { deck: { kind: "preset", id: "tshirt" } } }),
    ).toMatchObject({ ok: true });
    await expect(seats(page).locator("[data-seat]")).toHaveCount(3);
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(ben.page, "M").click();
    await vote(guests, ["L"], 1);
    await handCard(page, "unsure").click();

    // M and L once each, Ana unsure: a tie, so nothing is preselected and the PO picks.
    await expect(centreSentence(page)).toHaveText("Tie between M and L. Agreement 50%.");
    await expect(picker(page).getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(pick(page, "M, tied")).toBeVisible();
    await expect(pick(page, "L, tied")).toBeVisible();
    await expect(page.locator("[data-tie-mark]")).toHaveCount(2);
    await expect(recordButton(page)).toHaveText("Record");
    await expect(recordButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Pick the final estimate, then record it.")).toBeVisible();
    await page.waitForTimeout(1_500);
    await shoot(page, "final-po-tie");
    await shoot(ben.page, "final-voter-tie");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("[data-final-card='L']").click();
    await expect(pick(page, "L, tied")).toBeChecked();
    await page.getByRole("button", { name: "Record L" }).click();
    await expect(centreFinal(ben.page)).toHaveAttribute("data-centre-final", "L");
    await saidOnce(ben.page, "The PO recorded L as the final estimate.");
    await rowWithFinal(code, 1, "L");
  } finally {
    po.close();
    for (const guest of guests) guest.close();
    await ben.context.close();
  }
});

test("Vote again keeps the subject, a title or a link with its key, clears the votes and raises the number; the revealed round stays in history", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const guests = await guestsJoin(base, code, ["Cleo", "Dan"]);
  try {
    await expect(seats(page).locator("[data-seat]")).toHaveCount(3);
    await subjectField(page).fill("Login page");
    await page.getByRole("button", { name: "Start voting" }).click();
    await vote(guests, ["3", "5"], 1);
    await handCard(page, "8").click();
    await expect(page.getByRole("button", { name: "Record 5" })).toBeVisible();

    await page.getByRole("button", { name: "Vote again" }).click();
    await expect(subjectLine(page)).toHaveText("Round 2Login page");
    await expect(centreStatus(page)).toHaveText("0/3 voted so far");
    await expect(hand(page).locator("[aria-pressed='true']")).toHaveCount(0);
    await expect(page.locator("[data-seat] [data-badge='voted']")).toHaveCount(0);
    await saidOnce(page, "The PO started a new vote on the same subject.");
    // A vote again needs no confirmation and focuses the hand, like "Next round".
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(hand(page).locator("[tabindex='0']")).toBeFocused();
    let rows = await historyOf(code);
    expect(rows.map((row) => row.number)).toEqual([1]);
    expect(rows[0]?.subject).toEqual({ kind: "title", text: "Login page" });
    expect(rows[0]?.votes).toMatchObject({ kind: "named" });
    expect((rows[0]?.votes as { votes?: unknown[] } | undefined)?.votes).toHaveLength(3);

    // Round 2 settles; round 3 is a Jira link, voted on again as round 4.
    await vote(guests, ["5", "5"], 2);
    await handCard(page, "5").click();
    await subjectField(page).fill(JIRA);
    await page.getByRole("button", { name: "Next round" }).click();
    await expect(subjectLine(page).locator("[data-subject-key]")).toHaveText("PAY-482");
    await vote(guests, ["8", "13"], 3);
    await handCard(page, "13").click();
    await page.getByRole("button", { name: "Record 13" }).click();
    await expect(centreFinal(page)).toHaveAttribute("data-centre-final", "13");
    await page.getByRole("button", { name: "Vote again" }).click();
    await expect(subjectLine(page)).toContainText("Round 4");
    await expect(subjectLine(page).locator("[data-subject-key]")).toHaveText("PAY-482");
    await expect(centreStatus(page)).toHaveText("0/3 voted so far");
    rows = await historyOf(code);
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
    const third = rows[2];
    expect(third?.subject).toEqual({ kind: "link", url: JIRA, key: "PAY-482" });
    expect((third?.votes as { votes?: unknown[] } | undefined)?.votes).toHaveLength(3);
    expect(JSON.parse(third?.text ?? "{}").final).toBe("13");
  } finally {
    for (const guest of guests) guest.close();
  }
});

interface WireRound {
  number: number;
  phase: "voting" | "revealed";
  anonymous: boolean;
  votes?: unknown;
  cards?: string[];
  final?: string;
}
interface WireSnapshot {
  room: { round: WireRound | null; participants: Array<{ id: string; name: string }> };
  causes: Array<Record<string, unknown>>;
}

/** The snapshots in a page's frames: `snapshot` events and acks that carry one. */
function snapshotsOf(frames: readonly string[]): WireSnapshot[] {
  return packetsIn(frames).flatMap((packet) => {
    if (!Array.isArray(packet)) return [];
    const [first, second] = packet as unknown[];
    if (first === "snapshot") return [second as WireSnapshot];
    if (typeof first === "object" && first !== null && "snapshot" in first) {
      return [(first as { snapshot: WireSnapshot }).snapshot];
    }
    return [];
  });
}

test("an anonymous round with a final and a re-vote: the frames never tie a person to a card", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const po = await sameUser(base, context);
  const ben = await person(browser, page.url(), "Ben");
  const guests = await guestsJoin(base, code, ["Cleo", "Dan"]);
  // What each round's others played, and Ben's own card.
  const played = {
    1: { ben: "8", others: ["3", "5", "5"] },
    2: { ben: "3", others: ["13", "2", "21"] },
  } as const;
  try {
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(await po.cmd("updateSettings", { patch: { revealNames: false } })).toMatchObject({
      ok: true,
    });
    await expect(seats(page).locator("[data-seat]")).toHaveCount(4);
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(ben.page, played[1].ben).click();
    await vote(guests, played[1].others.slice(0, 2), 1);
    await handCard(page, played[1].others[2]).click();
    // 3, 5, 5 and 8: 5 suggested and recorded; then the same subject again.
    await page.getByRole("button", { name: "Record 5" }).click();
    await expect(centreFinal(ben.page)).toHaveAttribute("data-centre-final", "5");
    await page.getByRole("button", { name: "Vote again" }).click();
    await expect(centreStatus(ben.page)).toHaveText("0/4 voted so far");
    await handCard(ben.page, played[2].ben).click();
    await vote(guests, played[2].others.slice(0, 2), 2);
    await handCard(page, played[2].others[2]).click();
    await expect(centreStatus(ben.page)).toHaveAttribute("data-centre-status", "revealed");
    await saidOnce(ben.page, "Cards revealed.");

    const snapshots = snapshotsOf(ben.frames);
    const ids = snapshots.at(-1)?.room.participants.map((p) => p.id) ?? [];
    expect(ids).toHaveLength(4);
    let voting = 0;
    let revealed = 0;
    for (const snapshot of snapshots) {
      const round = snapshot.room.round;
      if (round === null) continue;
      const mine = played[round.number as 1 | 2];
      expect(round.anonymous, `round ${round.number} anonymous`).toBe(true);
      if (round.phase === "voting") {
        voting += 1;
        // Before its reveal no card of anyone else, and no final from the round before.
        expect(
          cardLeaks(
            snapshot,
            mine.others.filter((c) => c !== mine.ben),
          ),
        ).toEqual([]);
        expect(round.final).toBeUndefined();
        continue;
      }
      revealed += 1;
      // After the reveal: the cards alone, in deck order, and no per-person list.
      expect(round.votes, `round ${round.number}: no votes list`).toBeUndefined();
      expect([...(round.cards ?? [])].sort()).toEqual([...mine.others, mine.ben].sort());
      for (const cause of snapshot.causes) {
        if (cause.type === "voteCast" || cause.type === "voteRetracted") {
          expect(cause.who, "a vote cause after an anonymous reveal").toBeUndefined();
        }
        if (cause.type === "finalSet") expect(Object.keys(cause).sort()).toEqual(["card", "type"]);
      }
    }
    expect(voting).toBeGreaterThan(2);
    expect(revealed).toBeGreaterThan(1);
    // The history keeps the first round's cards and final, and no person at all.
    const [first] = await historyOf(code);
    expect(first?.votes).toEqual({ kind: "anonymous", cards: ["3", "5", "5", "8"] });
    expect(JSON.parse(first?.text ?? "{}").final).toBe("5");
    for (const leak of [...ids, "Ana", "Ben", "Cleo", "Dan"]) {
      expect(first?.text.includes(leak), "a person in the anonymous row").toBe(false);
    }
  } finally {
    po.close();
    for (const guest of guests) guest.close();
    await ben.context.close();
  }
});

test("the PO's flow by keyboard only on a phone", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  const ana = await phone(browser, "iPhone 13");
  const guests: Guest[] = [];
  try {
    const code = await createRoom(ana.page);
    await join(ana.page, "Ana");
    const po = await sameUser(base, ana.context);
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(
      await po.cmd("updateSettings", { patch: { revealWhenAllVoted: false, poVotes: false } }),
    ).toMatchObject({ ok: true });
    guests.push(...(await guestsJoin(base, code, ["Cleo", "Dan", "Eve"])));
    await expect(seats(ana.page).locator("[data-seat]")).toHaveCount(4);
    await ana.page.getByRole("button", { name: "Start voting" }).tap();
    await vote(guests, ["2", "3", "3"], 1);
    await expect(centreStatus(ana.page)).toContainText("3/3 voted so far");
    // 2, 3 and 3 suggest 3; the next card is 5.
    await poByKeyboard(ana.page, "3", "5");
    // The picker and the buttons fit the phone: no sideways scroll.
    const overflow = await ana.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await ana.page.keyboard.press("Shift+Tab");
    await expect(ana.page.getByRole("button", { name: "Next round" })).toBeFocused();
    await ana.page.keyboard.press("Enter");
    await expect(centreStatus(ana.page)).toHaveText("0/3 voted so far");
    expect(ana.errors).toEqual([]);
    po.close();
  } finally {
    for (const guest of guests) guest.close();
    await ana.context.close();
  }
});

/** The centre and the PO's decision against the table's cards, and the page's width. */
async function clearance(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element) => element.getBoundingClientRect();
    const overlaps = (a: DOMRect, b: DOMRect) =>
      !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    const cards = [...document.querySelectorAll("[data-slot-card] > [data-face]")].map(box);
    const centreElement = document.querySelector("[data-centre] [data-centre-status='revealed']");
    if (!centreElement) throw new Error("no revealed centre");
    const centre = box(centreElement);
    const decision = document.querySelector("[data-decision]");
    const stage = document.querySelector("[data-room-table] [data-stage]");
    const bar = decision ? box(decision) : null;
    return {
      width: Math.round(centre.width),
      height: Math.round(centre.height),
      touching: cards.filter((card) => overlaps(card, centre)).length,
      barOnCards: bar ? cards.filter((card) => overlaps(card, bar)).length : 0,
      barOnTable: bar && stage ? overlaps(bar, box(stage)) : false,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

const LANGUAGES = [
  ["Français", /^Language: English$/, "fr"],
  ["Deutsch", /^Langue/, "de"],
  ["English", /^Sprache/, "en"],
] as const;

test("the picker and the centre with a final stay clear of every card at 4, 8, 10 and 16 seats, in every language, on desktop and on a phone", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.setTimeout(600_000);
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  const po = await sameUser(base, context);
  const ben = await person(browser, page.url(), "Ben");
  const guests: Guest[] = [];
  const sizes: Array<Record<string, unknown>> = [];
  try {
    expect(await po.enter(code)).toMatchObject({ ok: true });
    const measure = async (label: string) => {
      for (const [who, viewer] of [
        ["po", page],
        ["voter", ben.page],
      ] as const) {
        for (const [size, viewport] of [
          ["desktop", { width: 1280, height: 900 }],
          ["phone", { width: 360, height: 800 }],
        ] as const) {
          await viewer.setViewportSize(viewport);
          await viewer.waitForTimeout(150);
          sizes.push({ label, who, size, language: "en", ...(await clearance(viewer)) });
          for (const [language, current, lang] of LANGUAGES) {
            await viewer.getByRole("button", { name: current }).click();
            await viewer.getByRole("menuitemradio", { name: language }).click();
            await expect(viewer.getByRole("menu")).toHaveCount(0);
            await expect(viewer.locator("html")).toHaveAttribute("lang", lang);
            if (lang !== "en") {
              sizes.push({ label, who, size, language: lang, ...(await clearance(viewer)) });
              if (size === "phone" && label.endsWith("-16")) {
                await viewer.screenshot({
                  path: `${SHOTS}final-centre-${label}-${who}-${lang}-360.png`,
                });
              }
            }
          }
        }
      }
    };

    let round = 0;
    const play = async (cards: readonly string[], mine: string, theirs: string, final: string) => {
      round += 1;
      await page.getByRole("button", { name: round === 1 ? "Start voting" : "Next round" }).click();
      await expect(handCard(page, mine)).toBeVisible();
      await handCard(ben.page, theirs).click();
      await vote(guests, cards, round);
      await handCard(page, mine).click();
      await expect(recordButton(page)).toBeVisible();
      expect(await po.cmd("setFinal", { card: final })).toMatchObject({ ok: true });
      await expect(centreFinal(ben.page)).toHaveAttribute("data-centre-final", final);
      await page.waitForTimeout(2_000);
    };
    const mixed = ["1", "2", "3", "5", "8", "13", "21", "3", "5", "8", "13", "2", "3", "5"];
    for (const count of [4, 8, 10, 16]) {
      const names = Array.from(
        { length: count - 2 - guests.length },
        (_, i) => `Guest ${guests.length + i + 1}`,
      );
      guests.push(...(await guestsJoin(base, code, names)));
      await expect(seats(page).locator("[data-seat]")).toHaveCount(count);
      // Everyone plays 8, and the final is 13: the pill, then the final.
      await play(Array(guests.length).fill("8"), "8", "8", "13");
      await measure(`consensus-${count}`);
      // Mixed cards, and a final other than the suggestion.
      await play(mixed.slice(0, guests.length), "21", "?", "21");
      await measure(`suggested-${count}`);
    }

    console.log(`final estimate sizes: ${JSON.stringify(sizes)}`);
    for (const size of sizes) {
      const at = `${size.label}, ${size.who} on ${size.size} in ${size.language}`;
      expect(size.touching, `${at}: centre against a card`).toBe(0);
      expect(size.barOnCards, `${at}: decision against a card`).toBe(0);
      expect(size.barOnTable, `${at}: decision on the table`).toBe(false);
      expect(size.overflow, `${at}: sideways scroll`).toBeLessThanOrEqual(0);
      if (size.size === "phone") expect(size.width, `${at}: centre width`).toBeLessThanOrEqual(76);
    }
  } finally {
    po.close();
    for (const guest of guests) guest.close();
    await ben.context.close();
  }
});
