import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";
import { SECRET, VALID_ENV } from "./test-support.ts";

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  it("applies the defaults and freezes the result", () => {
    const config = loadConfig(VALID_ENV);
    expect(config).toEqual({
      port: 3000,
      databaseUrl: VALID_ENV.DATABASE_URL,
      baseUrl: "http://localhost:3000",
      logLevel: "info",
      trustProxy: 1,
      roomTtlDays: 90,
      gitCommit: undefined,
      appVersion: undefined,
      staticDir: undefined,
      migrationsDir: undefined,
      cspReportOnly: false,
      cspExtraSources: {},
      betterAuthSecret: VALID_ENV.BETTER_AUTH_SECRET,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("reads every variable", () => {
    const config = loadConfig({
      PORT: "8080",
      DATABASE_URL: "postgresql://db.internal/pp?sslmode=require",
      BETTER_AUTH_SECRET: VALID_ENV.BETTER_AUTH_SECRET,
      BASE_URL: "https://poker.example.com/",
      LOG_LEVEL: "debug",
      TRUST_PROXY: "0",
      ROOM_TTL_DAYS: "30",
      GIT_COMMIT: "0a14f15",
      APP_VERSION: "1.2.0+build.7",
      STATIC_DIR: "/app/public",
      MIGRATIONS_DIR: "/app/drizzle",
      CSP_REPORT_ONLY: "true",
      CSP_EXTRA_SOURCES: "script-src https://stats.example.com",
      UNRELATED: "ignored",
    });
    expect(config).toEqual({
      port: 8080,
      databaseUrl: "postgresql://db.internal/pp?sslmode=require",
      baseUrl: "https://poker.example.com",
      logLevel: "debug",
      trustProxy: 0,
      roomTtlDays: 30,
      gitCommit: "0a14f15",
      appVersion: "1.2.0+build.7",
      staticDir: "/app/public",
      migrationsDir: "/app/drizzle",
      cspReportOnly: true,
      cspExtraSources: { "script-src": ["https://stats.example.com"] },
      betterAuthSecret: VALID_ENV.BETTER_AUTH_SECRET,
    });
  });

  it("reads TRUST_PROXY as a number of proxies: true is 1, false is 0", () => {
    const proxies = (TRUST_PROXY: string) => loadConfig({ ...VALID_ENV, TRUST_PROXY }).trustProxy;
    expect(proxies("true")).toBe(1);
    expect(proxies("1")).toBe(1);
    expect(proxies("2")).toBe(2);
    expect(proxies("10")).toBe(10);
    expect(proxies("false")).toBe(0);
    expect(proxies("0")).toBe(0);
    for (const TRUST_PROXY of ["yes", "11", "-1", "1.5", "TRUE"]) {
      expect(configError({ ...VALID_ENV, TRUST_PROXY }).message).toContain(
        "TRUST_PROXY must be true, false or a number of proxies from 0 to 10",
      );
    }
  });

  it("requires a BETTER_AUTH_SECRET of 32 characters or more, without echoing it", () => {
    const { BETTER_AUTH_SECRET: _, ...withoutSecret } = VALID_ENV;
    expect(configError(withoutSecret).message).toContain("BETTER_AUTH_SECRET is required");
    const short = `${SECRET}-short`;
    const error = configError({ ...VALID_ENV, BETTER_AUTH_SECRET: short });
    expect(error.variables).toEqual(["BETTER_AUTH_SECRET"]);
    expect(error.message).toContain("BETTER_AUTH_SECRET must be at least 32 random characters");
    expect(error.message).not.toContain(short);
    const secret = "0123456789abcdef0123456789abcdef";
    expect(loadConfig({ ...VALID_ENV, BETTER_AUTH_SECRET: secret }).betterAuthSecret).toBe(secret);
  });

  it("refuses the old placeholder and a secret of one repeated character, without echoing it", () => {
    for (const fake of [
      "replace-with-32-or-more-random-characters",
      "x".repeat(32),
      "0".repeat(64),
      "\u{1F600}".repeat(32),
    ]) {
      const error = configError({ ...VALID_ENV, BETTER_AUTH_SECRET: fake });
      expect(error.variables).toEqual(["BETTER_AUTH_SECRET"]);
      expect(error.message).toBe(
        "Invalid configuration: BETTER_AUTH_SECRET must be at least 32 random characters, such as the output of openssl rand -base64 32. See .env.example.",
      );
    }
  });

  it("treats an empty value as unset", () => {
    expect(loadConfig({ ...VALID_ENV, PORT: "", LOG_LEVEL: "" })).toMatchObject({
      port: 3000,
      logLevel: "info",
    });
    expect(configError({ ...VALID_ENV, DATABASE_URL: "" }).variables).toEqual(["DATABASE_URL"]);
  });

  it("names a missing DATABASE_URL in one line", () => {
    const error = configError({
      BASE_URL: VALID_ENV.BASE_URL,
      BETTER_AUTH_SECRET: VALID_ENV.BETTER_AUTH_SECRET,
    });
    expect(error.variables).toEqual(["DATABASE_URL"]);
    expect(error.message).toBe(
      "Invalid configuration: DATABASE_URL is required. See .env.example.",
    );
  });

  it("lists every bad variable with a fixed reason and never echoes a value", () => {
    const error = configError({
      PORT: "70000",
      DATABASE_URL: `mysql://root:${SECRET}@db/pp`,
      BASE_URL: `https://poker.example.com/rooms?k=${SECRET}`,
      LOG_LEVEL: "loud",
      TRUST_PROXY: "yes",
      ROOM_TTL_DAYS: "0",
      GIT_COMMIT: "has space",
      APP_VERSION: "x".repeat(65),
      STATIC_DIR: undefined,
      BETTER_AUTH_SECRET: SECRET,
    });
    expect(error.variables).toEqual([
      "PORT",
      "DATABASE_URL",
      "BASE_URL",
      "LOG_LEVEL",
      "TRUST_PROXY",
      "ROOM_TTL_DAYS",
      "GIT_COMMIT",
      "APP_VERSION",
      "BETTER_AUTH_SECRET",
    ]);
    expect(error.message).toContain("DATABASE_URL must be a postgres:// or postgresql:// URL");
    expect(error.message).toContain("PORT must be an integer from 0 to 65535");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("loud");
    expect(error.message).not.toMatch(/\n/);
  });

  it("refuses a BASE_URL that is not http(s) or has a path", () => {
    for (const BASE_URL of ["ftp://example.com", "https://example.com/app", "not a url"]) {
      expect(configError({ ...VALID_ENV, BASE_URL }).variables).toEqual(["BASE_URL"]);
    }
  });

  it("refuses a BASE_URL with a username or a password, without echoing it", () => {
    for (const BASE_URL of [
      `https://admin:${SECRET}@poker.example.com`,
      `https://${SECRET}@poker.example.com`,
      `https://:${SECRET}@poker.example.com`,
    ]) {
      const error = configError({ ...VALID_ENV, BASE_URL });
      expect(error.variables).toEqual(["BASE_URL"]);
      expect(error.message).toContain("BASE_URL must be an http(s) origin");
      expect(error.message).not.toContain(SECRET);
    }
  });

  it("refuses a PORT or ROOM_TTL_DAYS that is not a plain integer", () => {
    for (const value of ["-1", "3.5", "1e3", " 80", "abc"]) {
      expect(configError({ ...VALID_ENV, PORT: value, ROOM_TTL_DAYS: value }).variables).toEqual([
        "PORT",
        "ROOM_TTL_DAYS",
      ]);
    }
  });

  it("refuses a CSP_REPORT_ONLY or CSP_EXTRA_SOURCES it cannot read, without echoing it", () => {
    for (const [name, value] of [
      ["CSP_REPORT_ONLY", "maybe-later"],
      ["CSP_EXTRA_SOURCES", "script-src 'unsafe-inline'"],
      ["CSP_EXTRA_SOURCES", "default-src https://stats.example.com"],
      ["CSP_EXTRA_SOURCES", `script-src ${"https://a.example.com ".repeat(100)}`],
    ] as const) {
      const error = configError({ ...VALID_ENV, [name]: value });
      expect(error.variables).toEqual([name]);
      expect(error.message).not.toContain(value);
    }
    expect(loadConfig({ ...VALID_ENV, CSP_REPORT_ONLY: "0" }).cspReportOnly).toBe(false);
    expect(loadConfig({ ...VALID_ENV, CSP_REPORT_ONLY: "1" }).cspReportOnly).toBe(true);
  });
});
