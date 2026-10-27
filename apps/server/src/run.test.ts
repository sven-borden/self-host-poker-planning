import { EventEmitter } from "node:events";
import { createServer as createNetServer, type Server } from "node:net";
import { PROTOCOL_VERSION } from "@pp/protocol";
import { io as connect } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { type Crash, processHooks, run, type Signal } from "./run.ts";
import type { PokerServer } from "./server.ts";
import { collectLogs, SECRET, VALID_ENV } from "./test-support.ts";

const started: PokerServer[] = [];
afterEach(async () => {
  for (const server of started.splice(0)) await server.close();
});

function hooks(extra: { shutdownTimeoutMs?: number } = {}) {
  const logs = collectLogs();
  const exits: number[] = [];
  let signal: ((signal: Signal) => void) | undefined;
  let crash: ((crash: Crash, error: unknown) => void) | undefined;
  let exited: (code: number) => void = () => {};
  const exitCode = new Promise<number>((resolve) => {
    exited = resolve;
  });
  return {
    logs,
    exits,
    exitCode,
    send: (name: Signal) => signal?.(name),
    crash: (name: Crash, error: unknown) => crash?.(name, error),
    hooks: {
      destination: logs.destination,
      exit: (code: number) => {
        exits.push(code);
        exited(code);
      },
      onSignal: (handler: (signal: Signal) => void) => {
        signal = handler;
      },
      onCrash: (handler: (crash: Crash, error: unknown) => void) => {
        crash = handler;
      },
      ...extra,
    },
  };
}

describe("run", () => {
  it("stops with one log line and exit code 1 when DATABASE_URL is missing", async () => {
    const h = hooks();
    expect(await run({ BASE_URL: VALID_ENV.BASE_URL, BETTER_AUTH_SECRET: VALID_ENV.BETTER_AUTH_SECRET }, h.hooks)).toBeUndefined();
    expect(h.exits).toEqual([1]);
    expect(h.logs.raw).toHaveLength(1);
    expect(h.logs.raw[0]?.trimEnd()).not.toMatch(/\n/);
    expect(h.logs.lines[0]).toMatchObject({
      level: 60,
      variables: ["DATABASE_URL"],
      msg: "Invalid configuration: DATABASE_URL is required. See .env.example.",
    });
  });

  it("never logs the value of a bad variable", async () => {
    const h = hooks();
    await run({ ...VALID_ENV, DATABASE_URL: `mysql://root:${SECRET}@db/pp` }, h.hooks);
    expect(h.exits).toEqual([1]);
    expect(h.logs.raw.join("")).not.toContain(SECRET);
  });

  it("exits 1 with one line when the port is taken", async () => {
    const blocker: Server = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const address = blocker.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const h = hooks();
      let disposed = 0;
      const setup = async () => ({
        dispose: async () => {
          disposed += 1;
        },
      });
      expect(
        await run({ ...VALID_ENV, PORT: String(port) }, { ...h.hooks, setup }),
      ).toBeUndefined();
      expect(h.exits).toEqual([1]);
      expect(h.logs.messages()).toContain("cannot listen");
      expect(disposed).toBe(1);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("listens, then on SIGTERM closes a connected socket and exits 0", async () => {
    const h = hooks();
    const server = await run(
      { ...VALID_ENV, PORT: "0", GIT_COMMIT: "abc1234", STATIC_DIR: "no-such-dir" },
      h.hooks,
    );
    if (!server) throw new Error("server did not start");
    started.push(server);
    const address = server.httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    expect(h.logs.lines.find((line) => line.msg === "listening")).toMatchObject({
      port,
      commit: "abc1234",
      version: "dev",
    });
    expect(h.logs.messages()).toContain("web app not built: serving the API only");

    const health = await fetch(`http://localhost:${port}/api/health`);
    expect(await health.json()).toMatchObject({ status: "ok", commit: "abc1234" });

    const socket = connect(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
    });
    await new Promise((resolve) => socket.once("connect", () => resolve(undefined)));
    expect(await socket.emitWithAck("enter", { code: "x", protocol: PROTOCOL_VERSION })).toEqual({
      ok: false,
      code: "room_not_found",
    });
    const disconnected = new Promise((resolve) => socket.once("disconnect", resolve));

    h.send("SIGTERM");
    h.send("SIGINT");
    expect(await h.exitCode).toBe(0);
    expect(await disconnected).toBe("transport close");
    expect(h.exits).toEqual([0]);
    const shutdown = h.logs.messages().filter((msg) => msg.startsWith("shutdown:"));
    expect(shutdown).toEqual([
      "shutdown: started",
      "shutdown: stopped accepting connections",
      "shutdown: sockets disconnected",
      "shutdown: already in progress",
      "shutdown: http server closed",
      "shutdown: done",
    ]);
  });

  it("cuts a hanging request before the shutdown deadline and still exits 0", async () => {
    const h = hooks({ shutdownTimeoutMs: 2300 });
    const server = await run(
      { ...VALID_ENV, PORT: "0" },
      {
        ...h.hooks,
        setup: async () => ({
          deps: {
            registerApi: (api) => api.get("/api/hang", () => new Promise<Response>(() => {})),
          },
        }),
      },
    );
    if (!server) throw new Error("server did not start");
    started.push(server);
    const address = server.httpServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const hanging = fetch(`http://localhost:${port}/api/hang`).catch(() => "cut");
    // Let the request reach the server before the signal.
    await new Promise((resolve) => setTimeout(resolve, 100));

    h.send("SIGTERM");
    expect(await h.exitCode).toBe(0);
    expect(await hanging).toBe("cut");
    expect(h.logs.messages()).toContain("shutdown: closing the remaining connections");
  });

  it("logs one fatal line and exits 1 on an uncaught exception or an unhandled rejection", async () => {
    for (const crash of ["uncaughtException", "unhandledRejection"] as const) {
      const h = hooks();
      const server = await run({ ...VALID_ENV, PORT: "0" }, h.hooks);
      if (!server) throw new Error("server did not start");
      started.push(server);
      h.crash(crash, new Error(`boom ${crash}`));
      expect(h.exits).toEqual([1]);
      const fatal = h.logs.lines.filter((line) => line.level === 60);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]).toMatchObject({ msg: "crashed", crash, err: { message: `boom ${crash}` } });
    }
  });
});

