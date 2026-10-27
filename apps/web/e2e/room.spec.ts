import { expect, test } from "@playwright/test";

// The room page over the real socket (#15), against the real server and Postgres: the
// page connects once the guest exists, enters the room and shows the server's answer.
// Rooms cannot be created from the browser before #14, so this checks the refusal path;
// the server's own tests (apps/server/src/sync) cover live rooms. Needs DATABASE_URL, like
// identity.spec.ts: skipped without it locally, failing without it in CI.

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "needs DATABASE_URL: runs against the real server",
);
test.beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("CI must run the room tests: set DATABASE_URL");
});

test("an unknown room code ends in the room-not-found message, over the socket", async ({
  page,
}) => {
  const frames: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => frames.push(String(payload)));
  });
  await page.goto("/r/NoSuchRoom1");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room NoSuchRoom1");
  await expect(page.getByRole("alert")).toContainText("This room does not exist");
  await expect(page.getByRole("link", { name: "Back to the home page" })).toBeVisible();
  // The answer came as an enter ack (polling or WebSocket, whichever carried it).
  expect(frames.every((frame) => !frame.includes('"snapshot"'))).toBe(true);
});
