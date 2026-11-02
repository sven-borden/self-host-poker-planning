import type { Page } from "@playwright/test";
import { SOUNDS } from "../src/sound/sound-recipes.ts";
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

// Sound in a real browser, under the production headers (#44, #45, ADR-020, ADR-021): the
// real AudioContext, with its autoplay rule and `Permissions-Policy: autoplay=()`, and every
// voice the page starts written down. Nothing can be heard here, so what is checked is what
// started and when, the level at the output, and the numbers of the loops the page really
// plays. `sound-cues.test.ts` holds what each change of the room sounds like.

interface Voice {
  /** How far ahead it was scheduled, in seconds. */
  ahead: number;
  state: string;
  takenBack: boolean;
  /** For a loop: seconds from the stop to now, when it was stopped. */
  stopsIn?: number;
  loop: boolean;
  ended: boolean;
}

/** Writes down every context and voice the page makes, from its next load on. */
async function listen(page: Page) {
  await page.addInitScript(() => {
    const contexts: AudioContext[] = [];
    const voices: Voice[] = [];
    const tap = new WeakMap<BaseAudioContext, AnalyserNode>();
    const entries = new WeakMap<object, (typeof voices)[number]>();
    const loops: AudioBuffer[] = [];
    const renders = { started: 0, finished: 0 };
    const startRendering = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function (this: OfflineAudioContext) {
      renders.started += 1;
      const rendering = startRendering.call(this);
      rendering.then(
        () => {
          renders.finished += 1;
        },
        () => {},
      );
      return rendering;
    };
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
        const analyser = this.createAnalyser();
        analyser.fftSize = 2048;
        tap.set(this, analyser);
      }
    };
    // What reaches the speakers goes past an analyser too.
    const connect = AudioNode.prototype.connect as (...args: unknown[]) => AudioNode;
    AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
      const analyser = tap.get(this.context);
      if (analyser && args[0] === this.context.destination) connect.call(this, analyser);
      return connect.apply(this, args);
    } as typeof AudioNode.prototype.connect;
    type Source = AudioScheduledSourceNode;
    for (const proto of [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype]) {
      const start = proto.start as (this: Source, ...args: number[]) => void;
      proto.start = function (this: Source, ...args: number[]) {
        // A render is no voice: it plays to a buffer, not to anyone.
        if (!(this.context instanceof Real)) {
          start.apply(this, args);
          return;
        }
        const entry = {
          ahead: (args[0] ?? 0) - this.context.currentTime,
          state: this.context.state,
          takenBack: false,
          loop: this instanceof AudioBufferSourceNode && this.loop,
          ended: false,
        };
        voices.push(entry);
        entries.set(this, entry);
        this.addEventListener("ended", () => {
          entry.ended = true;
        });
        if (entry.loop) loops.push((this as AudioBufferSourceNode).buffer as AudioBuffer);
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
      if (entry?.loop) entry.stopsIn = (args[0] ?? 0) - this.context.currentTime;
      stop.apply(this, args);
    };
    /** How loud the output is now, as the root mean square of the last 40 ms or so. */
    const output = () => {
      const context = contexts.at(-1);
      const analyser = context && tap.get(context);
      if (!analyser) return 0;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    };
    Object.assign(window, { __sound: { contexts, voices, loops, output, renders } });
  });
}

const heard = (page: Page) =>
  page.evaluate(() => {
    const { contexts, voices } = (window as unknown as { __sound: { contexts: AudioContext[] } })
      .__sound as unknown as { contexts: AudioContext[]; voices: Voice[] };
    return { contexts: contexts.map((context) => context.state), voices };
  });

/** How many offline renders the page started and finished since it loaded. */
const renders = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __sound: { renders: { started: number; finished: number } } }).__sound
        .renders,
  );

/** The voices that are loops. */
const looped = async (page: Page) => (await heard(page)).voices.filter((voice) => voice.loop);
/** The output's level, over a moment or two: a soft bar may fall between two notes. */
const loudness = (page: Page) =>
  page.evaluate(async () => {
    const { output } = (window as unknown as { __sound: { output: () => number } }).__sound;
    let loudest = 0;
    for (let i = 0; i < 8; i += 1) {
      loudest = Math.max(loudest, output());
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return loudest;
  });

const soundButton = (page: Page) => page.locator("[data-sound]");
const theSwitch = (page: Page) => page.getByRole("switch", { name: "Play sound effects" });
const musicSwitch = (page: Page) => page.getByRole("switch", { name: "Play background music" });
const revealed = (page: Page) =>
  page.locator("[data-centre]").getByText("Consensus", { exact: true });

async function turnOn(page: Page) {
  await soundButton(page).click();
  await theSwitch(page).click();
  await expect(soundButton(page)).toHaveAttribute("data-sound", "on");
  await page.keyboard.press("Escape");
}

async function turnMusicOn(page: Page) {
  await soundButton(page).click();
  await musicSwitch(page).click();
  await expect(soundButton(page)).toHaveAttribute("data-sound", "on");
  await page.getByRole("slider", { name: "Volume" }).fill("100");
  await page.keyboard.press("Escape");
}

/** Remembers whether the page asked for the compositions. */
function watchCompositions(page: Page) {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (/music-render/.test(request.url())) asked.push(request.url());
  });
  return asked;
}

