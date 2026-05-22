import { describe, it, expect } from "bun:test";
import {
  validateMarketplace,
  validatePluginEntry,
  validatePluginEntrySource,
} from "../packages/core/src/plugins/schemas.js";

describe("validatePluginEntrySource", () => {
  it("accepts a non-empty string", () => {
    const r = validatePluginEntrySource("./plugins/foo", "src");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("./plugins/foo");
  });

  it("rejects an empty string", () => {
    const r = validatePluginEntrySource("", "src");
    expect(r.ok).toBe(false);
  });

  it("accepts git source with url", () => {
    const r = validatePluginEntrySource({ source: "git", url: "https://x" }, "src");
    expect(r.ok).toBe(true);
  });

  it("rejects git source without url", () => {
    const r = validatePluginEntrySource({ source: "git" }, "src");
    expect(r.ok).toBe(false);
  });

  it("accepts github source with owner/name", () => {
    const r = validatePluginEntrySource({ source: "github", repo: "anthropics/skills" }, "src");
    expect(r.ok).toBe(true);
  });

  it("rejects github source missing slash", () => {
    const r = validatePluginEntrySource({ source: "github", repo: "broken" }, "src");
    expect(r.ok).toBe(false);
  });

  it("accepts git-subdir with url+path", () => {
    const r = validatePluginEntrySource(
      { source: "git-subdir", url: "https://x", path: "plugins/foo" },
      "src",
    );
    expect(r.ok).toBe(true);
  });

  it("rejects git-subdir missing path", () => {
    const r = validatePluginEntrySource({ source: "git-subdir", url: "https://x" }, "src");
    expect(r.ok).toBe(false);
  });

  it("rejects unsupported source kind", () => {
    const r = validatePluginEntrySource({ source: "npm", package: "foo" }, "src");
    expect(r.ok).toBe(false);
  });

  it("rejects non-object non-string", () => {
    const r = validatePluginEntrySource(42, "src");
    expect(r.ok).toBe(false);
  });
});

describe("validatePluginEntry", () => {
  it("accepts a minimal plugin entry", () => {
    const r = validatePluginEntry({ name: "foo", source: "./plugins/foo" }, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("foo");
  });

  it("rejects missing name", () => {
    expect(validatePluginEntry({ source: "./foo" }, 0).ok).toBe(false);
  });

  it("rejects missing source", () => {
    expect(validatePluginEntry({ name: "foo" }, 0).ok).toBe(false);
  });

  it("rejects bad author shape", () => {
    expect(validatePluginEntry({ name: "foo", source: "./foo", author: "Alice" }, 0).ok).toBe(false);
  });

  it("accepts author with email", () => {
    const r = validatePluginEntry(
      { name: "foo", source: "./foo", author: { name: "A", email: "a@b" } },
      0,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.author?.email).toBe("a@b");
  });
});

describe("validateMarketplace", () => {
  it("accepts a minimal marketplace", () => {
    const r = validateMarketplace({
      name: "mkt",
      owner: { name: "Owner" },
      plugins: [{ name: "p1", source: "./plugins/p1" }],
    });
    expect(r.ok).toBe(true);
  });

  it("propagates plugin entry error with index", () => {
    const r = validateMarketplace({
      name: "mkt",
      owner: { name: "Owner" },
      plugins: [{ name: "p1", source: "./p1" }, { name: "p2" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("plugins[1]");
  });

  it("rejects missing owner.name", () => {
    const r = validateMarketplace({ name: "mkt", owner: {}, plugins: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects non-array plugins", () => {
    const r = validateMarketplace({ name: "mkt", owner: { name: "O" }, plugins: "many" });
    expect(r.ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateMarketplace(null).ok).toBe(false);
    expect(validateMarketplace([1, 2]).ok).toBe(false);
  });
});
