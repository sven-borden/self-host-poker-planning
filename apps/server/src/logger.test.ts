import { describe, expect, it } from "vitest";
import { collectLogs, SECRET } from "./test-support.ts";

describe("createLogger", () => {
  it("redacts cookies, auth headers and auth payloads of a handshake logged whole", () => {
    const logs = collectLogs();
    logs.logger.info(
      {
        handshake: {
          headers: {
            host: "poker.example.com",
            cookie: `sid=${SECRET}`,
            authorization: `Bearer ${SECRET}`,
            "set-cookie": [`sid=${SECRET}`],
          },
          auth: { token: SECRET },
        },
        headers: { "set-cookie": [`sid=${SECRET}`] },
        databaseUrl: `postgres://pp:${SECRET}@db/pp`,
      },
      "handshake",
    );
    expect(logs.raw.join("")).not.toContain(SECRET);
    expect(logs.lines[0]).toMatchObject({
      handshake: {
        headers: { host: "poker.example.com", cookie: "[redacted]", "set-cookie": "[redacted]" },
        auth: "[redacted]",
      },
    });
  });
});
