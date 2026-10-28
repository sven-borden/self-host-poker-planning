import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_BODY_LIMIT_BYTES, createApp } from "./app.ts";
import {
  CSP_SOURCE_PATTERN,
  CSP_WILDCARD_REFUSED,
  contentSecurityPolicy,
  HSTS,
  isCspSource,
  PERMISSIONS_POLICY,
  parseCspSources,
  securityHeaders,
} from "./security-headers.ts";
import { createServer } from "./server.ts";
import { collectLogs, testConfig } from "./test-support.ts";

const STRICT_HTTP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:3000",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

describe("contentSecurityPolicy", () => {
  it("is strict over http: no inline script or style, no eval, the socket's origin named", () => {
    expect(contentSecurityPolicy({ baseUrl: "http://localhost:3000" })).toBe(STRICT_HTTP);
  });

  it("upgrades insecure requests over https, and names the wss origin", () => {
    const policy = contentSecurityPolicy({ baseUrl: "https://poker.example.com" });
    expect(policy).toContain("connect-src 'self' wss://poker.example.com;");
    expect(policy.endsWith("; upgrade-insecure-requests")).toBe(true);
  });

  it("leaves the upgrade out of a report-only policy, where browsers ignore it", () => {
    const policy = contentSecurityPolicy({
      baseUrl: "https://poker.example.com",
      reportOnly: true,
    });
    expect(policy).not.toContain("upgrade-insecure-requests");
  });

  it("adds extra origins to their directives once, and starts a new one from 'self'", () => {
    const policy = contentSecurityPolicy({
      baseUrl: "http://localhost:3000",
      extra: {
        "script-src": ["https://stats.example.com", "https://stats.example.com"],
        "connect-src": ["https://stats.example.com", "ws://localhost:3000"],
        "frame-src": ["https://video.example.com"],
        "img-src": [],
      },
    });
    expect(policy).toContain("script-src 'self' https://stats.example.com;");
    expect(policy).toContain("connect-src 'self' ws://localhost:3000 https://stats.example.com;");
    expect(policy).toContain("frame-src 'self' https://video.example.com;");
    expect(policy).toContain("img-src 'self' data:;");
    // The fixed directives never move.
    expect(policy).toContain("object-src 'none'; base-uri 'none'");
  });
});

