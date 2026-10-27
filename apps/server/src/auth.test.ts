/** The pure parts of identity: error codes, token stripping and cookie names. */
import { describe, expect, it } from "vitest";
import { AUTH_ROUTES, authErrorCode, cookieNaming, withoutTokens } from "./auth.ts";

describe("authErrorCode", () => {
  it("maps Better Auth's answers to the app's codes", () => {
    expect(authErrorCode(500, "FAILED_TO_GET_SESSION")).toBe("internal");
    expect(authErrorCode(503, undefined)).toBe("internal");
    expect(authErrorCode(429, undefined)).toBe("rate_limited");
    expect(authErrorCode(401, "UNAUTHORIZED")).toBe("unauthenticated");
    expect(authErrorCode(403, "INVALID_ORIGIN")).toBe("not_allowed");
    expect(authErrorCode(400, "ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY")).toBe(
      "not_allowed",
    );
    expect(authErrorCode(400, "VALIDATION_ERROR")).toBe("bad_payload");
    expect(authErrorCode(415, undefined)).toBe("bad_payload");
  });
});

describe("withoutTokens", () => {
  it("drops every token key, however deep, and keeps the rest", () => {
    expect(
      withoutTokens({
        token: "t1",
        user: { id: "u1", name: "Ada" },
        session: { id: "s1", token: "t2", nested: [{ token: "t3", keep: 1 }] },
      }),
    ).toEqual({ user: { id: "u1", name: "Ada" }, session: { id: "s1", nested: [{ keep: 1 }] } });
    expect(withoutTokens(null)).toBeNull();
    expect(withoutTokens("token")).toBe("token");
  });
});

describe("cookieNaming", () => {
  it("uses __Host- on https only", () => {
    expect(cookieNaming("https://poker.example.com")).toEqual({
      secure: true,
      sessionCookie: "__Host-pp.session_token",
    });
    expect(cookieNaming("http://localhost:3000")).toEqual({
      secure: false,
      sessionCookie: "pp.session_token",
    });
  });
});

describe("AUTH_ROUTES", () => {
  it("forwards three endpoints and nothing that lists or edits sessions or users", () => {
    expect([...AUTH_ROUTES].sort()).toEqual([
      "GET /get-session",
      "POST /sign-in/anonymous",
      "POST /sign-out",
    ]);
  });
});