const startRound = async (page: Page, owner: Guest) => {
  expect(await owner.cmd("startRound", { subject: { kind: "none" } })).toMatchObject({ ok: true });
  await expect(handCard(page, "5")).toBeEnabled();
};

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
  const asked = watchCompositions(page);
  const { owner, guests, close } = await table(page, baseURL ?? "", context);
  try {
    await expect(soundButton(page)).toHaveAccessibleName("Sound: off");
    await agree(page, owner, guests, 1);
    expect(await heard(page)).toEqual({ contexts: [], voices: [] });
    expect(asked).toEqual([]);
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
    await expect(soundButton(page)).toHaveAccessibleName("Sound: on");
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
      "Sound: on, from your first click or key press",
    );
    await agree(page, owner, guests, 1);
    expect(await heard(page)).toEqual({ contexts: [], voices: [] });

    await page.getByRole("region", { name: "You" }).click({ position: { x: 4, y: 4 } });
    await expect(soundButton(page)).toHaveAccessibleName("Sound: on");
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

test("the music plays while voting, fades on the reveal, and comes back", async ({
  browser,
  baseURL,
}) => {
  const { page, context } = await newPerson(browser);
  await listen(page);
  const asked = watchCompositions(page);
  const { owner, guests, close } = await table(page, baseURL ?? "", context);
  try {
    // With only the music on: the effects' switch does not hold the context.
    await turnMusicOn(page);
    await expect.poll(() => asked.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await renders(page)).finished, { timeout: 20_000 }).toBe(1);
    // No round yet: rendered, and silent.
    expect(await looped(page)).toEqual([]);

    await startRound(page, owner);
    await expect.poll(async () => (await looped(page)).length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => loudness(page), { timeout: 8_000 }).toBeGreaterThan(0.002);

    for (const person of [owner, ...guests]) {
      await person.cmd("castVote", { card: "5", round: 1, restart: 0 });
    }
    expect(await owner.cmd("reveal")).toMatchObject({ ok: true });
    await expect(revealed(page)).toBeVisible();
    await expect.poll(async () => (await looped(page))[0]?.stopsIn).toBeDefined();
    const [falling] = await looped(page);
    // Stopped ahead of time, under its fade, and never taken back at once.
    expect(falling?.takenBack).toBe(false);
    expect(falling?.stopsIn).toBeGreaterThan(1.2);
    await expect.poll(async () => (await looped(page))[0]?.ended, { timeout: 6_000 }).toBe(true);
    expect(await loudness(page)).toBe(0);

    await startRound(page, owner);
    await expect.poll(async () => (await looped(page)).length).toBe(2);
    await expect.poll(() => loudness(page), { timeout: 8_000 }).toBeGreaterThan(0.002);
    expect((await heard(page)).contexts).toEqual(["running"]);
  } finally {
    close();
    await context.close();
  }
});

test("after a reload the music waits for a gesture, and starts if voting is open", async ({
  browser,
  baseURL,
}) => {
  const { page, context } = await newPerson(browser);
  await listen(page);
  const asked = watchCompositions(page);
  const { owner, close } = await table(page, baseURL ?? "", context);
  try {
    await turnMusicOn(page);
    await startRound(page, owner);
    await expect.poll(async () => (await looped(page)).length, { timeout: 20_000 }).toBe(1);

    asked.length = 0;
    await page.reload();
    await expect(soundButton(page)).toHaveAccessibleName(
      "Sound: on, from your first click or key press",
    );
    await expect(handCard(page, "5")).toBeEnabled();
    // Longer than a render waits for a quiet moment: this one is not on its way.
    await page.waitForTimeout(1_200);
    expect(await heard(page)).toEqual({ contexts: [], voices: [] });
    expect(asked).toEqual([]);
    expect(await renders(page)).toEqual({ started: 0, finished: 0 });

    await page.getByRole("region", { name: "You" }).click({ position: { x: 4, y: 4 } });
    await expect(soundButton(page)).toHaveAccessibleName("Sound: on");
    await expect.poll(async () => (await looped(page)).length, { timeout: 20_000 }).toBe(1);
    expect(asked).not.toEqual([]);
    expect(await renders(page)).toEqual({ started: 1, finished: 1 });
    await expect.poll(() => loudness(page), { timeout: 8_000 }).toBeGreaterThan(0.002);
  } finally {
    close();
    await context.close();
  }
});

