import { describe, it, expect } from "bun:test";
import { validatePluginEntrySource, validateMarketplace } from "./schemas.js";

describe("validatePluginEntrySource", () => {
  it("accepts a bare string path", () => {
    const r = validatePluginEntrySource("./plugins/foo", "plugins[0].source");
    expect(r).toEqual({ ok: true, value: "./plugins/foo" });
  });

  it("accepts git, github, git-subdir", () => {
    expect(validatePluginEntrySource({ source: "git", url: "https://x.git" }, "p").ok).toBe(true);
    expect(validatePluginEntrySource({ source: "github", repo: "o/n" }, "p").ok).toBe(true);
    expect(
      validatePluginEntrySource({ source: "git-subdir", url: "https://x.git", path: "p/q" }, "p").ok,
    ).toBe(true);
  });

  // The official claude-plugins-official marketplace emits a "url" source type
  // (e.g. Salesforce agentforce-adlc). It is semantically "clone this git repo",
  // so we normalize it onto git / git-subdir.
  it('normalizes a "url" source without path to a git source', () => {
    const r = validatePluginEntrySource(
      {
        source: "url",
        url: "https://github.com/SalesforceAIResearch/agentforce-adlc.git",
        sha: "55220ca32965a7543261a2ed00a0e33da59f7c80",
      },
      "plugins[3].source",
    );
    expect(r).toEqual({
      ok: true,
      value: {
        source: "git",
        url: "https://github.com/SalesforceAIResearch/agentforce-adlc.git",
        ref: undefined,
        sha: "55220ca32965a7543261a2ed00a0e33da59f7c80",
      },
    });
  });

  it('normalizes a "url" source with a path to a git-subdir source', () => {
    const r = validatePluginEntrySource(
      {
        source: "url",
        url: "https://github.com/RevenueCat/rc-claude-code-plugin.git",
        path: "revenuecat",
        sha: "81262a339601c4b64b909c370225cbd7917ade1f",
      },
      "plugins[153].source",
    );
    expect(r).toEqual({
      ok: true,
      value: {
        source: "git-subdir",
        url: "https://github.com/RevenueCat/rc-claude-code-plugin.git",
        path: "revenuecat",
        ref: undefined,
        sha: "81262a339601c4b64b909c370225cbd7917ade1f",
      },
    });
  });

  it('rejects a "url" source missing url', () => {
    const r = validatePluginEntrySource({ source: "url", sha: "abc1234" }, "p");
    expect(r.ok).toBe(false);
  });

  it("still rejects a genuinely unknown source type", () => {
    const r = validatePluginEntrySource({ source: "ftp", url: "ftp://x" }, "p");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unsupported source type "ftp"');
  });
});

describe("Codex marketplace shape (.agents/plugins/marketplace.json)", () => {
  // The hashgraph-online/awesome-codex-plugins marketplace uses the Codex /
  // agents format: no top-level `owner`, a top-level `interface.displayName`,
  // and every entry's source is { source: "local", path }. We accept it by
  // normalizing { source: "local", path } onto our bare-string path source and
  // by falling back to interface.displayName / name when owner is absent.
  it("normalizes { source: 'local', path } to a bare string path", () => {
    const r = validatePluginEntrySource(
      { source: "local", path: "./plugins/RBraga01/a-team" },
      "plugins[0].source",
    );
    expect(r).toEqual({ ok: true, value: "./plugins/RBraga01/a-team" });
  });

  it("rejects a { source: 'local' } missing path", () => {
    expect(validatePluginEntrySource({ source: "local" }, "p").ok).toBe(false);
  });

  it("parses a Codex manifest with no owner and local-object sources", () => {
    const raw = {
      name: "awesome-codex-plugins",
      interface: { displayName: "Awesome Codex Plugins" },
      plugins: [
        {
          name: "a-team",
          displayName: "A Team",
          source: { source: "local", path: "./plugins/RBraga01/a-team" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Development & Workflow",
          description: "Multi-agent infra.",
          icon: "./plugins/RBraga01/a-team/assets/x.svg",
        },
      ],
    };
    const r = validateMarketplace(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.owner.name).toBe("Awesome Codex Plugins");
      expect(r.value.plugins).toHaveLength(1);
      expect(r.value.plugins[0].source).toBe("./plugins/RBraga01/a-team");
    }
  });
});

describe("validateMarketplace with mixed url/git-subdir/string entries", () => {
  it("parses an official-style marketplace where many entries use url", () => {
    const raw = {
      name: "claude-plugins-official",
      owner: { name: "anthropics" },
      plugins: [
        { name: "a", source: "./plugins/a" },
        {
          name: "b",
          source: { source: "git-subdir", url: "https://x.git", path: "plugins/b", ref: "main" },
        },
        {
          name: "c",
          source: { source: "url", url: "https://y.git", sha: "deadbeefdeadbeef" },
        },
      ],
    };
    const r = validateMarketplace(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.plugins).toHaveLength(3);
      expect(r.value.plugins[2].source).toEqual({
        source: "git",
        url: "https://y.git",
        ref: undefined,
        sha: "deadbeefdeadbeef",
      });
    }
  });
});

describe("plugin entry version (marketplace 版本号显示)", () => {
  it("reads a declared version string off the manifest entry", () => {
    const r = validateMarketplace({
      name: "m",
      owner: { name: "o" },
      plugins: [{ name: "p", source: "./plugins/p", version: "1.2.3" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.plugins[0].version).toBe("1.2.3");
  });

  it("omits version when absent or non-string (CC manifests usually have none)", () => {
    const r = validateMarketplace({
      name: "m",
      owner: { name: "o" },
      plugins: [
        { name: "a", source: "./plugins/a" },
        { name: "b", source: "./plugins/b", version: 3 },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.plugins[0].version).toBeUndefined();
      expect(r.value.plugins[1].version).toBeUndefined();
    }
  });
});
