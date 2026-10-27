import { fileURLToPath } from "node:url";
import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from "@playwright/test";
import pg from "pg";
import { io, type Socket } from "socket.io-client";
import { PROTOCOL_VERSION } from "../../../packages/protocol/src/version.ts";

// Shared by the specs that run against the real server and Postgres (join.spec.ts,
// presence.spec.ts, mobile.spec.ts, four-person.spec.ts, …): guests driven over the
// protocol from Node, a client address per person, the room page's common steps, phones
// (#22), the frames a page receives, and Postgres read straight (the history UI is #33).

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
    // A body the browser lost is a frame nobody scanned: packetsIn fails on it.
    frames.push(await response.text().catch(() => UNREADABLE));
  });
  return frames;
}

const UNREADABLE = "(a polling body the browser could not read)";

/**
 * Every JSON packet in raw Socket.IO frames, as parsed: an event is an array
 * (`["snapshot", {…}]`), an ack the array of its arguments (`[{ ok: true, … }]`), a
 * handshake an object. Engine.io's control packets (close, ping, pong, upgrade, noop and
 * their probes) carry nothing; any other frame that does not parse throws, so a scan of
 * these packets never skips a frame it cannot read.
 */
export function packetsIn(frames: readonly string[]): unknown[] {
  const found: unknown[] = [];
  for (const raw of frames) {
    // Long-polling packs several packets into one body, separated by U+001E.
    for (const frame of raw.split("\u{1e}")) {
      // Engine.io's type comes first: 0 open (JSON), or 4 a message, which holds a
      // Socket.IO packet (its type, a namespace, an ack id, then JSON); 1, 2, 3, 5 and 6
      // are control packets.
      const json =
        /^0(.*)$/su.exec(frame)?.[1] ?? /^4[0-6](?:\/[^,]*,)?\d*(.*)$/su.exec(frame)?.[1];
      if (json === undefined) {
        if (/^[12356](probe)?$/u.test(frame)) continue;
        // Only the start of it: a frame may hold the room code further on.
        throw new Error(`Not an engine.io packet: ${frame.slice(0, 16)}…`);
      }
      // A Socket.IO connect or disconnect without data.
      if (json === "") continue;
      try {
        found.push(JSON.parse(json));
      } catch {
        throw new Error(`A packet that is not JSON: ${frame.slice(0, 16)}…`);
      }
    }
  }
  return found;
}

/** The snapshots in raw Socket.IO frames: `snapshot` events and `enter` acks. */
export function snapshotsIn(frames: readonly string[]): Snapshot[] {
  const found: Snapshot[] = [];
  const visit = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    if ("room" in value && "version" in value) found.push(value as Snapshot);
    else if ("snapshot" in value) visit((value as { snapshot: unknown }).snapshot);
  };
  for (const parsed of packetsIn(frames)) {
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) visit(item);
  }
  return found;
}

export interface Animated {
  keyframes: string;
  duration: number;
  delay: number;
  /**
   * `cover` (a slot card's back), `up` (a slot card's face), `bar` (a results column,
   * #20), a seat's `lowest` or `highest` badge, or the element's tag.
   */
  target: string;
  /** On the viewer's own slot. */
  you: boolean;
}

/**
 * Records every `Element.animate` call on the page from now on, in `window.__animated`;
 * with `reload`, from the next page load on.
 */
export async function recordAnimations(page: Page, { reload = false } = {}) {
  const install = () => {
    const seen: unknown[] = [];
    Object.assign(window, { __animated: seen });
    const original = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const timing = typeof options === "number" ? { duration: options } : (options ?? {});
      seen.push({
        keyframes: JSON.stringify(keyframes),
        duration: Number(timing.duration ?? 0),
        delay: Number(timing.delay ?? 0),
        target: this.hasAttribute("data-cover")
          ? "cover"
          : this.hasAttribute("data-bar")
            ? "bar"
            : (this.getAttribute("data-face") ??
              this.getAttribute("data-badge") ??
              this.tagName.toLowerCase()),
        you: this.closest("[data-slot-card]")?.hasAttribute("data-you") === true,
      });
      return original.call(this, keyframes, options);
    };
  };
  if (!reload) return page.evaluate(install);
  await page.addInitScript(install);
  await page.reload();
}

