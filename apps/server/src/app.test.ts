import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppDeps, createApp, DB_CHECK_TIMEOUT_MS, listStaticFiles } from "./app.ts";
import { collectLogs, SECRET, testConfig } from "./test-support.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

function app(deps: Partial<AppDeps> = {}, env: Record<string, string> = {}) {
  const logs = collectLogs();
  return { app: createApp(testConfig(env), { logger: logs.logger, ...deps }), logs };
}

describe("GET /api/health", () => {
  it("reports ok, the build, an unchecked database and whole seconds of uptime", async () => {
    const { app: a } = app({ uptime: () => 12.7 });
    const response = await a.request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      version: "dev",
      commit: "unknown",
      db: "unchecked",
      uptime: 12,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toMatch(UUID);
  });

  it("reports GIT_COMMIT and APP_VERSION", async () => {
    const { app: a } = app({}, { GIT_COMMIT: "0a14f15", APP_VERSION: "1.0.0" });
    expect(await (await a.request("/api/health")).json()).toMatchObject({
      version: "1.0.0",
      commit: "0a14f15",
    });
  });

  it("asks checkDb and answers 503 when the database is down or the check throws", async () => {
    const up = await app({ checkDb: async () => "ok" }).app.request("/api/health");
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({ status: "ok", db: "ok" });

    const down = await app({ checkDb: async () => "error" }).app.request("/api/health");
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ status: "error", db: "error" });

    const broken = app({ checkDb: () => Promise.reject(new Error("boom")) });
    const thrown = await broken.app.request("/api/health");
    expect(thrown.status).toBe(503);
    expect(await thrown.json()).toMatchObject({ db: "error" });
  });

  it("gives up on a hung database check and answers 503", async () => {
    const hung = app({ checkDb: () => new Promise(() => {}), dbCheckTimeoutMs: 30 });
    const response = await hung.app.request("/api/health");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "error", db: "error" });
    expect(DB_CHECK_TIMEOUT_MS).toBe(2000);
  });
});

describe("request ids and logs", () => {
  it("keeps a short safe x-request-id and replaces anything else", async () => {
    const { app: a, logs } = app();
    const kept = await a.request("/api/nope", { headers: { "x-request-id": "edge-42.a:b" } });
    expect(kept.headers.get("x-request-id")).toBe("edge-42.a:b");
    for (const unsafe of ["has space", "x".repeat(65), "<script>", "aé"]) {
      const replaced = await a.request("/api/nope", { headers: { "x-request-id": unsafe } });
      expect(replaced.headers.get("x-request-id")).toMatch(UUID);
    }
    expect(logs.lines[0]).toMatchObject({ requestId: "edge-42.a:b", status: 404 });
  });

  it("logs method, path and status but no query string, cookie or auth header", async () => {
    const { app: a, logs } = app();
    await a.request(`/api/rooms?token=${SECRET}`, {
      method: "POST",
      headers: { cookie: `sid=${SECRET}`, authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ password: SECRET }),
    });
    expect(logs.lines).toHaveLength(1);
    expect(logs.lines[0]).toMatchObject({
      level: 30,
      msg: "request",
      method: "POST",
      path: "/api/rooms",
      status: 404,
    });
    expect(logs.raw.join("")).not.toContain(SECRET);
  });

  it("answers an unhandled error with a JSON 500 and logs it", async () => {
    const { app: a, logs } = app({
      registerApi: (api) =>
        api.get("/api/explode", () => {
          throw new Error("kaboom");
        }),
    });
    const response = await a.request("/api/explode");
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "internal" });
    expect(logs.messages()).toEqual(["unhandled error", "request failed"]);
  });
});

