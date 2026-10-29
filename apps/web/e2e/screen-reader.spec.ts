import type { Page } from "@playwright/test";
import { listen, type Said, settle, transcript } from "./a11y.ts";
import { expect, test } from "./fixtures.ts";
import { createRoom, guestsJoin, hand, handCard, join, newPerson, sameUser } from "./support.ts";

// The scripted screen-reader pass (#37). No NVDA or VoiceOver runs here: what a reader
// would announce is what the page's live regions say (`listen` records every change of a
// status, alert or polite region), and what it reads on the way is the accessibility tree
// (`ariaSnapshot`). Ana, the PO, and Ben listen in their browsers; Cleo votes over the
// protocol. A vote value is never said before the reveal, and in an anonymous round no
// line pairs a name with a value (product invariants).

const NAMES = ["Ana", "Ben", "Cleo"];
const tableLive = "data-table-live";
const handLive = "data-hand-live";

/** Waits until `page`'s `region` said `text` (from the line `from` on); its index. */
async function heard(page: Page, region: string, text: string | RegExp, from = 0) {
  let found = -1;
  await expect
    .poll(
      async () => {
        const said = await transcript(page);
        found = said.findIndex(
          (line, i) =>
            i >= from &&
            line.region === region &&
            (typeof text === "string" ? line.text === text : text.test(line.text)),
        );
        return found >= 0 ? "heard" : said.slice(from).map((line) => line.text);
      },
      { message: `${region} says ${text}`, timeout: 10_000 },
    )
    .toBe("heard");
  return found;
}

/** A card value as a word of its own (not "Round 13", not "13%"): `\b8\b`. */
const valueIn = (text: string, values: readonly string[]) =>
  values.find((value) => new RegExp(`(^|[^\\w/])${value}(?![\\w%/])`).test(text));

/**
 * Whether a sentence of `text` names a person and a card of round 4 (5 or 8). Sentence
 * by sentence: a batch says "Cleo voted. Cards revealed. Suggested 5.", the group's result
 * after a vote, which is nobody's card.
 */
const pairsNameWithCard = (text: string) =>
  text
    .split(/(?<=\.) /)
    .some(
      (sentence) =>
        NAMES.some((name) => sentence.includes(name)) &&
        valueIn(sentence, ["5", "8"]) !== undefined,
    );

