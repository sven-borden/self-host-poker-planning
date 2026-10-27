import { writeFile } from "node:fs/promises";
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
  seats,
  subjectField,
  subjectLine,
} from "./support.ts";

// The whole of W1 in one test (#23): four people in four browsers, one of them a phone,
// play four rounds against the real server and Postgres. The PO creates a named room
// with a deck from the landing page; a voter on a Pixel 7, a voter and an observer open
// the link and join. Round 1 has a Jira link, a changed card and the PO's reveal; round 2
// a title and the last vote's reveal; round 3 is anonymous (the PO turns it on in her
// settings panel, #25, and gives every round a 12 s timer there, #27) and the server's
// own timeout reveals it while every page stays idle; in round 4 the PO starts, extends
// and stops a timer from the table's centre, everyone sees the countdown, and the last
// vote reveals the round. Every page shows both anonymous rounds' "Anonymous" chip.
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
/** Round 3's timer: long enough for every page to show it and two people to vote. */
const TIMER_SECONDS = 12;

const centre = (page: Page) => page.locator("[data-centre] [data-centre-status]");
/** Everyone's countdown in the centre (#27): the chip, the PO's being a button. */
const timer = (page: Page) => page.locator("[data-centre] [data-timer]");
const timerText = (page: Page) => timer(page).locator("[data-timer-text]");
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
  room: { round: WireRound | null; participants: Array<{ id: string; name: string }> };
  causes: Array<{ type: string; who?: string; by?: string }>;
}

/** The cards each person played in a round, in order; one who did not play is absent. */
type Own = Partial<Record<string, readonly string[]>>;

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
 * `from` on. A `yourVote` is one of the cards `person` played (`own`). At least one of
 * those snapshots counted `minVoted` votes or more, so the scan saw the votes land.
 */
function expectNoCardBeforeReveal(
  person: Person,
  from: number,
  number: number,
  played: readonly string[],
  minVoted: number,
  own: Own,
) {
  const mine = own[person.name] ?? [];
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
    if (round.yourVote !== undefined) {
      expect(mine, `${person.name}'s yourVote in round ${number}`).toContain(round.yourVote);
    }
    if (round.voted.length >= minVoted) seen += 1;
  }
  expect(seen, `${person.name} saw round ${number} with ${minVoted} votes`).toBeGreaterThan(0);
}

/**
 * Every `revealed` cause in the snapshots of round `number` that `person` received from
 * frame `from` on. Read once the next round has started, it counts a late duplicate too.
 */
function revealsOf(person: Person, from: number, number: number) {
  return packetsIn(person.frames.slice(from))
    .map(snapshotOf)
    .filter((snapshot) => snapshot?.room.round?.number === number)
    .flatMap((snapshot) => snapshot?.causes ?? [])
    .filter((cause) => cause.type === "revealed");
}

/** The ids of the room's participants, in the last snapshot `person` received. */
function participantIds(person: Person): string[] {
  const last = packetsIn(person.frames)
    .map(snapshotOf)
    .findLast((snapshot) => snapshot !== undefined);
  return last?.room.participants.map(({ id }) => id) ?? [];
}

/** Every property named `key` in `value`, by path, with what it holds. */
function keysIn(value: unknown, key: string, path = ""): Array<{ path: string; value: unknown }> {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(k === key ? [{ path: `${path}${k}`, value: v }] : []),
    ...keysIn(v, key, `${path}${k}.`),
  ]);
}

/**
 * Round `number` is anonymous in every snapshot of it `person` received from frame `from`
 * on: no vote list in any phase, so nothing pairs a voter with a card. Once revealed: the
 * `cards` in the deck's order, no vote cause naming its voter, a card only in the deck,
 * `yourVote`, the cards and the results, and `yourVote` the last card `person` played.
 * Returns the number of vote causes the revealed round carried.
 */
