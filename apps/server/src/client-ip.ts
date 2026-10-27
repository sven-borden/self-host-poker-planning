/**
 * The client's address for rate limits (architecture section 8), never for logs: there is
 * no tracking by default. Each reverse proxy appends the address it received the request
 * from to `X-Forwarded-For`, so behind N proxies (`TRUST_PROXY=N`; `true` is 1, Traefik
 * alone, the default) the client is the N-th entry from the right. With two (a TLS proxy,
 * then Traefik) the right-most entry is the first proxy, the same for everybody, and the
 * client is the one before it. Entries further left come from the client and can be
 * forged. Without a trusted proxy (`TRUST_PROXY=false` or 0) it is the socket's peer
 * address.
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

/**
 * The client's IP address, or `undefined` when the socket is already gone. `proxies` is
 * `config.trustProxy`: how many trusted proxies appended to `X-Forwarded-For`.
 */
export function clientIp(request: PeerRequest, proxies: number): string | undefined {
  const peer = address(request.socket.remoteAddress);
  if (proxies < 1) return peer;
  const header = request.headers["x-forwarded-for"];
  const joined = typeof header === "string" ? header : header?.join(",");
  const entries = joined
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // Fewer entries than proxies, or an entry that is not an address, means a proxy chain
  // other than the configured one: fall back to the socket rather than guess.
  const entry = entries && entries.length >= proxies ? entries.at(-proxies) : undefined;
  return address(entry) ?? peer;
}

/** An IP address with an IPv4-mapped IPv6 prefix removed, or `undefined` if not one. */
function address(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mapped = value.toLowerCase().startsWith("::ffff:") ? value.slice(7) : undefined;
  if (mapped && isIP(mapped) === 4) return mapped;
  return isIP(value) ? value : undefined;
}