test("what a screen reader hears through a round: votes, reveals by the PO, a voter and the timer, results, an anonymous round", async ({
  page,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(150_000);
  const base = baseURL ?? "";
  await listen(page);
  const code = await createRoom(page);
  await join(page, "Ana");
  const ben = await newPerson(browser);
  await listen(ben.page);
  await ben.page.goto(page.url());
  await join(ben.page, "Ben");
  await heard(page, tableLive, "Ben joined.");
  const [cleo] = await guestsJoin(base, code, ["Cleo"]);
  const owner = await sameUser(base, page.context());
  try {
    expect(await owner.enter(code)).toMatchObject({ ok: true });
    await heard(page, tableLive, "Cleo joined.");

    // Round 1: Ben and Ana vote 8; Cleo does not, so the PO's button reveals.
    let mark = { ana: (await transcript(page)).length, ben: (await transcript(ben.page)).length };
    await page.getByRole("button", { name: "Start voting" }).click();
    await heard(ben.page, tableLive, "Voting started: Round 1.", mark.ben);
    await handCard(ben.page, "8").click();
    await heard(ben.page, handLive, "Your vote: 8.", mark.ben);
    await heard(page, tableLive, "Ben voted.", mark.ana);
    await handCard(page, "8").click();
    await heard(page, handLive, "Your vote: 8.", mark.ana);
    await heard(ben.page, tableLive, "Ana voted.", mark.ben);
    // Before the reveal: the hand says the viewer's own card, the seats only who voted.
    await expect(hand(ben.page)).toMatchAriaSnapshot(`
      - toolbar "Your cards":
        - button "5"
        - button "8" [pressed]
        - button "13"
    `);
    await expect(page.getByRole("list", { name: "People at the table" })).toMatchAriaSnapshot(`
      - list "People at the table":
        - listitem:
          - button "Ana, you, product owner, voted"
        - listitem:
          - button "Ben, voted"
        - listitem:
          - button "Cleo, thinking"
    `);
    await expect(page.getByRole("button", { name: "Reveal cards" })).toHaveAttribute(
      "aria-keyshortcuts",
      "R",
    );
    for (const [who, viewer] of [
      ["Ana", page],
      ["Ben", ben.page],
    ] as const) {
      for (const line of await transcript(viewer)) {
        if (line.region === handLive) continue;
        expect(valueIn(line.text, ["8"]), `${who} heard before the reveal: ${line.text}`).toBe(
          undefined,
        );
      }
    }
    mark = { ana: (await transcript(page)).length, ben: (await transcript(ben.page)).length };
    await page.getByRole("button", { name: "Reveal cards" }).click();
    await heard(page, tableLive, "Cards revealed. Suggested 8. Agreement 100%.", mark.ana);
    await heard(ben.page, tableLive, "Cards revealed. Suggested 8. Agreement 100%.", mark.ben);
    await settle(ben.page);
    // After it: each seat says its card, the results their numbers; Ana's own card is
    // said once her name is with it.
    await expect(ben.page.locator("[data-room-table]")).toMatchAriaSnapshot(`
      - region "The table":
        - paragraph: Round 1
        - paragraph: Suggested 8. Agreement 100%.
        - list "People at the table":
          - listitem:
            - button "Ben, you, card 8"
          - listitem:
            - button "Cleo, no vote"
          - listitem:
            - button "Ana, product owner, card 8"
        - region "Results":
          - heading "Results" [level=2]
          - term: Average
          - definition: "8"
          - term: Median
          - definition: "8"
          - term: Agreement
          - definition: 100%
          - term: Spread
          - definition: "8"
          - list "Votes per card":
            - listitem: "8: 2 votes"
    `);
    await expect(ben.page.getByRole("region", { name: "Results" })).toMatchAriaSnapshot(`
      - region "Results":
        - heading "Results" [level=2]
    `);

    // Round 2: anyone who votes may reveal; Ben presses R in his hand.
    mark = { ana: (await transcript(page)).length, ben: (await transcript(ben.page)).length };
    await page.getByRole("button", { name: "Next round" }).click();
    expect(await owner.cmd("updateSettings", { patch: { whoCanReveal: "anyone" } })).toMatchObject({
      ok: true,
    });
    await heard(ben.page, tableLive, /^Voting started: Round 2\./, mark.ben);
    await handCard(ben.page, "3").click();
    await heard(ben.page, handLive, "Your vote: 3.", mark.ben);
    expect(await cleo?.cmd("castVote", { card: "13", round: 2, restart: 0 })).toMatchObject({
      ok: true,
    });
    // Ben's vote and Cleo's in one batch: "2 people voted."
    await heard(page, tableLive, /(Cleo voted|2 people voted)\.$/, mark.ana);
    await expect(ben.page.getByRole("button", { name: "Reveal cards" })).toBeVisible();
    await handCard(ben.page, "3").focus();
    await ben.page.keyboard.press("r");
    const byBen = await heard(page, tableLive, /^Ben revealed the cards\. /, mark.ana);
    const forBen = await heard(ben.page, tableLive, /^Cards revealed\. /, mark.ben);
    expect((await transcript(page))[byBen]?.text).not.toMatch(/Ana/);
    expect((await transcript(ben.page))[forBen]?.text).not.toMatch(/Ben/);

    // Round 3: a 5-second timer reveals; nobody is named.
    mark = { ana: (await transcript(page)).length, ben: (await transcript(ben.page)).length };
    await page.getByRole("button", { name: "Next round" }).click();
    await heard(ben.page, tableLive, /^Voting started: Round 3\./, mark.ben);
    expect(await owner.cmd("startTimer", { seconds: 5 })).toMatchObject({ ok: true });
    expect(await cleo?.cmd("castVote", { card: "2", round: 3, restart: 0 })).toMatchObject({
      ok: true,
    });
    const byTimer = await heard(page, tableLive, /Cards revealed\./, mark.ana);
    await heard(ben.page, tableLive, /Cards revealed\./, mark.ben);
    expect((await transcript(page))[byTimer]?.text).not.toMatch(/revealed the cards/);

    // Round 4, anonymous: the last vote reveals; no line ties a name to a card.
    expect(await owner.cmd("updateSettings", { patch: { revealNames: false } })).toMatchObject({
      ok: true,
    });
    await heard(ben.page, tableLive, "Anonymous voting starts with round 4.", mark.ben);
    await page.getByRole("button", { name: "Next round" }).click();
    mark = { ana: (await transcript(page)).length, ben: (await transcript(ben.page)).length };
    await heard(ben.page, tableLive, "Voting started: Round 4, anonymous.", mark.ben);
    await handCard(ben.page, "5").click();
    expect(await cleo?.cmd("castVote", { card: "8", round: 4, restart: 0 })).toMatchObject({
      ok: true,
    });
    await handCard(page, "5").click();
    await heard(page, tableLive, /Cards revealed\. Suggested 5/, mark.ana);
    await heard(ben.page, tableLive, /Cards revealed\. Suggested 5/, mark.ben);
    await settle(ben.page);
    for (const [who, viewer, from] of [
      ["Ana", page, mark.ana],
      ["Ben", ben.page, mark.ben],
    ] as const) {
      for (const line of await transcript(viewer, from)) {
        expect(pairsNameWithCard(line.text), `${who} heard: ${line.text}`).toBe(false);
      }
      // And what a reader finds on the table, seat by seat and in the results.
      const tree = await viewer.locator("[data-room-table]").ariaSnapshot();
      for (const row of tree.split("\n")) {
        expect(pairsNameWithCard(row), `${who} reads: ${row}`).toBe(false);
      }
    }

    const tree = await ben.page.locator("[data-room-table]").ariaSnapshot();
    await info.attach("anonymous-table.txt", { body: tree, contentType: "text/plain" });
  } finally {
    // What each page heard, in the report: the pull request quotes it, and a failure
    // shows it.
    const lines = (said: Said[]) => said.map((line) => `  [${line.region}] ${line.text}`);
    await info.attach("transcript.txt", {
      body: [
        "Ana (PO):",
        ...lines(await transcript(page).catch(() => [])),
        "Ben (voter):",
        ...lines(await transcript(ben.page).catch(() => [])),
      ].join("\n"),
      contentType: "text/plain",
    });
    cleo?.close();
    owner.close();
    await ben.context.close();
  }
});
