import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  type ClientToServerEvents,
  cmdAckSchema,
  enterAckSchema,
  PROTOCOL_VERSION,
  type ServerToClientEvents,
} from "@pp/protocol";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECT_TIMEOUT_MS,
  hasCookie,
  MAX_PAYLOAD_BYTES,
  MAX_SOCKETS_PER_USER,
  type SocketMiddleware,
} from "./realtime.ts";
import { createServer, type PokerServer, type ServerDeps } from "./server.ts";
import { HISTORY_LIMIT, ROSTER_LIMIT } from "./sync/token-bucket.ts";
import { collectLogs, type LogCollector, testConfig } from "./test-support.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
/** The same socket without the event map, to send what a broken or hostile client would. */
type RawClient = {
  emit(event: string, ...args: unknown[]): void;
  emitWithAck(event: string, ...args: unknown[]): Promise<unknown>;
};

const open: { server: PokerServer; clients: Client[] }[] = [];

afterEach(async () => {
  for (const { server, clients } of open.splice(0)) {
    for (const client of clients) client.disconnect();
    await server.close();
  }
});

async function start(deps: Partial<ServerDeps> = {}): Promise<{
  server: PokerServer;
  logs: LogCollector;
  port: number;
  client: (transports?: string[], extraHeaders?: Record<string, string>) => Client;
}> {
  const logs = collectLogs();
  const server = createServer(testConfig(), { logger: logs.logger, ...deps });
  const { port } = await server.listen();
  const entry = { server, clients: [] as Client[] };
  open.push(entry);
  const client = (transports = ["websocket"], extraHeaders: Record<string, string> = {}) => {
    const socket: Client = connect(`http://localhost:${port}`, {
      transports,
      reconnection: false,
      forceNew: true,
      extraHeaders,
    });
    entry.clients.push(socket);
    return socket;
  };
  return { server, logs, port, client };
}

/**
 * Sends a bare Engine.IO handshake, as a hostile page's browser would, and resolves with
 * the HTTP status: 101 for an accepted WebSocket upgrade, 200 for an accepted poll.
 */
function handshake(
  port: number,
  transport: "polling" | "websocket",
  origin: string | undefined,
  extra: Record<string, string> = {},
): Promise<number> {
  const headers: Record<string, string> = origin === undefined ? { ...extra } : { origin, ...extra };
  if (transport === "websocket") {
    Object.assign(headers, {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": randomBytes(16).toString("base64"),
    });
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "localhost",
      port,
      path: `/socket.io/?EIO=4&transport=${transport}`,
      headers,
      agent: false,
    });
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

/**
 * A bare Engine.IO WebSocket, as a script would hold one open: it never answers a ping.
 * `closed` resolves when the server closed it, `opened` with whether the upgrade passed.
 */
function bareSocket(port: number, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://localhost:${port}/socket.io/?EIO=4&transport=websocket`, {
    headers,
  } as unknown as string[]);
  const messages: string[] = [];
  ws.addEventListener("message", (event) => messages.push(String(event.data)));
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true));
    ws.addEventListener("error", () => resolve(false));
  });
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
  return { ws, messages, opened, closed };
}

/** Resolves with the milliseconds `promise` took, or rejects after `limitMs`. */
async function within(promise: Promise<unknown>, limitMs: number): Promise<number> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`not within ${limitMs} ms`)), limitMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return Date.now() - start;
}

function connected(socket: Client): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
}

const raw = (socket: Client) => socket as unknown as RawClient;
const ENTER = { code: "AbCdEf1234", protocol: PROTOCOL_VERSION };

