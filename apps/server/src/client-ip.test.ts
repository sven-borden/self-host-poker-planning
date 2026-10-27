import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
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
    expect(clientIp(request("1.1.1.1, 2001:db8::1"), 1)).toBe("2001:db8::");
    expect(clientIp(request("1.1.1.1,,  "), 1)).toBe("1.1.1.1");
  });

  it("counts the trusted proxies from the right", () => {
    // A TLS proxy appended the client, then Traefik appended the TLS proxy.
    expect(clientIp(request("203.0.113.9, 172.18.0.2"), 2)).toBe("203.0.113.9");
    expect(clientIp(request("6.6.6.6, 203.0.113.9, 172.18.0.2"), 2)).toBe("203.0.113.9");
    expect(clientIp(request(["6.6.6.6, 203.0.113.9", "172.18.0.2"]), 2)).toBe("203.0.113.9");
    expect(clientIp(request("2001:db8::7, 10.1.1.1, 172.18.0.2"), 3)).toBe("2001:db8::");
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
    expect(clientIp(request(undefined, "::1"), 0)).toBe("::");
    expect(clientIp({ headers: {}, socket: {} }, 0)).toBeUndefined();
    expect(fromNode).toBeTypeOf("function");
  });

  it("keys an IPv6 client by its /64 network, so rotating addresses gains nothing", () => {
    const key = (address: string) => clientIp(request(undefined, address), 0);
    // The same /64, whichever the host part and the spelling.
    for (const same of [
      "2001:db8:0:1::1",
      "2001:db8:0:1:ffff:ffff:ffff:ffff",
      "2001:DB8:0:1:abcd:ef01:2345:6789",
      "2001:0db8:0000:0001:0000:0000:0000:0002",
      "2001:db8:0:1::",
    ]) {
      expect(key(same), same).toBe("2001:db8:0:1::");
    }
    // Another /64 is another key.
    expect(key("2001:db8:0:2::1")).toBe("2001:db8:0:2::");
    expect(key("2001:db8:1:1::1")).toBe("2001:db8:1:1::");
    // Compressed forms, trailing zero groups of the prefix dropped.
    expect(key("2001:db8::1")).toBe("2001:db8::");
    expect(key("2001:db8:0:0:5::1")).toBe("2001:db8::");
    expect(key("2001:db8:0:1::")).toBe("2001:db8:0:1::");
    expect(key("1::")).toBe("1::");
    expect(key("::1")).toBe("::");
    expect(key("::")).toBe("::");
    expect(key("0:0:0:0:0:0:0:1")).toBe("::");
    expect(key("fe80::ffff:1:2:3")).toBe("fe80::");
    // The key is itself an IPv6 address.
    for (const address of ["2001:db8:0:1::1", "::1", "1::", "ffff:ffff:ffff:ffff::2"]) {
      expect(isIP(key(address) ?? ""), address).toBe(6);
    }
  });

  it("drops a zone id before keying", () => {
    expect(clientIp(request(undefined, "fe80::1%eth0"), 0)).toBe("fe80::");
    expect(clientIp(request("fe80::abcd:1%en0"), 1)).toBe("fe80::");
    // A zone id on a name or on nothing is no address.
    expect(clientIp(request("1.1.1.1, nothere%eth0"), 1)).toBe("10.0.0.5");
    expect(clientIp(request("%eth0"), 1)).toBe("10.0.0.5");
  });

  it("treats every spelling of an IPv4-mapped IPv6 address as the IPv4 address", () => {
    for (const mapped of [
      "::ffff:192.0.2.1",
      "::FFFF:192.0.2.1",
      "0:0:0:0:0:ffff:192.0.2.1",
      "::ffff:c000:201",
      "::ffff:C000:0201",
      "0000:0000:0000:0000:0000:ffff:c000:0201",
      "::ffff:192.0.2.1%eth0",
    ]) {
      expect(clientIp(request(undefined, mapped), 0), mapped).toBe("192.0.2.1");
    }
    expect(clientIp(request("::ffff:198.51.100.254"), 1)).toBe("198.51.100.254");
    expect(clientIp(request(undefined, "::ffff:0.0.0.0"), 0)).toBe("0.0.0.0");
    // Not mapped: another prefix (NAT64) or the IPv4-compatible form stays IPv6.
    expect(clientIp(request(undefined, "64:ff9b::192.0.2.1"), 0)).toBe("64:ff9b::");
    expect(clientIp(request(undefined, "::192.0.2.1"), 0)).toBe("::");
    expect(clientIp(request(undefined, "::fffe:c000:201"), 0)).toBe("::");
  });
});
