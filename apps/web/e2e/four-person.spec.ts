import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { computeResults } from "../../../packages/domain/src/results.ts";
import { isPublicCardPath, stringLeaves } from "../../../packages/protocol/src/leak-scan.ts";
import {
  dbQuery,
  hand,
  handCard,
  historyOf,
  join,
  newPerson,
  packetsIn,
  phone,
  ROOM_PATH,
  recordFrames,
  sameUser,
  seats,
  subjectField,
  subjectLine,
} from "./support.ts";

// The whole of W1 in one test (#23): four people in four browsers, one of them a phone,
// play three rounds against the real server and Postgres. The PO creates a named room
// with a deck from the landing page; a voter on a Pixel 7, a voter and an observer open
// the link and join. Round 1 has a Jira link, a changed card and the PO's reveal; round 2
// a title and the last vote's reveal; round 3 is anonymous and the timer reveals it.
// Everyone sees the results `computeResults` gives for the votes, `round_history` holds
// each finished round, and every frame each person receives is scanned: no card before
// the reveal, and in the anonymous round no frame that ties a person to a card.
// No fixed sleeps: every wait is on the page's own text, a data-* hook or a frame.
// Needs DATABASE_URL; skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("CI must run the four-person test: set DATABASE_URL");
  }
});
// A flaky step must fail here, not pass on CI's retry: fix its cause instead (#23, AC 2).
test.describe.configure({ retries: 0 });

const DECK = { kind: "preset", id: "mfib" } as const;
const ROOM_NAME = "Payments team";
const JIRA = "https://acme.atlassian.net/browse/PAY-482";
const TITLE = "Split invoices by currency";
const TIMER_SECONDS = 5;

const centre = (page: Page) => page.locator("[data-centre] [data-centre-status]");
const handLive = (page: Page) => page.locator("[data-hand-live]");
const pressedCards = (page: Page) => hand(page).locator("[aria-pressed='true']");
const tableLive = (page: Page) => page.locator("[data-table-live]");
const centreSentence = (page: Page) => page.locator("[data-centre-result] .sr-only");
const results = (page: Page) => page.getByRole("region", { name: "Results" });
const stat = (page: Page, key: string) => results(page).locator(`[data-stat='${key}'] dd`);
const perCard = (page: Page) =>
  results(page).getByRole("list", { name: "Votes per card" }).locator(":scope > li > .sr-only");

const one = (value: number | null) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value ?? Number.NaN);
const percent = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 }).format(value);

interface Person {
  name: string;
  context: BrowserContext;
  page: Page;
  /** Every frame the page received, from its first load. */
  frames: string[];
  errors: string[];
  /** Taps on a phone, clicks elsewhere. */
  press: (target: Locator) => Promise<void>;
}

