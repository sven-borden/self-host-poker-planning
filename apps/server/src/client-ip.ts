/**
 * The client's address for rate limits (architecture section 8), never for logs: there is
 * no tracking by default. Each reverse proxy appends the address it received the request
 * from to `X-Forwarded-For`, so behind N proxies (`TRUST_PROXY=N`; `true` is 1, Traefik
 * alone, the default) the client is the N-th entry from the right. With two (a TLS proxy,
 * then Traefik) the right-most entry is the first proxy, the same for everybody, and the
 * client is the one before it. Entries further left come from the client and can be
 * forged. Without a trusted proxy (`TRUST_PROXY=false` or 0) it is the socket's peer
 * address. The result is a rate-limit key, not the address itself: an IPv4-mapped IPv6
 * address counts as the IPv4 one, and an IPv6 address as its /64 network.
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

/**
 * The rate-limit key of an IP address, or `undefined` if the text is none. An IPv4-mapped
 * IPv6 address (`::ffff:192.0.2.1`, or `::ffff:c000:201`) is the IPv4 address it wraps: a
 * dual-stack socket reports every IPv4 client that way. Any other IPv6 address becomes the
 * network address of its /64 (`2001:db8:0:1::`), because a client on a /64 owns 2^64
 * addresses and could otherwise take a fresh rate-limit key for every request. A zone id
 * (`fe80::1%eth0`) is dropped.
 */
function address(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bare = value.split("%", 1)[0] ?? "";
  const kind = isIP(bare);
  if (kind === 4) return bare;
  if (kind !== 6) return undefined;
  const groups = ipv6Groups(bare);
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255].join(".");
  }
  const prefix = groups.slice(0, 4).map((group) => group.toString(16));
  while (prefix.at(-1) === "0") prefix.pop();
  return prefix.length === 0 ? "::" : `${prefix.join(":")}::`;
}

type Groups = [number, number, number, number, number, number, number, number];

/**
 * The eight 16-bit groups of a valid IPv6 address: `::` expanded, a dotted IPv4 tail
 * (`::ffff:192.0.2.1`) turned into its two groups.
 */
function ipv6Groups(ip: string): Groups {
  let text = ip;
  if (ip.includes(".")) {
    const cut = ip.lastIndexOf(":") + 1;
    const [a, b, c, d] = ip.slice(cut).split(".").map(Number) as [number, number, number, number];
    text = `${ip.slice(0, cut)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = tail === undefined ? 0 : 8 - front.length - back.length;
  // A valid address has eight groups once expanded.
  return [...front, ...Array<string>(zeros).fill("0"), ...back].map((group) =>
    Number.parseInt(group, 16),
  ) as Groups;
}
