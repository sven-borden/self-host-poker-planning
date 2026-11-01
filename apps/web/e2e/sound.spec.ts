import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import {
  createRoom,
  type Guest,
  guestsJoin,
  handCard,
  join,
  newPerson,
  phone,
  sameUser,
} from "./support.ts";

// Sound effects in a real browser, under the production headers (#44, ADR-020): the real
// AudioContext, with its autoplay rule and `Permissions-Policy: autoplay=()`, and every
// voice the page starts written down. Nothing can be heard here, so what is checked is what
// started and when. `sound-cues.test.ts` holds what each change of the room sounds like.

interface Voice {
  /** How far ahead it was scheduled, in seconds. */
  ahead: number;
  state: string;
  takenBack: boolean;
}

/** Writes down every context and voice the page makes, from its next load on. */
async function listen(page: Page) {
  await page.addInitScript(() => {
    const contexts: AudioContext[] = [];
    const voices: { ahead: number; state: string; takenBack: boolean }[] = [];
    const entries = new WeakMap<object, (typeof voices)[number]>();
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }
    };
    type Source = AudioScheduledSourceNode;
    for (const proto of [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype]) {
      const start = proto.start as (this: Source, ...args: number[]) => void;
      proto.start = function (this: Source, ...args: number[]) {
        const entry = {
          ahead: (args[0] ?? 0) - this.context.currentTime,
          state: this.context.state,
          takenBack: false,
        };
        voices.push(entry);
        entries.set(this, entry);
        start.apply(this, args);
      };
    }
    const stop = AudioScheduledSourceNode.prototype.stop as (
      this: Source,
      ...args: number[]
    ) => void;
    AudioScheduledSourceNode.prototype.stop = function (this: Source, ...args: number[]) {
      const entry = entries.get(this);
      if (entry && args.length === 0) entry.takenBack = true;
      stop.apply(this, args);
    };
    Object.assign(window, { __sound: { contexts, voices } });
  });
}

const heard = (page: Page) =>
  page.evaluate(() => {
    const { contexts, voices } = (window as unknown as { __sound: { contexts: AudioContext[] } })
      .__sound as unknown as { contexts: AudioContext[]; voices: Voice[] };
    return { contexts: contexts.map((context) => context.state), voices };
  });

const soundButton = (page: Page) => page.locator("[data-sound]");
const theSwitch = (page: Page) => page.getByRole("switch", { name: "Play sound effects" });
const revealed = (page: Page) =>
  page.locator("[data-centre]").getByText("Consensus", { exact: true });

async function turnOn(page: Page) {
  await soundButton(page).click();
  await theSwitch(page).click();
  await expect(soundButton(page)).toHaveAttribute("data-sound", "on");
  await page.keyboard.press("Escape");
}

/** A person at the table with two guests, and the person's own socket as PO. */
async function table(page: Page, base: string, context: Parameters<typeof sameUser>[1]) {
  const code = await createRoom(page);
  await join(page, "Ana");
  const owner = await sameUser(base, context);
  expect(await owner.enter(code)).toMatchObject({ ok: true });
  const guests = await guestsJoin(base, code, ["Ben", "Cleo"]);
  expect(await owner.cmd("updateSettings", { patch: { revealWhenAllVoted: false } })).toMatchObject(
    { ok: true },
  );
  const close = () => {
    for (const guest of [owner, ...guests]) guest.close();
  };
  return { owner, guests, close };
}

/** A round where everyone plays 5, revealed by the PO: every sound there is. */
async function agree(page: Page, owner: Guest, guests: Guest[], round: number) {
  expect(await owner.cmd("startRound", { subject: { kind: "none" } })).toMatchObject({ ok: true });
  await expect(handCard(page, "5")).toBeEnabled();
  for (const person of [owner, ...guests]) {
    expect(await person.cmd("castVote", { card: "5", round, restart: 0 })).toMatchObject({
      ok: true,
    });
  }
  expect(await owner.cmd("reveal")).toMatchObject({ ok: true });
  await expect(revealed(page)).toBeVisible();
}

test("a room stays silent until someone turns the sound on", async ({ browser, baseURL }) => {
  const { page, context } = await newPerson(browser);
  await listen(page);
  const { owner, guests, close } = await table(page, baseURL ?? "", context);
  try {
    await expect(soundButton(page)).toHaveAccessibleName("Sound effects: off");
    await agree(page, owner, guests, 1);
    expect(await heard(page)).toEqual({ contexts: [], voices: [] });
  } finally {
    close();
    await context.close();
  }
});

