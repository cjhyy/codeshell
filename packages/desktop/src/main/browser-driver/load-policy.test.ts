import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setPolicySettingsPathForTest,
  loadBrowserAutomationPolicy,
} from "./load-policy.js";
import { isDomainAllowed } from "./policy.js";

describe("browser automation policy loader", () => {
  let root: string;
  let settings: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codeshell-browser-policy-"));
    settings = join(root, "settings.json");
    _setPolicySettingsPathForTest(settings);
  });

  afterEach(() => {
    _setPolicySettingsPathForTest(null);
    rmSync(root, { recursive: true, force: true });
  });

  test("an absent policy keeps the user-present permissive default", () => {
    expect(isDomainAllowed("https://example.com", loadBrowserAutomationPolicy())).toBe(true);
  });

  test("loads and normalizes valid exact and suffix domains", () => {
    writeFileSync(
      settings,
      JSON.stringify({ browserAutomation: { allowedDomains: [" Example.COM ", ".Example.org"] } }),
    );
    const policy = loadBrowserAutomationPolicy();
    expect(policy.allowedDomains).toEqual(["example.com", ".example.org"]);
    expect(isDomainAllowed("https://example.com:9443", policy)).toBe(true);
    expect(isDomainAllowed("https://child.example.org", policy)).toBe(true);
    expect(isDomainAllowed("https://other.test", policy)).toBe(false);
  });

  test("fails closed when an existing policy is malformed", () => {
    writeFileSync(settings, JSON.stringify({ browserAutomation: { allowedDomains: [123] } }));
    expect(isDomainAllowed("https://example.com", loadBrowserAutomationPolicy())).toBe(false);

    _setPolicySettingsPathForTest(settings);
    writeFileSync(settings, "{");
    expect(isDomainAllowed("https://example.com", loadBrowserAutomationPolicy())).toBe(false);
  });

  test("fails closed for oversized and linked settings files", () => {
    writeFileSync(settings, "x".repeat(4 * 1024 * 1024 + 1));
    expect(isDomainAllowed("https://example.com", loadBrowserAutomationPolicy())).toBe(false);

    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify({ browserAutomation: { allowedDomains: [] } }));
    rmSync(settings);
    symlinkSync(outside, settings);
    _setPolicySettingsPathForTest(settings);
    expect(isDomainAllowed("https://example.com", loadBrowserAutomationPolicy())).toBe(false);
  });

  test("rejects excessive or URL-shaped domain patterns", () => {
    const invalid = [
      Array.from({ length: 1_001 }, () => "example.com"),
      ["https://example.com"],
      ["example.com/path"],
      [""],
    ];
    for (const allowedDomains of invalid) {
      writeFileSync(settings, JSON.stringify({ browserAutomation: { allowedDomains } }));
      _setPolicySettingsPathForTest(settings);
      expect(isDomainAllowed("https://example.com", loadBrowserAutomationPolicy())).toBe(false);
    }
  });
});
