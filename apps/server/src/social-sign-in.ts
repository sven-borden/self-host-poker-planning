/**
 * Sign-in with Google and Microsoft (#47, ADR-023): the parts of it that are ours. Better Auth
 * runs the OAuth flow; this file says what it may be asked and what comes back.
 *
 * - **In.** The page posts `{ provider, returnTo }`. Nothing else in Better Auth's body
 *   (`idToken`, `scopes`, `additionalData`, `errorCallbackURL` …) can come from a request:
 *   `signInRequest` builds it. A return target is `isReturnPath`, so it cannot leave
 *   the site, and it stays in the `verification` row: only a random `state` goes to the
 *   provider, never a room's code.
 * - **Providers.** Their addresses are the ones in Better Auth's code. No variable, header or
 *   option here can move them: `socialProviderOptions` sets none of `authority`,
 *   `authorizationEndpoint`, `tokenEndpoint` or `redirectURI`, which a test holds. Tests
 *   answer for the providers by replacing `fetch` in their own process (`fake-oidc.ts`).
 * - **Who.** A provider's word on an address never makes two sign-ins one person: Better Auth's
 *   implicit linking is off (`auth.ts`). A Microsoft person is a tenant and an object id
 *   (`microsoftIdentity`), and `tenantRefusal` holds `MICROSOFT_TENANT_ID` as the boundary it is.
 * - **Back.** The callback is a page the person sees, so every outcome is a redirect to the
 *   app, with a code in `SIGN_IN_ERROR_PARAM` when it failed: never JSON, never Better Auth's
 *   `error_description`, which a provider or a crafted link can fill with anything.
 */
import { createHash } from "node:crypto";
import { isRoomCode } from "@pp/domain";
import { SIGN_IN_ERROR_PARAM, type SignInErrorCode } from "@pp/protocol";
import type { MicrosoftEntraIDProfile } from "better-auth/social-providers";
import { z } from "zod";
import { type Config, socialProviderIds } from "./config.ts";

/**
 * Starting a sign-in, per client address: each start writes a `verification` row. A team of
 * 30 behind one office address signing in together passes; a loop gets one every 2 s.
 */
export const SOCIAL_SIGN_IN_LIMIT = { window: 60, max: 30 } as const;

/** Every personal Microsoft account carries this `tid`. */
const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** Better Auth's `error` for a Microsoft account `MICROSOFT_TENANT_ID` does not admit. */
const TENANT_REFUSED = "tenant_not_allowed";

/** The claims of an id token, read and not verified: see `microsoftIdentity`. */
export function idTokenClaims(idToken: string | undefined): Record<string, unknown> | null {
  if (!idToken) return null;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString(),
    );
    return typeof claims === "object" && claims !== null ? { ...claims } : null;
  } catch {
    return null;
  }
}

/**
 * What a Microsoft account stores in `user.email`, a unique column: an address of its own under a
 * reserved domain, which no provider can claim, no mail can reach, and only this identity has.
 * So a claim nobody proved never takes the value from the person who owns the address (ADR-025).
 */
export function microsoftAddress(tid: string, oid: string): string {
  const id = createHash("sha256").update(`${tid}:${oid}`).digest("hex");
  return `${id}@microsoft.invalid`;
}

/** The address a Microsoft token claims, for `account.claimed_email`. Proof of nothing. */
export function claimedAddress(claims: Record<string, unknown> | null): string | null {
  const email = claims?.email;
  return typeof email === "string" && email !== "" && email.length <= 320 ? email : null;
}

/**
 * Who a Microsoft sign-in is. Replaces the provider's own reading, which is the only way to reach
 * what `accountSubject` reads (`profile.oid`) without touching the library, for three reasons:
 * - `oid` is unique within a tenant only, so the account id is `tid:oid`. `data.oid` carries it
 *   for that reason alone; the claims are otherwise as they came.
 * - `emailVerified` is false whatever the token says. The claim is Entra's, a tenant's admin can
 *   set an address that is not theirs, and the signature is not checked in the code flow (the
 *   token comes straight from Microsoft over TLS, which is enough to know who sent it, not that
 *   the address is true). So `user.email_verified` never says this address is proved.
 * - For that same reason the claim does not become `user.email` (`microsoftAddress`); the
 *   `account` hook in `auth.ts` keeps it beside the tenant.
 * Null without either id: Better Auth ends that as `unable_to_get_user_info`.
 */
