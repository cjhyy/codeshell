import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { formatNetscapeCookies, parseCookieJar, summarizeCookieExpiry } from "./cookie-jar.js";

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
    expect(out.trim().split("\n")[1].split("\t")).toEqual([
      "x.com",
      "FALSE",
      "/",
      "FALSE",
      "0",
      "a",
      "b",
    ]);
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

describe("summarizeCookieExpiry", () => {
  test("reports the next persistent expiry without exposing names or values", () => {
    const summary = summarizeCookieExpiry(
      JSON.stringify([
        { name: "old", value: "secret", expirationDate: 100 },
        { name: "next", value: "secret", expirationDate: 300 },
        { name: "later", value: "secret", expirationDate: 400 },
        { name: "session", value: "secret" },
      ]),
      200_000,
    );
    expect(summary).toEqual({
      nextExpiryAt: new Date(300_000).toISOString(),
      persistentCount: 3,
      sessionCount: 1,
      expiredCount: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  test("handles session-only, expired, and malformed jars", () => {
    expect(summarizeCookieExpiry('[{"name":"session","value":"x"}]', 0)).toEqual({
      persistentCount: 0,
      sessionCount: 1,
      expiredCount: 0,
    });
    expect(summarizeCookieExpiry('[{"name":"old","value":"x","expirationDate":1}]', 2_000)).toEqual(
      {
        persistentCount: 1,
        sessionCount: 0,
        expiredCount: 1,
      },
    );
    expect(summarizeCookieExpiry("bad", 0)).toEqual({
      persistentCount: 0,
      sessionCount: 0,
      expiredCount: 0,
    });
  });
});

describe("Netscape consumer compatibility", () => {
  const cookies = [
    { name: "exact", value: "fixture", domain: "example.com" },
    { name: "ip", value: "fixture", domain: "127.0.0.1" },
    { name: "inferred-subdomains", value: "fixture", domain: ".example.com" },
    { name: "explicit-subdomains", value: "fixture", domain: "example.com", hostOnly: false },
    { name: "explicit-exact", value: "fixture", domain: ".example.com", hostOnly: true },
  ];
  test("missing hostOnly preserves exact scope and explicit scope normalizes domain syntax", () => {
    const rows = formatNetscapeCookies(cookies)
      .trim()
      .split("\n")
      .slice(1)
      .map((row) => row.split("\t").slice(0, 2));
    expect(rows).toEqual([
      ["example.com", "FALSE"],
      ["127.0.0.1", "FALSE"],
      [".example.com", "TRUE"],
      [".example.com", "TRUE"],
      ["example.com", "FALSE"],
    ]);
  });
  test.skipIf(!Bun.which("python3"))(
    "Python's real MozillaCookieJar accepts all exported scope forms",
    () => {
      const program = `import http.cookiejar, json, pathlib, sys, tempfile
with tempfile.TemporaryDirectory() as root:
    path = pathlib.Path(root) / "cookies.txt"
    path.write_text(sys.stdin.read())
    jar = http.cookiejar.MozillaCookieJar(str(path))
    jar.load(ignore_discard=True, ignore_expires=True)
    print(json.dumps({cookie.name: [cookie.domain, cookie.domain_specified] for cookie in jar}))
`;
      const result = spawnSync("python3", ["-c", program], {
        input: formatNetscapeCookies(cookies),
        encoding: "utf8",
        timeout: 10000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        exact: ["example.com", false],
        ip: ["127.0.0.1", false],
        "inferred-subdomains": [".example.com", true],
        "explicit-subdomains": [".example.com", true],
        "explicit-exact": ["example.com", false],
      });
    },
  );
});
