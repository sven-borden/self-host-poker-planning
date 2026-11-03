import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { anonymous } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { sessionKey, signedSessionToken } from "./session-cookie.ts";
import { VALID_ENV } from "./test-support.ts";

const SECRET = VALID_ENV.BETTER_AUTH_SECRET;
const NAME = "pp.session_token";
const BASE = "http://localhost:3000";

/** A guest signed in by Better Auth itself, in memory: the cookie header it set, and its token. */
async function signedByBetterAuth(): Promise<{ cookie: string; token: string }> {
  const auth = betterAuth({
    baseURL: BASE,
    secret: SECRET,
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    plugins: [anonymous()],
    advanced: { cookiePrefix: "pp" },
    telemetry: { enabled: false },
    logger: { disabled: true },
  });
  const response = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/anonymous`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: "{}",
    }),
  );
  const cookie = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${NAME}=`))
    ?.split(";")[0];
  const { token } = (await response.json()) as { token?: string };
  if (!cookie || !token) throw new Error("sign-in gave no session");
  return { cookie, token };
}

/** `token.signature` as better-call signs it, URI-encoded. */
const sign = (token: string, secret = SECRET) =>
  encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);

describe("signedSessionToken", () => {
  it("reads the token from a cookie Better Auth signed", async () => {
    const { cookie, token } = await signedByBetterAuth();
    // URI-encoded as Better Auth sends it: the signature's `=` and maybe `+` or `/`.
    expect(cookie).toContain("%3D");
    expect(signedSessionToken(`a=1; ${cookie}; b=2`, NAME, SECRET)).toBe(token);
    expect(signedSessionToken(cookie, NAME, `${SECRET}x`)).toBeNull();
    expect(signedSessionToken(cookie, `__Host-${NAME}`, SECRET)).toBeNull();
  });

  it("refuses a value whose signature does not hold", () => {
    const good = sign("abc");
    expect(signedSessionToken(`${NAME}=${good}`, NAME, SECRET)).toBe("abc");
    expect(signedSessionToken(`${NAME}=${sign("abc", "other")}`, NAME, SECRET)).toBeNull();
    expect(signedSessionToken(`${NAME}=${good.replace("abc", "abd")}`, NAME, SECRET)).toBeNull();
    expect(signedSessionToken(`${NAME}=x`, NAME, SECRET)).toBeNull();
    expect(signedSessionToken(`${NAME}=abc.forgedsignature`, NAME, SECRET)).toBeNull();
    expect(signedSessionToken(`${NAME}=.${"A".repeat(43)}=`, NAME, SECRET)).toBeNull();
    expect(signedSessionToken(`${NAME}=abc.${"A".repeat(43)}=`, NAME, SECRET)).toBeNull();
    expect(signedSessionToken(`${NAME}=`, NAME, SECRET)).toBeNull();
    expect(signedSessionToken(undefined, NAME, SECRET)).toBeNull();
    expect(signedSessionToken("", NAME, SECRET)).toBeNull();
  });

  it("reads the cookie's exact name, the first of two, quoted or not", () => {
    const good = sign("abc");
    expect(signedSessionToken(`x${NAME}=${good}`, NAME, SECRET)).toBeNull();
    expect(signedSessionToken(`${NAME}_data=${good}`, NAME, SECRET)).toBeNull();
    expect(signedSessionToken(`a=${NAME}=${good}`, NAME, SECRET)).toBeNull();
    expect(signedSessionToken(`junk; ${NAME}="${good}"`, NAME, SECRET)).toBe("abc");
    expect(signedSessionToken(`${NAME}=x; ${NAME}=${good}`, NAME, SECRET)).toBeNull();
    expect(signedSessionToken(`${NAME}=${good}; ${NAME}=x`, NAME, SECRET)).toBe("abc");
    expect(signedSessionToken(`__Host-${NAME}=${good}`, `__Host-${NAME}`, SECRET)).toBe("abc");
    // A broken escape is read as it stands, as better-call does, and fails the signature.
    expect(signedSessionToken(`${NAME}=%E0${good}`, NAME, SECRET)).toBeNull();
  });
});

describe("sessionKey", () => {
  it("is a hash of the token, not the token", () => {
    expect(sessionKey("abc")).toBe(sessionKey("abc"));
    expect(sessionKey("abc")).not.toBe(sessionKey("abd"));
    expect(sessionKey("abc")).not.toContain("abc");
    expect(sessionKey("abc")).toMatch(/^[\w-]{43}$/);
  });
});
