import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { clientIp, type PeerRequest } from "./client-ip.ts";

const request = (
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined = "10.0.0.5",
): PeerRequest => ({
  headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
  socket: { remoteAddress },
});

// A Node request (Hono's c.env.incoming, Socket.IO's socket.request) is a PeerRequest.
const fromNode = (incoming: IncomingMessage): PeerRequest => incoming;

describe("clientIp", () => {
  it("takes the right-most X-Forwarded-For entry behind a trusted proxy", () => {
    expect(clientIp(request("203.0.113.9"), 1)).toBe("203.0.113.9");
    // The left entries come from the client and can be forged.
    expect(clientIp(request("1.1.1.1, 198.51.100.7"), 1)).toBe("198.51.100.7");
    expect(clientIp(request(["6.6.6.6", "198.51.100.7 "]), 1)).toBe("198.51.100.7");
    expect(clientIp(request("1.1.1.1, 2001:db8::1"), 1)).toBe("2001:db8::1");
    expect(clientIp(request("1.1.1.1,,  "), 1)).toBe("1.1.1.1");
  });

  it("counts the trusted proxies from the right", () => {
    // A TLS proxy appended the client, then Traefik appended the TLS proxy.
    expect(clientIp(request("203.0.113.9, 172.18.0.2"), 2)).toBe("203.0.113.9");
    expect(clientIp(request("6.6.6.6, 203.0.113.9, 172.18.0.2"), 2)).toBe("203.0.113.9");
    expect(clientIp(request(["6.6.6.6, 203.0.113.9", "172.18.0.2"]), 2)).toBe("203.0.113.9");
    expect(clientIp(request("2001:db8::7, 10.1.1.1, 172.18.0.2"), 3)).toBe("2001:db8::7");
    // Fewer entries than proxies: not the configured chain, so the socket address.
    expect(clientIp(request("172.18.0.2"), 2)).toBe("10.0.0.5");
  });

  it("uses the socket address without a trusted proxy, whatever the header says", () => {
    expect(clientIp(request("203.0.113.9"), 0)).toBe("10.0.0.5");
    expect(clientIp(request(undefined), 0)).toBe("10.0.0.5");
  });

  it("falls back to the socket address when the header is missing or not an address", () => {
    expect(clientIp(request(undefined), 1)).toBe("10.0.0.5");
    expect(clientIp(request(""), 1)).toBe("10.0.0.5");
    expect(clientIp(request("1.1.1.1, unknown"), 1)).toBe("10.0.0.5");
    expect(clientIp(request("1.1.1.1, 198.51.100.7:4711"), 1)).toBe("10.0.0.5");
  });

  it("strips the IPv4-mapped IPv6 prefix and answers undefined without a socket", () => {
    expect(clientIp(request(undefined, "::ffff:192.0.2.1"), 0)).toBe("192.0.2.1");
    expect(clientIp(request("::FFFF:192.0.2.2"), 1)).toBe("192.0.2.2");
    expect(clientIp(request(undefined, "::1"), 0)).toBe("::1");
    expect(clientIp({ headers: {}, socket: {} }, 0)).toBeUndefined();
    expect(fromNode).toBeTypeOf("function");
  });
});
