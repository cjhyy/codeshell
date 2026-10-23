import { describe, expect, test } from "bun:test";
import { cookieAppliesToHost, normalizeCookieDomain } from "./cookie-domain.js";

describe("Cookie host scope", () => {
  test("accepts registrable DNS domains but not public or private suffixes", () => {
    expect(normalizeCookieDomain(".EXAMPLE.co.uk")).toBe("example.co.uk");
    expect(normalizeCookieDomain("account.github.io")).toBe("account.github.io");
    for (const value of [
      undefined,
      "",
      ".com",
      ".co.uk",
      ".github.io",
      ".s3.amazonaws.com",
      "..example.com",
      "example.com/",
      "example.com:443",
      "example.com\n",
    ])
      expect(normalizeCookieDomain(value)).toBeUndefined();
  });

  test("uses real Domain semantics for a parent cookie on a www login host", () => {
    expect(cookieAppliesToHost({ domain: ".example.com" }, "www.example.com")).toBe(true);
    expect(cookieAppliesToHost({ domain: "example.com", hostOnly: false }, "www.example.com")).toBe(
      true,
    );
    expect(cookieAppliesToHost({ domain: ".example.co.uk" }, "www.example.co.uk")).toBe(true);
  });

  test("host-only and legacy exact-host cookies stay exact", () => {
    expect(
      cookieAppliesToHost({ domain: "www.example.com", hostOnly: true }, "www.example.com"),
    ).toBe(true);
    expect(cookieAppliesToHost({ domain: "www.example.com" }, "www.example.com")).toBe(true);
    expect(cookieAppliesToHost({ domain: "example.com" }, "www.example.com")).toBe(false);
    expect(cookieAppliesToHost({ domain: ".example.com", hostOnly: true }, "www.example.com")).toBe(
      false,
    );
    expect(
      cookieAppliesToHost({ domain: "login.example.com", hostOnly: true }, "www.example.com"),
    ).toBe(false);
  });

  test("refuses public-suffix, sibling, and lookalike cookies", () => {
    for (const [cookieDomain, host] of [
      [".co.uk", "www.example.co.uk"],
      [".github.io", "account.github.io"],
      [".example.com", "example.com.attacker.test"],
      [".example.com", "notexample.com"],
      [".other.example.com", "www.example.com"],
      [".another.com", "www.example.com"],
    ])
      expect(cookieAppliesToHost({ domain: cookieDomain, hostOnly: false }, host)).toBe(false);
  });

  test("honors public-suffix wildcard exceptions and rejects malformed hostOnly metadata", () => {
    expect(normalizeCookieDomain("foo.ck")).toBeUndefined();
    expect(normalizeCookieDomain("www.ck")).toBe("www.ck");
    expect(cookieAppliesToHost({ domain: ".foo.ck" }, "login.foo.ck")).toBe(false);
    expect(cookieAppliesToHost({ domain: ".www.ck" }, "login.www.ck")).toBe(true);
    for (const hostOnly of ["false", 0, null])
      expect(
        cookieAppliesToHost(
          { domain: ".example.com", hostOnly: hostOnly as unknown as boolean },
          "www.example.com",
        ),
      ).toBe(false);
  });
});
