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

  // Every name the connectors' providers and the environment use for a secret, as a plain string
  // in the shapes a log call really has: on the line, in an object, in an object in an object,
  // and in a list of objects. A name missing from the list shows as a failure of its own.
  const NAMES = [
    "token",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "idToken",
    "id_token",
    "apiToken",
    "api_token",
    "pat",
    "client_secret",
    "clientSecret",
    "secret",
    "password",
    "sealed_token",
    "sealedToken",
    "vaultKey",
    "POKER_VAULT_KEY",
    "POKER_VAULT_OLD_KEYS",
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "Authorization",
    "authorization",
    "cookie",
    "jql",
    "summary",
  ];

  it.each(NAMES)("redacts %s at the top, one level down, two down and in a list", (name) => {
    const logs = collectLogs();
    logs.logger.info(
      {
        [name]: SECRET,
        a: { [name]: SECRET, b: { [name]: SECRET } },
        list: [{ [name]: SECRET }],
      },
      "shapes",
    );
    expect(logs.raw.join("")).not.toContain(SECRET);
    expect(logs.lines[0]).toMatchObject({
      [name]: "[redacted]",
      a: { [name]: "[redacted]", b: { [name]: "[redacted]" } },
      list: [{ [name]: "[redacted]" }],
    });
  });

  it("redacts a header in either case, on the line and one level down", () => {
    const logs = collectLogs();
    logs.logger.info(
      {
        headers: { Authorization: SECRET, Cookie: SECRET, "Set-Cookie": [SECRET], host: "h" },
        request: { headers: { Authorization: SECRET, Cookie: SECRET, "Set-Cookie": [SECRET] } },
        deep: { request: { headers: { Authorization: SECRET, "set-cookie": [SECRET] } } },
      },
      "headers",
    );
    expect(logs.raw.join("")).not.toContain(SECRET);
    expect(logs.lines[0]).toMatchObject({ headers: { host: "h", Authorization: "[redacted]" } });
  });

  it("does not claim more: a secret four levels down, or under another name, prints", () => {
    const logs = collectLogs();
    logs.logger.info({ a: { b: { c: { token: SECRET } } }, other: { bearer: SECRET } }, "limits");
    const output = logs.raw.join("");
    expect(output).toContain(`"token":"${SECRET}"`);
    expect(output).toContain(`"bearer":"${SECRET}"`);
  });
});
