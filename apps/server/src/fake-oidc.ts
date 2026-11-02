/**
 * A stand-in for Google and Microsoft, for tests only (#47, ADR-023). Not imported by
 * `main.ts`, so never bundled and not in the image: the production server has no way to reach
 * it, and `social-sign-in.test.ts` holds that. It is a real HTTP server with the real shape of
 * an OAuth code flow: an authorize address that redirects back with a one-time code and the
 * `state`, and a token address that checks the client, the redirect URI and the PKCE verifier.
 *
 * Nothing in the app points at it. A test, in its own process, replaces `fetch` with
 * `routeProvidersTo` and sends the browser's navigation here itself: the server runs the same
 * code and addresses as in production.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Who signs in at the fake provider. */
export interface FakePerson {
  /** `sub` at Google, `oid` at Microsoft: the provider's id of the person. */
  readonly id: string;
  readonly email?: string | undefined;
  readonly name?: string;
  readonly emailVerified?: boolean;
  readonly tenant?: string;
}

/** A query parameter a test adds to the authorize address: the person, as encoded JSON. */
export const FAKE_PERSON_PARAM = "fake_person";

export const fakePersonParam = (person: FakePerson | "denied") =>
  Buffer.from(JSON.stringify(person)).toString("base64url");

/** Refreshed on a sign-in; a test finds none of them in the database or in a log. */
export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
}

export interface FakeOidc {
  readonly origin: string;
  /** The query of every authorize request, as the browser sent it. */
  readonly authorizations: URLSearchParams[];
  /** The body of every token request. */
  readonly tokenRequests: URLSearchParams[];
  /** What was handed out, for tests that look for it. */
  readonly issued: IssuedTokens[];
  /** Codes it gave the browser. */
  readonly codes: string[];
  /** True: the token address answers 500, as a provider that is down. */
  failTokens: boolean;
  /** True: the id token is not a token at all, which Better Auth's decoding throws on. */
  garbleIdTokens: boolean;
  close(): Promise<void>;
}

interface PendingCode {
  person: FakePerson;
  provider: "google" | "microsoft";
  clientId: string;
  redirectUri: string;
  challenge: string;
}

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function idToken(code: PendingCode): string {
  const { person, provider, clientId } = code;
  const claims =
    provider === "google"
      ? { iss: "https://accounts.google.com", sub: person.id, email_verified: person.emailVerified }
      : {
          iss: `https://login.microsoftonline.com/${person.tenant}/v2.0`,
          sub: `pairwise-${person.id}`,
          oid: person.id,
          tid: person.tenant,
          ...(person.emailVerified !== undefined && { email_verified: person.emailVerified }),
        };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...claims,
    aud: clientId,
    iat: now,
    exp: now + 3600,
    name: person.name,
    email: person.email,
    picture: "https://example.invalid/picture.jpg",
  };
  // The code flow reads the claims of a token it got straight from the provider.
  return `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded(payload)}.${encoded("unsigned")}`;
}

async function bodyOf(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** `port`: 0 picks a free one. */
export async function startFakeOidc(port = 0): Promise<FakeOidc> {
  const pending = new Map<string, PendingCode>();
  const state = {
    authorizations: [] as URLSearchParams[],
    tokenRequests: [] as URLSearchParams[],
    issued: [] as IssuedTokens[],
    codes: [] as string[],
    failTokens: false,
    garbleIdTokens: false,
  };

  function authorize(url: URL, response: ServerResponse) {
    const query = url.searchParams;
    const person = JSON.parse(
      Buffer.from(query.get(FAKE_PERSON_PARAM) ?? "", "base64url").toString() || "null",
    ) as FakePerson | "denied" | null;
    query.delete(FAKE_PERSON_PARAM);
    state.authorizations.push(new URLSearchParams(query));
    const back = new URL(query.get("redirect_uri") ?? "");
    back.searchParams.set("state", query.get("state") ?? "");
    if (person === "denied" || person === null) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "The person went back: not for a log");
    } else {
      const code = randomBytes(16).toString("hex");
      state.codes.push(code);
      pending.set(code, {
        person,
        provider: url.pathname.includes("/oauth2/v2.0/") ? "microsoft" : "google",
        clientId: query.get("client_id") ?? "",
        redirectUri: query.get("redirect_uri") ?? "",
        challenge: query.get("code_challenge") ?? "",
      });
      back.searchParams.set("code", code);
    }
    response.writeHead(302, { location: back.toString() });
    response.end();
  }

  function token(body: URLSearchParams, response: ServerResponse) {
    state.tokenRequests.push(body);
    if (state.failTokens) {
      json(response, 500, { error: "server_error" });
      return;
    }
    const code = pending.get(body.get("code") ?? "");
    pending.delete(body.get("code") ?? "");
    const verifier = createHash("sha256")
      .update(body.get("code_verifier") ?? "")
      .digest("base64url");
    if (
      !code ||
      body.get("grant_type") !== "authorization_code" ||
      body.get("client_id") !== code.clientId ||
      !body.get("client_secret") ||
      body.get("redirect_uri") !== code.redirectUri ||
      verifier !== code.challenge
    ) {
      json(response, 400, { error: "invalid_grant" });
      return;
    }
    const issued = {
      accessToken: `fake-access-${randomBytes(12).toString("hex")}`,
      refreshToken: `fake-refresh-${randomBytes(12).toString("hex")}`,
      idToken: state.garbleIdTokens ? "not-a-jwt" : idToken(code),
    };
    state.issued.push(issued);
    json(response, 200, {
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email profile",
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      id_token: issued.idToken,
    });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    if (request.method === "GET" && /\/(v2\/auth|authorize)$/.test(url.pathname)) {
      authorize(url, response);
    } else if (request.method === "POST" && url.pathname.endsWith("/token")) {
      void bodyOf(request).then((body) => token(body, response));
    } else {
      json(response, 404, { error: "not_found" });
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  server.unref();
  const address = server.address() as AddressInfo;
  return Object.assign(state, {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

/** The providers' addresses the server's own `fetch` goes to. */
const PROVIDER_HOSTS: ReadonlySet<string> = new Set([
  "accounts.google.com",
  "oauth2.googleapis.com",
  "login.microsoftonline.com",
]);

/** `https://accounts.google.com/…` at the fake: the same path and query. */
export function atFake(address: string, origin: string): string {
  const url = new URL(address);
  return `${origin}${url.pathname}${url.search}`;
}

/**
 * Sends this process's `fetch` for the providers to the fake, from the test's side. Anything
 * else at a Google or Microsoft address fails, so a call the app should not make shows up
 * (Microsoft Graph). Returns how to put `fetch` back.
 */
export function routeProvidersTo(origin: string): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const address = input instanceof Request ? input.url : String(input);
    const { hostname } = new URL(address);
    if (PROVIDER_HOSTS.has(hostname)) return real(atFake(address, origin), init);
    if (/(^|\.)(google|googleapis|microsoft|microsoftonline)\.com$/.test(hostname)) {
      return Promise.reject(new Error("a request to a provider the fake does not know"));
    }
    return real(input, init);
  };
  return () => {
    globalThis.fetch = real;
  };
}