describe("run with setup", () => {
  it("awaits setup before listening, then on a signal closes, disposes and exits", async () => {
    const h = hooks();
    const events: string[] = [];
    let server: PokerServer | undefined;
    server = await run(
      { ...VALID_ENV, PORT: "0" },
      {
        ...h.hooks,
        setup: async (config, logger) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const listening = h.logs.messages().includes("listening");
          events.push(`setup ${config.baseUrl}, listening logged: ${listening}`);
          logger.info("migrated");
          return {
            deps: { checkDb: async () => "ok" },
            dispose: async () => {
              const open = server?.httpServer.listening;
              events.push(`dispose, listening: ${open}, exits: ${h.exits.length}`);
            },
          };
        },
      },
    );
    if (!server) throw new Error("server did not start");
    started.push(server);
    const messages = h.logs.messages();
    expect(messages.indexOf("migrated")).toBeLessThan(messages.indexOf("listening"));
    const { port } = server.httpServer.address() as { port: number };
    expect(await (await fetch(`http://localhost:${port}/api/health`)).json()).toMatchObject({
      db: "ok",
    });

    h.send("SIGTERM");
    expect(await h.exitCode).toBe(0);
    expect(events).toEqual([
      "setup http://localhost:3000, listening logged: false",
      "dispose, listening: false, exits: 0",
    ]);
    const shutdown = h.logs.messages().filter((msg) => msg.startsWith("shutdown:"));
    expect(shutdown.slice(-3)).toEqual([
      "shutdown: http server closed",
      "shutdown: resources released",
      "shutdown: done",
    ]);
  });

  it("exits 1 with one fatal line and never listens when setup fails", async () => {
    const h = hooks();
    const setup = () => Promise.reject(new Error("migration failed"));
    expect(await run({ ...VALID_ENV, PORT: "0" }, { ...h.hooks, setup })).toBeUndefined();
    expect(h.exits).toEqual([1]);
    const fatal = h.logs.lines.filter((line) => line.level === 60);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ msg: "setup failed", err: { message: "migration failed" } });
    expect(h.logs.messages()).not.toContain("listening");
  });

  it("still exits within the shutdown limit when dispose hangs", async () => {
    const h = hooks({ shutdownTimeoutMs: 2100 });
    const server = await run(
      { ...VALID_ENV, PORT: "0" },
      { ...h.hooks, setup: async () => ({ dispose: () => new Promise<void>(() => {}) }) },
    );
    if (!server) throw new Error("server did not start");
    started.push(server);
    const begun = performance.now();
    h.send("SIGTERM");
    expect(await h.exitCode).toBe(1);
    expect(performance.now() - begun).toBeLessThan(3000);
    expect(h.logs.messages()).toContain("shutdown: timed out");
  });
});

