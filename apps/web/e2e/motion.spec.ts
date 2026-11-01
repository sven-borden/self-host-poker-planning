import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import {
  animated,
  createRoom,
  type Guest,
  guestsJoin,
  handCard,
  join,
  newPerson,
  recordAnimations,
  sameUser,
} from "./support.ts";

// Reduced motion through a whole session (#37; design brief, "Motion spec"): the hand's
// deal, a card's flight, the flips, the results, an anonymous reveal, the timer's last
// seconds, the settings and history sheets, someone coming and going. Every animation the
// page runs, CSS or Web Animations, is sampled each frame: under `prefers-reduced-motion`
// none lasts longer than the 120 ms cross-fade, none waits, and none repeats for ever.
// reveal.spec.ts, settings.spec.ts and change-after-reveal.spec.ts check the reveal, the
// sheet and a changed card alone. The moments the other specs do not reach (#43): a seat
// joining and leaving, the others gliding, a vote landing, the hand's hover.

interface Seen {
  what: string;
  duration: number;
  delay: number;
  iterations: number;
}

/** Samples every animation the page runs from its next load on (`seen` reads them). */
async function sampleAnimations(page: Page) {
  await page.addInitScript(() => {
    const seen: { what: string; duration: number; delay: number; iterations: number }[] = [];
    const known = new WeakSet<Animation>();
    Object.assign(window, { __seen: seen });
    const sample = () => {
      for (const animation of document.getAnimations()) {
        if (known.has(animation)) continue;
        known.add(animation);
        const timing = animation.effect?.getComputedTiming();
        const target = (animation.effect as KeyframeEffect | null)?.target;
        const name =
          (animation as CSSAnimation).animationName ??
          (animation as CSSTransition).transitionProperty ??
          "animate()";
        const attributes = target
          ? [...target.attributes]
              .map((a) => a.name)
              .filter((a) => a.startsWith("data-"))
              .join(" ")
          : "";
        seen.push({
          what: `${name} on ${target?.tagName.toLowerCase() ?? "?"} ${attributes}`.trim(),
          duration: Number(timing?.duration ?? 0),
          delay: Number(timing?.delay ?? 0),
          iterations: Number(timing?.iterations ?? 1),
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

const seen = (page: Page) => page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);

test("under reduced motion every animation of a session is a short cross-fade, and none repeats", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const base = baseURL ?? "";
  await page.emulateMedia({ reducedMotion: "reduce" });
  await sampleAnimations(page);
  const code = await createRoom(page);
  await join(page, "Ana");
  let guests: Guest[] = [];
  const owner = await sameUser(base, page.context());
  try {
    expect(await owner.enter(code)).toMatchObject({ ok: true });
    guests = await guestsJoin(base, code, ["Ben", "Cleo"]);
    const vote = async (round: number, cards: string[]) => {
      for (const [i, card] of cards.entries()) {
        expect(await guests[i]?.cmd("castVote", { card, round, restart: 0 })).toMatchObject({
          ok: true,
        });
      }
    };

    // Round 1: the hand deals in, Ana's card flies, the last vote reveals, all agree.
    await page.getByRole("button", { name: "Start voting" }).click();
    await handCard(page, "5").click();
    await vote(1, ["5", "5"]);
    await expect(page.locator("[data-face='up']")).toHaveCount(3);
    await page.waitForTimeout(800);

    // Round 2, anonymous, with a timer in its last seconds; the PO reveals.
    expect(await owner.cmd("updateSettings", { patch: { revealNames: false } })).toMatchObject({
      ok: true,
    });
    await page.getByRole("button", { name: "Next round" }).click();
    expect(await owner.cmd("startTimer", { seconds: 11 })).toMatchObject({ ok: true });
    await page.waitForTimeout(2500);
    await vote(2, ["3", "8"]);
    await page.getByRole("button", { name: "Reveal cards" }).click();
    await expect(page.getByRole("region", { name: "Results" })).toBeVisible();
    await page.waitForTimeout(800);

    // The sheets.
    for (const name of ["Room settings", "History"]) {
      await page.getByRole("button", { name }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
    }

    // Someone comes and goes.
    const [late] = await guestsJoin(base, code, ["Dan"]);
    if (late) guests.push(late);
    await expect(page.locator("[data-seat]")).toHaveCount(4);
    await page.waitForTimeout(300);
    expect(await late?.cmd("leave")).toMatchObject({ ok: true });
    await expect(page.locator("[data-seat]")).toHaveCount(3);
    await page.waitForTimeout(300);

    const all = await seen(page);
    expect(all.length, "animations were sampled").toBeGreaterThan(5);
    const long = all.filter(
      (a) => a.duration > 121 || a.delay > 0 || a.iterations === Number.POSITIVE_INFINITY,
    );
    expect(long, JSON.stringify(long.slice(0, 10), null, 2)).toEqual([]);
    expect(all.filter((a) => a.what.includes("data-seat")).length).toBeGreaterThan(0);
  } finally {
    owner.close();
    for (const guest of guests) guest.close();
  }
});

test("a seat fades in and out, the others glide, and a vote lands with a pop", async ({
  browser,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const { page } = await newPerson(browser);
  const code = await createRoom(page);
  await join(page, "Ana");
  await expect(page.locator("[data-seat]")).toHaveCount(1);
  const owner = await sameUser(base, page.context());
  let guests: Guest[] = [];
  try {
    expect(await owner.enter(code)).toMatchObject({ ok: true });
    guests = await guestsJoin(base, code, ["Ben"]);
    await expect(page.locator("[data-seat]")).toHaveCount(2);
    await page.waitForTimeout(300);
    await recordAnimations(page);
    const ben = guests[0];

    // Cleo joins: the new seat and slot fade and scale from 0.9, everyone else glides.
    const [cleo] = await guestsJoin(base, code, ["Cleo"]);
    if (cleo) guests.push(cleo);
    await expect(page.locator("[data-seat]")).toHaveCount(3);
    const joined = await animated(page);
    const fades = joined.filter((a) => a.keyframes.includes('"scale":"0.9"'));
    expect(fades.map((a) => [a.target, a.duration]).sort()).toEqual([
      ["div", 220],
      ["li", 220],
    ]);
    expect(joined.filter((a) => a.keyframes.includes("translate")).length).toBeGreaterThan(0);
    await page.waitForTimeout(300);

    // Nothing stays moved, scaled or see-through.
    const rest = await page.locator("[data-seat], [data-slot-card]").evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return `${style.translate} ${style.scale} ${style.opacity}`;
      }),
    );
    expect(new Set(rest)).toEqual(new Set(["none none 1"]));

    // A vote lands: a 380 ms drop on the slot, a 300 ms pop of the check.
    await page.getByRole("button", { name: "Start voting" }).click();
    await page.evaluate(() => {
      (window as unknown as { __animated: unknown[] }).__animated.length = 0;
    });
    expect(await ben?.cmd("castVote", { card: "5", round: 1, restart: 0 })).toMatchObject({
      ok: true,
    });
    await expect(page.locator("[data-face='down']")).toHaveCount(1);
    const landed = await animated(page);
    expect(landed.filter((a) => a.target === "down").map((a) => a.duration)).toEqual([380]);
    expect(landed.filter((a) => a.target === "voted").map((a) => a.duration)).toEqual([300]);

    // The hand's hover and pick lift in 180 ms.
    expect(
      await handCard(page, "5").evaluate((card) => getComputedStyle(card).transitionDuration),
    ).toBe("0.18s");

    // Ben leaves: the seat fades out on the stage, out of reach, then it is gone.
    expect(await ben?.cmd("leave")).toMatchObject({ ok: true });
    await expect(page.locator("[data-seat]")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /^Ben/ })).toHaveCount(0);
    await expect(page.locator("[data-stage] [inert]")).toHaveCount(0);
  } finally {
    owner.close();
    for (const guest of guests) guest.close();
  }
});
