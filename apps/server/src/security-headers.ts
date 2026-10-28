/**
 * The security headers of every response the server sends (#36, architecture section 8):
 * the web app, the API, the static files, the 404s and Socket.IO's own HTTP answers. The
 * Content Security Policy is built here and nowhere else, from the config: `BASE_URL`
 * (https adds HSTS and `upgrade-insecure-requests`), `CSP_REPORT_ONLY` and
 * `CSP_EXTRA_SOURCES`. Opt-in services (#40: Sentry, Umami) add their origins through
 * `extra` the same way.
 */

/** The fetch directives an extra origin may be added to; every other one stays fixed. */
export const CSP_EXTENSIBLE_DIRECTIVES = [
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "frame-src",
  "media-src",
] as const;
export type CspDirective = (typeof CSP_EXTENSIBLE_DIRECTIVES)[number];
/** Extra origins per directive, such as `{ "script-src": ["https://stats.example.com"] }`. */
export type CspSources = Readonly<Partial<Record<CspDirective, readonly string[]>>>;

/**
 * One origin a self-hoster may add: a scheme (`https`, `http`, `wss`, `ws`), a host (its
 * left-most label may be `*`) and an optional port. No path, no keyword (`'unsafe-inline'`
 * and its kin), no bare scheme such as `https:`: each would open the policy wide.
 */
export const CSP_SOURCE_PATTERN =
  /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

/**
 * Parses `CSP_EXTRA_SOURCES`: directives separated by `;`, each a directive name followed
 * by origins separated by spaces, such as
 * `script-src https://stats.example.com; connect-src https://stats.example.com`. Returns
 * null when a directive is not one of `CSP_EXTENSIBLE_DIRECTIVES`, names no origin, or an
 * origin does not match `CSP_SOURCE_PATTERN`.
 */
export function parseCspSources(value: string): CspSources | null {
  const sources: Partial<Record<CspDirective, string[]>> = {};
  for (const part of value.split(";")) {
    const [name, ...origins] = part.trim().split(/\s+/);
    if (!name) continue;
    const directive = name.toLowerCase();
    if (!(CSP_EXTENSIBLE_DIRECTIVES as readonly string[]).includes(directive)) return null;
    if (origins.length === 0 || !origins.every((o) => CSP_SOURCE_PATTERN.test(o))) return null;
    const list = (sources[directive as CspDirective] ??= []);
    for (const origin of origins) if (!list.includes(origin)) list.push(origin);
  }
  return sources;
}

export interface PolicyOptions {
  /** The public origin (`BASE_URL`); `https:` turns on HSTS and the upgrade. */
  readonly baseUrl: string;
  /** Sends the policy as `Content-Security-Policy-Report-Only` (`CSP_REPORT_ONLY`). */
  readonly reportOnly?: boolean;
  /** Origins added to the extensible directives (`CSP_EXTRA_SOURCES`, #40's services). */
  readonly extra?: CspSources;
}

/**
 * The policy. No inline script, no `eval`, no inline style element or attribute: the web
 * app loads everything from its own origin. React's `style` props and the Web Animations
 * API write through the CSSOM, which no policy blocks; the few style sheets a library
 * builds at run time are constructed sheets (`apps/web/src/csp/`). `connect-src` names
 * the socket's `ws(s)://` origin as well as `'self'`, for browsers that do not match
 * WebSockets with `'self'`. `upgrade-insecure-requests` is left out of a report-only
 * policy, where browsers ignore it with a console warning.
 */
export function contentSecurityPolicy({
  baseUrl,
  reportOnly = false,
  extra = {},
}: PolicyOptions): string {
  const https = baseUrl.startsWith("https:");
  const base: Record<string, readonly string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "style-src": ["'self'"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", baseUrl.replace(/^http/, "ws")],
  };
  for (const directive of CSP_EXTENSIBLE_DIRECTIVES) {
    const added = extra[directive];
    if (!added?.length) continue;
    base[directive] = [...new Set([...(base[directive] ?? ["'self'"]), ...added])];
  }
  const fixed: Record<string, readonly string[]> = {
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const parts = Object.entries({ ...base, ...fixed }).map(
    ([name, values]) => `${name} ${values.join(" ")}`,
  );
  if (https && !reportOnly) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

/**
 * Every powerful feature the app never uses, turned off for this page and anything it
 * embeds; `clipboard-write` stays on for this origin (the room link's copy button, #34's
 * exports). Only features Chromium knows: an unknown one is a console error there.
 */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "browsing-topics=()",
  "camera=()",
  "clipboard-read=()",
  "clipboard-write=(self)",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

/** HSTS for a year, subdomains included; no `preload`: that is the domain owner's call. */
export const HSTS = "max-age=31536000; includeSubDomains";

/**
 * The headers every response carries, built once at start. `Referrer-Policy: same-origin`
 * keeps a room's URL, whose code is a bearer capability, out of the `Referer` of every
 * link that leaves the app (a Jira subject link).
 */
export function securityHeaders(options: PolicyOptions): Readonly<Record<string, string>> {
  const csp = options.reportOnly
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";
  return Object.freeze({
    [csp]: contentSecurityPolicy(options),
    ...(options.baseUrl.startsWith("https:") && { "Strict-Transport-Security": HSTS }),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
}
