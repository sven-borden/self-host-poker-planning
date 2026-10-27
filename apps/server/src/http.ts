/**
 * Checks and answers every app-owned `/api/*` route shares (identity, rooms): the Origin
 * check on a state-changing request, the JSON body check, the client address of the rate
 * limits and the `rate_limited` answer.
 */
import type { IncomingMessage } from "node:http";
import type { Context } from "hono";
import type { AppEnv } from "./app.ts";
import { clientIp } from "./client-ip.ts";
import type { Config } from "./config.ts";

/**
 * True when a request comes from another site's page: a browser always sends `Origin` on
 * a POST, so one that differs from `BASE_URL` is refused (`not_allowed`, 403). A request
 * without `Origin` is not a browser's and carries no visitor's cookie by accident.
 */
export function foreignOrigin(c: Context<AppEnv>, config: Config): boolean {
  const origin = c.req.header("origin");
  return origin !== undefined && origin !== config.baseUrl;
}

/** True for a JSON body; anything else is `bad_payload` (415) and is never read. */
export function isJsonBody(c: Context<AppEnv>): boolean {
  return c.req.header("content-type")?.toLowerCase().startsWith("application/json") === true;
}

/** The client address of a request, as every rate limit sees it (`TRUST_PROXY` hops). */
export function requestIp(c: Context<AppEnv>, config: Config): string | undefined {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  return incoming ? clientIp(incoming, config.trustProxy) : undefined;
}

/** The 429 answer, with the seconds to wait in `Retry-After` (60 when unknown). */
export function rateLimited(c: Context<AppEnv>, retryAfter: number | null | undefined) {
  c.header("Retry-After", String(retryAfter ?? 60));
  c.header("Cache-Control", "no-store");
  return c.json({ code: "rate_limited" }, 429);
}