export function microsoftIdentity(idToken: string | undefined) {
  const claims = idTokenClaims(idToken);
  const { oid, tid, name } = claims ?? {};
  if (typeof oid !== "string" || oid === "" || typeof tid !== "string" || tid === "") return null;
  return {
    user: {
      ...(typeof name === "string" && { name }),
      email: microsoftAddress(tid, oid),
      emailVerified: false,
    },
    data: { ...claims, oid: `${tid}:${oid}` } as unknown as MicrosoftEntraIDProfile,
  };
}

/** Whether `MICROSOFT_TENANT_ID` admits a token's tenant: the URL only asks, `tid` answers. */
export function tenantAdmitted(mode: string, tid: unknown): boolean {
  if (typeof tid !== "string") return false;
  const tenant = tid.toLowerCase();
  if (mode === "common") return true;
  if (mode === "organizations") return tenant !== MICROSOFT_CONSUMER_TENANT;
  if (mode === "consumers") return tenant === MICROSOFT_CONSUMER_TENANT;
  return tenant === mode.toLowerCase();
}

/**
 * For Better Auth's `validateUserInfo`, which it runs on a first sign-in, a link and each later
 * sign-in, before any write. A refusal is a redirect to the return path with this code, not an
 * exception: anyone with a Microsoft account of another tenant can cause one.
 */
export function tenantRefusal(
  { oauth }: { oauth?: { providerId: string; profile?: Record<string, unknown> | undefined } },
  { socialProviders: { microsoft } }: Config,
): { error: string } | undefined {
  if (oauth?.providerId !== "microsoft" || !microsoft) return undefined;
  return tenantAdmitted(microsoft.tenantId, oauth.profile?.tid)
    ? undefined
    : { error: TENANT_REFUSED };
}

/**
 * Better Auth's options for each configured provider. What is asked of them is what sign-in
 * needs and no more: a name and an email, no `offline_access`, no Microsoft Graph (nothing here
 * calls a provider after sign-in), and no profile photo, which the policy would refuse anyway.
 * `select_account`: after signing out, the next person at this browser gets a choice.
 */
export function socialProviderOptions({ socialProviders: { google, microsoft } }: Config) {
  return {
    ...(google && {
      google: {
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        prompt: "select_account" as const,
        disableIdTokenSignIn: true,
      },
    }),
    ...(microsoft && {
      microsoft: {
        clientId: microsoft.clientId,
        clientSecret: microsoft.clientSecret,
        tenantId: microsoft.tenantId,
        prompt: "select_account" as const,
        disableDefaultScope: true,
        scope: ["openid", "profile", "email"],
        disableIdTokenSignIn: true,
        getUserInfo: async ({ idToken }: { idToken?: string | undefined }) =>
          microsoftIdentity(idToken),
      },
    }),
  };
}

/** The Better Auth routes sign-in adds, as `METHOD path`: none without a provider. */
export function socialRoutes(config: Config): string[] {
  const ids = socialProviderIds(config);
  if (ids.length === 0) return [];
  return ["POST /sign-in/social", ...ids.map((id) => `GET /callback/${id}`)];
}

/**
 * Where a sign-in may return to, as a path of this site: the landing page, "My rooms" (#49), the
 * account page (#51) or a room.
 */
export function isReturnPath(path: string): boolean {
  return (
    path === "/" ||
    path === "/rooms" ||
    path === "/account" ||
    (path.startsWith("/r/") && isRoomCode(path.slice(3)))
  );
}

/**
 * The body Better Auth gets for what the page posted, or null when that is not a provider of
 * this install and a return path. `disableRedirect`: a form post could not follow the redirect
 * to the provider under `form-action 'self'`, so the page navigates to the URL it gets back.
 */
export function signInRequest(raw: unknown, config: Config): Record<string, unknown> | null {
  const parsed = z
    .strictObject({ provider: z.string(), returnTo: z.string().max(32) })
    .safeParse(raw);
  if (!parsed.success) return null;
  const { provider, returnTo } = parsed.data;
  if (!(socialProviderIds(config) as string[]).includes(provider)) return null;
  if (!isReturnPath(returnTo)) return null;
  const target = `${config.baseUrl}${returnTo}`;
  return { provider, callbackURL: target, errorCallbackURL: target, disableRedirect: true };
}