test("the effects and the music each keep the audio, and the last off lets it go", async ({
  browser,
  baseURL,
}) => {
  const { page, context } = await newPerson(browser);
  await listen(page);
  const { owner, close } = await table(page, baseURL ?? "", context);
  try {
    await startRound(page, owner);
    await turnOn(page);
    await turnMusicOn(page);
    await expect.poll(async () => (await looped(page)).length, { timeout: 20_000 }).toBe(1);

    await soundButton(page).click();
    await theSwitch(page).click();
    await expect(soundButton(page)).toHaveAccessibleName("Sound: on");
    expect((await heard(page)).contexts).toEqual(["running"]);
    expect((await looped(page))[0]?.stopsIn).toBeUndefined();

    await musicSwitch(page).click();
    await expect(soundButton(page)).toHaveAccessibleName("Sound: off");
    // Falling away, not cut: the context waits for it, then goes.
    expect((await heard(page)).contexts).toEqual(["running"]);
    await expect
      .poll(async () => (await heard(page)).contexts, { timeout: 6_000 })
      .toEqual(["closed"]);
    expect((await looped(page))[0]?.stopsIn).toBeGreaterThan(1.2);
  } finally {
    close();
    await context.close();
  }
});

test("the music stops, falling away, when the person leaves the room", async ({
  browser,
  baseURL,
}) => {
  const { page, context } = await newPerson(browser);
  await listen(page);
  const { owner, close } = await table(page, baseURL ?? "", context);
  try {
    await startRound(page, owner);
    await turnMusicOn(page);
    await expect.poll(async () => (await looped(page)).length, { timeout: 20_000 }).toBe(1);

    await page.getByRole("button", { name: "Leave the room" }).click();
    await expect.poll(async () => (await looped(page))[0]?.stopsIn).toBeGreaterThan(1.2);
    await expect
      .poll(async () => (await heard(page)).contexts, { timeout: 6_000 })
      .toEqual(["closed"]);
  } finally {
    close();
    await context.close();
  }
});

test("a change of mood leaves no gap: the old one plays until the new one is ready", async ({
  browser,
  baseURL,
}) => {
  const { page, context } = await newPerson(browser);
  await listen(page);
  const { owner, close } = await table(page, baseURL ?? "", context);
  try {
    await startRound(page, owner);
    await turnMusicOn(page);
    await expect.poll(async () => (await looped(page)).length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => loudness(page), { timeout: 8_000 }).toBeGreaterThan(0.002);

    await soundButton(page).click();
    await page.getByRole("radio", { name: "Tide" }).check();
    await expect.poll(async () => (await renders(page)).started).toBe(2);
    const [playing, ...none] = await looped(page);
    expect(none).toEqual([]);
    expect(playing?.stopsIn).toBeUndefined();
    expect(await loudness(page)).toBeGreaterThan(0.002);

    await expect.poll(async () => (await looped(page)).length, { timeout: 20_000 }).toBe(2);
    // The old one falls away under the new one, stopped ahead of time and never at once.
    const [falling] = await looped(page);
    expect(falling?.takenBack).toBe(false);
    expect(falling?.stopsIn).toBeGreaterThan(1.2);
    expect(await loudness(page)).toBeGreaterThan(0.002);
  } finally {
    close();
    await context.close();
  }
});

/** Each mood's loudness at full volume, as a root mean square, and how much either way. */
const MUSIC_RMS = 0.05;
const MUSIC_RMS_RANGE = 1.2;
/** A sample may not pass this at full volume. */
const MUSIC_PEAK = 0.25;
/** How far apart the moods may be, as a ratio: 2 dB. */
const MOODS_APART = 10 ** (2 / 20);
/** The reveal's strongest note must stand this far over the music's RMS: 10 dB. */
const REVEAL_CLEAR = 10 ** (10 / 20);
/** No more than this across the seam, against the biggest step in the 5 ms either side. */
const SEAM_STEP = 1.4;
/** How far the level over 50 ms may differ across the seam, either way, as a ratio. */
const SEAM_LEVELS = 1.15;