export const animated = (page: Page) =>
  page.evaluate(() => (window as unknown as { __animated: Animated[] }).__animated);

type Device = "iPhone 13" | "iPhone SE" | "Pixel 7";

export interface Phone {
  context: BrowserContext;
  page: Page;
  /** Every `navigator.vibrate` pattern the page asked for. */
  vibrations: () => Promise<number[]>;
  /** Uncaught errors on the page. */
  errors: string[];
}

/**
 * A phone: a device descriptor (viewport, touch, mobile, user agent) in the configured
 * Chromium or Edge, or a bare phone-sized viewport. The iPhone has no `navigator.vibrate`,
 * as in Safari; elsewhere each call is recorded.
 */
export async function phone(
  browser: Browser,
  device: Device | { width: number; height: number },
): Promise<Phone> {
  const options =
    typeof device === "string"
      ? (({ defaultBrowserType: _, ...descriptor }) => descriptor)(devices[device])
      : { viewport: device, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const context = await browser.newContext({
    ...options,
    locale: "en-US",
    extraHTTPHeaders: ownAddress(),
  });
  const ios = typeof device === "string" && device.startsWith("iPhone");
  await context.addInitScript((noVibrate: boolean) => {
    const calls: number[] = [];
    Object.assign(window, { __vibrations: calls });
    if (noVibrate) {
      Reflect.deleteProperty(Navigator.prototype, "vibrate");
      return;
    }
    Object.defineProperty(Navigator.prototype, "vibrate", {
      configurable: true,
      value: (pattern: number | Iterable<number>) => {
        calls.push(...(typeof pattern === "number" ? [pattern] : pattern));
        return true;
      },
    });
  }, ios);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return {
    context,
    page,
    errors,
    vibrations: () =>
      page.evaluate(() => (window as unknown as { __vibrations: number[] }).__vibrations),
  };
}

/** The viewer's hand, and one card in it by its name. */
export const hand = (page: Page) => page.getByRole("toolbar", { name: "Your cards" });
export const handCard = (page: Page, label: string) =>
  hand(page).getByRole("button", { name: label, exact: true });

/** Guests who join as voters over the protocol, named in order. */
export async function guestsJoin(base: string, code: string, names: readonly string[]) {
  const guests: Guest[] = [];
  for (const name of names) {
    const guest = await newGuest(base);
    guests.push(guest);
    expect(await guest.enter(code)).toMatchObject({ ok: true });
    expect(await guest.cmd("join", { name, role: "voter" })).toMatchObject({ ok: true });
  }
  return guests;
}

/** One query against the e2e database, read straight from Postgres. */
export async function dbQuery<Row>(sql: string, params: unknown[]): Promise<Row[]> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  client.on("error", () => {});
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as Row[];
  } finally {
    await client.end();
  }
}

export interface HistoryRow {
  number: number;
  subject: unknown;
  deck: unknown;
  votes: unknown;
  stats: unknown;
  /** The whole row as JSON, to look for a name that must not be there. */
  text: string;
}

/** The room's `round_history` rows, in round order (the history UI is #33). */
export const historyOf = (code: string) =>
  dbQuery<HistoryRow>(
    `select h.number, h.subject, h.deck, h.votes, h.stats, row_to_json(h)::text as text
    from round_history h join room r on r.id = h.room_id where r.code = $1
    order by h.number`,
    [code],
  );

/** The round line over the table, and the PO's field for the next round's subject (#21). */
export const subjectLine = (page: Page) => page.locator("[data-round-subject]");
export const subjectField = (page: Page) =>
  page.getByRole("textbox", { name: "Subject of the next round" });