/** Better Auth's failures a person can do something about; every other one is `failed`. */
const OWN_MESSAGE: ReadonlyMap<string, SignInErrorCode> = new Map([
  ["access_denied", "cancelled"],
  ["account_not_linked", "account_exists"],
  ["email_not_found", "no_email"],
  [TENANT_REFUSED, "tenant_not_allowed"],
]);

/**
 * Better Auth's and the providers' reasons a log line may name, for someone setting up the
 * keys (`invalid_code` is usually a wrong secret). The `error` of a callback's query comes from
 * outside: only a word on this list reaches a log.
 */
const LOGGED_REASONS: ReadonlySet<string> = new Set([
  "access_denied",
  "account_not_linked",
  "email_not_found",
  "internal_server_error",
  "invalid_code",
  "invalid_callback_request",
  "no_callback_url",
  "no_code",
  "oauth_provider_not_found",
  "server_error",
  "state_generation_error",
  "state_invalid",
  "state_mismatch",
  "state_not_found",
  TENANT_REFUSED,
  "temporarily_unavailable",
  "unable_to_create_session",
  "unable_to_create_user",
  "unable_to_get_user_info",
  "unable_to_link_account",
]);

/**
 * Reasons that point at this server, its keys or a provider's answer, which someone should look
 * at. Every other reason a stranger's link or a person going back can cause, so a line about it
 * must not reach an error report. `invalid_code` is a wrong secret's signal: forging one takes a
 * started sign-in, so the limit on those bounds it.
 */
const ALARMING_REASONS: ReadonlySet<string> = new Set([
  "bad_redirect",
  "internal_server_error",
  "invalid_code",
  "no_callback_url",
  "unable_to_create_session",
  "unable_to_create_user",
  "unable_to_get_user_info",
  "unable_to_link_account",
]);

/** Whether a failure's `reason` is for an error report. A thrown error has a line of its own. */
export const isAlarming = (reason: string) =>
  ALARMING_REASONS.has(reason) || /^status_5/.test(reason);

export interface SignInOutcome {
  /** Where the person goes: an absolute URL on this site. */
  readonly location: string;
  /** Absent when the sign-in worked. `reason` is safe to log. */
  readonly failure?: { readonly code: SignInErrorCode; readonly reason: string };
}

/** `path` of the app, with the code of a failure when there is one. */
function outcome(config: Config, path: string, failure?: SignInOutcome["failure"]): SignInOutcome {
  const location = `${config.baseUrl}${path}`;
  if (!failure) return { location };
  return { location: `${location}?${SIGN_IN_ERROR_PARAM}=${failure.code}`, failure };
}

/** A sign-in to an account being deleted (#51, ADR-029): no session, and the page says why. */
export function accountGoingOutcome(config: Config): SignInOutcome {
  return outcome(config, "/", { code: "account_going", reason: "account_going" });
}

/**
 * What a provider's callback ends in, given Better Auth's answer, or null when it threw. Its
 * redirects go to the return path; a failure's carries `error` (and `error_description`, which
 * is dropped), and one with no return path known goes to `/` (`onAPIError.errorURL`).
 */
export function signInOutcome(response: Response | null, config: Config): SignInOutcome {
  const failed = { code: "failed", reason: "exception" } as const;
  if (!response) return outcome(config, "/", failed);
  if (response.status === 429) {
    return outcome(config, "/", { code: "rate_limited", reason: "rate_limited" });
  }
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) {
    return outcome(config, "/", { code: "failed", reason: `status_${response.status}` });
  }
  const target = URL.canParse(location, config.baseUrl)
    ? new URL(location, config.baseUrl)
    : undefined;
  const path =
    target?.origin === config.baseUrl && isReturnPath(target.pathname) ? target.pathname : null;
  if (path === null) return outcome(config, "/", { code: "failed", reason: "bad_redirect" });
  const error = target?.searchParams.get("error");
  if (error === null || error === undefined) return outcome(config, path);
  return outcome(config, path, {
    code: OWN_MESSAGE.get(error) ?? "failed",
    reason: LOGGED_REASONS.has(error) ? error : "other",
  });
}
