import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { io, type Socket } from "socket.io-client";
import { PROTOCOL_VERSION } from "../../../packages/protocol/src/version.ts";

// Shared by the specs that run against the real server and Postgres (join.spec.ts,
// presence.spec.ts): guests driven over the protocol from Node, a client address per
// person, and the room page's common steps.

export const SHOTS = fileURLToPath(new URL("../tmp/screenshots/", import.meta.url));
export const ROOM_PATH = /\/r\/([1-9A-HJ-NP-Za-km-z]{10})$/;
export const SESSION_COOKIE = "pp.session_token";

export type Ack = { ok: true; version?: number; snapshot?: unknown } | { ok: false; code: string };

/** A person in the room without a browser: a guest's session and one socket. */
export interface Guest {
  cookie: string;
  socket: Socket;
  enter: (code: string) => Promise<Ack>;
  cmd: (type: string, payload?: Record<string, unknown>) => Promise<Ack>;
  close: () => void;
}

let commandIds = 0;
let addresses = 0;

/**
 * A client address of its own, as an X-Forwarded-For header: the e2e server trusts one
 * proxy (playwright.config.ts), so each person here counts alone against the server's
 * per-address limits (20 rooms in 10 minutes, 60 sign-ins a minute), which the whole
 * suite from one machine would otherwise share.
 */
export function ownAddress(): Record<string, string> {
  const n = ++addresses;
  const worker = test.info().workerIndex % 256;
  return { "x-forwarded-for": `10.${worker}.${(n >> 8) & 255}.${n & 255}` };
}

/** Opens a socket with `cookie`, as the web app does, over the preview's proxy. */
export async function connectGuest(base: string, cookie: string): Promise<Guest> {
  const socket = io(base, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: { cookie },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  const ask = (event: string, body: unknown) =>
    socket.timeout(10_000).emitWithAck(event as never, body as never) as Promise<Ack>;
  return {
    cookie,
    socket,
    enter: (code) => ask("enter", { code, protocol: PROTOCOL_VERSION }),
    cmd: (type, payload) => ask("cmd", { id: `e2e-${++commandIds}`, type, payload }),
    close: () => socket.disconnect(),
  };
}

/** A new guest (sign-in as the web app does it), connected. */
export async function newGuest(base: string): Promise<Guest> {
  const response = await fetch(`${base}/api/auth/sign-in/anonymous`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", ...ownAddress() },
    body: "{}",
  });
  expect(response.status, "guest sign-in").toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${SESSION_COOKIE}=`))
    ?.split(";")[0];
  if (!cookie) throw new Error("sign-in gave no session cookie");
  return connectGuest(base, cookie);
}

/** The browser's own guest, as a socket: the same user as the page. */
export async function sameUser(base: string, context: BrowserContext): Promise<Guest> {
  const session = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
  if (!session) throw new Error("the browser has no session yet");
  return connectGuest(base, `${SESSION_COOKIE}=${session.value}`);
}

export async function createRoom(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create the room" }).click();
  await expect(page).toHaveURL(ROOM_PATH);
  return ROOM_PATH.exec(page.url())?.[1] ?? "";
}

export async function join(page: Page, name: string, role: "Voter" | "Observer" = "Voter") {
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page.getByRole("radio", { name: new RegExp(`^${role}`) }).check();
  await page.getByRole("button", { name: "Join the room" }).click();
  await expect(page.getByRole("heading", { name: "You", exact: true })).toBeVisible();
}

export const seats = (page: Page) => page.getByRole("list", { name: "People at the table" });
export const seatNames = (page: Page) => seats(page).locator("[data-seat-part=name] bdi");
export const observerRow = (page: Page) => page.getByRole("list", { name: "Observers" });

export async function newPerson(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: ownAddress() });
  return { context, page: await context.newPage() };
}

/** Screenshots at 360 and 1440 px, light and dark (the theme follows the system). */
export async function shoot(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      // The table measures its container; let it settle at the new width.
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOTS}${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** What these tests read of a snapshot; the schemas stay out of the e2e build. */
export interface Snapshot {
  version: number;
  room: { round: unknown };
  causes: { type: string }[];
}

/** Every message frame the page receives, over the websocket or long-polling. */
export function recordFrames(page: Page): string[] {
  const frames: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => frames.push(String(payload))),
  );
  page.on("response", async (response) => {
    if (!new URL(response.url()).pathname.startsWith("/socket.io/")) return;
    if (response.request().method() !== "GET") return;
    frames.push(await response.text().catch(() => ""));
  });
  return frames;
}

/** The snapshots in raw Socket.IO frames: `snapshot` events and `enter` acks. */
export function snapshotsIn(frames: readonly string[]): Snapshot[] {
  const found: Snapshot[] = [];
  const visit = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    if ("room" in value && "version" in value) found.push(value as Snapshot);
    else if ("snapshot" in value) visit((value as { snapshot: unknown }).snapshot);
  };
  for (const raw of frames) {
    // Long-polling packs several packets into one body, separated by U+001E.
    for (const frame of raw.split("\u{1e}")) {
      const start = frame.search(/[[{]/);
      if (start < 0) continue;
      try {
        const parsed: unknown = JSON.parse(frame.slice(start));
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) visit(item);
      } catch {
        // Not a JSON packet (a handshake or a ping).
      }
    }
  }
  return found;
}
