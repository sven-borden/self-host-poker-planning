import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, REQUEST_FAILED } from "./logger.ts";
import { type SendEnvelope, startReports } from "./sentry.ts";
import { SECRET } from "./test-support.ts";

const DSN = "https://0123abcd@sentry.example.com/42";

interface Sent {
  url: string;
  headers: Record<string, string> | undefined;
  items: Record<string, unknown>[];
}

/** Reports to a fake Sentry: every envelope's items, parsed. */
function reporting(send?: SendEnvelope) {
  const sent: Sent[] = [];
  const fake: SendEnvelope = async (url, request, headers) => {
    const body =
      typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body);
    const lines = body.split("\n").filter((line) => line !== "");
    sent.push({ url, headers, items: lines.map((line) => JSON.parse(line)) });
    return { statusCode: 200 };
  };
  const reports = startReports({ dsn: DSN, release: "0a14f15", send: send ?? fake });
  const raw: string[] = [];
  const logger = createLogger("debug", { write: (line) => raw.push(line) }, reports.write);
  /** The events sent once the reports are flushed. */
  const events = async () => {
    await reports.flush(2000);
    return sent.flatMap((envelope) =>
      envelope.items.filter((item) => "event_id" in item && "level" in item),
    );
  };
  return { reports, logger, raw, sent, events };
}

afterEach(() => vi.restoreAllMocks());

describe("error reports (#40)", () => {
  it("sends an error line with its exception, frames, message and fields", async () => {
    const { logger, raw, sent, events } = reporting();
    const error = new TypeError("cannot read the room");
    logger
      .child({ requestId: "req-1" })
      .error({ err: error, event: "cmd" }, "message handler failed");
    const [event] = await events();
    expect(raw).toHaveLength(1);
    expect(sent[0]?.url).toBe(
      "https://sentry.example.com/api/42/envelope/?sentry_version=7&sentry_key=0123abcd",
    );
    expect(event).toMatchObject({
      level: "error",
      platform: "node",
      release: "0a14f15",
      extra: { requestId: "req-1", event: "cmd", msg: "message handler failed" },
      contexts: { runtime: { name: "node", version: process.version } },
      exception: { values: [{ type: "TypeError", value: "cannot read the room" }] },
    });
    const frames = (event as { exception: { values: { stacktrace: { frames: unknown[] } }[] } })
      .exception.values[0]?.stacktrace.frames;
    expect(frames?.at(-1)).toMatchObject({ filename: expect.stringContaining("sentry.test.ts") });
    for (const field of ["server_name", "breadcrumbs", "request", "user"]) {
      expect(event, field).not.toHaveProperty(field);
    }
    expect(JSON.stringify(event)).not.toMatch(/"pid"|"hostname"/);
  });

  it("sends a fatal line without an error as a message", async () => {
    const { logger, events } = reporting();
    logger.fatal({ timeoutMs: 10_000 }, "shutdown: timed out");
    expect(await events()).toMatchObject([
      { level: "fatal", message: "shutdown: timed out", extra: { timeoutMs: 10_000 } },
    ]);
  });

  it("leaves out lines below error and the request log's 5xx line", async () => {
    const { logger, raw, events } = reporting();
    logger.info("listening");
    logger.warn("web app not built: serving the API only");
    logger.error({ method: "GET", path: "/api/rooms/:code", status: 500 }, REQUEST_FAILED);
    expect(raw).toHaveLength(3);
    expect(await events()).toEqual([]);
  });

  it("sends what the log wrote: redacted fields stay redacted, room paths are hidden", async () => {
    const { logger, raw, events } = reporting();
    logger.error(
      { err: new Error("GET /r/Abc1234567 failed"), password: SECRET, headers: { cookie: SECRET } },
      "unhandled error",
    );
    const [event] = await events();
    expect(raw.join("")).not.toContain(SECRET);
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(JSON.stringify(event)).not.toContain("Abc1234567");
    expect(event).toMatchObject({
      extra: { password: "[redacted]", headers: { cookie: "[redacted]" } },
      exception: { values: [{ value: "GET /r/:code failed" }] },
    });
  });

  it("keeps a cause in the message, as the log does, and frames of the error only", async () => {
    const { logger, events } = reporting();
    const cause = new Error("connection refused");
    logger.error({ err: new Error("setup failed", { cause }) }, "setup failed");
    const [event] = await events();
    const [exception] = (event as { exception: { values: { value: string }[] } }).exception.values;
    expect(exception?.value).toBe("setup failed: connection refused");
    expect(JSON.stringify(event)).not.toContain("caused by");
  });

  it("never throws or rejects when Sentry is down, and the log goes on", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { reports, logger, raw } = reporting(async () => {
        throw new Error("network down");
      });
      logger.error({ err: new Error("boom") }, "unhandled error");
      reports.write("{not json");
      reports.write('{"level":50,');
      logger.info("still logging");
      await expect(reports.flush(2000)).resolves.toBeTypeOf("boolean");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(raw).toHaveLength(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