describe("/api routing", () => {
  it("answers a JSON 404 for any unknown /api path or method", async () => {
    const { app: a } = app();
    for (const [path, method] of [
      ["/api", "GET"],
      ["/api/nope", "GET"],
      ["/api/deep/er", "DELETE"],
      ["/api/health", "POST"],
    ] as const) {
      const response = await a.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "not_found" });
    }
  });

  it("lets registerApi routes win over the /api 404", async () => {
    const { app: a } = app({
      registerApi: (api) => api.get("/api/auth/ping", (c) => c.text("pong")),
    });
    expect(await (await a.request("/api/auth/ping")).text()).toBe("pong");
  });

  it("answers a JSON 404 everywhere when the web app is not built", async () => {
    const { app: a } = app({ staticDir: join(tmpdir(), "pp-server-no-such-dir") });
    const response = await a.request("/r/abc");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "not_found" });
  });
});

describe("the built web app", () => {
  let parent: string;
  let root: string;
  const INDEX = "<!doctype html><title>Poker Planning</title>";

  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), "pp-web-"));
    root = join(parent, "dist");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(parent, "outside.txt"), "SENTINEL");
    mkdirSync(join(root, ".vite"));
    writeFileSync(join(root, ".vite", "manifest.json"), "{}");
    writeFileSync(join(root, "index.html"), INDEX);
    writeFileSync(join(root, "theme-init.js"), "/* theme */");
    writeFileSync(join(root, "favicon.svg"), "<svg/>");
    writeFileSync(join(root, "assets", "index-C0ffee12.js"), "export {};");
    writeFileSync(join(root, "assets", ".hidden.js"), "SENTINEL");
  });
  afterAll(() => rmSync(parent, { recursive: true, force: true }));

  const get = (path: string, method = "GET") =>
    app({ staticDir: root }).app.request(path, { method });

  it("serves index.html at the root and as history fallback, never cached", async () => {
    for (const path of ["/", "/r/AbCdEf1234", "/some/deep/route"]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toBe(INDEX);
    }
  });

  it("answers HEAD on a fallback route", async () => {
    const response = await get("/r/AbCdEf1234", "HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
  });

  it("caches hashed assets for a year and revalidates the unhashed files", async () => {
    const asset = await get("/assets/index-C0ffee12.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(asset.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(await asset.text()).toBe("export {};");

    for (const path of ["/theme-init.js", "/favicon.svg", "/index.html"]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBe("no-cache");
    }
  });

  it("answers 404, not HTML, for a missing file with an extension", async () => {
    for (const path of ["/assets/index-0ld0ld00.js", "/missing.png", "/.vite/manifest.json"]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(await response.json()).toEqual({ code: "not_found" });
    }
  });

  it("lists the plain files once, without dot entries", () => {
    expect([...listStaticFiles(root)].sort()).toEqual([
      "/assets/index-C0ffee12.js",
      "/favicon.svg",
      "/index.html",
      "/theme-init.js",
    ]);
  });

  it("serves only the exact spelling of a listed file", async () => {
    for (const path of [
      "/.vite/manifest.json",
      "/.VITE/manifest.json",
      "/VITE~1/manifest.json",
      "/assets/.hidden.js",
      "/INDEX.HTML",
      "/Favicon.svg",
      "/assets/INDEX-C0FFEE12.JS",
      "/favicon.svg.",
      "/favicon.svg::$DATA",
      "/assets//index-C0ffee12.js",
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain("SENTINEL");
    }
  });

  it("never serves a file added after start", async () => {
    const { app: a } = app({ staticDir: root });
    const late = join(root, "late.js");
    writeFileSync(late, "SENTINEL");
    try {
      expect((await a.request("/late.js")).status).toBe(404);
    } finally {
      unlinkSync(late);
    }
  });

  it("never serves the web app under /api, nor for other methods", async () => {
    const api = await get("/api/r/AbCdEf1234");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ code: "not_found" });
    expect((await get("/r/AbCdEf1234", "POST")).status).toBe(404);
  });

  it("never serves a file outside its folder", async () => {
    for (const path of [
      "/../outside.txt",
      "/assets/../../outside.txt",
      "/%2e%2e/outside.txt",
      "/..%2foutside.txt",
      "/..%5coutside.txt",
    ]) {
      const response = await get(path);
      expect(await response.text(), path).not.toContain("SENTINEL");
    }
  });
});