async function desktop(browser: Browser, name: string): Promise<Person> {
  const { context, page } = await newPerson(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { name, context, page, frames: recordFrames(page), errors, press: (t) => t.click() };
}

/** What a snapshot's round looks like on the wire, as far as this test reads it. */
interface WireRound {
  number: number;
  phase: "voting" | "revealed";
  voted: string[];
  yourVote?: string;
  anonymous: boolean;
  votes?: Array<{ who: string; card: string }>;
  cards?: string[];
  results?: unknown;
}
interface WireSnapshot {
  room: { round: WireRound | null };
  causes: Array<{ type: string; who?: string; by?: string }>;
}

/** The snapshot a packet carries: a `snapshot` event, or an ack (`enter`) with one. */
function snapshotOf(packet: unknown): WireSnapshot | undefined {
  if (!Array.isArray(packet)) return undefined;
  const [first, second] = packet as unknown[];
  if (first === "snapshot") return second as WireSnapshot;
  if (typeof first === "object" && first !== null && "snapshot" in first) {
    return (first as { snapshot: WireSnapshot }).snapshot;
  }
  return undefined;
}

/**
 * The protocol's leak scan (`@pp/protocol/leak-scan`) over a whole packet, an event or an
 * ack: the strings equal to one of `cards` outside the paths that may hold a card. Paths
 * are taken from the snapshot (`1.room.…` in an event, `0.snapshot.room.…` in an ack).
 */
function leaksIn(packet: unknown, cards: readonly string[], allowed = isPublicCardPath) {
  return stringLeaves(packet)
    .map(({ path, value }) => ({ path: path.replace(/^\d+\.(snapshot\.)?/, ""), value }))
    .filter((leaf) => cards.includes(leaf.value) && !allowed(leaf.path));
}

/**
 * Before round `number` is revealed, `person` received no card but their own: every
 * snapshot of the round while voting, and every packet that is not a snapshot, from frame
 * `from` on. At least one of those snapshots counted `minVoted` votes or more, so the scan
 * saw the votes land.
 */
function expectNoCardBeforeReveal(
  person: Person,
  from: number,
  number: number,
  played: readonly string[],
  minVoted: number,
) {
  let seen = 0;
  for (const packet of packetsIn(person.frames.slice(from))) {
    const snapshot = snapshotOf(packet);
    const round = snapshot?.room.round;
    if (snapshot && (round?.number !== number || round.phase !== "voting")) continue;
    expect(leaksIn(packet, played), `${person.name}, round ${number}`).toEqual([]);
    if (!round) continue;
    expect(round, person.name).not.toHaveProperty("votes");
    expect(round, person.name).not.toHaveProperty("cards");
    expect(round, person.name).not.toHaveProperty("results");
    if (round.voted.length >= minVoted) seen += 1;
  }
  expect(seen, `${person.name} saw round ${number} with ${minVoted} votes`).toBeGreaterThan(0);
}

/**
 * Everyone sees the same results, equal to `computeResults` for the votes cast: the
 * suggested card and the agreement in the centre and the panel, and the distribution.
 */
async function expectResults(people: readonly Person[], cards: readonly string[]) {
  const expected = computeResults(cards, DECK);
  const sentence = `Suggested ${expected.suggested}. Agreement ${percent(expected.agreement)}.`;
  for (const { page } of people) {
    await expect(centre(page)).toHaveAttribute("data-centre-status", "revealed");
    await expect(centreSentence(page)).toHaveText(sentence);
    await expect(tableLive(page)).toContainText(`Cards revealed. ${sentence}`);
    await expect(stat(page, "agreement")).toHaveText(percent(expected.agreement));
    await expect(stat(page, "average")).toHaveText(one(expected.average));
    await expect(stat(page, "median")).toHaveText(one(expected.median));
    await expect(perCard(page)).toHaveText(
      expected.distribution.map(
        ({ card, count }) =>
          new RegExp(`^${card}: ${count} votes?(, (lowest|highest) card)?$`, "u"),
      ),
    );
  }
  return expected;
}

/** The next round has begun for everyone: its line, an empty count and no card picked. */
async function expectRoundStarted(people: readonly Person[], line: string) {
  for (const { page } of people) {
    await expect(subjectLine(page)).toHaveText(line);
    await expect(page.locator("[data-centre-status='voting']")).toHaveText("0/3 voted so far");
    await expect(pressedCards(page)).toHaveCount(0);
  }
}

test("four people play three rounds: create, join, vote, reveal, results, next round, secrecy on every frame", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  const ana = await desktop(browser, "Ana");
  const pixel = await phone(browser, "Pixel 7");
  const ben: Person = {
    name: "Ben",
    context: pixel.context,
    page: pixel.page,
    frames: recordFrames(pixel.page),
    errors: pixel.errors,
    press: (t) => t.tap(),
  };
  const cleo = await desktop(browser, "Cleo");
  const dee = await desktop(browser, "Dee");
  const everyone = [ana, ben, cleo, dee];
  let po: Awaited<ReturnType<typeof sameUser>> | undefined;
  try {
    // The PO creates a named room with the modified Fibonacci deck, from the landing page.
    await ana.page.goto("/");
    await ana.page.getByRole("textbox", { name: "Room name" }).fill(ROOM_NAME);
    await ana.page.getByRole("radio", { name: /^Modified Fibonacci/ }).check();
    await ana.page.getByRole("button", { name: "Create the room" }).click();
    await expect(ana.page).toHaveURL(ROOM_PATH);
    const code = ROOM_PATH.exec(ana.page.url())?.[1] ?? "";
    const link = ana.page.url();
    expect(link).toBe(`${base}/r/${code}`);
    await join(ana.page, "Ana");
    expect(await dbQuery("select name from room where code = $1", [code])).toEqual([
      { name: ROOM_NAME },
    ]);

    // The others open the shared link: two voters, Ben on his phone, and an observer.
    for (const [person, role] of [
      [ben, "Voter"],
      [cleo, "Voter"],
      [dee, "Observer"],
    ] as const) {
      await person.page.goto(link);
      await join(person.page, person.name, role);
    }
    for (const { page } of everyone) {
      await expect(seats(page).locator("[data-seat]")).toHaveCount(3);
      await expect(page.getByRole("list", { name: "Observers" }).locator("bdi")).toHaveText([
        "Dee",
      ]);
    }
    // Only the PO sets the subject; the observer has no hand.
    await expect(subjectField(ana.page)).toBeVisible();
    await expect(subjectField(cleo.page)).toHaveCount(0);
    await expect(hand(dee.page)).toHaveCount(0);

    // Round 1: a Jira link. Ben picks 3, then changes to 8; Cleo plays 5; Ana holds back
    // and reveals with two votes in.
    let marks = everyone.map((person) => person.frames.length);
    await subjectField(ana.page).fill(JIRA);
    await ana.page.getByRole("button", { name: "Start voting" }).click();
    for (const { page } of everyone) {
      const jira = page.getByRole("link", { name: "PAY-482 (opens in a new tab)" });
      await expect(jira).toHaveAttribute("href", JIRA);
      await expect(jira).toHaveAttribute("rel", "noopener noreferrer");
      await expect(subjectLine(page)).toContainText("Round 1");
      await expect(centre(page)).toHaveText("0/3 voted so far");
    }
    for (const card of ["3", "8"]) {
      await ben.press(handCard(ben.page, card));
      await expect(handLive(ben.page)).toHaveText(`Your vote: ${card}.`);
      await expect(handCard(ben.page, card)).toHaveAttribute("aria-pressed", "true");
    }
    await cleo.press(handCard(cleo.page, "5"));
    for (const { page } of everyone) await expect(centre(page)).toHaveText("2/3 voted so far");
    // Ben's own card is his alone: the others see that he voted, never what.
    await expect(seats(ana.page).getByRole("button", { name: /^Ben, voted$/ })).toHaveCount(1);
    await expect(seats(dee.page).getByRole("button", { name: /^Ben, voted$/ })).toHaveCount(1);
    await ana.press(ana.page.getByRole("button", { name: "Reveal cards" }));
    const first = await expectResults(everyone, ["8", "5"]);
    for (const { page } of everyone) {
      await expect(seats(page).getByRole("button", { name: /^Ben, card 8\b/ })).toHaveCount(1);
      await expect(seats(page).getByRole("button", { name: /^Cleo, card 5\b/ })).toHaveCount(1);
    }
    for (const [i, person] of everyone.entries()) {
      expectNoCardBeforeReveal(person, marks[i] ?? 0, 1, ["3", "5", "8"], 2);
    }
    expect(await historyOf(code)).toEqual([]);

    // Round 2, with a title: votes clear, the number goes up, round 1 is history.
    marks = everyone.map((person) => person.frames.length);
    await subjectField(ana.page).fill(TITLE);
    await ana.page.getByRole("button", { name: "Next round" }).click();
    await expectRoundStarted(everyone, `Round 2${TITLE}`);
    const [round1, ...later] = await historyOf(code);
    expect(later).toEqual([]);
    expect(round1).toMatchObject({
      number: 1,
      subject: { kind: "link", url: JIRA, key: "PAY-482" },
      deck: { spec: DECK },
      votes: {
        kind: "named",
        votes: [
          { name: "Ben", card: "8" },
          { name: "Cleo", card: "5" },
        ],
      },
      stats: first,
    });

    // Everyone votes; the last vote reveals the round by itself.
    await ana.press(handCard(ana.page, "13"));
    await ben.press(handCard(ben.page, "8"));
    await expect(centre(cleo.page)).toHaveText("2/3 voted so far");
    await cleo.press(handCard(cleo.page, "13"));
    const second = await expectResults(everyone, ["13", "8", "13"]);
    for (const [i, person] of everyone.entries()) {
      expectNoCardBeforeReveal(person, marks[i] ?? 0, 2, ["8", "13"], 2);
      const reveals = packetsIn(person.frames.slice(marks[i]))
        .map(snapshotOf)
        .flatMap((s) => s?.causes ?? [])
        .filter((cause) => cause.type === "revealed");
      expect(reveals, person.name).toEqual([{ type: "revealed", by: "everyoneVoted" }]);
    }

    // Round 3, anonymous, with a timer: Ana and Ben vote, Cleo does not, and the server
    // reveals the round at its deadline. The settings panel comes in W2, so the PO sets
    // both over the protocol, as her own user; they apply from the next round.
    po = await sameUser(base, ana.context);
    expect(await po.enter(code)).toMatchObject({ ok: true });
    expect(
      await po.cmd("updateSettings", {
        patch: { revealNames: false, timer: { seconds: TIMER_SECONDS } },
      }),
    ).toMatchObject({ ok: true });
    marks = everyone.map((person) => person.frames.length);
    await ana.page.getByRole("button", { name: "Next round" }).click();
    await expectRoundStarted(everyone, "Round 3");
    expect((await historyOf(code)).map((row) => row.number)).toEqual([1, 2]);
    await ana.press(handCard(ana.page, "2"));
    await ben.press(handCard(ben.page, "5"));
    for (const { page } of everyone) await expect(centre(page)).toHaveText("2/3 voted so far");
    // The deadline is the server's: nobody acts, and the round reveals itself.
    for (const { page } of everyone) {
      await expect(centre(page)).toHaveAttribute("data-centre-status", "revealed", {
        timeout: (TIMER_SECONDS + 10) * 1000,
      });
    }
    const third = await expectResults(everyone, ["2", "5"]);
    for (const { page } of everyone) {
      // The seats keep only who voted; nothing in the results names anyone.
      await expect(page.locator("[data-face='up']")).toHaveCount(0);
      const panel = await page.locator("[data-results-panel]").innerHTML();
      for (const { name } of everyone) expect(panel).not.toContain(name);
      await expect(page.locator("[data-badge='lowest'], [data-badge='highest']")).toHaveCount(0);
    }
    const played = ["2", "5"];
    for (const [i, person] of everyone.entries()) {
      const from = marks[i] ?? 0;
      expectNoCardBeforeReveal(person, from, 3, played, 2);
      // After the reveal: the cards in the deck's order and no voter, no vote cause that
      // names anyone, and the reveal came from the timer, once.
      let revealed = 0;
      const reveals: unknown[] = [];
      for (const packet of packetsIn(person.frames.slice(from))) {
        const snapshot = snapshotOf(packet);
        const round = snapshot?.room.round;
        if (!snapshot || round?.number !== 3) continue;
        for (const cause of snapshot.causes) {
          if (cause.type === "revealed") reveals.push(cause);
          if (round.phase === "revealed" && cause.type.startsWith("vote")) {
            expect(cause, person.name).not.toHaveProperty("who");
          }
        }
        if (round.phase !== "revealed") continue;
        revealed += 1;
        expect(round.anonymous, person.name).toBe(true);
        expect(round, person.name).not.toHaveProperty("votes");
        expect(round.cards, person.name).toEqual(["2", "5"]);
        // A card may sit only in the deck, the viewer's own vote, the cards and the results.
        expect(
          leaksIn(
            packet,
            played,
            (path) =>
              isPublicCardPath(path) ||
              path.startsWith("room.round.cards.") ||
              path.startsWith("room.round.results."),
          ),
          person.name,
        ).toEqual([]);
        expect(round.yourVote, person.name).toBe(
          { Ana: "2", Ben: "5" }[person.name as "Ana" | "Ben"],
        );
      }
      expect(revealed, `${person.name} saw round 3 revealed`).toBeGreaterThan(0);
      expect(reveals, person.name).toEqual([{ type: "revealed", by: "timer" }]);
      for (const frame of person.frames.slice(from)) expect(frame).not.toContain('"votes"');
    }

    // The next round, with no subject: round 3 is history with its cards and no name.
    await ana.page.getByRole("button", { name: "Next round" }).click();
    await expectRoundStarted(everyone, "Round 4");
    const rows = await historyOf(code);
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
    expect(rows[1]).toMatchObject({
      subject: { kind: "title", text: TITLE },
      votes: {
        kind: "named",
        votes: [
          { name: "Ana", card: "13" },
          { name: "Ben", card: "8" },
          { name: "Cleo", card: "13" },
        ],
      },
      stats: second,
    });
    expect(rows[2]).toMatchObject({
      subject: { kind: "none" },
      votes: { kind: "anonymous", cards: ["2", "5"] },
      stats: third,
    });
    for (const { name } of everyone) expect(rows[2]?.text).not.toContain(name);
    for (const person of everyone) expect(person.errors, person.name).toEqual([]);
  } finally {
    po?.close();
    for (const person of everyone) await person.context.close();
  }
});
