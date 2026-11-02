/**
 * Sign-in with Google and Microsoft (#47, ADR-023): the parts of it that are ours. Better Auth
 * runs the OAuth flow; this file says what it may be asked and what comes back.
 *
 * - **In.** The page posts `{ provider, returnTo }`. Nothing else in Better Auth's body
 *   (`idToken`, `scopes`, `additionalData`, `errorCallbackURL` …) can come from a request:
 *   `signInRequest` builds it. A return target is `/` or a room's path, so it cannot leave
 *   the site, and it stays in the `verification` row: only a random `state` goes to the
 *   provider, never a room's code.
 * - **Providers.** Their addresses are the ones in Better Auth's code. No variable, header or
 *   option here can move them: `socialProviderOptions` sets none of `authority`,
 *   `authorizationEndpoint`, `tokenEndpoint` or `redirectURI`, which a test holds. Tests
 *   answer for the providers by replacing `fetch` in their own process (`fake-oidc.ts`).
 * - **Back.** The callback is a page the person sees, so every outcome is a redirect to the
 *   app, with a code in `SIGN_IN_ERROR_PARAM` when it failed: never JSON, never Better Auth's
 *   `error_description`, which a provider or a crafted link can fill with anything.
 */
import { isRoomCode } from "@pp/domain";
import { SIGN_IN_ERROR_PARAM, type SignInErrorCode } from "@pp/protocol";
import { z } from "zod";
import { type Config, socialProviderIds } from "./config.ts";

/**
 * Starting a sign-in, per client address: each start writes a `verification` row. A team of
 * 30 behind one office address signing in together passes; a loop gets one every 2 s.
 */
export const SOCIAL_SIGN_IN_LIMIT = { window: 60, max: 30 } as const;

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
        disableProfilePhoto: true,
        disableIdTokenSignIn: true,
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

/** Where a sign-in may return to: the landing page or a room, as a path of this site. */
export function isReturnPath(path: string): boolean {
  return path === "/" || (path.startsWith("/r/") && isRoomCode(path.slice(3)));
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
const OWN_MESSAGE: Readonly<Record<string, SignInErrorCode>> = {
  access_denied: "cancelled",
  account_not_linked: "account_exists",
  email_not_found: "no_email",
};

/**
 * Better Auth's and the providers' reasons a log line may name, for someone setting up the
 * keys (`invalid_code` is usually a wrong secret). The `error` of a callback's query comes from
 * outside: only a word on this list reaches a log.
 */
const LOGGED_REASONS: ReadonlySet<string> = new Set([
  "access_denied",
  "account_not_linked",
  "email_not_found",
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
  "temporarily_unavailable",
  "unable_to_create_session",
  "unable_to_create_user",
  "unable_to_get_user_info",
  "unable_to_link_account",
]);

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
    code: OWN_MESSAGE[error] ?? "failed",
    reason: LOGGED_REASONS.has(error) ? error : "other",
  });
}
