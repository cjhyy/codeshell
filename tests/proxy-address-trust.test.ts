import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

// Resolve through the actual SDK → Express chain; a patched root-only copy
// would leave Express using the vulnerable nested dependency.
const fromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const fromSdk = createRequire(
  fromCore.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js"),
);
const fromExpress = createRequire(fromSdk.resolve("express"));
const proxyAddress = fromExpress("proxy-addr") as {
  (request: object, trust: (address: string, index: number) => boolean): string;
  compile(subnet: string): (address: string, index: number) => boolean;
};

function clientAddress(remoteAddress: string, subnet: string): string {
  return proxyAddress(
    { socket: { remoteAddress }, headers: { "x-forwarded-for": "198.51.100.42" } },
    proxyAddress.compile(subnet),
  );
}

describe("Express transitive proxy-address trust boundary", () => {
  test("a short mapped-IPv6 prefix cannot trust an arbitrary IPv4 sender", () => {
    expect(clientAddress("203.0.113.10", "::ffff:10.0.0.0/8")).toBe("203.0.113.10");
  });

  test("a zero-leading IPv6 subnet cannot trust an IPv4 sender", () => {
    expect(clientAddress("203.0.113.10", "::/1")).toBe("203.0.113.10");
  });

  test("a correctly mapped subnet still trusts its private IPv4 proxy", () => {
    expect(clientAddress("10.1.2.3", "::ffff:10.0.0.0/104")).toBe("198.51.100.42");
    expect(clientAddress("203.0.113.10", "::ffff:10.0.0.0/104")).toBe("203.0.113.10");
  });

  test("plain IPv4 subnet behavior is preserved", () => {
    expect(clientAddress("10.1.2.3", "10.0.0.0/8")).toBe("198.51.100.42");
    expect(clientAddress("203.0.113.10", "10.0.0.0/8")).toBe("203.0.113.10");
  });

  test("genuine IPv6 subnet behavior is preserved", () => {
    expect(clientAddress("2001:db8::1", "2001:db8::/32")).toBe("198.51.100.42");
    expect(clientAddress("2001:db9::1", "2001:db8::/32")).toBe("2001:db9::1");
  });
});
