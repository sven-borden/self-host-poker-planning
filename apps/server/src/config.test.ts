import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  azureDevOpsGaps,
  connectorGaps,
  connectorNames,
  loadConfig,
  socialProviderIds,
} from "./config.ts";
import { SECRET, VALID_ENV } from "./test-support.ts";
import { Secret, Vault } from "./vault.ts";

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
      redisUrl: undefined,
      sentryDsn: undefined,
      umami: undefined,
      socialProviders: { google: undefined, microsoft: undefined },
      azureDevOps: false,
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
      REDIS_URL: "redis://redis.internal:6379/0",
      SENTRY_DSN: "https://abc123@o1.ingest.sentry.io/42",
      AZURE_DEVOPS_CONNECTOR: "on",
      UMAMI_URL: "https://stats.example.com",
      UMAMI_WEBSITE_ID: "6639E935-21CE-47C9-89D2-DA5D28B7DC15",
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
      redisUrl: "redis://redis.internal:6379/0",
      sentryDsn: "https://abc123@o1.ingest.sentry.io/42",
      azureDevOps: true,
      umami: {
        scriptUrl: "https://stats.example.com/script.js",
        websiteId: "6639e935-21ce-47c9-89d2-da5d28b7dc15",
      },
      socialProviders: { google: undefined, microsoft: undefined },
      betterAuthSecret: VALID_ENV.BETTER_AUTH_SECRET,
    });
  });

  it("takes a SENTRY_DSN with a public key only, and never echoes a bad one (#40)", () => {
    for (const ok of [
      "https://abc123@o1.ingest.us.sentry.io/42",
      "http://abc123@localhost:9000/1",
      "https://abc123@sentry.example.com/sentry/7",
    ]) {
      expect(loadConfig({ ...VALID_ENV, SENTRY_DSN: ok }).sentryDsn).toBe(ok);
    }
    for (const SENTRY_DSN of [
      `https://abc123:${SECRET}@o1.ingest.sentry.io/42`,
      "https://o1.ingest.sentry.io/42",
      `https://${SECRET}@o1.ingest.sentry.io/project`,
      "https://public-key@o1.ingest.sentry.io/42",
      `https://${SECRET}@o1.ingest.sentry.io/42?x=1`,
      `ftp://${SECRET}@o1.ingest.sentry.io/42`,
      SECRET,
    ]) {
      const error = configError({ ...VALID_ENV, SENTRY_DSN });
      expect(error.variables).toEqual(["SENTRY_DSN"]);
      expect(error.message).toContain("SENTRY_DSN must be a Sentry DSN");
      expect(error.message).not.toContain(SECRET);
    }
  });

  it("finds Umami's tracker under UMAMI_URL, or takes the tracker's own URL (#40)", () => {
    const id = "6639e935-21ce-47c9-89d2-da5d28b7dc15";
    const script = (UMAMI_URL: string) =>
      loadConfig({ ...VALID_ENV, UMAMI_URL, UMAMI_WEBSITE_ID: id }).umami?.scriptUrl;
    expect(script("https://stats.example.com")).toBe("https://stats.example.com/script.js");
    expect(script("https://stats.example.com/")).toBe("https://stats.example.com/script.js");
    expect(script("https://example.com/umami/")).toBe("https://example.com/umami/script.js");
    expect(script("https://stats.example.com/s.js")).toBe("https://stats.example.com/s.js");
    expect(script("http://localhost:3001")).toBe("http://localhost:3001/script.js");
    for (const UMAMI_URL of [
      `${SECRET}.example.com`,
      `https://umami.example.org/?site=${SECRET}`,
      `https://user:${SECRET}@umami.example.org`,
      `javascript:alert("${SECRET}")`,
    ]) {
      const error = configError({ ...VALID_ENV, UMAMI_URL, UMAMI_WEBSITE_ID: id });
      expect(error.variables).toEqual(["UMAMI_URL"]);
      expect(error.message).toContain("UMAMI_URL must be the http(s) address of Umami");
      expect(error.message).not.toContain(SECRET);
    }
    const badId = configError({
      ...VALID_ENV,
      UMAMI_URL: "https://umami.example.org",
      UMAMI_WEBSITE_ID: SECRET,
    });
    expect(badId.variables).toEqual(["UMAMI_WEBSITE_ID"]);
    expect(badId.message).toContain("UMAMI_WEBSITE_ID must be the website's id in Umami, a UUID");
    expect(badId.message).not.toContain(SECRET);
  });

  it("has a provider when both its keys are set, in Microsoft's case with a tenant (#47)", () => {
    expect(loadConfig(VALID_ENV).socialProviders).toEqual({
      google: undefined,
      microsoft: undefined,
    });
    expect(socialProviderIds(loadConfig(VALID_ENV))).toEqual([]);
    const config = loadConfig({
      ...VALID_ENV,
      GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "GOCSPX-abc_def",
      MICROSOFT_CLIENT_ID: "a1b2c3d4-0000-1111-2222-333344445555",
      MICROSOFT_CLIENT_SECRET: "abc~def.ghi_jkl",
    });
    expect(config.socialProviders).toEqual({
      google: {
        clientId: "123-abc.apps.googleusercontent.com",
        clientSecret: "GOCSPX-abc_def",
      },
      microsoft: {
        clientId: "a1b2c3d4-0000-1111-2222-333344445555",
        clientSecret: "abc~def.ghi_jkl",
        tenantId: "common",
      },
    });
    expect(socialProviderIds(config)).toEqual(["google", "microsoft"]);
  });

  it("names what keeps a keyed Jira dark, and nothing when there is nothing to say (#54)", () => {
    const jira = { JIRA_CLIENT_ID: "jira-id", JIRA_CLIENT_SECRET: "jira-secret" };
    const google = { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" };
    const vault = { POKER_VAULT_KEY: randomBytes(32).toString("base64") };
    const gaps = (env: Record<string, string>) =>
      connectorGaps(loadConfig({ ...VALID_ENV, ...env }));
    expect(gaps({})).toEqual([]);
    expect(gaps({ ...google, ...vault })).toEqual([]);
    expect(gaps({ ...jira, ...google, ...vault })).toEqual([]);
    expect(gaps({ ...jira, ...google })).toEqual(["POKER_VAULT_KEY"]);
    expect(gaps({ ...jira, ...vault })).toEqual(["GOOGLE_CLIENT_ID", "MICROSOFT_CLIENT_ID"]);
  });

  it("has Jira only with both its keys, the vault and a way to sign in (#54)", () => {
    const jira = { JIRA_CLIENT_ID: "jira-id", JIRA_CLIENT_SECRET: "jira-secret" };
    const google = { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" };
    const vault = { POKER_VAULT_KEY: randomBytes(32).toString("base64") };
    const names = (env: Record<string, string>) =>
      connectorNames(loadConfig({ ...VALID_ENV, ...env }));
    expect(names({ ...jira, ...google, ...vault })).toEqual(["jira"]);
    expect(names({})).toEqual([]);
    expect(names({ ...google, ...vault })).not.toContain("jira");
    expect(names({ ...jira, ...google })).toEqual([]);
    expect(names({ ...jira, ...vault })).toEqual([]);
    expect(loadConfig({ ...VALID_ENV, ...jira }).jira).toEqual({
      clientId: "jira-id",
      clientSecret: "jira-secret",
    });
    expect(loadConfig(VALID_ENV).jira).toBeUndefined();
  });

  it("has Azure DevOps only on the operator's word, with the vault and a way to sign in (#55)", () => {
    const google = { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" };
    const jira = { JIRA_CLIENT_ID: "jira-id", JIRA_CLIENT_SECRET: "jira-secret" };
    const vault = { POKER_VAULT_KEY: randomBytes(32).toString("base64") };
    const on = { AZURE_DEVOPS_CONNECTOR: "on" };
    const names = (env: Record<string, string>) =>
      connectorNames(loadConfig({ ...VALID_ENV, ...env }));
    expect(names({ ...on, ...google, ...vault })).toEqual(["azure-devops"]);
    expect(names({ ...on, ...jira, ...google, ...vault })).toEqual(["jira", "azure-devops"]);
    expect(names({ ...google, ...vault })).toEqual([]);
    expect(names({ ...on, ...google })).toEqual([]);
    expect(names({ ...on, ...vault })).toEqual([]);
    expect(names(on)).toEqual([]);
    expect(connectorGaps(loadConfig({ ...VALID_ENV, ...on, ...vault }))).toEqual([]);
  });

  it.each(["true", "ON", "On", "1", "yes", "off", " on", ""])(
    "leaves Azure DevOps dark at %j, and does not stop the start",
    (value) => {
      const config = loadConfig({
        ...VALID_ENV,
        GOOGLE_CLIENT_ID: "g",
        GOOGLE_CLIENT_SECRET: "s",
        POKER_VAULT_KEY: randomBytes(32).toString("base64"),
        AZURE_DEVOPS_CONNECTOR: value,
      });
      expect(config.azureDevOps).toBe(false);
      expect(connectorNames(config)).toEqual([]);
    },
  );

  it("names what keeps an Azure DevOps that was turned on dark, and nothing else", () => {
    const google = { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" };
    const vault = { POKER_VAULT_KEY: randomBytes(32).toString("base64") };
    const on = { AZURE_DEVOPS_CONNECTOR: "on" };
    const gaps = (env: Record<string, string>) =>
      azureDevOpsGaps(loadConfig({ ...VALID_ENV, ...env }));
    expect(gaps({})).toEqual([]);
    expect(gaps(vault)).toEqual([]);
    expect(gaps({ ...on, ...google, ...vault })).toEqual([]);
    expect(gaps({ ...on, ...google })).toEqual(["POKER_VAULT_KEY"]);
    expect(gaps({ ...on, ...vault })).toEqual(["GOOGLE_CLIENT_ID", "MICROSOFT_CLIENT_ID"]);
    expect(gaps(on)).toEqual(["POKER_VAULT_KEY", "GOOGLE_CLIENT_ID", "MICROSOFT_CLIENT_ID"]);
  });

  it("names the missing half of a provider's keys, never the value (#47)", () => {
    const halves = [
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      ["GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_ID"],
      ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
      ["MICROSOFT_CLIENT_SECRET", "MICROSOFT_CLIENT_ID"],
      ["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET"],
      ["JIRA_CLIENT_SECRET", "JIRA_CLIENT_ID"],
    ] as const;
    for (const [set, missing] of halves) {
      const error = configError({ ...VALID_ENV, [set]: SECRET });
      expect(error.variables).toEqual([missing]);
      expect(error.message).toContain(`${missing} is required when ${set} is set`);
      expect(error.message).not.toContain(SECRET);
    }
  });

  it("refuses a key with a space or a line break in it, without showing it (#47)", () => {
    const error = configError({
      ...VALID_ENV,
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: `${SECRET}\n`,
    });
    expect(error.variables).toEqual(["GOOGLE_CLIENT_SECRET"]);
    expect(error.message).toContain("GOOGLE_CLIENT_SECRET must be the OAuth client secret");
    expect(error.message).not.toContain(SECRET);
  });

  it("takes a tenant mode or a tenant's id, nothing that could change the address (#47)", () => {
    const keys = { ...VALID_ENV, MICROSOFT_CLIENT_ID: "id", MICROSOFT_CLIENT_SECRET: "secret" };
    const tenant = (MICROSOFT_TENANT_ID: string) =>
      loadConfig({ ...keys, MICROSOFT_TENANT_ID }).socialProviders.microsoft?.tenantId;
    expect(loadConfig(keys).socialProviders.microsoft?.tenantId).toBe("common");
    for (const value of ["common", "organizations", "consumers"]) {
      expect(tenant(value)).toBe(value);
    }
    expect(tenant("11111111-2222-3333-4444-555555555555")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    for (const value of ["../evil", "evil.example/x", "Common", "contoso.onmicrosoft.com"]) {
      const error = configError({ ...keys, MICROSOFT_TENANT_ID: value });
      expect(error.variables).toEqual(["MICROSOFT_TENANT_ID"]);
      expect(error.message).not.toContain(value);
    }
  });

  it("needs UMAMI_URL and UMAMI_WEBSITE_ID together (#40)", () => {
    expect(configError({ ...VALID_ENV, UMAMI_URL: "https://stats.example.com" }).message).toBe(
      "Invalid configuration: UMAMI_WEBSITE_ID is required when UMAMI_URL is set. See .env.example.",
    );
    const error = configError({
      ...VALID_ENV,
      PORT: "-1",
      UMAMI_WEBSITE_ID: "6639e935-21ce-47c9-89d2-da5d28b7dc15",
    });
    expect(error.variables).toEqual(["PORT", "UMAMI_URL"]);
    expect(error.message).toContain("UMAMI_URL is required when UMAMI_WEBSITE_ID is set");
  });

  it("takes a redis:// or rediss:// REDIS_URL, and never echoes a bad one (#39)", () => {
    const tls = `rediss://default:${SECRET}@cache.example.com:6380`;
    expect(loadConfig({ ...VALID_ENV, REDIS_URL: tls }).redisUrl).toBe(tls);
    expect(loadConfig({ ...VALID_ENV, REDIS_URL: "" }).redisUrl).toBeUndefined();
    for (const ok of ["redis://cache", "redis://cache/", "redis://cache:6379/2"]) {
      expect(loadConfig({ ...VALID_ENV, REDIS_URL: ok }).redisUrl).toBe(ok);
    }
    for (const REDIS_URL of [
      `http://user:${SECRET}@cache`,
      `${SECRET}`,
      "redis://",
      `redis://:${SECRET}@cache/db`,
      "redis://cache:6379/0/1",
    ]) {
      const error = configError({ ...VALID_ENV, REDIS_URL });
      expect(error.variables).toEqual(["REDIS_URL"]);
      expect(error.message).toContain("REDIS_URL must be a redis:// or rediss:// URL");
      expect(error.message).not.toContain(SECRET);
    }
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

describe("the vault keys (#53)", () => {
  const newKey = () => randomBytes(32).toString("base64");
  const row = { userId: "user-a", connector: "jira" };

  it("are off without POKER_VAULT_KEY, and an empty value counts as unset", () => {
    expect(loadConfig(VALID_ENV).vault).toBeUndefined();
    expect(
      loadConfig({ ...VALID_ENV, POKER_VAULT_KEY: "", POKER_VAULT_OLD_KEYS: "" }).vault,
    ).toBeUndefined();
  });

  it("build a vault that seals with the key and opens with the old ones", () => {
    const [key, one, two] = [newKey(), newKey(), newKey()];
    const { vault } = loadConfig({
      ...VALID_ENV,
      POKER_VAULT_KEY: key,
      POKER_VAULT_OLD_KEYS: `${one},${two}`,
    });
    const sealed = vault?.seal(new Secret("fake-token"), row) ?? "";
    expect(new Vault(key).open(sealed, row).ok).toBe(true);
    const older = new Vault(two).seal(new Secret("fake-token"), row);
    expect(vault?.open(older, row)).toMatchObject({ ok: true, onCurrentKey: false });
  });

  it("do not print themselves with the config", () => {
    const key = newKey();
    const config = loadConfig({ ...VALID_ENV, POKER_VAULT_KEY: key });
    expect(JSON.stringify(config)).not.toContain(key);
  });

  it("stop the start when malformed, naming the variable and no value", () => {
    const short = randomBytes(16).toString("base64");
    const long = randomBytes(48).toString("base64");
    const blank = Buffer.alloc(32).toString("base64");
    for (const value of [SECRET, short, long, blank, `${newKey()}\n`]) {
      const error = configError({ ...VALID_ENV, POKER_VAULT_KEY: value });
      expect(error.variables).toEqual(["POKER_VAULT_KEY"]);
      expect(error.message).toContain("POKER_VAULT_KEY must be 32 random bytes in base64");
      expect(error.message).not.toContain(value);

      const key = newKey();
      const old = configError({
        ...VALID_ENV,
        POKER_VAULT_KEY: key,
        POKER_VAULT_OLD_KEYS: `${newKey()},${value}`,
      });
      expect(old.variables).toEqual(["POKER_VAULT_OLD_KEYS"]);
      expect(old.message).not.toContain(value);
      expect(old.message).not.toContain(key);
    }
  });

  it("stop the start when a key is listed twice", () => {
    const [key, old] = [newKey(), newKey()];
    for (const list of [key, `${old},${old}`, `${old},${key}`]) {
      const error = configError({
        ...VALID_ENV,
        POKER_VAULT_KEY: key,
        POKER_VAULT_OLD_KEYS: list,
      });
      expect(error.variables).toEqual(["POKER_VAULT_OLD_KEYS"]);
      expect(error.message).not.toContain(key);
      expect(error.message).not.toContain(old);
    }
  });

  it("need a current key when old ones are listed", () => {
    expect(configError({ ...VALID_ENV, POKER_VAULT_OLD_KEYS: newKey() }).message).toContain(
      "POKER_VAULT_KEY is required when POKER_VAULT_OLD_KEYS is set",
    );
  });

  it("may not be BETTER_AUTH_SECRET, however it is written", () => {
    const key = newKey();
    const bytes = Buffer.from(key, "base64");
    for (const secret of [key, bytes.toString("base64url")]) {
      const same = configError({
        ...VALID_ENV,
        BETTER_AUTH_SECRET: secret,
        POKER_VAULT_KEY: key,
      });
      expect(same.variables).toEqual(["POKER_VAULT_KEY"]);
      expect(same.message).not.toContain(key);
      const old = configError({
        ...VALID_ENV,
        BETTER_AUTH_SECRET: secret,
        POKER_VAULT_KEY: newKey(),
        POKER_VAULT_OLD_KEYS: key,
      });
      expect(old.variables).toEqual(["POKER_VAULT_OLD_KEYS"]);
    }
  });
});
