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
    expect(error.message).toContain("BETTER_AUTH_SECRET must be at least 32 characters");
    expect(error.message).not.toContain(short);
    expect(loadConfig({ ...VALID_ENV, BETTER_AUTH_SECRET: "x".repeat(32) }).betterAuthSecret).toBe(
      "x".repeat(32),
    );
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
});
