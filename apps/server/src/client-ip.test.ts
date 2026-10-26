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
    expect(clientIp(request("203.0.113.9"), true)).toBe("203.0.113.9");
    // The left entries come from the client and can be forged.
    expect(clientIp(request("1.1.1.1, 198.51.100.7"), true)).toBe("198.51.100.7");
    expect(clientIp(request(["6.6.6.6", "198.51.100.7 "]), true)).toBe("198.51.100.7");
    expect(clientIp(request("1.1.1.1, 2001:db8::1"), true)).toBe("2001:db8::1");
    expect(clientIp(request("1.1.1.1,,  "), true)).toBe("1.1.1.1");
  });

  it("uses the socket address without a trusted proxy, whatever the header says", () => {
    expect(clientIp(request("203.0.113.9"), false)).toBe("10.0.0.5");
    expect(clientIp(request(undefined), false)).toBe("10.0.0.5");
  });

  it("falls back to the socket address when the header is missing or not an address", () => {
    expect(clientIp(request(undefined), true)).toBe("10.0.0.5");
    expect(clientIp(request(""), true)).toBe("10.0.0.5");
    expect(clientIp(request("1.1.1.1, unknown"), true)).toBe("10.0.0.5");
    expect(clientIp(request("1.1.1.1, 198.51.100.7:4711"), true)).toBe("10.0.0.5");
  });

  it("strips the IPv4-mapped IPv6 prefix and answers undefined without a socket", () => {
    expect(clientIp(request(undefined, "::ffff:192.0.2.1"), false)).toBe("192.0.2.1");
    expect(clientIp(request("::FFFF:192.0.2.2"), true)).toBe("192.0.2.2");
    expect(clientIp(request(undefined, "::1"), false)).toBe("::1");
    expect(clientIp({ headers: {}, socket: {} }, false)).toBeUndefined();
    expect(fromNode).toBeTypeOf("function");
  });
});