function expectAnonymousRound(
  person: Person,
  from: number,
  number: number,
  cards: readonly string[],
  own: Own,
) {
  let revealed = 0;
  let voteCauses = 0;
  for (const packet of packetsIn(person.frames.slice(from))) {
    const snapshot = snapshotOf(packet);
    const round = snapshot?.room.round;
    if (!snapshot || round?.number !== number) continue;
    // The path and what it holds, never the whole snapshot: that names the room.
    expect(keysIn(snapshot, "votes"), person.name).toEqual([]);
    if (round.phase !== "revealed") continue;
    revealed += 1;
    for (const cause of snapshot.causes) {
      if (!cause.type.startsWith("vote")) continue;
      voteCauses += 1;
      expect(cause, person.name).not.toHaveProperty("who");
    }
    expect(round.anonymous, person.name).toBe(true);
    expect(round.cards, person.name).toEqual(cards);
    expect(
      leaksIn(
        packet,
        cards,
        (path) =>
          isPublicCardPath(path) ||
          path.startsWith("room.round.cards.") ||
          path.startsWith("room.round.results."),
      ),
      person.name,
    ).toEqual([]);
    expect(round.yourVote, person.name).toBe(own[person.name]?.at(-1));
  }
  expect(revealed, `${person.name} saw round ${number} revealed`).toBeGreaterThan(0);
  return voteCauses;
}

/** In an anonymous round's results, the seats keep only who voted and nothing names anyone. */
async function expectNoNames(people: readonly Person[]) {
  for (const { page } of people) {
    await expect(page.locator("[data-face='up']")).toHaveCount(0);
    const panel = await page.locator("[data-results-panel]").innerHTML();
    for (const { name } of people) expect(panel).not.toContain(name);
    await expect(page.locator("[data-badge='lowest'], [data-badge='highest']")).toHaveCount(0);
  }
}

/**
 * On a failure, each person's frames, room code masked, go next to the trace: a trace
 * holds the polling bodies but no WebSocket frame.
 */
async function attachFrames(people: readonly Person[], code: string | undefined) {
  const info = test.info();
  for (const person of people) {
    const text = person.frames.join("\n");
    const path = info.outputPath(`frames-${person.name}.txt`);
    await writeFile(path, code ? text.replaceAll(code, "<room code>") : text);
    await info.attach(`frames-${person.name}`, { path, contentType: "text/plain" });
  }
}

/**
 * Everyone sees the same results, equal to `computeResults` for the votes cast: the
 * suggested card and the agreement in the centre and the panel, and the distribution.
 * `sentence` is worked out by hand, so a fault inside `computeResults` fails too.
 */
