import { expect, type Page, test } from "./fixtures.ts";
import { createRoom, handCard, join, newPerson, phone, seats } from "./support.ts";

// The app in WebKit (U3), the engine of every browser on an iPhone and of Safari on a Mac.
// `/dev/table` crashed here with React error 185 (a card label measured against its own clip,
// in and out without end) while Chromium drew it, and no Safari had run the app. This
// project runs the table's bench and one whole round, at a desktop's size and on an
// iPhone 13, in Playwright's WebKit, and fails on any uncaught error (e2e/fixtures.ts) and
// any error in the console: a React error caught by the router's boundary only logs.
//
// Playwright's WebKit is not Safari: it is WebKit's engine on Playwright's own port (on
// Windows the WinCairo one, on Linux WPE/GTK), with Playwright's patches. It proves the
// engine's layout, style, script and events; not Safari's own frame (its toolbars and the
// viewport they resize), iOS's keyboard, touch scrolling and rubber-banding, Safari's
// stricter storage and privacy rules, its fonts, or Apple's GPU. Those take a real iPhone.

/** A console line from the app that tells of a problem: every error, and React's warnings. */
const PROBLEM = /^(error|assert)$/;
const REACT = /react|minified|maximum update depth/i;

function watchConsole(page: Page, who: string, lines: string[]) {
  page.on("console", (message) => {
    const text = message.text();
    if (PROBLEM.test(message.type()) || (message.type() === "warning" && REACT.test(text))) {
      lines.push(`${who} ${message.type()}: ${text}`);
    }
  });
}

/** The table's bench drew: the seats, no error page. A failure says what the console did. */
async function expectBench(page: Page, people: number, problems: readonly string[]) {
  const said = problems.join("\n") || "nothing in the console";
  await expect(seats(page).locator("[data-seat]"), said).toHaveCount(people);
  await expect(page.getByRole("heading", { name: "Something went wrong" }), said).toHaveCount(0);
}

/** A sheet, once it has slid in: a press during the slide lands where its control was. */
async function slidIn(page: Page, name: string) {
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        // A cancelled animation rejects its `finished`: it has ended all the same.
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  return dialog;
}

const BENCH = [
  ["", 8],
  ["?n=1&state=lobby", 1],
  ["?n=16&state=voting&observers=4&away=1", 16],
  ["?n=16&state=revealed&observers=4&avatars=1", 16],
  ["?n=11&state=revealed&changed=1&avatars=2", 11],
] as const;

test.describe("WebKit", () => {
  test("draws the table's bench at a desktop's size and on an iPhone", async ({
    page,
    browser,
  }) => {
    const problems: string[] = [];
    watchConsole(page, "desktop", problems);
    const iphone = await phone(browser, "iPhone 13");
    watchConsole(iphone.page, "iPhone", problems);
    try {
      for (const [query, people] of BENCH) {
        for (const [who, at] of [
          ["desktop", page],
          ["iPhone", iphone.page],
        ] as const) {
          await test.step(`${who} /dev/table${query}`, async () => {
            await at.goto(`/dev/table${query}`);
            await expectBench(at, people, problems);
            // The labels are measured on the observer's first delivery, a frame or two on, and
            // again when the font loads: wait for both.
            await at.evaluate(async () => {
              await document.fonts.ready;
              for (let frame = 0; frame < 3; frame += 1) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
              }
            });
            await expectBench(at, people, problems);
          });
        }
      }
      expect(problems).toEqual([]);
    } finally {
      await iphone.context.close();
    }
  });

  test("plays a round, named then anonymous, between a desktop and an iPhone", async ({
    browser,
  }) => {
    const problems: string[] = [];
    const ana = await newPerson(browser);
    watchConsole(ana.page, "Ana (desktop)", problems);
    const ben = await phone(browser, "iPhone 13");
    watchConsole(ben.page, "Ben (iPhone)", problems);
    const everyone = [ana.page, ben.page];
    const results = (page: Page) => page.getByRole("region", { name: "Results" });
    try {
      // The landing page, then the room; Ben gets the join form from the link.
      const code = await createRoom(ana.page);
      await join(ana.page, "Ana");
      await ben.page.goto(`/r/${code}`);
      await expect(ben.page.getByRole("textbox", { name: "Your name" })).toBeVisible();
      await join(ben.page, "Ben");
      for (const page of everyone) await expect(seats(page).locator("[data-seat]")).toHaveCount(2);

      // A named round: Ben votes, Ana reveals with his vote alone in.
      await ana.page.getByRole("button", { name: "Start voting" }).click();
      await handCard(ben.page, "3").tap();
      await handCard(ben.page, "8").tap();
      await expect(handCard(ben.page, "8")).toHaveAttribute("aria-pressed", "true");
      await expect(seats(ana.page).getByRole("button", { name: /^Ben, voted$/ })).toHaveCount(1);
      await ana.page.getByRole("button", { name: "Reveal cards" }).click();
      for (const page of everyone) {
        await expect(seats(page).getByRole("button", { name: /^Ben, (you, )?card 8/ })).toHaveCount(
          1,
        );
        await expect(results(page)).toBeVisible();
      }

      // Ana turns anonymity on in her settings; the next round's last vote reveals it.
      await ana.page.getByRole("button", { name: "Room settings" }).click();
      const settings = await slidIn(ana.page, "Room settings");
      const anonymous = settings.getByRole("switch", { name: "Anonymous voting" });
      await anonymous.click();
      await expect(anonymous).toHaveAttribute("aria-checked", "true");
      await expect(anonymous).not.toHaveAttribute("aria-busy", "true");
      await ana.page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      await ana.page.getByRole("button", { name: "Next round" }).click();
      for (const page of everyone) await expect(results(page)).toHaveCount(0);
      await handCard(ana.page, "5").click();
      await handCard(ben.page, "13").tap();
      for (const page of everyone) {
        await expect(results(page)).toBeVisible();
        // Nobody's seat names a card in an anonymous round.
        await expect(seats(page).getByRole("button", { name: /card \d/ })).toHaveCount(0);
      }

      // Ben reads the room's rules and its history on his phone.
      await ben.page.getByRole("button", { name: "Room rules" }).tap();
      const rules = await slidIn(ben.page, "Room rules");
      await rules.getByRole("button", { name: "Close" }).tap();
      await expect(rules).toBeHidden();
      await ben.page.getByRole("button", { name: "History" }).tap();
      const history = await slidIn(ben.page, "History");
      await expect(history.getByRole("heading", { name: "Round 1" })).toBeVisible();
      await history.getByRole("button", { name: "Close" }).tap();
      await expect(history).toBeHidden();

      // A third round starts clean for both.
      await ana.page.getByRole("button", { name: "Next round" }).click();
      for (const page of everyone) await expect(results(page)).toHaveCount(0);
      await expect(handCard(ben.page, "13")).toHaveAttribute("aria-pressed", "false");
      expect(problems).toEqual([]);
    } finally {
      await ana.context.close();
      await ben.context.close();
    }
  });
});