test("turned on, a round is heard, under the production headers", async ({ browser, baseURL }) => {
  const { page, context } = await newPerson(browser);
  await listen(page);
  const { owner, guests, close } = await table(page, baseURL ?? "", context);
  try {
    await turnOn(page);
    await expect(soundButton(page)).toHaveAccessibleName("Sound effects: on");
    const after = await heard(page);
    expect(after.contexts).toEqual(["running"]);
    // The switch's own test of the sound, heard at once.
    expect(after.voices).toHaveLength(2);

    await agree(page, owner, guests, 1);
    const round = await heard(page);
    expect(round.voices.every((voice) => voice.state === "running")).toBe(true);
    // Two cards at least, the reveal's two notes, three flicks and a four-note consensus.
    expect(round.voices.length).toBeGreaterThanOrEqual(2 + 4 + 4 + 3 + 8);
  } finally {
    close();
    await context.close();
  }
});

test("a reload keeps the choice, and nothing plays before the next gesture", async ({
  browser,
  baseURL,
}) => {
  const { page, context } = await newPerson(browser);
  await listen(page);
  const { owner, guests, close } = await table(page, baseURL ?? "", context);
  try {
    await turnOn(page);
    await soundButton(page).click();
    await page.getByRole("slider", { name: "Volume" }).fill("25");
    await page.keyboard.press("Escape");

    await page.reload();
    await expect(soundButton(page)).toHaveAccessibleName(
      "Sound effects: on, from your first click or key press",
    );
    await agree(page, owner, guests, 1);
    expect(await heard(page)).toEqual({ contexts: [], voices: [] });

    await page.getByRole("region", { name: "You" }).click({ position: { x: 4, y: 4 } });
    await expect(soundButton(page)).toHaveAccessibleName("Sound effects: on");
    // What came before the gesture stays missed.
    expect(await heard(page)).toEqual({ contexts: ["running"], voices: [] });

    await soundButton(page).click();
    await expect(theSwitch(page)).toBeChecked();
    await expect(page.getByRole("slider", { name: "Volume" })).toHaveValue("25");
  } finally {
    close();
    await context.close();
  }
});

test("the timer's last seconds are laid out ahead and taken back with the timer", async ({
  browser,
  baseURL,
}) => {
  const { page, context } = await newPerson(browser);
  await listen(page);
  const { owner, close } = await table(page, baseURL ?? "", context);
  try {
    await turnOn(page);
    expect(await owner.cmd("startRound", { subject: { kind: "none" } })).toMatchObject({
      ok: true,
    });
    expect(await owner.cmd("startTimer", { seconds: 60 })).toMatchObject({ ok: true });
    await expect(page.locator("[data-timer=running]").first()).toBeVisible();
    const { voices } = await heard(page);
    const ticks = voices.slice(2);
    expect(ticks).toHaveLength(5);
    expect(ticks[0]?.ahead).toBeGreaterThan(50);
    expect(ticks[0]?.ahead).toBeLessThanOrEqual(55);
    expect((ticks[4]?.ahead ?? 0) - (ticks[0]?.ahead ?? 0)).toBeCloseTo(4, 0);

    expect(await owner.cmd("stopTimer")).toMatchObject({ ok: true });
    await expect
      .poll(async () => (await heard(page)).voices.slice(2).every((voice) => voice.takenBack))
      .toBe(true);
  } finally {
    close();
    await context.close();
  }
});

test("a phone reaches the sound, and the bar fits down to 320 px", async ({ browser, baseURL }) => {
  const { page, context } = await phone(browser, { width: 360, height: 740 });
  const { close } = await table(page, baseURL ?? "", context);
  try {
    const box = await soundButton(page).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 740 });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await expect(soundButton(page)).toBeInViewport({ ratio: 1 });
    }
    await soundButton(page).tap();
    await theSwitch(page).tap();
    await expect(soundButton(page)).toHaveAttribute("data-sound", "on");
    const panel = await page.locator("[data-sound-panel]").boundingBox();
    expect(panel?.x).toBeGreaterThanOrEqual(0);
    expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(360);
  } finally {
    close();
    await context.close();
  }
});
