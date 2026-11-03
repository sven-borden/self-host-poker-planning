import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  ACK_CLAIM_MS,
  ACK_KEEP_MS,
  type AckCommands,
  redisAcks,
  sharedAckKey,
  within,
} from "./shared-acks.ts";

/** A Redis stand-in for SET (NX, PX), GET and DEL, recording each call's options. */
function fakeRedis() {
  const values = new Map<string, string>();
  const ttls: number[] = [];
  const redis: AckCommands & { values: typeof values; ttls: number[] } = {
    values,
    ttls,
    set: async (key, value, options) => {
      if (options.condition === "NX" && values.has(key)) return null;
      values.set(key, value);
      ttls.push(options.expiration.value);
      return "OK";
    },
    get: async (key) => values.get(key) ?? null,
    del: async (key) => (values.delete(key) ? 1 : 0),
  };
  return redis;
}

describe("redisAcks (#39)", () => {
  it("lets the first claim run, answers running meanwhile, then the stored answer", async () => {
    const redis = fakeRedis();
    const acks = redisAcks(redis);
    const key = sharedAckKey("user-1", "room-1", "c1");
    expect(await acks.claim(key)).toEqual({ state: "mine" });
    // The key #39 wrote, with the default prefix: a rolling deploy keeps reading it (U4).
    expect([...redis.values.keys()]).toEqual(["pp:ack:user-1 room-1 c1"]);
    expect(await acks.claim(key)).toEqual({ state: "running" });
    await acks.settle(key, { ok: true, version: 7 });
    expect(await acks.claim(key)).toEqual({ state: "done", ack: { ok: true, version: 7 } });
    expect(redis.ttls).toEqual([ACK_CLAIM_MS, ACK_KEEP_MS]);
  });

  it("puts every key under the deployment's own prefix (U4)", async () => {
    const redis = fakeRedis();
    const acks = redisAcks(redis, "staging");
    await acks.claim("u r c");
    await acks.settle("u r c", { ok: true, version: 1 });
    await acks.claim("u r d");
    await acks.settle("u r d", null);
    expect([...redis.values.keys()]).toEqual(["staging:ack:u r c"]);
  });

  it("lets a released claim run again", async () => {
    const acks = redisAcks(fakeRedis());
    expect(await acks.claim("k")).toEqual({ state: "mine" });
    await acks.settle("k", null);
    expect(await acks.claim("k")).toEqual({ state: "mine" });
  });

  it("takes an unreadable value for a command still running, never for an answer", async () => {
    const redis = fakeRedis();
    redis.values.set("pp:ack:k", "{not json");
    redis.values.set("pp:ack:j", JSON.stringify({ ok: "yes" }));
    const acks = redisAcks(redis);
    expect(await acks.claim("k")).toEqual({ state: "running" });
    expect(await acks.claim("j")).toEqual({ state: "running" });
  });

  it("claims again when the key expired between its SET and its GET", async () => {
    const redis = fakeRedis();
    let first = true;
    const racing: AckCommands = {
      ...redis,
      set: async (key, value, options) => {
        if (first) {
          first = false;
          return null;
        }
        return redis.set(key, value, options);
      },
    };
    expect(await redisAcks(racing).claim("k")).toEqual({ state: "mine" });
  });

  it("rejects when Redis does not answer in time, so the caller falls back", async () => {
    const hung: AckCommands = {
      set: () => new Promise(() => {}),
      get: () => new Promise(() => {}),
      del: () => new Promise(() => {}),
    };
    await expect(redisAcks(hung, "pp", 20).claim("k")).rejects.toThrow("timeout");
    await expect(within(Promise.resolve(3), 20)).resolves.toBe(3);
  });

  it("takes an answer that came while this process's own loop was blocked past the timeout", async () => {
    // The other side answered in time, but this loop was busy: when it wakes, Node runs the
    // timers before it reads the socket, so the timeout must wait for the read.
    let received: () => void = () => {};
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", () => {
        socket.write("pong");
        received();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const client = net.connect(port, "127.0.0.1");
    client.on("error", () => {});
    await new Promise<void>((resolve) => client.once("connect", resolve));
    try {
      for (let turn = 0; turn < 3; turn++) {
        const reply = new Promise<string>((resolve) =>
          client.once("data", (data) => resolve(String(data))),
        );
        const answer = within(reply, 20).catch((error: Error) => error.message);
        const got = new Promise<void>((resolve) => {
          received = resolve;
        });
        client.write("ping");
        await got;
        // The answer is on its way; block this loop past the timeout.
        const until = Date.now() + 100;
        while (Date.now() < until) {
          // Busy, as in a long GC or a heavy request.
        }
        expect(await answer, `turn ${turn}`).toBe("pong");
      }
    } finally {
      client.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