describe("parseCspSources", () => {
  it("reads directives and origins, case-insensitive names, duplicates once", () => {
    expect(
      parseCspSources(
        " Script-Src https://a.example.com  https://*.b.example:8443;connect-src wss://a.example.com https://a.example.com; ; script-src https://a.example.com",
      ),
    ).toEqual({
      "script-src": ["https://a.example.com", "https://*.b.example:8443"],
      "connect-src": ["wss://a.example.com", "https://a.example.com"],
    });
    expect(parseCspSources("")).toEqual({});
  });

  it.each([
    "script-src 'unsafe-inline'",
    "script-src 'unsafe-eval'",
    "script-src https:",
    "script-src *",
    "script-src data:",
    "script-src https://a.example.com/path",
    "script-src javascript://a.example.com",
    "script-src https://user@a.example.com",
    "script-src",
    "default-src https://a.example.com",
    "frame-ancestors https://a.example.com",
    "base-uri https://a.example.com",
    "object-src https://a.example.com",
    "script-src https://a.example.com; style-src 'unsafe-inline'",
  ])("refuses %s", (value) => {
    expect(parseCspSources(value)).toBeNull();
  });

  it("accepts only plain origins", () => {
    expect(CSP_SOURCE_PATTERN.test("https://stats.example.com")).toBe(true);
    expect(CSP_SOURCE_PATTERN.test("http://10.0.0.5:3000")).toBe(true);
    expect(CSP_SOURCE_PATTERN.test("https://*.example.com")).toBe(true);
    expect(CSP_SOURCE_PATTERN.test("https://a.*.example.com")).toBe(false);
    expect(CSP_SOURCE_PATTERN.test("https://-a.example.com")).toBe(false);
  });

  it.each([
    "https://*.example.com",
    "https://*.EXAMPLE.co.uk",
    "https://*.me.github.io",
    "https://a.github.io",
    "http://10.0.0.5:1",
    "https://stats.example.com:65535",
  ])("accepts %s", (value) => {
    expect(isCspSource(value)).toBe(true);
    expect(parseCspSources(`connect-src ${value}`)).not.toBeNull();
  });

  it.each([
    ["a wildcard over one label", "https://*.com"],
    ["a wildcard over one label, with a port", "https://*.localhost:8080"],
    ["a wildcard on a hosting platform", "https://*.github.io"],
    ["a wildcard on a hosting platform, any case", "https://*.Vercel.App"],
    ["a wildcard on a country suffix", "https://*.co.uk"],
    ["a port above 65535", "https://stats.example.com:99999"],
    ["a port above 65535, just", "https://stats.example.com:65536"],
    ["port 0", "https://stats.example.com:0"],
  ])("refuses %s", (_what, value) => {
    expect(isCspSource(value)).toBe(false);
    expect(parseCspSources(`connect-src ${value}`)).toBeNull();
  });

  it("lists suffixes, not whole hosts or keywords", () => {
    for (const suffix of CSP_WILDCARD_REFUSED) {
      expect(suffix).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
  });
});

describe("securityHeaders", () => {
  it("sends every header over http, without HSTS", () => {
    expect(securityHeaders({ baseUrl: "http://localhost:3000" })).toEqual({
      "Content-Security-Policy": STRICT_HTTP,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": PERMISSIONS_POLICY,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
  });

  it("adds HSTS over https, a year with subdomains and without preload", () => {
    const headers = securityHeaders({ baseUrl: "https://poker.example.com" });
    expect(headers["Strict-Transport-Security"]).toBe(HSTS);
    expect(HSTS).toBe("max-age=31536000; includeSubDomains");
  });

  it("sends the policy report-only when asked, and never both", () => {
    const headers = securityHeaders({ baseUrl: "https://poker.example.com", reportOnly: true });
    expect(headers["Content-Security-Policy-Report-Only"]).toBeDefined();
    expect(headers["Content-Security-Policy"]).toBeUndefined();
    expect(headers["Strict-Transport-Security"]).toBe(HSTS);
  });

  it("turns off the features the app never uses and keeps the clipboard write", () => {
    const features = PERMISSIONS_POLICY.split(", ");
    expect(features).toContain("clipboard-write=(self)");
    for (const off of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      expect(features).toContain(`${off}=()`);
    }
  });
});

describe("the headers on every kind of response", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pp-headers-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>x</title>");
    writeFileSync(join(root, "theme-init.js"), "/* theme */");
    writeFileSync(join(root, "assets", "index-C0ffee12.js"), "export {};");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const env = { BASE_URL: "https://poker.example.com" };
  const build = (extraEnv: Record<string, string> = {}) =>
    createApp(testConfig({ ...env, ...extraEnv }), {
      logger: collectLogs().logger,
      staticDir: root,
      registerApi: (api) => {
        api.get("/api/boom", () => {
          throw new Error("boom");
        });
        api.post("/api/echo", async (c) => c.text(await c.req.text()));
        // Better Auth answers with a Response of its own.
        api.get("/api/raw", () => new Response("raw", { headers: { "x-raw": "1" } }));
      },
    });

  const expectHeaders = (response: Response, what: string) => {
    const expected = securityHeaders({ baseUrl: env.BASE_URL });
    for (const [name, value] of Object.entries(expected)) {
      expect(response.headers.get(name), `${what}: ${name}`).toBe(value);
    }
  };

  it.each([
    ["the web app", "/", "GET", 200],
    ["the history fallback", "/r/AbCdEf1234", "GET", 200],
    ["a static file", "/theme-init.js", "GET", 200],
    ["a hashed asset", "/assets/index-C0ffee12.js", "GET", 200],
    ["a missing asset", "/assets/missing-1234.js", "GET", 404],
    ["health", "/api/health", "GET", 200],
    ["an API 404", "/api/nope", "GET", 404],
    ["a 500", "/api/boom", "GET", 500],
    ["a raw Response", "/api/raw", "GET", 200],
  ] as const)("%s", async (what, path, method, status) => {
    const response = await build().request(path, { method });
    expect(response.status).toBe(status);
    expectHeaders(response, what);
  });

  it("a body over the limit", async () => {
    const response = await build().request("/api/echo", {
      method: "POST",
      body: "x".repeat(API_BODY_LIMIT_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expectHeaders(response, "413");
  });

  it("CSP_REPORT_ONLY sends the report-only header instead", async () => {
    const response = await build({ CSP_REPORT_ONLY: "1" }).request("/");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("content-security-policy-report-only")).toContain(
      "script-src 'self'",
    );
  });

  it("CSP_EXTRA_SOURCES reaches the policy", async () => {
    const response = await build({
      CSP_EXTRA_SOURCES: "script-src https://stats.example.com",
    }).request("/");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self' https://stats.example.com;",
    );
  });

  it("Socket.IO's own HTTP answers carry them too", async () => {
    const server = createServer(testConfig(env), { logger: collectLogs().logger });
    const { port } = await server.listen();
    try {
      const response = await fetch(`http://localhost:${port}/socket.io/?EIO=4&transport=polling`);
      expect(response.status).toBe(200);
      await response.text();
      expectHeaders(response, "polling");
    } finally {
      await server.close();
    }
  });

  /** A GET with any header (fetch would not send another Origin), as a Response. */
  const get = (port: number, path: string, headers: Record<string, string> = {}) =>
    new Promise<Response>((resolve, reject) => {
      const request = httpRequest({ host: "localhost", port, path, headers, agent: false });
      request.once("response", (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("end", () => {
          const out = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            for (const one of [value ?? []].flat()) out.append(name, one);
          }
          resolve(
            new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 0, headers: out }),
          );
        });
      });
      request.once("error", reject);
      request.end();
    });

  it.each([
    ["a bad query", "/socket.io/?EIO=4&transport=carrier-pigeon", {}, 400, "Transport unknown"],
    [
      "a foreign Origin",
      "/socket.io/?EIO=4&transport=polling",
      { origin: "https://evil.example" },
      403,
      "Forbidden",
    ],
    ["no session cookie", "/socket.io/?EIO=4&transport=polling", {}, 403, "unauthenticated"],
  ] as const)(
    "Engine.IO's own refusal of %s carries them, once each",
    async (what, path, headers, status, message) => {
      const server = createServer(testConfig(env), {
        logger: collectLogs().logger,
        sessionCookie: "__Host-pp.session_token",
      });
      const { port } = await server.listen();
      try {
        const response = await get(port, path, headers);
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ message });
        expectHeaders(response, what);
        // Set once: a header given twice would read "a, a".
        expect(response.headers.get("content-type")).toBe("application/json");
      } finally {
        await server.close();
      }
    },
  );
});
