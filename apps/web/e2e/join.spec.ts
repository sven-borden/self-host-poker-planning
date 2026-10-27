import { expect, test } from "@playwright/test";
import {
  createRoom,
  type Guest,
  join,
  newGuest,
  newPerson,
  observerRow,
  ownAddress,
  ROOM_PATH,
  SHOTS,
  sameUser,
  seatNames,
  shoot,
} from "./support.ts";

// Joining a room (#16) in real browsers, against the real server and Postgres: people
// join with a name as voter or observer and see each other seated, the 17th person sees
// that the room is full, a refresh or a second tab keeps the seat and the vote, and the
// viewer renames, switches role and leaves from the room. Extra people are driven over
// the protocol from Node (a guest's cookie and a socket), which keeps the full-room test
// fast. Needs DATABASE_URL; skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("CI must run the join tests: set DATABASE_URL");
});

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(ownAddress());
});

test("three people join one room and each sees the other two seated", async ({
  page,
  browser,
  baseURL,
}) => {
  const base = baseURL ?? "";
  await createRoom(page);
  await expect(page.getByRole("heading", { name: "Take a seat" })).toBeVisible();
  await shoot(page, "join");
  // Windows high contrast: the role cards, the field and the Join button keep their edges.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ forcedColors: "active" });
  await page.screenshot({ path: `${SHOTS}join-1440-forced-colors.png`, fullPage: true });
  await page.emulateMedia({ forcedColors: "none" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await join(page, "Ana");

  const ben = await newPerson(browser);
  const cleo = await newPerson(browser);
  const watchers: Guest[] = [];
  try {
    await ben.page.goto(page.url());
    await join(ben.page, "Ben");
    await cleo.page.goto(page.url());
    await join(cleo.page, "Cleo");
    // Each viewer sits at the bottom, first in the list; the others follow clockwise in
    // join order, starting with whoever joined after the viewer.
    await expect(seatNames(page)).toHaveText(["Ana", "Ben", "Cleo"]);
    await expect(seatNames(ben.page)).toHaveText(["Ben", "Cleo", "Ana"]);
    await expect(seatNames(cleo.page)).toHaveText(["Cleo", "Ana", "Ben"]);

    // Two observers watch from the row under the table.
    for (const name of ["Dee", "Eli"]) {
      const watcher = await newGuest(base);
      watchers.push(watcher);
      expect(await watcher.enter(ROOM_PATH.exec(page.url())?.[1] ?? "")).toMatchObject({
        ok: true,
      });
      expect(await watcher.cmd("join", { name, role: "observer" })).toMatchObject({ ok: true });
    }
    await expect(observerRow(page).locator("bdi")).toHaveText(["Dee", "Eli"]);
    await expect(seatNames(page)).toHaveCount(3);
    await shoot(page, "table-3-observers");
  } finally {
    for (const watcher of watchers) watcher.close();
    await ben.context.close();
    await cleo.context.close();
  }
});

test("the 17th person sees that the room is full, and can join once someone leaves", async ({
  page,
  browser,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Product owner");
  const guests: Guest[] = [];
  const late = await newPerson(browser);
  try {
    // People 2 to 16 over the protocol.
    for (let i = 2; i <= 16; i++) {
      const guest = await newGuest(base);
      guests.push(guest);
      expect(await guest.enter(code)).toMatchObject({ ok: true });
      const role = i % 5 === 0 ? "observer" : "voter";
      expect(await guest.cmd("join", { name: `Person ${i}`, role })).toMatchObject({ ok: true });
    }
    await expect(seatNames(page)).toHaveCount(13);
    await expect(observerRow(page).locator("li")).toHaveCount(3);

    await late.page.goto(page.url());
    await expect(late.page.getByRole("heading", { name: "This room is full" })).toBeVisible();
    await expect(late.page.getByText(/^16 people are already here\./)).toBeVisible();
    await expect(late.page.getByRole("button", { name: "Join the room" })).toHaveCount(0);
    await shoot(late.page, "room-full");

    // Someone leaves: the screen turns into the join form, which takes the focus and says
    // why, and the 17th person sits down.
    expect(await guests[0]?.cmd("leave")).toMatchObject({ ok: true });
    await expect(late.page.getByRole("textbox", { name: "Your name" })).toBeFocused();
    await expect(late.page.locator("[data-room-notice]")).toHaveText(
      "A seat is free. You can join now.",
    );
    await join(late.page, "Seventeen");
    await expect(seatNames(late.page).first()).toHaveText("Seventeen");
  } finally {
    for (const guest of guests) guest.close();
    await late.context.close();
  }
});

test("a refresh and a second tab keep the seat and the vote", async ({
  page,
  context,
  baseURL,
}) => {
  const base = baseURL ?? "";
  const code = await createRoom(page);
  await join(page, "Ana");
  // The vote UI is #18: the same user casts a vote over the protocol, as the page would.
  const ana = await sameUser(base, context);
  try {
    expect(await ana.enter(code)).toMatchObject({ ok: true });
    expect(await ana.cmd("startRound", { subject: { kind: "none" } })).toMatchObject({ ok: true });
    expect(await ana.cmd("castVote", { card: "5", round: 1, restart: 0 })).toMatchObject({
      ok: true,
    });
  } finally {
    ana.close();
  }

  // Socket.IO starts on HTTP long-polling and upgrades to a websocket, so the enter ack
  // may come either way: both are read.
  const frames: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => frames.push(String(payload))),
  );
  page.on("response", async (response) => {
    if (!new URL(response.url()).pathname.startsWith("/socket.io/")) return;
    if (response.request().method() !== "GET") return;
    frames.push(await response.text().catch(() => ""));
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Join the room" })).toHaveCount(0);
  await expect(seatNames(page)).toHaveText(["Ana"]);
  // The page's own snapshot after the refresh still holds the vote, for its viewer only.
  await expect.poll(() => frames.some((f) => f.includes('"yourVote":"5"'))).toBe(true);

  const second = await context.newPage();
  await second.goto(page.url());
  await expect(second.getByRole("heading", { name: "You", exact: true })).toBeVisible();
  await expect(seatNames(second)).toHaveText(["Ana"]);
  await second.close();
});

test("a join still saving the name never lands in the next room the page opens", async ({
  page,
  context,
  baseURL,
}) => {
  const base = baseURL ?? "";
  await createRoom(page);
  // The name save hangs for a while; the person goes back and creates another room.
  let saved: () => void = () => {};
  const nameSaved = new Promise<void>((resolve) => {
    saved = resolve;
  });
  await page.route("**/api/me/name", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
    saved();
  });
  await page.getByRole("textbox", { name: "Your name" }).fill("Wanderer");
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.goBack();
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  const second = ROOM_PATH.exec(page.url())?.[1] ?? "";
  await expect(page.getByRole("heading", { name: "Take a seat" })).toBeVisible();
  await nameSaved;
  // Time for a join that would follow the save; then nobody sits in the second room.
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("heading", { name: "Take a seat" })).toBeVisible();
  const probe = await sameUser(base, context);
  try {
    const ack = await probe.enter(second);
    expect(ack).toMatchObject({ ok: true, snapshot: { room: { participants: [] } } });
  } finally {
    probe.close();
  }
});

test("rename, switch role and leave from the room, as others see it", async ({ page, browser }) => {
  await createRoom(page);
  await join(page, "Ana");
  const ben = await newPerson(browser);
  try {
    await ben.page.goto(page.url());
    await join(ben.page, "Ben");

    await page.getByRole("button", { name: "Change your name" }).click();
    const field = page.getByRole("textbox", { name: "Your name" });
    await expect(field).toBeFocused();
    await field.fill("Ana Lima");
    await field.press("Enter");
    await expect(page.getByRole("button", { name: "Change your name" })).toBeFocused();
    await expect(seatNames(ben.page)).toHaveText(["Ben", "Ana Lima"]);

    await page.getByRole("button", { name: "Switch to observer" }).click();
    await expect(observerRow(ben.page).locator("bdi")).toHaveText(["Ana Lima"]);
    await expect(seatNames(ben.page)).toHaveText(["Ben"]);
    await expect(page.getByText("Watching, not voting")).toBeVisible();

    await page.getByRole("button", { name: "Switch to voter" }).click();
    await expect(seatNames(ben.page)).toHaveText(["Ben", "Ana Lima"]);

    await page.getByRole("button", { name: "Leave the room" }).click();
    const name = page.getByRole("textbox", { name: "Your name" });
    await expect(name).toBeFocused();
    // The last name used is the one offered again.
    await expect(name).toHaveValue("Ana Lima");
    await expect(seatNames(ben.page)).toHaveText(["Ben"]);
  } finally {
    await ben.context.close();
  }
});

test("the join form works with the keyboard alone and explains a refused name", async ({
  page,
}) => {
  const names: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/me/name")) names.push(request.method());
  });
  await createRoom(page);
  const name = page.getByRole("textbox", { name: "Your name" });
  await name.focus();
  for (const bad of ["   ", "x".repeat(33), "Sv\u{200B}en"]) {
    await name.fill(bad);
    await page.keyboard.press("Enter");
    const alert = page.getByRole("alert");
    await expect(alert).toHaveText("A name needs 1 to 32 characters. Choose another one.");
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    expect(await name.getAttribute("aria-describedby")).toContain(await alert.getAttribute("id"));
  }
  // Checked in the browser: nothing was sent.
  expect(names).toEqual([]);

  await name.fill("Kim");
  // Tab to the role choice, pick observer with the arrow key, Tab to the button, Enter.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: /^Voter/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: /^Observer/ })).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Join the room" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "You", exact: true })).toBeFocused();
  await expect(observerRow(page).locator("bdi")).toHaveText(["Kim"]);

  // Rename with the keyboard; Escape cancels and gives the focus back.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Change your name" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Your name" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Change your name" })).toBeFocused();
});
