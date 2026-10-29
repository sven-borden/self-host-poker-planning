/**
 * Losing Redis never takes an instance down (#39): a stand-in Redis on a local port that
 * answers every command and drops the connection when told to. The adapter itself and two
 * real instances are covered by `sync/scale-out.db.test.ts` against a real Redis.
 */
import net from "node:net";
import { createClient } from "@redis/client";
import { afterEach, describe, expect, it } from "vitest";
import { catchFireAndForget, connectScaleOut, RedisUnavailableError } from "./scale-out.ts";
import { collectLogs } from "./test-support.ts";

interface FakeRedis {
  url: string;
  /** Drops every connection the next time one sends a PUBLISH. */
  dropOnPublish(): void;
  /** Drops every connection and refuses new ones. */
  stop(): Promise<void>;
}

const servers: FakeRedis[] = [];

/** Answers `+PONG` to a PING and `+OK` to anything else, one reply per command. */
async function fakeRedis(): Promise<FakeRedis> {
  const sockets = new Set<net.Socket>();
  let drop = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      const text = chunk.toString();
      if (drop && text.includes("PUBLISH")) {
        drop = false;
        for (const open of sockets) open.destroy();
        return;
      }
      const commands = text.match(/^\*\d+\r\n\$\d+\r\n[^\r]*/gm) ?? [];
      socket.write(
        commands.map((command) => (/PING$/i.test(command) ? "+PONG\r\n" : "+OK\r\n")).join(""),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  const fake: FakeRedis = {
    url: `redis://127.0.0.1:${port}`,
    dropOnPublish: () => {
      drop = true;
    },
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(fake);
  return fake;
}

/** Every rejection nobody handled while `run` ran, and shortly after. */
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return unhandled;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

describe("catchFireAndForget", () => {
  it("leaves no rejection unhandled when the connection drops with a publish in flight", async () => {
    const redis = await fakeRedis();
    const client = catchFireAndForget(
      createClient({ url: redis.url, RESP: 2, socket: { reconnectStrategy: () => 50 } }),
    );
    client.on("error", () => {});
    await client.connect();
    let awaited: unknown;
    const unhandled = await unhandledDuring(async () => {
      redis.dropOnPublish();
      // As the adapter does: neither awaited nor caught.
      void client.publish("pp-request#/#", "{}");
      // A caller that awaits still sees the failure.
      awaited = await client.publish("pp-request#/#", "{}").then(
        () => "published",
        () => "rejected",
      );
    });
    expect(unhandled).toEqual([]);
    expect(awaited).toBe("rejected");
    client.destroy();
  });
});

describe("connectScaleOut", () => {
  it("closes cleanly when Redis went away", async () => {
    const redis = await fakeRedis();
    const logs = collectLogs("debug");
    const scaleOut = await connectScaleOut(redis.url, logs.logger, { budgetMs: 2000 });
    expect(await scaleOut.ping()).toBe("ok");
    const unhandled = await unhandledDuring(async () => {
      await redis.stop();
      expect(await scaleOut.ping()).toBe("down");
      await scaleOut.close();
    });
    expect(unhandled).toEqual([]);
    expect(logs.messages()).toContain("redis: unavailable");
  });

  it("fails an unreachable Redis with the fixed message, and logs no URL", async () => {
    const redis = await fakeRedis();
    await redis.stop();
    const logs = collectLogs("debug");
    const url = redis.url.replace("redis://", "redis://:hunter2-hunter2@");
    await expect(connectScaleOut(url, logs.logger, { budgetMs: 300 })).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    expect(logs.messages()).toContain("redis: unavailable");
    expect(logs.raw.join("")).not.toContain("hunter2");
    expect(logs.raw.join("")).not.toContain("127.0.0.1");
  });

  it("logs no failure when the start is stopped (a signal while waiting)", async () => {
    const redis = await fakeRedis();
    await redis.stop();
    const logs = collectLogs("debug");
    const aborter = new AbortController();
    const started = connectScaleOut(redis.url, logs.logger, {
      budgetMs: 5000,
      signal: aborter.signal,
    });
    setTimeout(() => aborter.abort(), 50);
    await expect(started).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(logs.lines.filter((line) => line.level === 50)).toEqual([]);
  });
});
