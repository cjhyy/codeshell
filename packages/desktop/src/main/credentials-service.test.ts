import { describe, test, expect } from "bun:test";
import { formatNetscapeCookies, type ElectronCookieLike } from "./credentials-service.js";

describe("formatNetscapeCookies", () => {
  test("emits the Netscape header line", () => {
    const out = formatNetscapeCookies([]);
    expect(out.split("\n")[0]).toBe("# Netscape HTTP Cookie File");
  });

  test("maps one cookie to 7 tab-separated fields", () => {
    const c: ElectronCookieLike = {
      domain: ".example.com",
      hostOnly: false,
      path: "/",
      secure: true,
      expirationDate: 1893456000,
      name: "sid",
      value: "abc",
    };
    const lines = formatNetscapeCookies([c]).trim().split("\n");
    const fields = lines[lines.length - 1].split("\t");
    expect(fields).toEqual([".example.com", "TRUE", "/", "TRUE", "1893456000", "sid", "abc"]);
  });

  test("hostOnly cookie → include-subdomains FALSE", () => {
    const c: ElectronCookieLike = {
      domain: "x.com",
      hostOnly: true,
      path: "/",
      secure: false,
      name: "a",
      value: "1",
    };
    const fields = formatNetscapeCookies([c]).trim().split("\n").pop()!.split("\t");
    expect(fields[1]).toBe("FALSE");
    expect(fields[3]).toBe("FALSE");
  });

  test("session cookie (no expirationDate) → 0", () => {
    const c: ElectronCookieLike = {
      domain: "x.com",
      path: "/",
      secure: false,
      name: "a",
      value: "1",
    };
    const fields = formatNetscapeCookies([c]).trim().split("\n").pop()!.split("\t");
    expect(fields[4]).toBe("0");
  });

  test("skips cookies whose name/value contain tab or newline", () => {
    const bad: ElectronCookieLike = { domain: "x.com", path: "/", secure: false, name: "a\tb", value: "v" };
    const good: ElectronCookieLike = { domain: "x.com", path: "/", secure: false, name: "ok", value: "v" };
    const lines = formatNetscapeCookies([bad, good]).trim().split("\n");
    // header + 1 good cookie only
    expect(lines).toHaveLength(2);
    expect(lines[1].split("\t")[5]).toBe("ok");
  });
});
