/**
 * The client's address for rate limits (architecture section 8), never for logs: there is
 * no tracking by default. Behind Traefik (`TRUST_PROXY=true`, the default) the address is
 * the right-most `X-Forwarded-For` entry, the one the proxy itself appended; entries to
 * its left come from the client and can be forged. Without a trusted proxy it is the
 * socket's peer address.
 */
import { isIP } from "node:net";

/**
 * What `clientIp` reads from a request. A Node `IncomingMessage` fits: Hono's
 * `c.env.incoming` and Socket.IO's `socket.request` are both one.
 */
export interface PeerRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: { readonly remoteAddress?: string | undefined };
}

/** The client's IP address, or `undefined` when the socket is already gone. */
export function clientIp(request: PeerRequest, trustProxy: boolean): string | undefined {
  const peer = address(request.socket.remoteAddress);
  if (!trustProxy) return peer;
  const header = request.headers["x-forwarded-for"];
  const joined = typeof header === "string" ? header : header?.join(",");
  const last = joined
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  // A right-most entry that is not an address means a misconfigured proxy: fall back.
  return address(last) ?? peer;
}

/** An IP address with an IPv4-mapped IPv6 prefix removed, or `undefined` if not one. */
function address(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mapped = value.toLowerCase().startsWith("::ffff:") ? value.slice(7) : undefined;
  if (mapped && isIP(mapped) === 4) return mapped;
  return isIP(value) ? value : undefined;
}
