import { createServer as createNetServer, type Server } from "node:net";
import { PROTOCOL_VERSION } from "@pp/protocol";
import { io as connect } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { run, type Signal } from "./run.ts";
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
  let exited: (code: number) => void = () => {};
  const exitCode = new Promise<number>((resolve) => {
    exited = resolve;
  });
  return {
    logs,
    exits,
    exitCode,
    send: (name: Signal) => signal?.(name),
    hooks: {
      destination: logs.destination,
      exit: (code: number) => {
        exits.push(code);
        exited(code);
      },
      onSignal: (handler: (signal: Signal) => void) => {
        signal = handler;
      },
      ...extra,
    },
  };
}

describe("run", () => {
  it("stops with one log line and exit code 1 when DATABASE_URL is missing", async () => {
    const h = hooks();
    expect(await run({ BASE_URL: VALID_ENV.BASE_URL }, h.hooks)).toBeUndefined();
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
      expect(await run({ ...VALID_ENV, PORT: String(port) }, h.hooks)).toBeUndefined();
      expect(h.exits).toEqual([1]);
      expect(h.logs.messages()).toContain("cannot listen");
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
      "shutdown: already in progress",
      "shutdown: socket.io closed",
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
        deps: {
          registerApi: (api) => api.get("/api/hang", () => new Promise<Response>(() => {})),
        },
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
});