async function expectResults(
  people: readonly Person[],
  cards: readonly string[],
  sentence: string,
) {
  const expected = computeResults(cards, DECK);
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
async function expectRoundStarted(people: readonly Person[], line: string, anonymous = false) {
  for (const { page } of people) {
    // An anonymous round says so after its number, on every page (#25).
    const chip = subjectLine(page).locator("[data-round-anonymous]");
    await expect(chip).toHaveCount(anonymous ? 1 : 0);
    if (anonymous) await expect(chip.locator("[title]")).toHaveText("Anonymous");
    await expect
      .poll(() =>
        subjectLine(page).evaluate((element) =>
          [...element.children]
            .filter((child) => !child.hasAttribute("data-round-anonymous"))
            .map((child) => child.textContent)
            .join(""),
        ),
      )
      .toBe(line);
    await expect(page.locator("[data-centre-status='voting']")).toHaveText("0/3 voted so far");
    await expect(pressedCards(page)).toHaveCount(0);
  }
}

test("four people play four rounds: create, join, vote, reveal, results, next round, secrecy on every frame", async ({
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
  /** How many frames each person has now: a round's scans read from there on. */
  const mark = () => everyone.map((person) => person.frames.length);
  /** Round `number` was revealed once, by `by`, for everyone. Call it in the next round. */
  const expectRevealedOnce = (number: number, from: readonly number[], by: string) => {
    for (const [i, person] of everyone.entries()) {
      expect(revealsOf(person, from[i] ?? 0, number), `${person.name}, round ${number}`).toEqual([
        { type: "revealed", by },
      ]);
    }
  };
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
    const from1 = mark();
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
    const first = await expectResults(everyone, ["8", "5"], "Suggested 5. Agreement 50%.");
    // The seats say the cards, and mark the lowest and the highest; Ana did not vote.
    for (const { page } of everyone) {
      for (const label of [
        /^Ana, (you, )?product owner, no vote/,
        /^Ben, (you, )?card 8, highest card/,
        /^Cleo, (you, )?card 5, lowest card/,
      ]) {
        await expect(seats(page).getByRole("button", { name: label })).toHaveCount(1);
      }
    }
    for (const [i, person] of everyone.entries()) {
      expectNoCardBeforeReveal(person, from1[i] ?? 0, 1, ["3", "5", "8"], 2, {
        Ben: ["3", "8"],
        Cleo: ["5"],
      });
    }
    expect(await historyOf(code)).toEqual([]);

    // Round 2, with a title: votes clear, the number goes up, round 1 is history.
    const from2 = mark();
    await subjectField(ana.page).fill(TITLE);
    await ana.page.getByRole("button", { name: "Next round" }).click();
    await expectRoundStarted(everyone, `Round 2${TITLE}`);
    expectRevealedOnce(1, from1, "manual");
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
    const second = await expectResults(everyone, ["13", "8", "13"], "Suggested 13. Agreement 67%.");
    for (const [i, person] of everyone.entries()) {
      expectNoCardBeforeReveal(person, from2[i] ?? 0, 2, ["8", "13"], 2, {
        Ana: ["13"],
        Ben: ["8"],
        Cleo: ["13"],
      });
    }

    // Round 3, anonymous, with a timer: Ana and Ben vote, Cleo does not, and the server
    // reveals the round at its deadline. The PO turns anonymity on in her settings panel
    // (#25) and gives each round a custom 12 s timer there (#27). Both apply from the next
    // round.
    await ana.press(ana.page.getByRole("button", { name: "Room settings" }));
    const settings = ana.page.getByRole("dialog", { name: "Room settings" });
    const anonymous = settings.getByRole("switch", { name: "Anonymous voting" });
    await ana.press(anonymous);
    await expect(anonymous).toHaveAttribute("aria-checked", "true");
    await expect(anonymous).not.toHaveAttribute("aria-busy", "true");
    const timerSetting = settings.locator("[data-setting='timer']");
    await ana.press(timerSetting.getByRole("radio", { name: "Custom" }));
    await timerSetting.getByRole("textbox", { name: "Custom length" }).fill(String(TIMER_SECONDS));
    await ana.press(timerSetting.getByRole("button", { name: "Set" }));
    await expect(timerSetting.getByRole("radio", { name: "Custom" })).toBeChecked();
    await expect(timerSetting.locator("[data-setting-saving]")).toHaveCount(0);
    await ana.page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    const from3 = mark();
    await ana.page.getByRole("button", { name: "Next round" }).click();
    await expectRoundStarted(everyone, "Round 3", true);
    expectRevealedOnce(2, from2, "everyoneVoted");
    expect((await historyOf(code)).map((row) => row.number)).toEqual([1, 2]);
    // Ana plays the higher card first, so the people's order is not the deck's.
    const own3 = { Ana: ["5"], Ben: ["2"] };
    // Every page counts the round's timer down, from 12 s; it never shows more.
    for (const { page } of everyone) {
      await expect(timer(page)).toHaveAttribute("data-timer", /^(running|warn)$/);
      await expect(timerText(page)).toHaveText(/^0:(0\d|1[0-2])$/);
    }
    await ana.press(handCard(ana.page, "5"));
    await ben.press(handCard(ben.page, "2"));
    for (const { page } of everyone) await expect(centre(page)).toHaveText("2/3 voted so far");
    // The deadline is the server's: nobody acts, and the round reveals itself. Every page
    // goes through the last 10 s on its way.
    for (const { page } of everyone) {
      await expect(timer(page)).toHaveAttribute("data-timer", /^(warn|zero)$/, {
        timeout: TIMER_SECONDS * 1000,
      });
    }
    for (const { page } of everyone) {
      await expect(centre(page)).toHaveAttribute("data-centre-status", "revealed", {
        timeout: (TIMER_SECONDS + 10) * 1000,
      });
    }
    const third = await expectResults(everyone, ["5", "2"], "Suggested 3. Agreement 50%.");
    await expectNoNames(everyone);
    for (const [i, person] of everyone.entries()) {
      expectNoCardBeforeReveal(person, from3[i] ?? 0, 3, ["2", "5"], 2, own3);
      expectAnonymousRound(person, from3[i] ?? 0, 3, ["2", "5"], own3);
    }

    for (const { page } of everyone) {
      await expect(tableLive(page)).toContainText("Time is up. Cards revealed.");
    }

    // Round 4, still anonymous, without the round's timer (Off in the panel): the last
    // vote reveals it, so its vote causes come after an anonymous reveal. Round 3 is
    // history with its cards and no name.
    await ana.press(ana.page.getByRole("button", { name: "Room settings" }));
    await ana.press(timerSetting.getByRole("radio", { name: "Off" }));
    await expect(timerSetting.getByRole("radio", { name: "Off" })).toBeChecked();
    await expect(timerSetting.locator("[data-setting-saving]")).toHaveCount(0);
    await ana.page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    const from4 = mark();
    await ana.page.getByRole("button", { name: "Next round" }).click();
    await expectRoundStarted(everyone, "Round 4", true);
    expectRevealedOnce(3, from3, "timer");
    const ids = participantIds(ana);
    expect(ids).toHaveLength(everyone.length);
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
    expect(rows[2]).toMatchObject({ subject: { kind: "none" }, stats: third });
    expect(rows[2]?.votes).toEqual({ kind: "anonymous", cards: ["2", "5"] });
    for (const word of [...everyone.map(({ name }) => name), ...ids]) {
      expect(rows[2]?.text).not.toContain(word);
    }

    // The PO's controls in the centre (#27): she starts 2 min, adds 30 s and stops it;
    // every page counts down with her, then shows no timer.
    for (const { page } of everyone) {
      await expect(timer(page)).toHaveCount(page === ana.page ? 1 : 0);
    }
    await ana.press(ana.page.getByRole("button", { name: "Timer", exact: true }));
    await ana.press(ana.page.locator("[data-timer-preset='120']"));
    for (const { page } of everyone) {
      await expect(timer(page)).toHaveAttribute("data-timer", "running");
      await expect(timerText(page)).toHaveText(/^(2:00|1:5\d)$/);
      await expect(tableLive(page)).toContainText("Timer started: 2 minutes.");
    }
    await ana.press(ana.page.getByRole("button", { name: "Add 30 seconds" }));
    for (const { page } of everyone) {
      await expect(timerText(page)).toHaveText(/^2:[23]\d$/);
      await expect(tableLive(page)).toContainText("30 seconds added.");
    }
    await ana.press(ana.page.getByRole("button", { name: "Stop the timer" }));
    for (const { page } of everyone) {
      await expect(timer(page)).toHaveCount(page === ana.page ? 1 : 0);
      await expect(tableLive(page)).toContainText("Timer stopped.");
    }
    await expect(ana.page.locator("[data-timer-button]")).toHaveAttribute("data-timer", "idle");

    const own4 = { Ana: ["3"], Ben: ["2"], Cleo: ["2"] };
    await ana.press(handCard(ana.page, "3"));
    await ben.press(handCard(ben.page, "2"));
    await expect(centre(cleo.page)).toHaveText("2/3 voted so far");
    await cleo.press(handCard(cleo.page, "2"));
    const fourth = await expectResults(everyone, ["3", "2", "2"], "Suggested 2. Agreement 67%.");
    await expectNoNames(everyone);
    for (const [i, person] of everyone.entries()) {
      expectNoCardBeforeReveal(person, from4[i] ?? 0, 4, ["2", "3"], 2, own4);
      const voteCauses = expectAnonymousRound(person, from4[i] ?? 0, 4, ["2", "2", "3"], own4);
      expect(voteCauses, `${person.name} saw the last vote of round 4`).toBeGreaterThan(0);
    }

    // Round 5, anonymous too: round 4 is history.
    await ana.page.getByRole("button", { name: "Next round" }).click();
    await expectRoundStarted(everyone, "Round 5", true);
    expectRevealedOnce(4, from4, "everyoneVoted");
    const [, , , row4, ...rest] = await historyOf(code);
    expect(rest).toEqual([]);
    expect(row4).toMatchObject({ number: 4, subject: { kind: "none" }, stats: fourth });
    expect(row4?.votes).toEqual({ kind: "anonymous", cards: ["2", "2", "3"] });
    for (const word of [...everyone.map(({ name }) => name), ...ids]) {
      expect(row4?.text).not.toContain(word);
    }
    for (const person of everyone) expect(person.errors, person.name).toEqual([]);
  } catch (error) {
    await attachFrames(everyone, ROOM_PATH.exec(ana.page.url())?.[1]);
    throw error;
  } finally {
    for (const person of everyone) await person.context.close();
  }
});