describe("Socket.IO", () => {
  it("answers enter with a typed room_not_found ack", async () => {
    const { client, logs } = await start();
    const socket = client();
    await connected(socket);
    const ack = enterAckSchema.parse(await socket.emitWithAck("enter", ENTER));
    expect(ack).toEqual({ ok: false, code: "room_not_found" });
    const connectedLine = logs.lines.find((line) => line.msg === "socket connected");
    expect(connectedLine).toMatchObject({ transport: "websocket" });
    expect(connectedLine?.conn).toMatch(/^[\w-]{8}$/);
  });

  it("works over long-polling too", async () => {
    const { client } = await start();
    const socket = client(["polling"]);
    await connected(socket);
    expect(await socket.emitWithAck("enter", ENTER)).toEqual({
      ok: false,
      code: "room_not_found",
    });
  });

  it("answers protocol_mismatch to another protocol version", async () => {
    const { client } = await start();
    const socket = client();
    await connected(socket);
    expect(await raw(socket).emitWithAck("enter", { code: "x", protocol: 999 })).toEqual({
      ok: false,
      code: "protocol_mismatch",
    });
  });

  it("answers bad_payload to junk on enter and cmd", async () => {
    const { client } = await start();
    const socket = client();
    await connected(socket);
    for (const junk of [
      null,
      "enter",
      42,
      [],
      { code: 1, protocol: PROTOCOL_VERSION },
      { ...ENTER, extra: true },
    ]) {
      expect(await raw(socket).emitWithAck("enter", junk), JSON.stringify(junk)).toEqual({
        ok: false,
        code: "bad_payload",
      });
    }
    for (const junk of [null, { id: "c1" }, { id: "has space", type: "reveal" }]) {
      const ack = cmdAckSchema.parse(await raw(socket).emitWithAck("cmd", junk));
      expect(ack, JSON.stringify(junk)).toEqual({ ok: false, code: "bad_payload" });
    }
  });

  it("parses a well-formed cmd and answers room_not_found", async () => {
    const { client } = await start();
    const socket = client();
    await connected(socket);
    const ack = cmdAckSchema.parse(await socket.emitWithAck("cmd", { id: "c-1", type: "reveal" }));
    expect(ack).toEqual({ ok: false, code: "room_not_found" });
  });

  it("survives a message without an ack, or with only an ack", async () => {
    const { client } = await start();
    const socket = client();
    await connected(socket);
    raw(socket).emit("enter", ENTER);
    raw(socket).emit("cmd");
    raw(socket).emit("enter", ENTER, "not a function");
    expect(await raw(socket).emitWithAck("enter")).toEqual({ ok: false, code: "bad_payload" });
    expect(await socket.emitWithAck("enter", ENTER)).toEqual({ ok: false, code: "room_not_found" });
    expect(socket.connected).toBe(true);
  });

  it("hands parsed messages to the handlers and answers internal when one throws", async () => {
    const seen: unknown[] = [];
    const { client, logs } = await start({
      handlers: {
        enter: (_socket, enter) => {
          seen.push(enter);
          throw new Error("handler bug");
        },
        cmd: async (_socket, id, command) => {
          seen.push({ id, command });
          return { ok: true, version: 7 };
        },
      },
    });
    const socket = client();
    await connected(socket);
    expect(await socket.emitWithAck("enter", ENTER)).toEqual({ ok: false, code: "internal" });
    expect(await socket.emitWithAck("cmd", { id: "c-2", type: "reveal", payload: {} })).toEqual({
      ok: true,
      version: 7,
    });
    expect(seen).toEqual([ENTER, { id: "c-2", command: { type: "reveal" } }]);
    expect(logs.messages()).toContain("message handler failed");
  });

  it("runs the handshake middleware after setting the connection id", async () => {
    const conns: string[] = [];
    const { client } = await start({
      socketMiddleware: [
        (socket, next) => {
          conns.push(socket.data.conn);
          next(new Error("unauthenticated"));
        },
      ],
    });
    const socket = client();
    await expect(connected(socket)).rejects.toThrow("unauthenticated");
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatch(/^[\w-]{8}$/);
  });

  it("refuses with internal, logs one line and keeps running when a middleware throws or rejects", async () => {
    // The first handshake meets a rejecting async middleware, the second a throwing one.
    let handshakes = 0;
    const { client, logs } = await start({
      socketMiddleware: [
        async (_socket, next) => {
          handshakes += 1;
          if (handshakes === 1) throw new Error("db down");
          next();
        },
        (_socket, next) => {
          if (handshakes === 2) throw new Error("bug");
          next();
        },
      ],
    });
    for (const failure of ["rejects", "throws"]) {
      await expect(connected(client()), failure).rejects.toThrow("internal");
    }
    const failed = logs.lines.filter((line) => line.msg === "socket middleware failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ level: 50, err: { message: "db down" } });
    expect(failed[0]?.conn).toMatch(/^[\w-]{8}$/);
    const ok = client();
    await connected(ok);
    expect(await ok.emitWithAck("enter", ENTER)).toEqual({ ok: false, code: "room_not_found" });
  });

  it("drops a connection whose message exceeds the payload cap", async () => {
    const { client } = await start();
    const socket = client();
    await connected(socket);
    const closed = new Promise<string>((resolve) => socket.once("disconnect", resolve));
    raw(socket).emit("enter", { code: "x".repeat(MAX_PAYLOAD_BYTES), protocol: PROTOCOL_VERSION });
    expect(await closed).toBe("transport close");
  });
});

/** Every handshake is the same person, as many tabs of one session would be. */
const samePerson: SocketMiddleware = (socket, next) => {
  socket.data.user = { id: "u1", name: "", isAnonymous: true };
  next();
};
const CMD = { id: "c1", type: "reveal" };

describe("limits per person", () => {
  it(`holds at most ${MAX_SOCKETS_PER_USER} sockets of one person and refuses the next with rate_limited`, async () => {
    const { client } = await start({ socketMiddleware: [samePerson] });
    const sockets = Array.from({ length: MAX_SOCKETS_PER_USER }, () => client());
    await Promise.all(sockets.map(connected));
    const extra = client();
    await expect(connected(extra)).rejects.toThrow("rate_limited");
    // A closed socket frees its place.
    const gone = new Promise((resolve) => setTimeout(resolve, 50));
    sockets[0]?.disconnect();
    await gone;
    await connected(client());
  });

  it("shares one message bucket between the sockets of one person", async () => {
    const { client } = await start({
      socketMiddleware: [samePerson],
      handlers: {
        enter: () => ({ ok: false, code: "room_not_found" }),
        cmd: () => ({ ok: true, version: 1 }),
      },
    });
    const sockets = [client(), client()];
    await Promise.all(sockets.map(connected));
    const acks = await Promise.all(
      sockets.flatMap((socket) =>
        Array.from({ length: 20 }, () => raw(socket).emitWithAck("cmd", CMD)),
      ),
    );
    const ok = acks.filter((ack) => cmdAckSchema.parse(ack).ok).length;
    // A burst of 20 for both together, and what refills meanwhile.
    expect(ok).toBeGreaterThanOrEqual(20);
    expect(ok).toBeLessThanOrEqual(22);
  });

  it(`limits roster commands to a burst of ${ROSTER_LIMIT.burst}, other commands unaffected`, async () => {
    const { client } = await start({
      socketMiddleware: [samePerson],
      handlers: {
        enter: () => ({ ok: false, code: "room_not_found" }),
        cmd: () => ({ ok: true, version: 1 }),
      },
    });
    const sockets = [client(), client()];
    await Promise.all(sockets.map(connected));
    const roster = [
      { type: "join", payload: { name: "Ada", role: "voter" } },
      { type: "rename", payload: { name: "Ada L." } },
      { type: "setRole", payload: { role: "observer" } },
      { type: "leave" },
    ];
    const acks = [];
    for (let n = 0; n < 12; n++) {
      const command = roster[n % roster.length];
      const socket = sockets[n % 2] as Client;
      acks.push(
        cmdAckSchema.parse(await raw(socket).emitWithAck("cmd", { id: `r${n}`, ...command })),
      );
    }
    expect(acks.slice(0, ROSTER_LIMIT.burst).every((ack) => ack.ok)).toBe(true);
    expect(acks.slice(ROSTER_LIMIT.burst)).toEqual([
      { ok: false, code: "rate_limited" },
      { ok: false, code: "rate_limited" },
    ]);
    // A refused payload costs no roster token, and the round's commands still pass.
    expect(await raw(sockets[0] as Client).emitWithAck("cmd", CMD)).toEqual({
      ok: true,
      version: 1,
    });
  });

  it(`limits history requests to a burst of ${HISTORY_LIMIT.burst}`, async () => {
    const { client } = await start({
      socketMiddleware: [samePerson],
      handlers: {
        enter: () => ({ ok: false, code: "room_not_found" }),
        cmd: () => ({ ok: true, version: 1 }),
        history: () => ({ ok: true, rounds: [] }),
      },
    });
    const socket = client();
    await connected(socket);
    // Malformed requests cost no history token.
    expect(await raw(socket).emitWithAck("history", { before: 2 ** 31 })).toEqual({
      ok: false,
      code: "bad_payload",
    });
    const acks = await Promise.all(
      Array.from({ length: 14 }, () => raw(socket).emitWithAck("history", {})),
    );
    const ok = acks.filter((ack) => (ack as { ok: boolean }).ok).length;
    expect(ok).toBeGreaterThanOrEqual(HISTORY_LIMIT.burst);
    expect(ok).toBeLessThanOrEqual(HISTORY_LIMIT.burst + 1);
  });
});

describe("the Origin check", () => {
  // testConfig() sets BASE_URL=http://localhost:3000; the server listens elsewhere, which
  // does not matter: the rule compares the Origin header with BASE_URL's origin.
  const SAME = "http://localhost:3000";

  it("refuses a foreign Origin on both transports", async () => {
    const { port } = await start();
    for (const transport of ["websocket", "polling"] as const) {
      for (const origin of ["https://evil.example", "http://localhost:3001", "null"]) {
        const status = await handshake(port, transport, origin);
        expect(status, `${transport} ${origin}`).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it("accepts BASE_URL's origin and a handshake without Origin on both transports", async () => {
    const { port } = await start();
    expect(await handshake(port, "websocket", SAME)).toBe(101);
    expect(await handshake(port, "polling", SAME)).toBe(200);
    expect(await handshake(port, "websocket", undefined)).toBe(101);
    expect(await handshake(port, "polling", undefined)).toBe(200);
  });

  it("lets a same-origin client through to an ack and stops a foreign one", async () => {
    const { client } = await start();
    const same = client(["websocket"], { origin: SAME });
    await connected(same);
    expect(await same.emitWithAck("enter", ENTER)).toEqual({ ok: false, code: "room_not_found" });
    const foreign = client(["websocket"], { origin: "https://evil.example" });
    await expect(connected(foreign)).rejects.toThrow();
  });
});

describe("connections that are nobody's (#36)", () => {
  const COOKIE = "pp.session_token";
  const refuse: SocketMiddleware = (_socket, next) => next(new Error("unauthenticated"));

  it("reads the cookie's name, not a value or a longer name", () => {
    expect(hasCookie(`a=1; ${COOKIE}=x.y`, COOKIE)).toBe(true);
    expect(hasCookie(`${COOKIE}=`, COOKIE)).toBe(true);
    expect(hasCookie(`x${COOKIE}=1; a=${COOKIE}=2`, COOKIE)).toBe(false);
    expect(hasCookie(`${COOKIE}_data=1`, COOKIE)).toBe(false);
    expect(hasCookie(undefined, COOKIE)).toBe(false);
  });

  it("refuses a handshake without the session cookie before the upgrade, on both transports", async () => {
    const { port, server } = await start({ sessionCookie: COOKIE });
    expect(await handshake(port, "websocket", undefined)).toBe(400);
    expect(await handshake(port, "polling", undefined)).toBe(403);
    expect(await handshake(port, "polling", undefined, { cookie: "other=1" })).toBe(403);
    expect(await handshake(port, "websocket", undefined, { cookie: `${COOKIE}=x` })).toBe(101);
    // The Origin check still comes first.
    expect(
      await handshake(port, "polling", "https://evil.example", { cookie: `${COOKIE}=x` }),
    ).toBe(403);
    expect(server.io.engine.clientsCount).toBe(0);
  });

  it("closes the connection as soon as the session middleware refused its socket", async () => {
    const { port, server } = await start({ sessionCookie: COOKIE, socketMiddleware: [refuse] });
    const bare = bareSocket(port, { cookie: `${COOKIE}=junk` });
    expect(await bare.opened).toBe(true);
    bare.ws.send("40");
    expect(await within(bare.closed, 1_000)).toBeLessThan(1_000);
    expect(bare.messages.some((m) => m.startsWith("44") && m.includes("unauthenticated"))).toBe(
      true,
    );
    expect(server.io.engine.clientsCount).toBe(0);
  });

  it("closes a connection that never asks for a socket after CONNECT_TIMEOUT_MS", async () => {
    expect(CONNECT_TIMEOUT_MS).toBe(5_000);
    const { port, server } = await start();
    const bare = bareSocket(port);
    expect(await bare.opened).toBe(true);
    expect(server.io.engine.clientsCount).toBe(1);
    const took = await within(bare.closed, CONNECT_TIMEOUT_MS + 1_000);
    expect(took).toBeGreaterThan(CONNECT_TIMEOUT_MS - 1_000);
    expect(server.io.engine.clientsCount).toBe(0);
  }, 10_000);
});

describe("shutdown", () => {
  it("disconnects a connected socket and closes the HTTP server", async () => {
    const { server, client, logs } = await start();
    const socket = client();
    await connected(socket);
    const disconnected = new Promise<string>((resolve) => socket.once("disconnect", resolve));
    await server.close();
    expect(await disconnected).toBe("transport close");
    expect(server.httpServer.listening).toBe(false);
    expect(logs.messages()).toEqual(
      expect.arrayContaining([
        "shutdown: stopped accepting connections",
        "shutdown: socket messages answered",
        "shutdown: sockets disconnected",
        "shutdown: http server closed",
      ]),
    );
    expect(logs.lines.find((line) => line.msg === "shutdown: sockets disconnected")).toMatchObject({
      sockets: 1,
    });
    // close() is idempotent: afterEach calls it again.
    await server.close();
  });

  it("logs each phase when it happens, while a request is still open", async () => {
    let reached: () => void = () => {};
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { server, port, client, logs } = await start({
      registerApi: (api) =>
        api.get("/api/stall", async (c) => {
          reached();
          await released;
          return c.text("done");
        }),
    });
    const socket = client();
    await connected(socket);
    const disconnected = new Promise<string>((resolve) => socket.once("disconnect", resolve));
    const stalled = fetch(`http://localhost:${port}/api/stall`).then((r) => r.text());
    await arrived;

    const closed = server.close();
    expect(await disconnected).toBe("transport close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const phases = () => logs.messages().filter((msg) => msg.startsWith("shutdown:"));
    expect(phases()).toEqual([
      "shutdown: stopped accepting connections",
      "shutdown: socket messages answered",
      "shutdown: sockets disconnected",
    ]);

    release();
    expect(await stalled).toBe("done");
    await closed;
    expect(phases().at(-1)).toBe("shutdown: http server closed");
  });

  it("answers the commands it took before closing the sockets, and takes no new one", async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { server, client } = await start({
      handlers: {
        enter: () => ({ ok: false, code: "room_not_found" }),
        cmd: async () => {
          started();
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { ok: true, version: 7 };
        },
      },
    });
    const socket = client();
    await connected(socket);
    const taken = raw(socket).emitWithAck("cmd", CMD);
    await running;
    const closed = server.close();
    // Sent during the drain: dropped, so the client sends it again after reconnecting.
    const late = socket.timeout(2000).emitWithAck("cmd", { ...CMD, id: "c2" } as never);
    expect(cmdAckSchema.parse(await taken)).toEqual({ ok: true, version: 7 });
    await expect(late).rejects.toThrow();
    await closed;
  });
});