test("every loop closes on itself, at the agreed level, under the reveal", async ({
  browser,
  baseURL,
}) => {
  const { page, context } = await newPerson(browser);
  await listen(page);
  const { owner, close } = await table(page, baseURL ?? "", context);
  try {
    await startRound(page, owner);
    await turnMusicOn(page);
    await soundButton(page).click();
    const levels: number[] = [];
    const revealGains = SOUNDS.reveal.map((voice) => voice.gain);
    for (const [index, mood] of ["Dusk", "Tide", "Embers"].entries()) {
      await page.getByRole("radio", { name: mood }).check();
      await expect
        .poll(async () => (await looped(page)).length, { timeout: 20_000 })
        .toBe(index + 1);
      const report = await page.evaluate(seamReport, index);
      // Printed for the pull request: nobody can listen to this test.
      console.log(mood, JSON.stringify(report));
      expect(report.seconds).toBe(48);
      expect(report.channels).toBe(2);
      levels.push(report.rms);
      expect(report.rms).toBeGreaterThan(MUSIC_RMS / MUSIC_RMS_RANGE);
      expect(report.rms).toBeLessThan(MUSIC_RMS * MUSIC_RMS_RANGE);
      expect(report.peak).toBeLessThanOrEqual(MUSIC_PEAK);
      // The reveal stands clear of the music, and the two together do not clip.
      expect(Math.max(...revealGains) / report.rms).toBeGreaterThan(REVEAL_CLEAR);
      expect(report.peak + revealGains.reduce((sum, gain) => sum + gain)).toBeLessThan(1);
      expect(report.edgeLevels).toBeGreaterThan(1 / SEAM_LEVELS);
      expect(report.edgeLevels).toBeLessThan(SEAM_LEVELS);
      for (const { seamStep, nearStep } of report.seams) {
        expect(seamStep).toBeLessThanOrEqual(SEAM_STEP * nearStep);
      }
    }
    expect(Math.max(...levels) / Math.min(...levels)).toBeLessThan(MOODS_APART);
  } finally {
    close();
    await context.close();
  }
});

/**
 * The numbers of one loop the page really plays: its level, the step across the seam against
 * the steps around it, as stored and as a source node plays it at 44.1 and 48 kHz, and the
 * level either side. Against the biggest step anywhere a seam proves little: a loop has much
 * bigger steps than the one a note cut short leaves.
 */
async function seamReport(index: number) {
  const { loops } = (window as unknown as { __sound: { loops: AudioBuffer[] } }).__sound;
  const loop = loops[index] as AudioBuffer;
  const rms = (samples: Float32Array) =>
    Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  const largestStep = (samples: Float32Array) => {
    let largest = 0;
    for (let i = 1; i < samples.length; i += 1) {
      largest = Math.max(largest, Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0)));
    }
    return largest;
  };
  /** The step across a seam at `at`, resampled or not, and the biggest in the 5 ms each side. */
  const across = (channels: Float32Array[], at: number, rate: number) => {
    const near = Math.floor(rate / 200);
    const steps = { rate, seamStep: 0, nearStep: 0 };
    for (const samples of channels) {
      steps.seamStep = Math.max(steps.seamStep, largestStep(samples.subarray(at - 8, at + 8)));
      steps.nearStep = Math.max(
        steps.nearStep,
        largestStep(samples.subarray(at - 8 - near, at - 8)),
        largestStep(samples.subarray(at + 8, at + 8 + near)),
      );
    }
    return steps;
  };

  const channels = Array.from({ length: loop.numberOfChannels }, (_, channel) =>
    loop.getChannelData(channel),
  );
  const span = Math.floor(loop.sampleRate / 20);
  const report = {
    seconds: loop.duration,
    channels: loop.numberOfChannels,
    rms: 0,
    peak: 0,
    edgeLevels: 1,
    seams: [] as Array<{ rate: number; seamStep: number; nearStep: number }>,
  };
  let power = 0;
  for (const samples of channels) {
    power += rms(samples) ** 2 / channels.length;
    for (const sample of samples) report.peak = Math.max(report.peak, Math.abs(sample));
    const edges = rms(samples.subarray(0, span)) / rms(samples.subarray(samples.length - span));
    // Whichever channel is further from level on both sides of the seam.
    if (Math.abs(Math.log(edges)) > Math.abs(Math.log(report.edgeLevels))) {
      report.edgeLevels = edges;
    }
  }
  report.rms = Math.sqrt(power);

  // The end of the loop and then its start, as a looping source reads them.
  const wrapped = channels.map((samples) => {
    const both = new Float32Array(2 * span);
    both.set(samples.subarray(samples.length - span));
    both.set(samples.subarray(0, span), span);
    return both;
  });
  report.seams.push(across(wrapped, span, loop.sampleRate));

  // Three seconds as played: one up to the seam, and two past it.
  for (const rate of [44_100, 48_000]) {
    const offline = new OfflineAudioContext(2, 3 * rate, rate);
    const source = offline.createBufferSource();
    source.buffer = loop;
    source.loop = true;
    source.connect(offline.destination);
    source.start(0, loop.duration - 1);
    const played = await offline.startRendering();
    report.seams.push(across([played.getChannelData(0), played.getChannelData(1)], rate, rate));
  }
  return report;
}

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
