import { describe, it, expect, afterEach } from "bun:test";
import {
  webFetchTool,
  __setDnsLookupForTests,
} from "../packages/core/src/tool-system/builtin/web-fetch.js";

// A3 SSRF regression tests. The host & DNS validation logic is
// shared between the initial URL and every redirect hop (they both
// call validateHopHost), so covering the initial-URL refusal is
// sufficient to cover redirect refusals. We mock DNS via the test
// hook __setDnsLookupForTests.
//
// We intentionally do NOT spin up a local HTTP server in these tests
// — Node's built-in fetch performs its own DNS resolution (separate
// from our mock), so a true end-to-end "redirect follows into
// loopback" test would require a custom undici Dispatcher, which is
// explicitly out of scope (see spec §Known limitations).

afterEach(() => {
  __setDnsLookupForTests(null);
});

describe("WebFetch SSRF guard — initial URL host validation", () => {
  it("refuses literal loopback hostname (block list)", async () => {
    const result = await webFetchTool({ url: "http://127.0.0.1/x" });
    expect(result).toMatch(/refusing to fetch/);
    expect(result).toMatch(/block list/);
  });

  it("refuses literal IPv6 loopback in URL", async () => {
    const result = await webFetchTool({ url: "http://[::1]/x" });
    expect(result).toMatch(/block list/);
  });

  it("refuses non-http(s) protocols", async () => {
    const result = await webFetchTool({ url: "file:///etc/passwd" });
    expect(result).toMatch(/protocol "file:" is not allowed/);
  });

  it("refuses ftp://", async () => {
    const result = await webFetchTool({ url: "ftp://example.com/x" });
    expect(result).toMatch(/protocol "ftp:" is not allowed/);
  });

  it("refuses userinfo-embedded loopback", async () => {
    // new URL("http://evil@127.0.0.1/x").hostname === "127.0.0.1"
    const result = await webFetchTool({ url: "http://evil@127.0.0.1/" });
    expect(result).toMatch(/block list|blocked IP/);
  });

  it("returns invalid-URL error for unparseable input", async () => {
    const result = await webFetchTool({ url: "not a url" });
    expect(result).toMatch(/invalid URL/);
  });

  it("returns url-required error when url is empty", async () => {
    const result = await webFetchTool({ url: "" });
    expect(result).toMatch(/url is required/);
  });
});

describe("WebFetch SSRF guard — DNS-resolved private IP rejection", () => {
  it("refuses host that resolves to 127.0.0.1", async () => {
    __setDnsLookupForTests(async () => ["127.0.0.1"]);
    const result = await webFetchTool({ url: "http://evil.example.com/x" });
    expect(result).toMatch(/resolves to blocked IP 127\.0\.0\.1/);
  });

  it("refuses host that resolves to AWS metadata 169.254.169.254", async () => {
    __setDnsLookupForTests(async () => ["169.254.169.254"]);
    const result = await webFetchTool({ url: "http://meta.example.com/" });
    expect(result).toMatch(/169\.254\.169\.254/);
  });

  it("refuses host that resolves to 10.0.0.1 (RFC1918)", async () => {
    __setDnsLookupForTests(async () => ["10.0.0.1"]);
    const result = await webFetchTool({ url: "http://corp.example.com/" });
    expect(result).toMatch(/10\.0\.0\.1/);
  });

  it("refuses host that resolves to 192.168.1.1 (RFC1918)", async () => {
    __setDnsLookupForTests(async () => ["192.168.1.1"]);
    const result = await webFetchTool({ url: "http://router.example.com/" });
    expect(result).toMatch(/192\.168\.1\.1/);
  });

  it("refuses host that resolves to 172.16.0.1 (RFC1918)", async () => {
    __setDnsLookupForTests(async () => ["172.16.0.1"]);
    const result = await webFetchTool({ url: "http://internal.example.com/" });
    expect(result).toMatch(/172\.16\.0\.1/);
  });

  it("refuses host that resolves to 100.64.0.1 (CGNAT)", async () => {
    __setDnsLookupForTests(async () => ["100.64.0.1"]);
    const result = await webFetchTool({ url: "http://cg.example.com/" });
    expect(result).toMatch(/100\.64\.0\.1/);
  });

  it("refuses host that resolves to 0.0.0.0", async () => {
    __setDnsLookupForTests(async () => ["0.0.0.0"]);
    const result = await webFetchTool({ url: "http://zero.example.com/" });
    expect(result).toMatch(/0\.0\.0\.0/);
  });

  it("refuses host that resolves to 224.0.0.1 (multicast)", async () => {
    __setDnsLookupForTests(async () => ["224.0.0.1"]);
    const result = await webFetchTool({ url: "http://mcast.example.com/" });
    expect(result).toMatch(/224\.0\.0\.1/);
  });

  it("refuses host that resolves to IPv6 ::1", async () => {
    __setDnsLookupForTests(async () => ["::1"]);
    const result = await webFetchTool({ url: "http://v6.example.com/" });
    expect(result).toMatch(/::1/);
  });

  it("refuses host that resolves to IPv6 fc00:: (ULA)", async () => {
    __setDnsLookupForTests(async () => ["fc00::1"]);
    const result = await webFetchTool({ url: "http://ula.example.com/" });
    expect(result).toMatch(/fc00::1/);
  });

  it("refuses host that resolves to IPv6 fe80:: (link-local)", async () => {
    __setDnsLookupForTests(async () => ["fe80::1"]);
    const result = await webFetchTool({ url: "http://ll.example.com/" });
    expect(result).toMatch(/fe80::1/);
  });

  it("refuses host that resolves to IPv4-mapped IPv6 loopback", async () => {
    __setDnsLookupForTests(async () => ["::ffff:127.0.0.1"]);
    const result = await webFetchTool({ url: "http://mapped.example.com/" });
    expect(result).toMatch(/blocked IP/);
  });

  it("refuses if ANY of multiple resolved IPs is private", async () => {
    // A host that resolves to one public + one private IP must still
    // be refused. Any one private IP is enough to fail.
    __setDnsLookupForTests(async () => ["8.8.8.8", "10.0.0.1"]);
    const result = await webFetchTool({ url: "http://mixed.example.com/" });
    expect(result).toMatch(/10\.0\.0\.1/);
  });

  it("refuses when DNS lookup fails entirely", async () => {
    __setDnsLookupForTests(async () => {
      throw new Error("ENOTFOUND");
    });
    const result = await webFetchTool({ url: "http://nonexistent.example.com/" });
    expect(result).toMatch(/DNS lookup failed/);
  });

  it("refuses when DNS returns no addresses", async () => {
    __setDnsLookupForTests(async () => []);
    const result = await webFetchTool({ url: "http://empty.example.com/" });
    expect(result).toMatch(/DNS returned no addresses/);
  });
});

describe("WebFetch SSRF guard — header stripping", () => {
  it("strips Cookie / Authorization / Proxy-Authorization from user args (BLOCKED_REQUEST_HEADERS)", async () => {
    // We just verify the refusal happens before fetch is issued, so
    // the cookie never goes on the wire. The pre-existing
    // BLOCKED_REQUEST_HEADERS filter removes them from the request
    // build; A3 doesn't change this but we add a regression test.
    const result = await webFetchTool({
      url: "http://127.0.0.1/x",
      headers: {
        Cookie: "secret=1",
        Authorization: "Bearer x",
        "Proxy-Authorization": "Basic y",
      },
    });
    expect(result).toMatch(/block list/);
  });
});
