/**
 * The pure parts of sign-in, and that production has no way to point a provider elsewhere: the
 * real provider code, built from every variable the server reads, reaches the providers' own
 * addresses, and the stand-in for them is imported by no file that ships.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { betterAuth } from "better-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_ROUTES, authOptions } from "./auth.ts";
import { loadConfig } from "./config.ts";
import type { Db } from "./db/rooms.ts";
import { createLogger } from "./logger.ts";
import {
  claimedAddress,
  idTokenClaims,
  isAlarming,
  isReturnPath,
  microsoftAddress,
  microsoftIdentity,
  signInOutcome,
  signInRequest,
  socialProviderOptions,
  socialRoutes,
  tenantAdmitted,
  tenantRefusal,
} from "./social-sign-in.ts";
import { testConfig, VALID_ENV } from "./test-support.ts";

const KEYS = {
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  MICROSOFT_CLIENT_ID: "microsoft-id",
  MICROSOFT_CLIENT_SECRET: "microsoft-secret",
};
const CODE = "AbCdEf2345";
const BASE = VALID_ENV.BASE_URL;
const config = testConfig(KEYS);
const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

describe("socialRoutes", () => {
  it("adds nothing without keys, and each provider's callback by its keys", () => {
    expect(socialRoutes(testConfig())).toEqual([]);
    expect(
      socialRoutes(testConfig({ MICROSOFT_CLIENT_ID: "a", MICROSOFT_CLIENT_SECRET: "b" })),
    ).toEqual(["POST /sign-in/social", "GET /callback/microsoft"]);
    expect(socialRoutes(config)).toEqual([
      "POST /sign-in/social",
      "GET /callback/google",
      "GET /callback/microsoft",
    ]);
  });

  it("leaves the base routes as they are", () => {
    expect([...AUTH_ROUTES].sort()).toEqual([
      "GET /get-session",
      "POST /sign-in/anonymous",
      "POST /sign-out",
    ]);
  });
});

describe("isReturnPath", () => {
  it("takes the landing page and a room's path, spelled exactly", () => {
    expect(isReturnPath("/")).toBe(true);
    expect(isReturnPath(`/r/${CODE}`)).toBe(true);
    for (const path of [
      "",
      "//evil.example",
      "/\\evil.example",
      `/r/${CODE}/`,
      `/r/${CODE}?x=1`,
      "/r/0OIl000000",
      "/api/health",
      "https://evil.example/",
    ]) {
      expect(isReturnPath(path), path).toBe(false);
    }
  });
});

describe("signInRequest", () => {
  it("builds the whole body: nothing of the page's reaches Better Auth but these", () => {
    expect(signInRequest({ provider: "google", returnTo: `/r/${CODE}` }, config)).toEqual({
      provider: "google",
      callbackURL: `${BASE}/r/${CODE}`,
      errorCallbackURL: `${BASE}/r/${CODE}`,
      disableRedirect: true,
    });
  });

  it("refuses a provider this install does not have", () => {
    const googleOnly = testConfig({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" });
    expect(signInRequest({ provider: "microsoft", returnTo: "/" }, googleOnly)).toBeNull();
    expect(signInRequest({ provider: "google", returnTo: "/" }, testConfig())).toBeNull();
  });
});

describe("signInOutcome", () => {
  it("passes a finished sign-in on to the return path", () => {
    expect(signInOutcome(redirect(`${BASE}/r/${CODE}`), config)).toEqual({
      location: `${BASE}/r/${CODE}`,
    });
  });

  it("names a failure by a code, and keeps only a reason on its list", () => {
    const failed = (query: string) =>
      signInOutcome(redirect(`${BASE}/r/${CODE}?${query}`), config).failure;
    expect(failed("error=access_denied&error_description=No")).toEqual({
      code: "cancelled",
      reason: "access_denied",
    });
    expect(failed("error=account_not_linked")).toEqual({
      code: "account_exists",
      reason: "account_not_linked",
    });
    expect(failed("error=email_not_found")).toEqual({
      code: "no_email",
      reason: "email_not_found",
    });
    expect(failed("error=invalid_code")).toEqual({ code: "failed", reason: "invalid_code" });
    expect(failed(`error=${CODE}`)).toEqual({ code: "failed", reason: "other" });
    expect(failed("error=%3Cscript%3E")).toEqual({ code: "failed", reason: "other" });
    expect(failed("error=tenant_not_allowed&error_description=x")).toEqual({
      code: "tenant_not_allowed",
      reason: "tenant_not_allowed",
    });
  });

  it("takes a word of the prototype for no reason at all", () => {
    for (const error of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const { location, failure } = signInOutcome(redirect(`${BASE}/?error=${error}`), config);
      expect(location, error).toBe(`${BASE}/?sign_in_error=failed`);
      expect(failure, error).toEqual({ code: "failed", reason: "other" });
    }
  });

  it("carries the code, and nothing else of the query, to the page", () => {
    const { location } = signInOutcome(
      redirect(`${BASE}/r/${CODE}?error=access_denied&error_description=Anything`),
      config,
    );
    expect(location).toBe(`${BASE}/r/${CODE}?sign_in_error=cancelled`);
  });

  it("ends on the landing page whatever else comes", () => {
    const landing = `${BASE}/?sign_in_error=failed`;
    expect(signInOutcome(null, config).location).toBe(landing);
    expect(signInOutcome(new Response(null, { status: 500 }), config).location).toBe(landing);
    expect(signInOutcome(new Response(null, { status: 200 }), config).location).toBe(landing);
    expect(signInOutcome(new Response(null, { status: 302 }), config).location).toBe(landing);
    expect(signInOutcome(redirect("https://evil.example/"), config).location).toBe(landing);
    expect(signInOutcome(redirect(`${BASE}/somewhere`), config).location).toBe(landing);
    expect(signInOutcome(redirect("http://["), config).location).toBe(landing);
    expect(signInOutcome(new Response(null, { status: 429 }), config)).toEqual({
      location: `${BASE}/?sign_in_error=rate_limited`,
      failure: { code: "rate_limited", reason: "rate_limited" },
    });
  });
});

const TENANT = "11111111-2222-3333-4444-555555555555";
const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const token = (claims: unknown) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("what a failure's reason is worth", () => {
  it("alarms when this server, its keys or a provider failed", () => {
    for (const reason of [
      "internal_server_error",
      "invalid_code",
      "unable_to_create_user",
      "unable_to_get_user_info",
      "status_500",
      "status_503",
    ]) {
      expect(isAlarming(reason), reason).toBe(true);
    }
  });

  it("does not alarm on what a stranger's link or a person going back can cause", () => {
    for (const reason of [
      "state_mismatch",
      "state_not_found",
      "no_code",
      "access_denied",
      "account_not_linked",
      "tenant_not_allowed",
      "rate_limited",
      "other",
      "exception",
      "status_400",
    ]) {
      expect(isAlarming(reason), reason).toBe(false);
    }
  });
});

describe("a Microsoft sign-in", () => {
  it("is a tenant and an object id, whatever else the token says", () => {
    const identity = microsoftIdentity(
      token({ oid: "o", tid: TENANT, name: "Ada", email: "a@example.com", email_verified: true }),
    );
    expect(identity?.data.oid).toBe(`${TENANT}:o`);
    expect(identity?.data.tid).toBe(TENANT);
    expect(identity?.user).toEqual({
      name: "Ada",
      email: microsoftAddress(TENANT, "o"),
      emailVerified: false,
    });
  });

  it("never stores a claimed address as `user.email`, or calls it verified", () => {
    const claimed = token({ oid: "o", tid: TENANT, email: "owner@example.com" });
    expect(microsoftIdentity(claimed)?.user.email).not.toContain("owner");
    expect(microsoftIdentity(token({ oid: "o", tid: TENANT }))?.user).toEqual({
      email: microsoftAddress(TENANT, "o"),
      emailVerified: false,
    });
  });

  it("gives every tenant and object id an address of its own, under a reserved domain", () => {
    const one = microsoftAddress(TENANT, "o");
    expect(one).toMatch(/^[0-9a-f]{64}@microsoft\.invalid$/);
    expect(microsoftAddress(TENANT, "o")).toBe(one);
    expect(microsoftAddress(TENANT, "p")).not.toBe(one);
    expect(microsoftAddress("other", "o")).not.toBe(one);
  });

  it("keeps a claimed address as it came, and nothing that is not one", () => {
    expect(claimedAddress({ email: "a@example.com" })).toBe("a@example.com");
    expect(claimedAddress({ email: "" })).toBeNull();
    expect(claimedAddress({ email: 5 })).toBeNull();
    expect(claimedAddress({ email: "x".repeat(321) })).toBeNull();
    expect(claimedAddress({})).toBeNull();
    expect(claimedAddress(null)).toBeNull();
  });

  it("is nobody without both ids, or without a token", () => {
    for (const claims of [
      { tid: TENANT },
      { oid: "o" },
      { oid: "", tid: TENANT },
      { oid: "o", tid: "" },
      { oid: 1, tid: TENANT },
      { oid: "o", tid: null },
      "text",
      null,
    ]) {
      expect(microsoftIdentity(token(claims)), JSON.stringify(claims)).toBeNull();
    }
    expect(microsoftIdentity(undefined)).toBeNull();
    expect(microsoftIdentity("not-a-jwt")).toBeNull();
    expect(idTokenClaims("a.%%%.b")).toBeNull();
  });

  it("is not reached through the provider's own reading", async () => {
    const built = socialProviderOptions(config);
    const identity = await built.microsoft?.getUserInfo({
      idToken: token({ oid: "o", tid: TENANT, email_verified: true }),
    });
    expect(identity?.user.emailVerified).toBe(false);
    expect(built.google).not.toHaveProperty("getUserInfo");
  });
});

describe("the tenant of a Microsoft sign-in", () => {
  const other = "99999999-9999-9999-9999-999999999999";

  it.each([
    ["common", TENANT, true],
    ["common", CONSUMER_TENANT, true],
    ["organizations", TENANT, true],
    ["organizations", CONSUMER_TENANT, false],
    ["organizations", CONSUMER_TENANT.toUpperCase(), false],
    ["consumers", CONSUMER_TENANT, true],
    ["consumers", TENANT, false],
    [TENANT, TENANT, true],
    [TENANT, TENANT.toUpperCase(), true],
    [TENANT.toUpperCase(), TENANT, true],
    [TENANT, other, false],
    [TENANT, CONSUMER_TENANT, false],
  ])("%s, a token of %s: %s", (mode, tid, admitted) => {
    expect(tenantAdmitted(mode, tid)).toBe(admitted);
  });

  it("admits no token without a tenant, in any mode", () => {
    for (const mode of ["common", "organizations", "consumers", TENANT]) {
      for (const tid of [undefined, null, 1, {}]) expect(tenantAdmitted(mode, tid)).toBe(false);
    }
  });

  it("refuses by the install's variable, and only for Microsoft", () => {
    const company = testConfig({ ...KEYS, MICROSOFT_TENANT_ID: TENANT });
    const signIn = (providerId: string, profile?: Record<string, unknown>) =>
      tenantRefusal({ oauth: { providerId, profile } }, company);
    expect(signIn("microsoft", { tid: TENANT })).toBeUndefined();
    expect(signIn("microsoft", { tid: other })).toEqual({ error: "tenant_not_allowed" });
    expect(signIn("microsoft")).toEqual({ error: "tenant_not_allowed" });
    expect(signIn("google", { tid: other })).toBeUndefined();
    expect(tenantRefusal({}, company)).toBeUndefined();
  });
});

describe("the provider addresses", () => {
  /** Better Auth's own provider objects, built as the server builds them. */
  async function providers(env: Record<string, string>) {
    const built = loadConfig({ ...VALID_ENV, ...KEYS, ...env });
    const auth = betterAuth(authOptions(built, {} as Db, createLogger("silent")));
    return (await auth.$context).socialProviders;
  }

  /** Every name a misconfiguration or an attacker might try. */
  const HIJACK = Object.fromEntries(
    [
      "GOOGLE_AUTHORIZATION_ENDPOINT",
      "GOOGLE_AUTHORIZATION_URL",
      "GOOGLE_TOKEN_ENDPOINT",
      "GOOGLE_TOKEN_URL",
      "GOOGLE_ISSUER",
      "GOOGLE_AUTHORITY",
      "GOOGLE_BASE_URL",
      "GOOGLE_REDIRECT_URI",
      "MICROSOFT_AUTHORITY",
      "MICROSOFT_AUTHORIZATION_ENDPOINT",
      "MICROSOFT_TOKEN_ENDPOINT",
      "MICROSOFT_ISSUER",
      "MICROSOFT_BASE_URL",
      "MICROSOFT_REDIRECT_URI",
      "OAUTH_PROXY",
      "OIDC_ISSUER",
      "OIDC_FAKE",
      "FAKE_OIDC_PORT",
      "AUTH_PROVIDER_URL",
      "NODE_ENV",
    ].map((name) => [name, "https://evil.example"]),
  );

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("holds no address, in any option, for any environment", () => {
    const options = socialProviderOptions(loadConfig({ ...VALID_ENV, ...KEYS, ...HIJACK }));
    expect(Object.keys(options.google ?? {}).sort()).toEqual([
      "clientId",
      "clientSecret",
      "disableIdTokenSignIn",
      "prompt",
    ]);
    expect(Object.keys(options.microsoft ?? {}).sort()).toEqual([
      "clientId",
      "clientSecret",
      "disableDefaultScope",
      "disableIdTokenSignIn",
      "getUserInfo",
      "prompt",
      "scope",
      "tenantId",
    ]);
    expect(JSON.stringify(options)).not.toContain("evil.example");
  });

  it("goes to Google and Microsoft, whatever the environment says", async () => {
    const [google, microsoft] = await providers(HIJACK);
    const request = {
      state: "s",
      codeVerifier: "v",
      redirectURI: `${BASE}/api/auth/callback/x`,
    };
    const start = async (provider: typeof google) => {
      const url = await provider?.createAuthorizationURL(request);
      return url && `${url.origin}${url.pathname}`;
    };
    expect(await start(google)).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(await start(microsoft)).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );

    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: Request | string | URL) => {
      asked.push(input instanceof Request ? input.url : String(input));
      return Response.json({ access_token: "t", token_type: "Bearer" });
    });
    const exchange = { code: "c", codeVerifier: "v", redirectURI: request.redirectURI };
    await google?.validateAuthorizationCode(exchange);
    await microsoft?.validateAuthorizationCode(exchange);
    expect(asked).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    ]);
  });

  it("puts only a checked tenant in Microsoft's address", async () => {
    const [, microsoft] = await providers({
      MICROSOFT_TENANT_ID: "11111111-2222-3333-4444-555555555555",
    });
    const url = await microsoft?.createAuthorizationURL({
      state: "s",
      codeVerifier: "v",
      redirectURI: `${BASE}/x`,
    });
    expect(url?.pathname).toBe("/11111111-2222-3333-4444-555555555555/oauth2/v2.0/authorize");
  });

  it("reads no variable that names an address beyond the ones it always had", () => {
    const source = readFileSync(fileURLToPath(new URL("./config.ts", import.meta.url)), "utf8");
    const names = [...source.matchAll(/^ {2}([A-Z][A-Z0-9_]+): /gm)].map((match) => match[1]);
    const addresses = new Set(
      names.filter((name) => /URL|URI|ENDPOINT|AUTHORITY|ISSUER|HOST|DSN|PROXY/.test(name ?? "")),
    );
    expect([...addresses].sort()).toEqual([
      "BASE_URL",
      "DATABASE_URL",
      "REDIS_URL",
      "SENTRY_DSN",
      "TRUST_PROXY",
      "UMAMI_URL",
    ]);
  });

  it("keeps the stand-in out of everything that ships", () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      (file) => file.endsWith(".ts") && !/\.test\.ts$|^fake-oidc/.test(file),
    );
    expect(files.length).toBeGreaterThan(20);
    const importers = files.filter((file) =>
      readFileSync(join(root, file), "utf8").includes("fake-oidc"),
    );
    // A comment in `social-sign-in.ts` names it; no import does.
    expect(importers).toEqual(["social-sign-in.ts"]);
    expect(readFileSync(join(root, "social-sign-in.ts"), "utf8")).not.toMatch(
      /from "\.\/fake-oidc/,
    );
    const bundled = readFileSync(join(root, "..", "tsdown.config.ts"), "utf8");
    expect(bundled).toContain('entry: ["src/main.ts"]');
  });
});
