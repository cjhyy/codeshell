import { describe, test, expect } from "bun:test";
import { formatNetscapeCookies, parseCookieJar } from "./cookie-jar.js";

describe("formatNetscapeCookies", () => {
  test("emits header + 7 TAB-separated fields", () => {
    const out = formatNetscapeCookies([
      { name: "s", value: "v", domain: ".x.com", path: "/", secure: true, expirationDate: 123.9 },
    ]);
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("# Netscape HTTP Cookie File");
    expect(lines[1].split("\t")).toEqual([".x.com", "TRUE", "/", "TRUE", "123", "s", "v"]);
  });

  test("hostOnly=true → includeSubdomains FALSE; defaults path '/' secure FALSE expiry 0", () => {
    const out = formatNetscapeCookies([{ name: "a", value: "b", domain: "x.com", hostOnly: true }]);
    expect(out.trim().split("\n")[1].split("\t")).toEqual(["x.com", "FALSE", "/", "FALSE", "0", "a", "b"]);
  });

  test("skips cookies with TAB/newline in name/value/domain", () => {
    const out = formatNetscapeCookies([
      { name: "bad\tname", value: "v", domain: "x.com" },
      { name: "ok", value: "v", domain: "x.com" },
    ]);
    expect(out).toContain("ok");
    expect(out).not.toContain("bad");
  });
});

describe("parseCookieJar", () => {
  test("parses a JSON array", () => {
    expect(parseCookieJar('[{"name":"a","value":"b"}]')).toEqual([{ name: "a", value: "b" }]);
  });
  test("bad JSON / non-array / undefined → []", () => {
    expect(parseCookieJar("not json")).toEqual([]);
    expect(parseCookieJar('{"name":"a"}')).toEqual([]);
    expect(parseCookieJar(undefined)).toEqual([]);
  });
});