describe("a signal while starting", () => {
  /** A setup that waits until aborted, then rejects as a database wait would. */
  const abortable = (_config: unknown, _logger: unknown, signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

  it("aborts setup, logs one line and exits 0 without listening", async () => {
    const h = hooks();
    let entered = false;
    const starting = run(
      { ...VALID_ENV, PORT: "0" },
      {
        ...h.hooks,
        setup: (config, logger, signal) => {
          entered = true;
          return abortable(config, logger, signal);
        },
      },
    );
    await expect.poll(() => entered).toBe(true);
    const before = h.logs.lines.length;
    h.send("SIGTERM");
    expect(await starting).toBeUndefined();
    expect(h.exits).toEqual([0]);
    expect(h.logs.lines.slice(before)).toEqual([
      expect.objectContaining({ level: 30, msg: "shutdown: stopped while starting" }),
    ]);
  });

  it("disposes what a setup opened when it finished despite the signal, then exits 0", async () => {
    const h = hooks();
    const events: string[] = [];
    let finish: () => void = () => {};
    const starting = run(
      { ...VALID_ENV, PORT: "0" },
      {
        ...h.hooks,
        setup: () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({
                dispose: async () => {
                  events.push("disposed");
                },
              });
          }),
      },
    );
    // run() calls setup synchronously, so `finish` is set by now.
    h.send("SIGINT");
    finish();
    expect(await starting).toBeUndefined();
    expect(events).toEqual(["disposed"]);
    expect(h.exits).toEqual([0]);
    expect(h.logs.messages()).not.toContain("listening");
  });

  it("still exits within the shutdown limit when setup ignores the signal", async () => {
    const h = hooks({ shutdownTimeoutMs: 300 });
    void run({ ...VALID_ENV, PORT: "0" }, { ...h.hooks, setup: () => new Promise(() => {}) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.send("SIGTERM");
    expect(await h.exitCode).toBe(1);
    expect(h.logs.messages()).toContain("shutdown: timed out");
  });
});

describe("processHooks", () => {
  it("wires exit, both signals and both crash events to the process", () => {
    const exits: number[] = [];
    const proc = Object.assign(new EventEmitter(), { exit: (code: number) => exits.push(code) });
    const hooks = processHooks(proc);
    const seen: unknown[] = [];
    hooks.onSignal((signal) => seen.push(signal));
    hooks.onCrash((crash, error) => seen.push([crash, error]));
    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    proc.emit("uncaughtException", "e1");
    proc.emit("unhandledRejection", "r1");
    hooks.exit(3);
    expect(seen).toEqual([
      "SIGTERM",
      "SIGINT",
      ["uncaughtException", "e1"],
      ["unhandledRejection", "r1"],
    ]);
    expect(exits).toEqual([3]);
  });
});
