import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { createRoom, type Guest, guestsJoin, handCard, join, sameUser } from "./support.ts";

// Reduced motion through a whole session (#37; design brief, "Motion spec"): the hand's
// deal, a card's flight, the flips, the results, an anonymous reveal, the timer's last
// seconds, the settings and history sheets. Every animation the page runs, CSS or Web
// Animations, is sampled each frame: under `prefers-reduced-motion` none lasts longer
// than the 120 ms cross-fade, and none repeats for ever. reveal.spec.ts, settings.spec.ts
// and change-after-reveal.spec.ts check the reveal, the sheet and a changed card alone.

interface Seen {
  what: string;
  duration: number;
  iterations: number;
}

/** Samples every animation the page runs from its next load on (`seen` reads them). */
async function sampleAnimations(page: Page) {
  await page.addInitScript(() => {
    const seen: { what: string; duration: number; iterations: number }[] = [];
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

    const all = await seen(page);
    expect(all.length, "animations were sampled").toBeGreaterThan(5);
    const long = all.filter((a) => a.duration > 121 || a.iterations === Number.POSITIVE_INFINITY);
    expect(long, JSON.stringify(long.slice(0, 10), null, 2)).toEqual([]);
  } finally {
    owner.close();
    for (const guest of guests) guest.close();
  }
});
